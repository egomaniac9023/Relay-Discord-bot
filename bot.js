require('dotenv').config();
const {
    Client,
    GatewayIntentBits,
    WebhookClient,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionsBitField,
    DiscordAPIError
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');

const ALLOWED_CHANNEL_IDS = process.env.ALLOWED_CHANNEL_IDS ? process.env.ALLOWED_CHANNEL_IDS.split(',') : [];
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 3;
const ROTATION_INTERVAL = 86400000;

const userMessageCounts = new Map();
let db;

(async () => {
    try {
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir);
            console.log('Der "data"-Ordner für die Datenbank wurde erstellt.');
        }

        db = await open({
            filename: path.join(dataDir, 'webhooks.db'),
            driver: sqlite3.Database
        });

        await db.run(`CREATE TABLE IF NOT EXISTS webhooks (
            channelId TEXT PRIMARY KEY,
            webhookId TEXT NOT NULL,
            webhookToken TEXT NOT NULL
        )`);
        console.log('Datenbank erfolgreich initialisiert.');
    } catch (error) {
        console.error('Fehler bei der Initialisierung der Datenbank:', error);
        process.exit(1);
    }
})();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

async function getOrCreateWebhook(channel) {
    try {
        const row = await db.get('SELECT webhookId, webhookToken FROM webhooks WHERE channelId = ?', channel.id);
        if (row) {
            return new WebhookClient({ id: row.webhookId, token: row.webhookToken });
        }

        const newWebhook = await channel.createWebhook({
            name: 'General Webhook',
            reason: 'Wiederverwendbarer Webhook für Nachrichten'
        });

        await db.run('INSERT INTO webhooks (channelId, webhookId, webhookToken) VALUES (?, ?, ?)',
            channel.id, newWebhook.id, newWebhook.token
        );

        return new WebhookClient({ id: newWebhook.id, token: newWebhook.token });

    } catch (error) {
        if (error instanceof DiscordAPIError && error.code === 10015) {
             await db.run('DELETE FROM webhooks WHERE channelId = ?', channel.id);
             return getOrCreateWebhook(channel);
        }
        console.error(`Konnte keinen Webhook für Kanal ${channel.id} erstellen oder abrufen:`, error);
        return null;
    }
}

async function sendWebhookMessage({ message, attachment, channel, username, displayAvatarURL }) {
    const webhookClient = await getOrCreateWebhook(channel);
    if (!webhookClient) {
        console.error(`Senden fehlgeschlagen: Kein Webhook für Kanal ${channel.id} verfügbar.`);
        return;
    }
    try {
        await webhookClient.send({
            content: message || undefined,
            username: username,
            avatarURL: displayAvatarURL,
            files: attachment ? [attachment.url] : [],
            allowedMentions: { parse: [] }
        });
    } catch (error) {
        console.error('Fehler beim Senden der Webhook-Nachricht:', error);
    }
}

async function rotateWebhooks() {
    console.log('Starte tägliche Webhook-Rotation...');
    const allWebhooks = await db.all('SELECT * FROM webhooks');
    if (allWebhooks.length === 0) {
        console.log('Keine Webhooks zur Rotation in der Datenbank gefunden.');
        return;
    }

    let rotatedCount = 0;
    for (const webhook of allWebhooks) {
        try {
            const channel = await client.channels.fetch(webhook.channelId);
            if (!channel) throw new Error('Kanal nicht gefunden');

            const oldWebhookClient = new WebhookClient({ id: webhook.webhookId, token: webhook.webhookToken });
            await oldWebhookClient.delete().catch(() => {});

            const newWebhook = await channel.createWebhook({
                name: 'General Webhook',
                reason: 'Tägliche Rotation'
            });

            await db.run('UPDATE webhooks SET webhookId = ?, webhookToken = ? WHERE channelId = ?',
                newWebhook.id, newWebhook.token, channel.id
            );
            rotatedCount++;
        } catch (error) {
            console.warn(`Fehler bei Rotation für Kanal ${webhook.channelId}. Entferne Eintrag. Fehler: ${error.message}`);
            await db.run('DELETE FROM webhooks WHERE channelId = ?', webhook.channelId);
        }
    }
    console.log(`Webhook-Rotation abgeschlossen. ${rotatedCount} Webhooks rotiert.`);
}


