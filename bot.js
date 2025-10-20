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
const crypto = require('crypto');

const ALLOWED_CHANNEL_IDS = process.env.ALLOWED_CHANNEL_IDS ? process.env.ALLOWED_CHANNEL_IDS.split(',') : [];
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 3;
const ROTATION_INTERVAL = 86400000;

const ENCRYPTED_TOKEN_PREFIX = 'enc:';

class DecryptionError extends Error {
    constructor(message, { isPlaintext = false } = {}) {
        super(message);
        this.name = 'DecryptionError';
        this.isPlaintext = isPlaintext;
    }
}

const userMessageCounts = new Map();
let db;

const encryptionSecret = process.env.WEBHOOK_TOKEN_SECRET;
if (!encryptionSecret) {
    console.error('Die Umgebungsvariable WEBHOOK_TOKEN_SECRET ist erforderlich, um Webhook-Tokens zu schützen.');
    process.exit(1);
}

const encryptionKey = crypto.createHash('sha256').update(encryptionSecret).digest();

function encryptWebhookToken(token) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, authTag, ciphertext]).toString('base64');
    return `${ENCRYPTED_TOKEN_PREFIX}${payload}`;
}

function decryptWebhookToken(storedToken) {
    if (!storedToken.startsWith(ENCRYPTED_TOKEN_PREFIX)) {
        throw new DecryptionError('Token liegt im Klartext vor.', { isPlaintext: true });
    }

    try {
        const data = Buffer.from(storedToken.slice(ENCRYPTED_TOKEN_PREFIX.length), 'base64');
        const iv = data.subarray(0, 12);
        const authTag = data.subarray(12, 28);
        const ciphertext = data.subarray(28);

        const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return decrypted.toString('utf8');
    } catch (error) {
        throw new DecryptionError('Entschlüsselung des Webhook-Tokens fehlgeschlagen.');
    }
}

async function ensureEncryptedToken(channelId, token) {
    const encrypted = encryptWebhookToken(token);
    await db.run('UPDATE webhooks SET webhookToken = ? WHERE channelId = ?', encrypted, channelId);
    return encrypted;
}

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
            let webhookToken;
            try {
                webhookToken = decryptWebhookToken(row.webhookToken);
            } catch (error) {
                if (error instanceof DecryptionError && error.isPlaintext) {
                    webhookToken = row.webhookToken;
                    await ensureEncryptedToken(channel.id, webhookToken).catch(err => {
                        console.warn(`Konnte Webhook-Token für Kanal ${channel.id} nicht nachträglich verschlüsseln:`, err);
                    });
                } else {
                    console.warn(`Webhook-Token für Kanal ${channel.id} konnte nicht entschlüsselt werden. Eintrag wird entfernt und neu erstellt.`);
                    await db.run('DELETE FROM webhooks WHERE channelId = ?', channel.id);
                    return getOrCreateWebhook(channel);
                }
            }

            return new WebhookClient({ id: row.webhookId, token: webhookToken });
        }

        const newWebhook = await channel.createWebhook({
            name: 'General Webhook',
            reason: 'Wiederverwendbarer Webhook für Nachrichten'
        });

        const encryptedToken = encryptWebhookToken(newWebhook.token);
        await db.run('INSERT INTO webhooks (channelId, webhookId, webhookToken) VALUES (?, ?, ?)',
            channel.id, newWebhook.id, encryptedToken
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

            let webhookToken;
            try {
                webhookToken = decryptWebhookToken(webhook.webhookToken);
            } catch (error) {
                if (error instanceof DecryptionError && error.isPlaintext) {
                    webhookToken = webhook.webhookToken;
                    await ensureEncryptedToken(webhook.channelId, webhookToken).catch(err => {
                        console.warn(`Konnte Webhook-Token für Kanal ${webhook.channelId} nicht nachträglich verschlüsseln:`, err);
                    });
                } else {
                    console.warn(`Webhook-Token für Kanal ${webhook.channelId} konnte nicht entschlüsselt werden und wird entfernt.`);
                    await db.run('DELETE FROM webhooks WHERE channelId = ?', webhook.channelId);
                    continue;
                }
            }

            const oldWebhookClient = new WebhookClient({ id: webhook.webhookId, token: webhookToken });
            await oldWebhookClient.delete().catch(() => {});

            const newWebhook = await channel.createWebhook({
                name: 'General Webhook',
                reason: 'Tägliche Rotation'
            });

            const encryptedToken = encryptWebhookToken(newWebhook.token);
            await db.run('UPDATE webhooks SET webhookId = ?, webhookToken = ? WHERE channelId = ?',
                newWebhook.id, encryptedToken, channel.id
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
