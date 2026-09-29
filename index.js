import makeWASocket, {
    DisconnectReason,
    jidDecode,
    useMultiFileAuthState,
} from '@whiskeysockets/baileys'
import express from 'express'
import multer from 'multer'
import pino from 'pino'
import QRCode from 'qrcode'
import fs from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const app = express()
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 40 * 1024 * 1024, files: 1 },
})
const appLogger = pino({ level: process.env.LOG_LEVEL || 'info' })
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' })
const root = path.dirname(fileURLToPath(import.meta.url))
const authDirectory = path.join(root, 'auth_info_baileys')
const dataDirectory = path.join(root, 'data')
const frontendDirectory = path.join(root, 'dist')
const PORT = Number(process.env.PORT || 3000)
mkdirSync(dataDirectory, { recursive: true })
const database = new DatabaseSync(path.join(dataDirectory, 'whatsapp.sqlite'))
database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        timestamp INTEGER NOT NULL DEFAULT 0,
        unread_count INTEGER NOT NULL DEFAULT 0,
        last_message TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        muted_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
        jid TEXT NOT NULL,
        id TEXT NOT NULL,
        timestamp INTEGER NOT NULL DEFAULT 0,
        from_me INTEGER NOT NULL DEFAULT 0,
        is_read INTEGER NOT NULL DEFAULT 1,
        summary TEXT NOT NULL,
        key_json TEXT NOT NULL,
        PRIMARY KEY (jid, id)
    );
    CREATE TABLE IF NOT EXISTS statuses (
        id TEXT PRIMARY KEY,
        sender_name TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        from_me INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_by_chat_time ON messages (jid, timestamp);
`)
const messageColumns = database.prepare('PRAGMA table_info(messages)').all().map((column) => column.name)
if (!messageColumns.includes('is_read')) database.exec('ALTER TABLE messages ADD COLUMN is_read INTEGER NOT NULL DEFAULT 1')
const chatColumns = database.prepare('PRAGMA table_info(chats)').all().map((column) => column.name)
if (!chatColumns.includes('archived')) database.exec('ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
if (!chatColumns.includes('pinned')) database.exec('ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
if (!chatColumns.includes('muted_until')) database.exec('ALTER TABLE chats ADD COLUMN muted_until INTEGER NOT NULL DEFAULT 0')
database.prepare("DELETE FROM chats WHERE id = 'status@broadcast'").run()
database.prepare("DELETE FROM messages WHERE jid = 'status@broadcast'").run()

let sock
let authState
let connection = 'close'
let qrDataUrl = null
let pairingCode = null
let pairingNumber = null
let pairingRequest
let latestQr = null
let lastError = null
let user = null
let historyProgress = null
let reconnectAttempts = 0
let reconnectTimer = null
let resetUnregisteredAuthOnce = false
let nextActivityId = 1
const activities = []
const messages = new Map()
const chats = new Map()
const calls = new Map()
const contactNames = new Map()

app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: false, limit: '1mb' }))
app.use(express.static(frontendDirectory))
app.use('/api', (req, res, next) => {
    const startedAt = Date.now()
    res.on('finish', () => {
        if (req.method === 'GET' && res.statusCode < 400) return
        const details = { method: req.method, path: req.path, statusCode: res.statusCode, durationMs: Date.now() - startedAt }
        if (res.statusCode >= 500) appLogger.error(details, 'API request failed')
        else if (res.statusCode >= 400) appLogger.warn(details, 'API request rejected')
        else appLogger.info(details, 'API request completed')
    })
    next()
})
app.use('/api', (req, res, next) => {
    const origin = req.get('origin')
    const allowedOrigins = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin && !allowedOrigins.includes(origin)) {
        return res.status(403).json({ ok: false, error: 'Requests must come from the local dashboard.' })
    }
    next()
})

function record(type, details = {}) {
    activities.push({ id: nextActivityId++, at: new Date().toISOString(), type, ...details })
    if (activities.length > 250) activities.shift()
}

function rememberMessage(message, { countUnread = false } = {}) {
    const jid = message?.key?.remoteJid
    const id = message?.key?.id
    if (!jid || !id || jid === 'status@broadcast') return
    messages.set(`${jid}:${id}`, message)
    if (messages.size > 5000) messages.delete(messages.keys().next().value)
    const summary = safeMessage(message)
    const current = chats.get(jid) || { id: jid, name: '' }
    const chat = {
        ...current,
        id: jid,
        name: message.pushName || current.name || '',
        timestamp: summary.timestamp,
        unreadCount: Number(current.unreadCount || 0) + (countUnread && !message.key?.fromMe ? 1 : 0),
        lastMessage: message,
        lastSummary: summary,
    }
    chats.set(jid, chat)
    database.prepare(`
        INSERT INTO messages (jid, id, timestamp, from_me, is_read, summary, key_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(jid, id) DO UPDATE SET
            timestamp = excluded.timestamp,
            from_me = excluded.from_me,
                is_read = CASE WHEN messages.is_read = 1 THEN 1 ELSE excluded.is_read END,
                summary = excluded.summary,
                key_json = excluded.key_json
            `).run(jid, id, summary.timestamp, summary.fromMe ? 1 : 0, countUnread && !summary.fromMe ? 0 : 1, JSON.stringify(summary), JSON.stringify(message.key))
    persistChat(chat)
}

function rememberStatus(message) {
    const key = message?.key
    if (key?.remoteJid !== 'status@broadcast') return
    const summary = safeMessage(message)
    const senderId = key.participantAlt || key.participant
    const fromMe = Boolean(key.fromMe)
    const senderName = fromMe ? 'You' : message.pushName || contactNames.get(senderId) || 'Contact'
    const timestamp = Number(message.messageTimestamp || Math.floor(Date.now() / 1000))
    const id = key.id || `${senderName}:${timestamp}`
    database.prepare(`
        INSERT INTO statuses (id, sender_name, timestamp, from_me, kind, text, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            sender_name = excluded.sender_name,
            timestamp = excluded.timestamp,
            from_me = excluded.from_me,
            kind = excluded.kind,
            text = excluded.text,
            expires_at = excluded.expires_at
    `).run(id, senderName, timestamp, fromMe ? 1 : 0, summary.kind, summary.text, timestamp + 24 * 60 * 60)
}

function persistChat(chat) {
    if (!chat?.id) return
    const summary = chat.lastSummary || (chat.lastMessage ? safeMessage(chat.lastMessage) : null)
    database.prepare(`
        INSERT INTO chats (id, name, timestamp, unread_count, last_message, archived, pinned, muted_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = CASE WHEN excluded.name = '' THEN chats.name ELSE excluded.name END,
            timestamp = MAX(chats.timestamp, excluded.timestamp),
            unread_count = excluded.unread_count,
            last_message = COALESCE(excluded.last_message, chats.last_message),
            archived = excluded.archived,
            pinned = excluded.pinned,
            muted_until = excluded.muted_until
    `).run(
        chat.id,
        chat.name || chat.subject || chat.notify || '',
        Number(chat.timestamp || 0),
        Number(chat.unreadCount || 0),
        summary ? JSON.stringify(summary) : null,
        chat.archived ? 1 : 0,
        chat.pinned ? 1 : 0,
        Number(chat.mutedUntil || 0),
    )
}

function upsertChat(metadata) {
    const id = metadata?.id || metadata?.jid
    if (!id) return null
    const existing = chats.get(id) || { id }
    const chat = {
        ...existing,
        ...metadata,
        id,
        name: metadata.name || metadata.notify || metadata.subject || existing.name || '',
        timestamp: Number(metadata.conversationTimestamp || metadata.timestamp || existing.timestamp || 0),
        unreadCount: Number(metadata.unreadCount ?? existing.unreadCount ?? 0),
        archived: Boolean(metadata.archived ?? metadata.archive ?? existing.archived),
        pinned: Boolean(metadata.pinned ?? metadata.pin ?? existing.pinned),
        mutedUntil: Number(metadata.muteEndTime ?? metadata.mutedUntil ?? existing.mutedUntil ?? 0),
        lastMessage: existing.lastMessage || null,
        lastSummary: existing.lastSummary || null,
    }
    chats.set(id, chat)
    persistChat(chat)
    return chat
}

async function syncParticipatingGroups(socket) {
    const groups = await socket.groupFetchAllParticipating()
    for (const group of Object.values(groups)) {
        upsertChat({ id: group.id, name: group.subject, subject: group.subject, timestamp: Number(group.creation || 0) })
    }
    return Object.keys(groups).length
}

function readStoredChat(row) {
    return {
        id: row.id,
        name: row.name,
        timestamp: row.timestamp,
        unreadCount: row.unread_count,
        archived: Boolean(row.archived),
        pinned: Boolean(row.pinned),
        mutedUntil: Number(row.muted_until || 0),
        lastSummary: row.last_message ? JSON.parse(row.last_message) : null,
        lastMessage: null,
    }
}

for (const row of database.prepare('SELECT * FROM chats ORDER BY timestamp DESC').all()) {
    chats.set(row.id, readStoredChat(row))
}

function safeMessage(message) {
    const content = message.message || {}
    const text = content.conversation || content.extendedTextMessage?.text ||
        content.imageMessage?.caption || content.videoMessage?.caption ||
        content.documentMessage?.caption || ''
    const kind = Object.keys(content)[0] || 'message'
    return {
        id: message.key?.id,
        jid: message.key?.remoteJid,
        fromMe: Boolean(message.key?.fromMe),
        participant: message.key?.participant || message.key?.participantAlt || null,
        timestamp: Number(message.messageTimestamp || 0),
        kind,
        text: String(text).slice(0, 10_000),
    }
}

function requireSocket() {
    if (!sock || connection !== 'open') {
        throw Object.assign(new Error('WhatsApp is not connected yet.'), { status: 409 })
    }
    return sock
}

function asJid(value) {
    const input = String(value || '').trim()
    if (input.includes('@')) {
        if (!jidDecode(input)) throw Object.assign(new Error('Enter a valid WhatsApp JID.'), { status: 400 })
        return input
    }
    const digits = input.replace(/[\s()+.-]/g, '')
    if (!/^\d{7,15}$/.test(digits)) {
        throw Object.assign(new Error('Use an international number with country code, or a full WhatsApp JID.'), { status: 400 })
    }
    return `${digits}@s.whatsapp.net`
}

async function resolveRecipient(value) {
    const jid = asJid(value)
    if (!jid.endsWith('@s.whatsapp.net')) return jid
    const [result] = await requireSocket().onWhatsApp(jid)
    if (!result?.exists) throw Object.assign(new Error('That number is not registered on WhatsApp.'), { status: 404 })
    return result.jid || jid
}

function parseList(value) {
    return String(value || '').split(/[\n,;]/).map((item) => item.trim()).filter(Boolean)
}

function sendResult(res, result) {
    res.json({ ok: true, result })
}

function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

async function startSocket() {
    if (sock || connection === 'connecting') return
    connection = 'connecting'
    appLogger.info({ reconnectAttempts }, 'Starting WhatsApp connection')
    const { state, saveCreds } = await useMultiFileAuthState(authDirectory)
    authState = state
    const currentSocket = makeWASocket({
        auth: state,
        logger: baileysLogger,
    })
    sock = currentSocket

    currentSocket.ev.on('creds.update', async () => {
        try {
            await saveCreds()
            appLogger.debug('WhatsApp credentials saved')
        } catch (error) {
            appLogger.error({ err: error }, 'Failed to save WhatsApp credentials')
        }
    })
    currentSocket.ev.on('connection.update', async (update) => {
        const { connection: nextConnection, lastDisconnect, qr } = update
        if (nextConnection) appLogger.info({ connection: nextConnection }, 'WhatsApp connection state changed')
        if (qr) {
            latestQr = qr
            appLogger.info('WhatsApp QR code is ready')
            if (pairingNumber && !state.creds.registered) {
                try {
                    pairingRequest ||= currentSocket.requestPairingCode(pairingNumber)
                    pairingCode = await pairingRequest
                    pairingNumber = null
                    pairingRequest = null
                    qrDataUrl = null
                    record('pairing-code', { detail: 'Pairing code ready' })
                    appLogger.info('WhatsApp pairing code generated')
                } catch (error) {
                    lastError = error.message
                    pairingRequest = null
                    appLogger.warn({ err: error }, 'WhatsApp pairing code request failed')
                }
            } else {
                qrDataUrl = await QRCode.toDataURL(qr)
            }
        }
        if (nextConnection) connection = nextConnection
        if (nextConnection === 'open') {
            user = currentSocket.user
            qrDataUrl = null
            pairingCode = null
            pairingNumber = null
            pairingRequest = null
            latestQr = null
            lastError = null
            reconnectAttempts = 0
            resetUnregisteredAuthOnce = false
            record('connected', { detail: user?.name || user?.id || 'WhatsApp connected' })
            appLogger.info('WhatsApp connection opened')
            void syncParticipatingGroups(currentSocket).catch((error) => appLogger.warn({ err: error }, 'Could not sync participating groups'))
        }
        if (nextConnection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const loggedOut = statusCode === DisconnectReason.loggedOut
            const errorMessage = lastDisconnect?.error?.message || 'Connection closed'
            lastError = `${errorMessage}${statusCode ? ` (code ${statusCode})` : ''}`
            sock = null
            user = null
            if (loggedOut) {
                qrDataUrl = null
                pairingCode = null
                pairingRequest = null
                latestQr = null
                if (!state.creds.registered && !resetUnregisteredAuthOnce) {
                    resetUnregisteredAuthOnce = true
                    lastError = 'An unfinished pairing expired. Preparing a fresh QR code.'
                    appLogger.warn('Unregistered auth rejected; clearing incomplete pairing state once')
                    clearTimeout(reconnectTimer)
                    reconnectTimer = setTimeout(async () => {
                        try {
                            await fs.rm(authDirectory, { recursive: true, force: true })
                            authState = null
                            await startSocket()
                        } catch (error) {
                            lastError = error.message
                            appLogger.error({ err: error }, 'Failed to recover unfinished pairing state')
                        }
                    }, 1200)
                    return
                }
                pairingNumber = null
                lastError = 'Session logged out. Clear the saved session to link again.'
                appLogger.warn({ statusCode }, 'WhatsApp session logged out')
            } else {
                record('disconnected', { detail: lastError })
                const delay = Math.min(30_000, 1200 * 2 ** Math.min(reconnectAttempts, 5))
                reconnectAttempts += 1
                appLogger.warn({ statusCode, error: errorMessage, reconnectDelayMs: delay }, 'WhatsApp connection closed; retry scheduled')
                clearTimeout(reconnectTimer)
                reconnectTimer = setTimeout(() => startSocket().catch((error) => { lastError = error.message }), delay)
            }
        }
    })
    currentSocket.ev.on('messages.upsert', ({ messages: incoming, type }) => {
        for (const message of incoming) {
            if (message.key?.remoteJid === 'status@broadcast') {
                rememberStatus(message)
                record('status', { detail: `Status update from ${message.key.fromMe ? 'You' : message.pushName || 'Contact'}` })
                continue
            }
            rememberMessage(message, { countUnread: type === 'notify' })
            record(message.key?.fromMe ? 'sent' : 'received', safeMessage(message))
            appLogger.debug({ direction: message.key?.fromMe ? 'outgoing' : 'incoming', kind: Object.keys(message.message || {})[0] || 'message' }, 'WhatsApp message event')
        }
    })
    currentSocket.ev.on('messaging-history.set', ({ chats: historyChats, messages: historyMessages, progress }) => {
        for (const chat of historyChats || []) {
            if (!chat.id) continue
            upsertChat(chat)
        }
        for (const message of historyMessages || []) rememberMessage(message)
        historyProgress = typeof progress === 'number' ? progress : historyProgress
    })
    currentSocket.ev.on('chats.upsert', (updates) => {
        for (const chat of updates) upsertChat(chat)
    })
    currentSocket.ev.on('chats.update', (updates) => {
        for (const chat of updates) upsertChat(chat)
    })
    currentSocket.ev.on('chats.delete', (jids) => {
        for (const jid of jids) {
            chats.delete(jid)
            database.prepare('DELETE FROM chats WHERE id = ?').run(jid)
        }
    })
    currentSocket.ev.on('contacts.upsert', (contacts) => {
        for (const contact of contacts) {
            if (!contact.id) continue
            const contactName = contact.name || contact.notify || contact.verifiedName
            if (contactName) contactNames.set(contact.id, contactName)
            const existing = chats.get(contact.id)
            if (existing) upsertChat({ ...existing, id: contact.id, name: contactName || existing.name })
        }
    })
    currentSocket.ev.on('contacts.update', (updates) => {
        for (const contact of updates) {
            if (!contact.id) continue
            const contactName = contact.name || contact.notify || contact.verifiedName
            if (contactName) contactNames.set(contact.id, contactName)
            if (!contactName) continue
            const existing = chats.get(contact.id)
            if (existing) upsertChat({ ...existing, id: contact.id, name: contactName })
        }
    })
    currentSocket.ev.on('groups.upsert', (groups) => {
        for (const group of groups) upsertChat({ id: group.id, name: group.subject, subject: group.subject })
    })
    currentSocket.ev.on('groups.update', (updates) => {
        for (const group of updates) upsertChat({ ...group, name: group.subject || chats.get(group.id)?.name })
    })
    currentSocket.ev.on('call', (incomingCalls) => {
        for (const call of incomingCalls) {
            calls.set(call.id, { id: call.id, from: call.from, status: call.status, date: new Date().toISOString() })
            record('call', { detail: `Incoming call ${call.status} from ${call.from}` })
            appLogger.warn({ status: call.status }, 'WhatsApp call event')
        }
    })
    currentSocket.ev.on('presence.update', ({ id, presences }) => {
        record('presence', { jid: id, detail: JSON.stringify(presences).slice(0, 300) })
    })
}

app.get('/api/state', (_req, res) => {
    res.json({
        connection,
        qr: qrDataUrl,
        pairingCode,
        pairingPending: Boolean(pairingNumber || pairingRequest),
        error: lastError,
        user: user ? { id: user.id, name: user.name, platform: user.platform } : null,
        historyProgress,
        callEvents: [...calls.values()].slice(-10),
        chatCount: chats.size,
    })
})

app.get('/api/activity', (req, res) => {
    const after = Number(req.query.after || 0)
    res.json({ items: activities.filter((item) => item.id > after).slice(-100) })
})

app.post('/api/sync/chats', asyncRoute(async (_req, res) => {
    const groupsSynced = await syncParticipatingGroups(requireSocket())
    sendResult(res, { chats: chats.size, groupsSynced, historyProgress })
}))

app.post('/api/connect', asyncRoute(async (_req, res) => {
    lastError = null
    await startSocket()
    sendResult(res, { connection })
}))

app.post('/api/session/reset', asyncRoute(async (_req, res) => {
    if (connection !== 'close') {
        throw Object.assign(new Error('Disconnect WhatsApp before clearing the saved session.'), { status: 409 })
    }
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    await fs.rm(authDirectory, { recursive: true, force: true })
    authState = null
    sock = null
    qrDataUrl = null
    pairingCode = null
    pairingNumber = null
    pairingRequest = null
    latestQr = null
    lastError = null
    user = null
    reconnectAttempts = 0
    resetUnregisteredAuthOnce = false
    await startSocket()
    sendResult(res, { connection })
}))

app.post('/api/pairing', asyncRoute(async (req, res) => {
    const phone = String(req.body.phone || '').replace(/\D/g, '')
    if (!/^\d{7,15}$/.test(phone)) throw Object.assign(new Error('Include country code; enter digits only.'), { status: 400 })
    if (pairingNumber || pairingRequest) {
        throw Object.assign(new Error('A pairing request is already in progress. Wait for its code before trying again.'), { status: 409 })
    }
    if (authState?.creds.registered && connection === 'open') {
        throw Object.assign(new Error('This WhatsApp session is already linked.'), { status: 409 })
    }
    pairingNumber = phone
    pairingCode = null
    pairingRequest = null
    lastError = null
    if (latestQr && sock && !authState?.creds.registered) {
        pairingNumber = null
        pairingRequest = sock.requestPairingCode(phone)
        pairingCode = await pairingRequest
        pairingRequest = null
        qrDataUrl = null
        latestQr = null
        return sendResult(res, { code: pairingCode })
    }
    await startSocket()
    if (authState?.creds.registered) throw Object.assign(new Error('This session is already registered.'), { status: 409 })
    sendResult(res, { pending: true })
}))

app.post('/api/send', upload.single('file'), asyncRoute(async (req, res) => {
    const socket = requireSocket()
    const to = await resolveRecipient(req.body.to)
    const kind = String(req.body.kind || (req.file ? 'media' : 'text'))
    const text = String(req.body.text || '').slice(0, 4000)
    const caption = String(req.body.caption || text).slice(0, 1024)
    const options = {}
    if (req.body.viewOnce === 'true') options.viewOnce = true
    let content

    if (kind === 'poll') {
        const choices = parseList(req.body.options)
        if (!text || choices.length < 2) throw Object.assign(new Error('A poll needs a question and at least two options.'), { status: 400 })
        content = { poll: { name: text, values: choices.slice(0, 12), selectableCount: 1 } }
    } else if (kind === 'location') {
        const latitude = Number(req.body.latitude)
        const longitude = Number(req.body.longitude)
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
            throw Object.assign(new Error('Enter valid latitude and longitude.'), { status: 400 })
        }
        content = { location: { degreesLatitude: latitude, degreesLongitude: longitude, name: text || undefined } }
    } else if (kind === 'contact') {
        const contactName = String(req.body.contactName || '').trim()
        const phone = String(req.body.contactPhone || '').replace(/\D/g, '')
        if (!contactName || !phone) throw Object.assign(new Error('A contact name and international phone number are required.'), { status: 400 })
        content = { contacts: { displayName: contactName, contacts: [{ vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${contactName}\nTEL;type=CELL;type=VOICE;waid=${phone}:+${phone}\nEND:VCARD` }] } }
    } else if (req.file) {
        const mimetype = req.file.mimetype || 'application/octet-stream'
        const mediaKind = req.body.mediaKind || (mimetype.startsWith('image/') ? 'image' : mimetype.startsWith('video/') ? 'video' : mimetype.startsWith('audio/') ? 'audio' : 'document')
        if (!['image', 'video', 'audio', 'document', 'sticker'].includes(mediaKind)) {
            throw Object.assign(new Error('Unsupported media type.'), { status: 400 })
        }
        content = { [mediaKind]: req.file.buffer }
        if (mediaKind !== 'audio' && mediaKind !== 'sticker' && caption) content.caption = caption
        if (mediaKind === 'audio') content.mimetype = mimetype
        if (mediaKind === 'document') content.fileName = req.file.originalname
        if (req.body.gif === 'true' && mediaKind === 'video') content.gifPlayback = true
    } else {
        if (!text) throw Object.assign(new Error('Enter a message or attach a file.'), { status: 400 })
        content = { text }
    }

    const sent = await socket.sendMessage(to, content, options)
    if (sent) rememberMessage(sent)
    record('sent', { jid: to, detail: `${kind} message sent` })
    appLogger.info({ kind }, 'WhatsApp message sent')
    sendResult(res, sent ? safeMessage(sent) : null)
}))