function isUserRateLimited(userId) {
    if (!userMessageCounts.has(userId)) {
        userMessageCounts.set(userId, []);
    }
    const timestamps = userMessageCounts.get(userId);
    const currentTime = Date.now();
    while (timestamps.length > 0 && timestamps[0] <= currentTime - RATE_LIMIT_WINDOW) {
        timestamps.shift();
    }
    timestamps.push(currentTime);
    return timestamps.length > RATE_LIMIT_MAX;
}

client.once('ready', () => {
    console.log(`Bot ist als ${client.user.tag} bereit!`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
    const commands = [
        new SlashCommandBuilder()
        .setName('webhook')
        .setDescription('Sende eine Nachricht oder einen Anhang als Webhook.')
        .addStringOption(option =>
            option.setName('message')
            .setDescription('Die zu sendende Nachricht')
            .setRequired(false))
        .addAttachmentOption(option =>
            option.setName('attachment')
            .setDescription('Der zu sendende Anhang')
            .setRequired(false)),
    ].map(command => command.toJSON());

    rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands })
        .then(() => console.log('Slash-Befehle erfolgreich registriert.'))
        .catch(console.error);

    rotateWebhooks();
    setInterval(rotateWebhooks, ROTATION_INTERVAL);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand() || interaction.commandName !== 'webhook') return;

    if (!ALLOWED_CHANNEL_IDS.includes(interaction.channelId)) {
        await interaction.reply({ content: 'Dieser Befehl kann in diesem Kanal nicht verwendet werden.', ephemeral: true });
        return;
    }

    try {
        const message = interaction.options.getString('message');
        const attachment = interaction.options.getAttachment('attachment');
        const user = interaction.user;

        if (!message && !attachment) {
            await interaction.reply({ content: 'Du musst entweder eine Nachricht oder einen Anhang angeben.', ephemeral: true });
            return;
        }

        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            if (isUserRateLimited(user.id)) {
                await interaction.reply({ content: 'Du sendest Befehle zu schnell. Bitte warte einen Moment.', ephemeral: true });
                return;
            }
        }

        await interaction.reply({ content: 'Deine Nachricht wird gesendet...', ephemeral: true });

        await sendWebhookMessage({
            message,
            attachment,
            channel: interaction.channel,
            username: interaction.member.displayName,
            displayAvatarURL: user.displayAvatarURL({ format: 'png' })
        });

    } catch (error) {
        console.error('Fehler bei der Verarbeitung einer Interaktion:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.followUp({ content: 'Ein Fehler ist aufgetreten.', ephemeral: true }).catch(() => {});
        }
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot || !ALLOWED_CHANNEL_IDS.includes(message.channelId)) {
        return;
    }

    try {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            if (isUserRateLimited(message.author.id)) {
                await message.author.send('Du sendest Nachrichten zu schnell. Deine letzte Nachricht wurde ignoriert.').catch(() => {});
                await message.delete().catch(() => {});
                return;
            }
        }

        if (!message.content && message.attachments.size === 0) {
            return;
        }

        await sendWebhookMessage({
            message: message.content,
            attachment: message.attachments.first(),
            channel: message.channel,
            username: message.member.displayName,
            displayAvatarURL: message.author.displayAvatarURL({ format: 'png' })
        });

        await message.delete().catch(() => {});

    } catch (error) {
        console.error('Fehler bei der Verarbeitung einer Nachricht:', error);
    }
});

client.login(process.env.DISCORD_BOT_TOKEN).catch(error => {
    console.error('Fehler beim Einloggen:', error);
});
