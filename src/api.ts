export type SessionState = {
  connection: 'open' | 'connecting' | 'close'
  qr: string | null
  pairingCode: string | null
  pairingPending: boolean
  error: string | null
  user: { id: string; name?: string; platform?: string } | null
  historyProgress: number | null
  chatCount: number
  callEvents?: { id: string; from: string; status: string; date: string }[]
}

export type SendOptions = { viewOnce?: boolean; gif?: boolean }

export type Message = {
  id: string
  jid: string
  fromMe: boolean
  participant: string | null
  timestamp: number
  kind: string
  text: string
}

export type Chat = {
  id: string
  name: string
  timestamp: number
  unreadCount: number
  archived: boolean
  pinned: boolean
  mutedUntil: number
  lastMessage: Message | null
}

export type GroupSummary = { id: string; subject: string; desc?: string; members: number }

export type StatusEntry = {
  id: string
  senderName: string
  timestamp: number
  fromMe: boolean
  kind: string
  text: string
  expiresAt: number
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body as T
}

export const getSession = () => request<SessionState>('/api/state')
export const getChats = async () => (await request<{ items: Chat[] }>('/api/chats')).items
export const getStatuses = async () => (await request<{ items: StatusEntry[] }>('/api/status')).items
export const getGroups = async () => (await request<{ items: GroupSummary[] }>('/api/groups')).items
export const getMessages = async (jid: string) =>
  (await request<{ items: Message[] }>(`/api/chats/${encodeURIComponent(jid)}/messages?limit=100`)).items
export const syncChats = () => request<{ result: { chats: number; groupsSynced: number; historyProgress: number | null } }>('/api/sync/chats', { method: 'POST' })

export async function sendMessage(jid: string, text: string, file?: File, options: SendOptions = {}) {
  const body = new FormData()
  body.set('to', jid)
  body.set('kind', file ? 'media' : 'text')
  body.set('text', text)
  if (options.viewOnce) body.set('viewOnce', 'true')
  if (options.gif) body.set('gif', 'true')
  if (file) {
    body.set('file', file)
    body.set('mediaKind', file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'document')
  }
  return request<{ ok: boolean; result: Message }>('/api/send', { method: 'POST', body })
}

export async function requestPairing(phone: string) {
  return request('/api/pairing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ phone }),
  })
}

export const requestQr = () => request('/api/connect', { method: 'POST' })
export const resetSession = () => request('/api/session/reset', { method: 'POST' })
export const clearUnread = (jid: string) => request('/api/chat-action', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ jid, action: 'read' }),
})