app.post('/api/message-action', asyncRoute(async (req, res) => {
    const socket = requireSocket()
    const jid = asJid(req.body.jid)
    const id = String(req.body.id || '')
    if (!id) throw Object.assign(new Error('Message ID is required.'), { status: 400 })
    const key = { remoteJid: jid, id, fromMe: req.body.fromMe === true || req.body.fromMe === 'true' }
    let result
    switch (req.body.action) {
        case 'edit': result = await socket.sendMessage(jid, { text: String(req.body.text || ''), edit: key }); break
        case 'delete': result = await socket.sendMessage(jid, { delete: key }); break
        case 'react': result = await socket.sendMessage(jid, { react: { text: String(req.body.emoji || ''), key } }); break
        case 'pin':
        case 'unpin': result = await socket.sendMessage(jid, { pin: { type: req.body.action === 'unpin' ? 0 : 1, time: 86400, key } }); break
        case 'read':
            result = await socket.readMessages([key])
            database.prepare('UPDATE messages SET is_read = 1 WHERE jid = ? AND id = ?').run(jid, id)
            database.prepare('UPDATE chats SET unread_count = (SELECT COUNT(*) FROM messages WHERE jid = ? AND from_me = 0 AND is_read = 0) WHERE id = ?').run(jid, jid)
            break
        case 'star':
        case 'unstar': result = await socket.chatModify({ star: { messages: [{ id, fromMe: key.fromMe }], star: req.body.action === 'star' } }, jid); break
        default: throw Object.assign(new Error('Unknown message action.'), { status: 400 })
    }
    sendResult(res, result)
}))

