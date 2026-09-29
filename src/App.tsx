import { useEffect, useRef, useState } from 'react'
import {
  ArrowDownLeft,
  ArrowLeft,
  BellOff,
  CheckCheck,
  CircleDashed,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Smile,
  Users,
  Video,
  Wrench,
  X,
} from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { clearUnread, getChats, getGroups, getMessages, getSession, getStatuses, sendMessage, syncChats } from './api'
import type { Chat, Message, StatusEntry } from './api'
import ConnectionDialog from './components/ConnectionDialog'
import ToolsPanel from './components/ToolsPanel'
import { useAppState } from './state'

function jidLabel(jid: string) {
  if (jid === 'status@broadcast') return 'Status'
  const value = jid.split('@')[0]
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-5)}` : value
}

function titleFor(chat?: Chat | null, jid?: string | null) {
  return chat?.name || (jid ? jidLabel(jid) : 'New chat')
}

function formatTime(timestamp: number) {
  if (!timestamp) return ''
  const milliseconds = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(milliseconds))
}

function previewFor(message?: Message | null) {
  if (!message) return 'No messages yet'
  if (message.text) return message.text
  if (message.kind.includes('image')) return 'Photo'
  if (message.kind.includes('video')) return 'Video'
  if (message.kind.includes('audio')) return 'Audio message'
  if (message.kind.includes('document')) return 'Document'
  if (message.kind.includes('sticker')) return 'Sticker'
  if (message.kind.includes('location')) return 'Location'
  return 'Message'
}

function statusPreview(status: StatusEntry) {
  if (status.text) return status.text
  if (status.kind.includes('image')) return 'Photo status'
  if (status.kind.includes('video')) return 'Video status'
  if (status.kind.includes('audio')) return 'Audio status'
  return 'Status update'
}

function Avatar({ name, group = false, small = false }: { name: string; group?: boolean; small?: boolean }) {
  const initials = name.replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '•'
  return <span className={`avatar ${small ? 'avatar-small' : ''} ${group ? 'avatar-group' : ''}`} aria-hidden="true">{group ? <Users size={small ? 15 : 18} /> : initials}</span>
}

function ChatRow({ chat, active, onClick }: { chat: Chat; active: boolean; onClick: () => void }) {
  const title = titleFor(chat, chat.id)
  return (
    <button className={`chat-row ${active ? 'is-active' : ''}`} type="button" onClick={onClick}>
      <Avatar name={title} group={chat.id.endsWith('@g.us')} />
      <span className="chat-row-copy">
        <span className="chat-row-top"><strong>{title}</strong><time>{formatTime(chat.timestamp)}</time></span>
        <span className="chat-row-bottom"><span className="chat-preview">{previewFor(chat.lastMessage)}</span><span className="chat-row-indicators">{chat.pinned && <Pin size={12} aria-label="Pinned" />}{chat.mutedUntil > Date.now() && <BellOff size={12} aria-label="Muted" />}{chat.unreadCount > 0 && <span className="unread-count">{chat.unreadCount > 99 ? '99+' : chat.unreadCount}</span>}</span></span>
      </span>
    </button>
  )
}

function GroupRow({ group, onClick }: { group: { id: string; subject: string; members: number }; onClick: () => void }) {
  return (
    <button className="chat-row" type="button" onClick={onClick}>
      <Avatar name={group.subject || 'Group'} group />
      <span className="chat-row-copy"><span className="chat-row-top"><strong>{group.subject || 'Unnamed group'}</strong></span><span className="chat-row-bottom"><span className="chat-preview">{group.members} participants</span></span></span>
    </button>
  )
}

function MessageBubble({ message }: { message: Message }) {
  const incoming = !message.fromMe
  const attachment = !message.text && message.kind !== 'conversation' && message.kind !== 'extendedTextMessage'
  const label = previewFor(message)
  const kindIcon = message.kind.includes('image') ? <ImageIcon size={18} /> : message.kind.includes('video') ? <Video size={18} /> : <FileText size={18} />
  return (
    <article className={`message-row ${message.fromMe ? 'outgoing' : 'incoming'}`}>
      {incoming && <Avatar name={message.participant || message.jid} group={Boolean(message.participant)} small />}
      <div className="message-bubble">
        {attachment && <span className="message-attachment">{kindIcon}<span>{label}</span></span>}
        {message.text && <p>{message.text}</p>}
        <span className="message-meta"><time>{formatTime(message.timestamp)}</time>{message.fromMe && <CheckCheck size={14} aria-label="Sent" />}</span>
      </div>
    </article>
  )
}

function StatusRow({ status, active, onClick }: { status: StatusEntry; active: boolean; onClick: () => void }) {
  return (
    <button className={`chat-row status-row ${active ? 'is-active' : ''}`} type="button" onClick={onClick}>
      <span className="status-avatar-ring"><Avatar name={status.senderName} /></span>
      <span className="chat-row-copy"><span className="chat-row-top"><strong>{status.senderName}</strong><time>{formatTime(status.timestamp)}</time></span><span className="chat-row-bottom"><span className="chat-preview">{statusPreview(status)}</span></span></span>
    </button>
  )
}

function StatusFeed({ status, onBack }: { status: StatusEntry | null; onBack: () => void }) {
  return (
    <section className="status-feed">
      <header className="conversation-header status-header">
        <button className="icon-button back-button" type="button" aria-label="Back to statuses" onClick={onBack}><ArrowLeft size={20} /></button>
        <span className="status-avatar-ring"><Avatar name={status?.senderName || 'Status'} /></span>
        <div className="conversation-title"><strong>{status?.senderName || 'Status updates'}</strong><small>{status ? `Posted ${formatTime(status.timestamp)} · expires after 24 hours` : 'Updates from your contacts'}</small></div>
      </header>
      <div className="status-stage">
        {status ? <article className={`status-card ${status.kind.includes('image') || status.kind.includes('video') ? 'status-card-media' : ''}`}>
          {(status.kind.includes('image') || status.kind.includes('video')) && <span className="status-media-label">{status.kind.includes('image') ? <ImageIcon size={21} /> : <Video size={21} />}{statusPreview(status)}</span>}
          {status.text && <p>{status.text}</p>}
          <time>{formatTime(status.timestamp)}</time>
        </article> : <div className="status-empty"><span><CircleDashed size={30} /></span><strong>Select a status update</strong><small>Status updates expire after 24 hours.</small></div>}
      </div>
    </section>
  )
}

function NewChatDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (jid: string) => void }) {
  const [number, setNumber] = useState('')
  const [error, setError] = useState('')
  function submit(event: React.FormEvent) {
    event.preventDefault()
    const cleaned = number.trim()
    if (!cleaned) return setError('Enter an international phone number or a full chat JID.')
    const digits = cleaned.replace(/[\s()+.-]/g, '')
    if (!cleaned.includes('@') && !/^\d{7,15}$/.test(digits)) return setError('Use country code and digits only.')
    onOpen(cleaned.includes('@') ? cleaned : `${digits}@s.whatsapp.net`)
  }
  return (
    <div className="dialog-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <form className="new-chat-dialog" onSubmit={submit}>
        <header className="dialog-header"><div><span className="eyebrow">NEW CONVERSATION</span><h2>Start a chat</h2></div><button className="icon-button" type="button" aria-label="Close" onClick={onClose}><X size={19} /></button></header>
        <label htmlFor="new-chat-number">Phone number or chat JID</label>
        <input id="new-chat-number" autoFocus value={number} onChange={(event) => { setNumber(event.target.value); setError('') }} placeholder="15551234567" />
        {error && <p className="inline-error" role="alert">{error}</p>}
        <button className="primary-button" type="submit"><MessageCircle size={16} /> Open conversation</button>
      </form>
    </div>
  )
}

export default function App() {
  const queryClient = useQueryClient()
  const activeChatId = useAppState((state) => state.activeChatId)
  const setActiveChat = useAppState((state) => state.setActiveChat)
  const search = useAppState((state) => state.search)
  const setSearch = useAppState((state) => state.setSearch)
  const chatFilter = useAppState((state) => state.chatFilter)
  const setChatFilter = useAppState((state) => state.setChatFilter)
  const sidebarView = useAppState((state) => state.sidebarView)
  const setSidebarView = useAppState((state) => state.setSidebarView)
  const drafts = useAppState((state) => state.drafts)
  const setDraft = useAppState((state) => state.setDraft)
  const [showConnection, setShowConnection] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const [showNewChat, setShowNewChat] = useState(false)
  const [file, setFile] = useState<File | undefined>()
  const [viewOnce, setViewOnce] = useState(false)
  const [sendAsGif, setSendAsGif] = useState(false)
  const [mobileChatOpen, setMobileChatOpen] = useState(Boolean(activeChatId))
  const [sendError, setSendError] = useState('')
  const [syncMessage, setSyncMessage] = useState('')
  const [activeStatusId, setActiveStatusId] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const messageEnd = useRef<HTMLDivElement>(null)

  const sessionQuery = useQuery({ queryKey: ['session'], queryFn: getSession, refetchInterval: 1800 })
  const chatsQuery = useQuery({ queryKey: ['chats'], queryFn: getChats, refetchInterval: 2600 })
  const groupsQuery = useQuery({ queryKey: ['groups'], queryFn: getGroups, enabled: sidebarView === 'groups', refetchInterval: 30_000 })
  const statusesQuery = useQuery({ queryKey: ['statuses'], queryFn: getStatuses, enabled: sidebarView === 'status', refetchInterval: 5000 })
  const messagesQuery = useQuery({
    queryKey: ['messages', activeChatId],
    queryFn: () => getMessages(activeChatId!),
    enabled: Boolean(activeChatId),
    refetchInterval: 1800,
  })
  const chats = chatsQuery.data || []
  const groups = groupsQuery.data || []
  const statuses = statusesQuery.data || []
  const activeChat = chats.find((chat) => chat.id === activeChatId)
  const messages = messagesQuery.data || []
  const draft = activeChatId ? drafts[activeChatId] || '' : ''
  const connected = sessionQuery.data?.connection === 'open'

  const visibleChats = chats
    .filter((chat) => chatFilter === 'archived' ? chat.archived : chatFilter === 'unread' ? !chat.archived && chat.unreadCount > 0 : !chat.archived)
    .filter((chat) => `${titleFor(chat, chat.id)} ${chat.id} ${previewFor(chat.lastMessage)}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.timestamp - a.timestamp)
  const visibleGroups = groups.filter((group) => `${group.subject} ${group.id}`.toLowerCase().includes(search.toLowerCase()))
  const visibleStatuses = statuses.filter((status) => `${status.senderName} ${statusPreview(status)}`.toLowerCase().includes(search.toLowerCase()))
  const activeStatus = visibleStatuses.find((status) => status.id === activeStatusId) || null

  const sendMutation = useMutation({
    mutationFn: ({ jid, text, attachment, once, gif }: { jid: string; text: string; attachment?: File; once: boolean; gif: boolean }) => sendMessage(jid, text, attachment, { viewOnce: once, gif }),
    onSuccess: async (_result, variables) => {
      setDraft(variables.jid, '')
      setFile(undefined)
      setViewOnce(false)
      setSendAsGif(false)
      setSendError('')
      if (fileInput.current) fileInput.current.value = ''
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['chats'] }),
        queryClient.invalidateQueries({ queryKey: ['messages', variables.jid] }),
      ])
    },
    onError: (error) => setSendError(error instanceof Error ? error.message : 'Could not send message'),
  })
  const syncMutation = useMutation({
    mutationFn: syncChats,
    onSuccess: async ({ result }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['chats'] }),
        queryClient.invalidateQueries({ queryKey: ['groups'] }),
      ])
      setSyncMessage(`${result.groupsSynced} groups checked · ${result.chats} conversations saved`)
      window.setTimeout(() => setSyncMessage(''), 3500)
    },
    onError: (error) => setSyncMessage(error instanceof Error ? error.message : 'Could not sync chats'),
  })

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [messages.length, activeChatId])

  useEffect(() => {
    if (activeChatId && (activeChat?.unreadCount || 0) > 0 && connected) {
      void clearUnread(activeChatId).then(() => queryClient.invalidateQueries({ queryKey: ['chats'] })).catch(() => undefined)
    }
  }, [activeChatId, activeChat?.unreadCount, connected, queryClient])

  function openChat(jid: string) {
    setActiveChat(jid)
    setMobileChatOpen(true)
    setShowNewChat(false)
  }

  function submitMessage(event: React.FormEvent) {
    event.preventDefault()
    if (!activeChatId || (!draft.trim() && !file) || !connected || sendMutation.isPending) return
    sendMutation.mutate({ jid: activeChatId, text: draft.trim(), attachment: file, once: viewOnce, gif: sendAsGif })
  }

  function handleComposerKey(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  const activeTitle = titleFor(activeChat, activeChatId)
  const connectionLabel = connected ? 'Connected' : sessionQuery.data?.connection === 'connecting' ? 'Connecting' : 'Link device'

  return (
    <div className="app-frame">
      <aside className={`sidebar ${mobileChatOpen ? 'sidebar-hidden-mobile' : ''}`}>
        <header className="sidebar-header">
          <div className="brand-lockup"><span className="brand-symbol"><MessageCircle size={21} fill="currentColor" /></span><span>WhatsApp <i>Desk</i></span></div>
          <div className="sidebar-actions">
            <button className="icon-button" type="button" aria-label="New chat" title="New chat" onClick={() => setShowNewChat(true)}><Plus size={20} /></button>
            <button className="icon-button" type="button" aria-label="Sync chats" title="Sync conversations and groups" disabled={syncMutation.isPending} onClick={() => syncMutation.mutate()}>{syncMutation.isPending ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}</button>
            <button className="icon-button" type="button" aria-label="More WhatsApp features" title="Account and chat tools" onClick={() => setShowTools(true)}><Wrench size={18} /></button>
            <button className="icon-button" type="button" aria-label="Connection settings" title="Connection settings" onClick={() => setShowConnection(true)}><Settings2 size={19} /></button>
          </div>
        </header>
        <button className={`connection-strip ${connected ? 'connected' : ''}`} type="button" onClick={() => setShowConnection(true)}>
          <span className="connection-dot" />
          <span>{connectionLabel}</span>
          {sessionQuery.data?.user?.name && <small>{sessionQuery.data.user.name}</small>}
        </button>
        <div className="search-wrap"><Search size={16} /><input aria-label={sidebarView === 'chats' ? 'Search chats' : sidebarView === 'groups' ? 'Search groups' : 'Search statuses'} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={sidebarView === 'chats' ? 'Search chats or start a new one' : sidebarView === 'groups' ? 'Search groups' : 'Search status updates'} /></div>
        <div className="chat-filters view-filters" role="tablist" aria-label="Chats, groups, or status">
          <button className={sidebarView === 'chats' ? 'selected' : ''} type="button" onClick={() => { setSidebarView('chats'); setMobileChatOpen(false) }}>Chats</button>
          <button className={sidebarView === 'groups' ? 'selected' : ''} type="button" onClick={() => { setSidebarView('groups'); setMobileChatOpen(false) }}>Groups</button>
          <button className={sidebarView === 'status' ? 'selected' : ''} type="button" onClick={() => { setSidebarView('status'); setActiveStatusId(null); setMobileChatOpen(false) }}>Status</button>
        </div>
        {sidebarView === 'chats' && <div className="chat-filters" role="tablist" aria-label="Chat filter">
          <button className={chatFilter === 'all' ? 'selected' : ''} type="button" onClick={() => setChatFilter('all')}>All chats</button>
          <button className={chatFilter === 'unread' ? 'selected' : ''} type="button" onClick={() => setChatFilter('unread')}>Unread</button>
          <button className={chatFilter === 'archived' ? 'selected' : ''} type="button" onClick={() => setChatFilter('archived')}>Archived</button>
        </div>}
        {sidebarView === 'chats' && <div className="chat-list" aria-label="Conversations">
          {chatsQuery.isLoading ? <div className="list-state"><LoaderCircle className="spin" size={19} />Loading chats</div> : visibleChats.length ? visibleChats.map((chat) => <ChatRow key={chat.id} chat={chat} active={chat.id === activeChatId} onClick={() => openChat(chat.id)} />) : (
            <div className="list-state empty-list"><MessageCircle size={24} strokeWidth={1.4} /><span>{search ? 'No chats match this search.' : chatFilter === 'unread' ? 'No unread conversations.' : chatFilter === 'archived' ? 'No archived conversations.' : 'Your conversations will appear here.'}</span><button type="button" onClick={() => setShowNewChat(true)}>Start a chat <Plus size={14} /></button></div>
          )}
        </div>}
        {sidebarView === 'groups' && <div className="chat-list" aria-label="Groups">
          {groupsQuery.isLoading ? <div className="list-state"><LoaderCircle className="spin" size={19} />Loading groups</div> : visibleGroups.length ? visibleGroups.map((group) => <GroupRow key={group.id} group={group} onClick={() => { setSidebarView('chats'); openChat(group.id) }} />) : <div className="list-state empty-list"><Users size={24} /><span>{search ? 'No groups match this search.' : 'No groups found yet.'}</span><button type="button" onClick={() => syncMutation.mutate()}>Sync groups <RefreshCw size={14} /></button></div>}
        </div>}
        {sidebarView === 'status' && <div className="chat-list status-list" aria-label="Status updates">
          {statusesQuery.isLoading ? <div className="list-state"><LoaderCircle className="spin" size={19} />Loading statuses</div> : visibleStatuses.length ? visibleStatuses.map((status) => <StatusRow key={status.id} status={status} active={status.id === activeStatusId} onClick={() => { setActiveStatusId(status.id); setMobileChatOpen(true) }} />) : <div className="list-state empty-list"><CircleDashed size={24} /><span>{search ? 'No status updates match.' : 'No status updates in the last 24 hours.'}</span></div>}
        </div>}
        <footer className="sidebar-footer">
          <Avatar name={sessionQuery.data?.user?.name || 'You'} small />
          <span><strong>{sessionQuery.data?.user?.name || 'Your account'}</strong><small>{connected ? sessionQuery.data?.user?.id : 'Device not linked'}</small></span>
          <button className="icon-button" type="button" aria-label="Manage device" onClick={() => setShowConnection(true)}><MoreHorizontal size={19} /></button>
        </footer>
      </aside>

      <main className={`conversation ${mobileChatOpen ? 'conversation-visible-mobile' : ''}`}>
        {sidebarView === 'status' ? <StatusFeed status={activeStatus} onBack={() => setMobileChatOpen(false)} /> : sidebarView === 'groups' ? (
          <section className="welcome-pane"><div className="welcome-mark"><Users size={34} /></div><h1>Your groups</h1><p>Select a group from the list to open its conversation.</p><button className="welcome-link" type="button" onClick={() => syncMutation.mutate()}><RefreshCw size={14} /> Refresh groups</button></section>
        ) : activeChatId ? (
          <>
            <header className="conversation-header">
              <button className="icon-button back-button" type="button" aria-label="Back to chats" onClick={() => setMobileChatOpen(false)}><ArrowLeft size={20} /></button>
              <Avatar name={activeTitle} group={activeChatId.endsWith('@g.us')} />
              <div className="conversation-title"><strong>{activeTitle}</strong><small>{activeChatId.endsWith('@g.us') ? 'Group conversation' : activeChatId}</small></div>
              <div className="conversation-tools"><button className="icon-button" type="button" aria-label="Search this chat" title="Search chats" onClick={() => document.querySelector<HTMLInputElement>('[aria-label="Search chats"]')?.focus()}><Search size={19} /></button><button className="icon-button" type="button" aria-label="Connection settings" title="Connection settings" onClick={() => setShowConnection(true)}><MoreHorizontal size={21} /></button></div>
            </header>
            <section className="messages-pane" aria-label={`Messages with ${activeTitle}`}>
              <div className="message-date"><span>Conversation</span></div>
              {messagesQuery.isLoading ? <div className="list-state"><LoaderCircle className="spin" size={18} />Loading messages</div> : messages.length ? messages.map((message) => <MessageBubble key={`${message.jid}:${message.id}`} message={message} />) : <div className="empty-conversation"><span className="empty-conversation-icon"><MessageCircle size={25} /></span><strong>No messages here yet</strong><span>Send a message to start this conversation.</span></div>}
              <div ref={messageEnd} />
            </section>
            {sendError && <div className="composer-error" role="alert">{sendError}</div>}
            {!connected && <button className="link-warning" type="button" onClick={() => setShowConnection(true)}>{sessionQuery.data?.error || 'Link your device to send messages.'}</button>}
            <form className="composer" onSubmit={submitMessage}>
              {file && <div className="attachment-chip">{file.type.startsWith('image/') ? <ImageIcon size={16} /> : <FileText size={16} />}<span>{file.name}</span><label className="media-option"><input type="checkbox" checked={viewOnce} onChange={(event) => setViewOnce(event.target.checked)} />View once</label>{file.type.startsWith('video/') && <label className="media-option"><input type="checkbox" checked={sendAsGif} onChange={(event) => setSendAsGif(event.target.checked)} />GIF</label>}<button className="icon-button" type="button" aria-label="Remove attachment" onClick={() => { setFile(undefined); setViewOnce(false); setSendAsGif(false); if (fileInput.current) fileInput.current.value = '' }}><X size={14} /></button></div>}
              <input ref={fileInput} className="visually-hidden" type="file" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt" onChange={(event) => setFile(event.target.files?.[0])} />
              <button className="icon-button attach-button" type="button" aria-label="Attach media" title="Attach a file" onClick={() => fileInput.current?.click()}><Paperclip size={19} /></button>
              <button className="icon-button emoji-button" type="button" aria-label="Insert smile" title="Insert smile" onClick={() => setDraft(activeChatId, `${draft}🙂`)}><Smile size={19} /></button>
              <textarea aria-label="Message" rows={1} value={draft} onKeyDown={handleComposerKey} onChange={(event) => setDraft(activeChatId, event.target.value)} placeholder={connected ? 'Type a message' : 'Connect WhatsApp to send'} disabled={!connected} />
              <button className="send-button" type="submit" aria-label="Send message" disabled={!connected || (!draft.trim() && !file) || sendMutation.isPending}>
                {sendMutation.isPending ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
              </button>
            </form>
          </>
        ) : (
          <section className="welcome-pane">
            <div className="welcome-mark"><MessageCircle size={34} /></div>
            <h1>Keep the conversation going.</h1>
            <p>Your chats, synced through your linked WhatsApp device.</p>
            <button className="primary-button" type="button" onClick={() => setShowNewChat(true)}><Plus size={16} /> Start a conversation</button>
            <button className="welcome-link" type="button" onClick={() => setShowConnection(true)}><span className={`connection-dot ${connected ? 'dot-online' : ''}`} />{connectionLabel} · device settings</button>
          </section>
        )}
      </main>
      {showNewChat && <NewChatDialog onClose={() => setShowNewChat(false)} onOpen={openChat} />}
      {showConnection && <ConnectionDialog onClose={() => setShowConnection(false)} />}
      {showTools && <ToolsPanel activeJid={activeChatId} onClose={() => setShowTools(false)} onOpenChat={(jid) => { openChat(jid); setShowTools(false) }} />}
      {(sessionQuery.isError || syncMessage) && <div className="global-toast" role="alert"><ArrowDownLeft size={15} />{sessionQuery.isError ? "Can't reach the WhatsApp server." : syncMessage}</div>}
    </div>
  )
}