app.get('/api/chats', (_req, res) => {
    const items = database.prepare("SELECT * FROM chats WHERE id <> 'status@broadcast' ORDER BY pinned DESC, timestamp DESC").all()
        .map((row) => readStoredChat(row))
    res.json({ items: items.map(({ lastMessage, lastSummary, ...chat }) => ({ ...chat, lastMessage: lastSummary })) })
})

app.get('/api/status', (_req, res) => {
    const now = Math.floor(Date.now() / 1000)
    database.prepare('DELETE FROM statuses WHERE expires_at <= ?').run(now)
    const items = database.prepare('SELECT id, sender_name, timestamp, from_me, kind, text, expires_at FROM statuses WHERE expires_at > ? ORDER BY timestamp DESC').all(now)
    res.json({ items: items.map((item) => ({
        id: item.id,
        senderName: item.sender_name,
        timestamp: item.timestamp,
        fromMe: Boolean(item.from_me),
        kind: item.kind,
        text: item.text,
        expiresAt: item.expires_at,
    })) })
})

app.get('/api/chats/:jid/messages', (req, res) => {
    const jid = asJid(req.params.jid)
    const before = Number(req.query.before || 0)
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)))
    const rows = before > 0
        ? database.prepare('SELECT summary FROM messages WHERE jid = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?').all(jid, before, limit)
        : database.prepare('SELECT summary FROM messages WHERE jid = ? ORDER BY timestamp DESC LIMIT ?').all(jid, limit)
    res.json({ items: rows.map((row) => JSON.parse(row.summary)).reverse() })
})

app.post('/api/chat-action', asyncRoute(async (req, res) => {
    const socket = requireSocket()
    const jid = asJid(req.body.jid)
    const action = req.body.action
    const modification = {
        archive: { archive: true }, unarchive: { archive: false },
        pin: { pin: true }, unpin: { pin: false },
        mute: { mute: 8 * 60 * 60 * 1000 }, unmute: { mute: null },
        read: { markRead: true }, unread: { markRead: false },
        delete: { delete: true },
    }[action]
    if (!modification) throw Object.assign(new Error('Unknown chat action.'), { status: 400 })
    if (action === 'read') {
        const unread = database.prepare('SELECT key_json FROM messages WHERE jid = ? AND from_me = 0 AND is_read = 0').all(jid)
        if (unread.length) await socket.readMessages(unread.map((row) => JSON.parse(row.key_json)))
        database.prepare('UPDATE messages SET is_read = 1 WHERE jid = ?').run(jid)
        database.prepare('UPDATE chats SET unread_count = 0 WHERE id = ?').run(jid)
        const chat = chats.get(jid)
        if (chat) chats.set(jid, { ...chat, unreadCount: 0 })
        return sendResult(res, { read: unread.length })
    }
    const chat = chats.get(jid)
    if (['archive', 'unarchive', 'unread', 'delete'].includes(action) && !chat?.lastMessage) {
        throw Object.assign(new Error('The latest message is not loaded yet. Wait for history sync or fetch chat history before changing this chat.'), { status: 409 })
    }
    if (chat?.lastMessage && ['archive', 'unarchive', 'unread'].includes(action)) {
        modification.lastMessages = [chat.lastMessage]
    } else if (chat?.lastMessage && action === 'delete') {
        modification.lastMessages = [{ key: chat.lastMessage.key, messageTimestamp: chat.lastMessage.messageTimestamp }]
    }
    const result = await socket.chatModify(modification, jid)
    if (action === 'delete') {
        database.prepare('DELETE FROM messages WHERE jid = ?').run(jid)
        database.prepare('DELETE FROM chats WHERE id = ?').run(jid)
        chats.delete(jid)
        for (const key of messages.keys()) if (key.startsWith(`${jid}:`)) messages.delete(key)
    } else {
        const updates = {
            archive: { archived: true },
            unarchive: { archived: false },
            pin: { pinned: true },
            unpin: { pinned: false },
            mute: { mutedUntil: Date.now() + 8 * 60 * 60 * 1000 },
            unmute: { mutedUntil: 0 },
            unread: { unreadCount: Math.max(1, Number(chat.unreadCount || 0)) },
        }[action] || {}
        const updated = { ...chat, ...updates }
        chats.set(jid, updated)
        persistChat(updated)
    }
    sendResult(res, result)
}))

app.get('/api/groups', asyncRoute(async (_req, res) => {
    const groups = await requireSocket().groupFetchAllParticipating()
    res.json({ items: Object.values(groups).map(({ id, subject, desc, participants }) => ({ id, subject, desc, members: participants?.length || 0 })) })
}))

app.post('/api/groups', asyncRoute(async (req, res) => {
    const socket = requireSocket()
    const jid = String(req.body.jid || '')
    const participants = parseList(req.body.participants).map((entry) => asJid(entry))
    let result
    switch (req.body.action) {
        case 'create':
            if (!req.body.subject || participants.length === 0) throw Object.assign(new Error('A group name and at least one participant are required.'), { status: 400 })
            result = await socket.groupCreate(String(req.body.subject), participants)
            break
        case 'metadata': result = await socket.groupMetadata(asJid(jid)); break
        case 'participants':
            if (!participants.length || !['add', 'remove', 'promote', 'demote'].includes(req.body.operation)) throw Object.assign(new Error('Choose participants and a valid participant action.'), { status: 400 })
            result = await socket.groupParticipantsUpdate(asJid(jid), participants, req.body.operation)
            break
        case 'subject': result = await socket.groupUpdateSubject(asJid(jid), String(req.body.subject || '')); break
        case 'description': result = await socket.groupUpdateDescription(asJid(jid), String(req.body.description || '')); break
        case 'setting':
            if (!['announcement', 'not_announcement', 'locked', 'unlocked'].includes(req.body.setting)) throw Object.assign(new Error('Invalid group setting.'), { status: 400 })
            result = await socket.groupSettingUpdate(asJid(jid), req.body.setting)
            break
        case 'ephemeral': result = await socket.groupToggleEphemeral(asJid(jid), Number(req.body.seconds)); break
        case 'invite': result = `https://chat.whatsapp.com/${await socket.groupInviteCode(asJid(jid))}`; break
        case 'revoke-invite': result = `https://chat.whatsapp.com/${await socket.groupRevokeInvite(asJid(jid))}`; break
        case 'invite-info': result = await socket.groupGetInviteInfo(String(req.body.code || '').replace(/^.*chat\.whatsapp\.com\//, '')); break
        case 'join': result = await socket.groupAcceptInvite(String(req.body.code || '').replace(/^.*chat\.whatsapp\.com\//, '')); break
        case 'leave': result = await socket.groupLeave(asJid(jid)); break
        case 'member-add-mode':
            if (!['all_member_add', 'admin_add'].includes(req.body.mode)) throw Object.assign(new Error('Choose who can add members.'), { status: 400 })
            result = await socket.groupMemberAddMode(asJid(jid), req.body.mode)
            break
        case 'requests': result = await socket.groupRequestParticipantsList(asJid(jid)); break
        case 'requests-update':
            if (!participants.length || !['approve', 'reject'].includes(req.body.operation)) throw Object.assign(new Error('Choose requesters and approve or reject.'), { status: 400 })
            result = await socket.groupRequestParticipantsUpdate(asJid(jid), participants, req.body.operation)
            break
        default: throw Object.assign(new Error('Unknown group action.'), { status: 400 })
    }
    sendResult(res, result)
}))

app.post('/api/presence', asyncRoute(async (req, res) => {
    const socket = requireSocket()
    const jid = req.body.jid ? asJid(req.body.jid) : undefined
    if (req.body.action === 'subscribe') {
        if (!jid) throw Object.assign(new Error('A chat JID is required.'), { status: 400 })
        await socket.presenceSubscribe(jid)
        return sendResult(res, { subscribed: jid })
    }
    if (!['available', 'unavailable', 'composing', 'recording', 'paused'].includes(req.body.presence)) {
        throw Object.assign(new Error('Invalid presence state.'), { status: 400 })
    }
    sendResult(res, await socket.sendPresenceUpdate(req.body.presence, jid))
}))

app.get('/api/privacy', asyncRoute(async (_req, res) => {
    const socket = requireSocket()
    const [settings, blocklist] = await Promise.all([socket.fetchPrivacySettings(true), socket.fetchBlocklist()])
    res.json({ settings, blocklist })
}))

app.post('/api/privacy', asyncRoute(async (req, res) => {
    const socket = requireSocket()
    const jid = req.body.jid ? asJid(req.body.jid) : undefined
    const methods = {
        lastSeen: 'updateLastSeenPrivacy', online: 'updateOnlinePrivacy',
        profilePicture: 'updateProfilePicturePrivacy', status: 'updateStatusPrivacy',
        readReceipts: 'updateReadReceiptsPrivacy', groupsAdd: 'updateGroupsAddPrivacy',
        defaultDisappearing: 'updateDefaultDisappearingMode',
    }
    if (req.body.action === 'block' || req.body.action === 'unblock') {
        if (!jid) throw Object.assign(new Error('A phone number or JID is required.'), { status: 400 })
        return sendResult(res, await socket.updateBlockStatus(jid, req.body.action))
    }
    const method = methods[req.body.setting]
    if (!method) throw Object.assign(new Error('Unknown privacy setting.'), { status: 400 })
    const value = req.body.setting === 'defaultDisappearing' ? Number(req.body.value) : String(req.body.value)
    sendResult(res, await socket[method](value))
}))

app.post('/api/status', upload.single('file'), asyncRoute(async (req, res) => {
    const socket = requireSocket()
    const recipients = parseList(req.body.recipients).map(asJid)
    if (!recipients.length) throw Object.assign(new Error('Add at least one status recipient JID or international phone number.'), { status: 400 })
    let content
    if (req.file) {
        const mediaKind = req.file.mimetype.startsWith('video/') ? 'video' : 'image'
        content = { [mediaKind]: req.file.buffer, caption: String(req.body.text || '') }
    } else if (req.body.text) {
        content = { text: String(req.body.text).slice(0, 700) }
    } else {
        throw Object.assign(new Error('Enter status text or attach an image/video.'), { status: 400 })
    }
    const options = { statusJidList: recipients, broadcast: true }
    if (req.body.backgroundColor) options.backgroundColor = req.body.backgroundColor
    if (req.body.font) options.font = Number(req.body.font)
    const statusMessage = await socket.sendMessage('status@broadcast', content, options)
    if (statusMessage) rememberStatus(statusMessage)
    sendResult(res, statusMessage ? safeMessage(statusMessage) : null)
}))

app.post('/api/lookup', asyncRoute(async (req, res) => {
    const socket = requireSocket()
    const numbers = parseList(req.body.numbers).map((value) => {
        const jid = asJid(value)
        if (!jid.endsWith('@s.whatsapp.net')) throw Object.assign(new Error('Lookup accepts phone numbers only.'), { status: 400 })
        return jid
    })
    if (!numbers.length || numbers.length > 50) throw Object.assign(new Error('Enter between 1 and 50 numbers.'), { status: 400 })
    sendResult(res, await socket.onWhatsApp(...numbers))
}))

app.post('/api/usync/lids', asyncRoute(async (req, res) => {
    const socket = requireSocket()
    const numbers = parseList(req.body.numbers).map((value) => {
        const jid = asJid(value)
        if (!jid.endsWith('@s.whatsapp.net')) throw Object.assign(new Error('USync lookup accepts phone numbers only.'), { status: 400 })
        return jid
    })
    if (!numbers.length || numbers.length > 50) throw Object.assign(new Error('Enter between 1 and 50 numbers.'), { status: 400 })
    sendResult(res, await socket.signalRepository.lidMapping.getLIDsForPNs(numbers))
}))

app.post('/api/broadcast-info', asyncRoute(async (req, res) => {
    const jid = asJid(req.body.jid)
    if (!jid.endsWith('@broadcast')) throw Object.assign(new Error('Enter an existing broadcast-list JID.'), { status: 400 })
    sendResult(res, await requireSocket().getBroadcastListInfo(jid))
}))

app.post('/api/history', asyncRoute(async (req, res) => {
    const socket = requireSocket()
    const jid = asJid(req.body.jid)
    const oldest = database.prepare('SELECT key_json, timestamp FROM messages WHERE jid = ? ORDER BY timestamp ASC LIMIT 1').get(jid)
    if (!oldest) throw Object.assign(new Error('No cached messages for this chat; wait for history sync or receive a message first.'), { status: 404 })
    const count = Math.min(50, Math.max(1, Number(req.body.count || 25)))
    sendResult(res, await socket.fetchMessageHistory(count, JSON.parse(oldest.key_json), oldest.timestamp))
}))

app.post('/api/calls/reject', asyncRoute(async (req, res) => {
    const socket = requireSocket()
    const call = calls.get(String(req.body.id || ''))
    if (!call) throw Object.assign(new Error('Call event not found.'), { status: 404 })
    sendResult(res, await socket.rejectCall(call.id, call.from))
}))

app.get('/api/profile', asyncRoute(async (_req, res) => {
    const socket = requireSocket()
    const picture = socket.user?.id
        ? await socket.profilePictureUrl(socket.user.id).catch(() => null)
        : null
    res.json({ user: socket.user ? { id: socket.user.id, name: socket.user.name } : null, picture })
}))

app.post('/api/profile', upload.single('file'), asyncRoute(async (req, res) => {
    const socket = requireSocket()
    let result
    if (req.body.name?.trim()) result = await socket.updateProfileName(String(req.body.name).trim())
    if (req.body.status?.trim()) result = await socket.updateProfileStatus(String(req.body.status).trim())
    if (req.body.removePicture === 'true') result = await socket.removeProfilePicture(socket.user.id)
    else if (req.file) result = await socket.updateProfilePicture(socket.user.id, req.file.buffer)
    sendResult(res, result)
}))

app.use((error, _req, res, _next) => {
    const status = error.status || (error instanceof multer.MulterError ? 400 : 500)
    if (status >= 500) appLogger.error({ err: error, statusCode: status }, 'Request failed')
    else appLogger.warn({ message: error.message, statusCode: status }, 'Request rejected')
    res.status(status).json({ ok: false, error: error.message || 'Request failed.' })
})

app.listen(PORT, '127.0.0.1', () => {
    appLogger.info({ url: `http://127.0.0.1:${PORT}` }, 'Baileys dashboard listening')
    startSocket().catch((error) => {
        connection = 'close'
        lastError = error.message
        appLogger.error({ err: error }, 'WhatsApp startup failed')
    })
})