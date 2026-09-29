import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Activity,
  Check,
  ContactRound,
  Eye,
  FileClock,
  Globe2,
  Image as ImageIcon,
  LoaderCircle,
  LockKeyhole,
  MessageSquareText,
  PhoneOff,
  Plus,
  RotateCcw,
  Send,
  Settings2,
  Users,
  X,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { getSession } from '../api'

type ToolTab = 'profile' | 'privacy' | 'groups' | 'status' | 'presence' | 'messages' | 'history' | 'lookup' | 'activity'
type Group = { id: string; subject: string; desc?: string; members: number }
const privacyOptions: Record<string, [string, string][]> = {
  lastSeen: [['all', 'Everyone'], ['contacts', 'Contacts'], ['contact_blacklist', 'Everyone except blocked'], ['none', 'Nobody']],
  online: [['all', 'Everyone'], ['match_last_seen', 'Match last seen']],
  profilePicture: [['all', 'Everyone'], ['contacts', 'Contacts'], ['contact_blacklist', 'Everyone except blocked'], ['none', 'Nobody']],
  status: [['all', 'Everyone'], ['contacts', 'Contacts'], ['contact_blacklist', 'Everyone except blocked'], ['none', 'Nobody']],
  readReceipts: [['all', 'On'], ['none', 'Off']],
  groupsAdd: [['all', 'Everyone'], ['contacts', 'Contacts'], ['contact_blacklist', 'Everyone except blocked']],
  defaultDisappearing: [['0', 'Off'], ['86400', '24 hours'], ['604800', '7 days'], ['7776000', '90 days']],
}

const tabs: { id: ToolTab; label: string; icon: typeof Settings2 }[] = [
  { id: 'profile', label: 'Profile', icon: ImageIcon },
  { id: 'privacy', label: 'Privacy', icon: LockKeyhole },
  { id: 'groups', label: 'Groups', icon: Users },
  { id: 'status', label: 'Status', icon: Eye },
  { id: 'presence', label: 'Presence', icon: Globe2 },
  { id: 'messages', label: 'Messages', icon: MessageSquareText },
  { id: 'history', label: 'History', icon: FileClock },
  { id: 'lookup', label: 'Lookup', icon: ContactRound },
  { id: 'activity', label: 'Activity', icon: Activity },
]

async function jsonRequest(url: string, options?: RequestInit) {
  const response = await fetch(url, options)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body
}

function formBody(form: HTMLFormElement, values: Record<string, string> = {}) {
  const data = new FormData(form)
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  const hasFile = [...data.values()].some((value) => value instanceof File && value.size > 0)
  return hasFile ? data : new URLSearchParams([...data.entries()].filter(([, value]) => typeof value === 'string') as [string, string][])
}

export default function ToolsPanel({ activeJid, onClose, onOpenChat }: { activeJid: string | null; onClose: () => void; onOpenChat: (jid: string) => void }) {
  const [tab, setTab] = useState<ToolTab>('profile')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [output, setOutput] = useState('')
  const [groupAction, setGroupAction] = useState('metadata')
  const [groupJid, setGroupJid] = useState(activeJid?.endsWith('@g.us') ? activeJid : '')
  const [privacySetting, setPrivacySetting] = useState('lastSeen')
  const [richKind, setRichKind] = useState('poll')
  const [profilePicture, setProfilePicture] = useState<string | null>(null)
  const { data: session } = useQuery({ queryKey: ['session'], queryFn: getSession, refetchInterval: 2000 })
  const [groups, setGroups] = useState<Group[]>([])

  useEffect(() => {
    if (tab !== 'groups' || !session || session.connection !== 'open') return
    let mounted = true
    void jsonRequest('/api/groups').then((data) => { if (mounted) setGroups(data.items || []) }).catch((cause) => { if (mounted) setError(cause.message) })
    return () => { mounted = false }
  }, [tab, session?.connection])

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try {
      const result = await action()
      setOutput(JSON.stringify(result, null, 2))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>, url: string, values: Record<string, string> = {}) {
    event.preventDefault()
    await run(() => jsonRequest(url, { method: 'POST', body: formBody(event.currentTarget, values) }))
  }

  async function loadProfile() {
    setBusy(true)
    setError('')
    try {
      const data = await jsonRequest('/api/profile')
      setProfilePicture(data.picture || null)
      setOutput(JSON.stringify(data, null, 2))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load profile')
    } finally {
      setBusy(false)
    }
  }

  function tabContent() {
    if (tab === 'profile') return (
      <div className="tool-grid">
        <form className="tool-form" onSubmit={(event) => submit(event, '/api/profile')}>
          <h3>Profile</h3>
          <div className="profile-picture-line">
            {profilePicture ? <img src={profilePicture} alt="Current WhatsApp profile" /> : <span><ImageIcon size={20} /></span>}
            <button className="secondary-button" type="button" onClick={() => void loadProfile()} disabled={busy}>Load profile</button>
          </div>
          <label>Display name<input name="name" maxLength={64} placeholder={session?.user?.name || 'Name'} /></label>
          <label>About<input name="status" maxLength={139} placeholder="About" /></label>
          <label>New profile photo<input name="file" type="file" accept="image/*" /></label>
          <div className="tool-actions"><button className="primary-button" type="submit" disabled={busy}><Check size={15} /> Save profile</button><button className="secondary-button" type="button" onClick={() => run(() => jsonRequest('/api/profile', { method: 'POST', body: new URLSearchParams({ removePicture: 'true' }) }))}>Remove photo</button></div>
        </form>
        <form className="tool-form" onSubmit={(event) => submit(event, '/api/lookup')}>
          <h3>Check WhatsApp numbers</h3>
          <label>Numbers, one per line<textarea name="numbers" rows={4} placeholder="15551234567" /></label>
          <p className="tool-hint">Checks up to 50 phone numbers through WhatsApp's contact lookup.</p>
          <button className="secondary-button" type="submit" disabled={busy}><ContactRound size={15} /> Check numbers</button>
        </form>
      </div>
    )

    if (tab === 'privacy') return (
      <div className="tool-grid">
        <form className="tool-form" onSubmit={(event) => submit(event, '/api/privacy')}>
          <h3>Privacy settings</h3>
          <label>Setting<select name="setting" value={privacySetting} onChange={(event) => setPrivacySetting(event.target.value)}><option value="lastSeen">Last seen</option><option value="online">Online visibility</option><option value="profilePicture">Profile photo</option><option value="status">Status audience</option><option value="readReceipts">Read receipts</option><option value="groupsAdd">Who can add me to groups</option><option value="defaultDisappearing">Default disappearing timer</option></select></label>
          <label>Value<select key={privacySetting} name="value">{privacyOptions[privacySetting].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <div className="tool-actions"><button className="primary-button" type="submit" disabled={busy}><Check size={15} /> Save setting</button><button className="secondary-button" type="button" onClick={() => run(() => jsonRequest('/api/privacy'))} disabled={busy}>Load current</button></div>
        </form>
        <form className="tool-form" onSubmit={(event) => submit(event, '/api/privacy')}>
          <h3>Block / unblock</h3>
          <label>Number or JID<input name="jid" placeholder="15551234567" /></label>
          <label>Action<select name="action"><option value="block">Block contact</option><option value="unblock">Unblock contact</option></select></label>
          <button className="secondary-button" type="submit" disabled={busy}>Apply block action</button>
          <button className="text-button" type="button" onClick={() => run(() => jsonRequest('/api/privacy'))}>Show current block list</button>
        </form>
      </div>
    )

    if (tab === 'groups') return (
      <div className="tool-grid">
        <form className="tool-form" onSubmit={(event) => submit(event, '/api/groups', { action: groupAction })}>
          <h3>Group administration</h3>
          <label>Action<select value={groupAction} onChange={(event) => setGroupAction(event.target.value)}><option value="metadata">Group details</option><option value="subject">Change group name</option><option value="description">Change description</option><option value="participants">Manage participants</option><option value="setting">Group permissions</option><option value="member-add-mode">Who can add members</option><option value="ephemeral">Disappearing messages</option><option value="invite">Get invite link</option><option value="revoke-invite">Revoke invite link</option><option value="invite-info">Inspect invite link</option><option value="join">Join with invite code</option><option value="leave">Leave group</option><option value="requests">List join requests</option><option value="requests-update">Approve / reject requests</option></select></label>
          {!['join', 'invite-info'].includes(groupAction) && <label>Group JID<input name="jid" value={groupJid} onChange={(event) => setGroupJid(event.target.value)} placeholder="group-id@g.us" /></label>}
          {groupAction === 'subject' && <label>New group name<input name="subject" /></label>}
          {groupAction === 'description' && <label>New description<textarea name="description" rows={3} /></label>}
          {['participants', 'requests-update'].includes(groupAction) && <label>Numbers or participant JIDs<textarea name="participants" rows={3} placeholder="15551234567" /></label>}
          {['participants', 'requests-update'].includes(groupAction) && <label>Participant operation<select name="operation">{(groupAction === 'participants' ? ['add', 'remove', 'promote', 'demote'] : ['approve', 'reject']).map((item) => <option key={item}>{item}</option>)}</select></label>}
          {groupAction === 'setting' && <label>Permission<select name="setting"><option value="announcement">Admins can send messages</option><option value="not_announcement">Everyone can send</option><option value="locked">Admins manage group info</option><option value="unlocked">Everyone manages group info</option></select></label>}
          {groupAction === 'member-add-mode' && <label>Who can add participants<select name="mode"><option value="all_member_add">All members</option><option value="admin_add">Admins only</option></select></label>}
          {groupAction === 'ephemeral' && <label>Disappearing timer<select name="seconds"><option value="0">Off</option><option value="86400">24 hours</option><option value="604800">7 days</option><option value="7776000">90 days</option></select></label>}
          {['join', 'invite-info'].includes(groupAction) && <label>Invite link or code<input name="code" /></label>}
          <button className="primary-button" type="submit" disabled={busy}><Users size={15} /> Run group action</button>
        </form>
        <section className="tool-form">
          <div className="tool-section-heading"><h3>Your groups</h3><button className="secondary-button" type="button" onClick={() => run(async () => { const data = await jsonRequest('/api/groups'); setGroups(data.items || []); return data })}><RotateCcw size={14} /> Refresh</button></div>
          <div className="tool-list">{groups.length ? groups.map((group) => <button key={group.id} type="button" onClick={() => { setGroupAction('metadata'); setGroupJid(group.id) }}><span><strong>{group.subject || 'Unnamed group'}</strong><small>{group.members} participants · {group.id}</small></span><Plus size={14} /></button>) : <p className="tool-hint">Load groups to see your participating groups.</p>}</div>
          <form className="tool-subform" onSubmit={(event) => submit(event, '/api/groups', { action: 'create' })}>
            <h3>Create a group</h3>
            <label>Group name<input name="subject" required /></label>
            <label>Participants<textarea name="participants" rows={2} required placeholder="Numbers separated by commas" /></label>
            <button className="secondary-button" type="submit" disabled={busy}><Plus size={14} /> Create group</button>
          </form>
        </section>
      </div>
    )

    if (tab === 'status') return (
      <div className="tool-grid">
        <form className="tool-form" onSubmit={(event) => submit(event, '/api/status')}>
          <h3>Publish a WhatsApp status</h3>
          <label>Audience numbers or JIDs<textarea name="recipients" rows={3} placeholder="15551234567, 447700900000" /></label>
          <label>Status text / caption<textarea name="text" rows={3} maxLength={700} /></label>
          <label>Photo or video<input name="file" type="file" accept="image/*,video/*" /></label>
          <div className="form-row"><label>Text background<input name="backgroundColor" type="color" defaultValue="#13805e" /></label><label>Font<select name="font"><option value="0">Classic</option><option value="1">Modern</option><option value="2">Typewriter</option></select></label></div>
          <button className="primary-button" type="submit" disabled={busy}><Send size={15} /> Publish status</button>
        </form>
        <div className="tool-form"><h3>Broadcast lists</h3><p className="tool-hint">Send regular messages to an existing broadcast-list JID. WhatsApp does not expose creating broadcast lists through Baileys.</p><form onSubmit={(event) => { event.preventDefault(); const jid = new FormData(event.currentTarget).get('jid')?.toString().trim(); if (jid) onOpenChat(jid) }}><label>Broadcast list JID<input name="jid" placeholder="list-id@broadcast" /></label><button className="secondary-button" type="submit"><Plus size={14} /> Open recipient</button></form><form onSubmit={(event) => submit(event, '/api/broadcast-info')}><label>Inspect broadcast list<input name="jid" placeholder="list-id@broadcast" /></label><button className="secondary-button" type="submit" disabled={busy}>Get list information</button></form></div>
      </div>
    )

    if (tab === 'presence') return (
      <div className="tool-grid">
        <form className="tool-form" onSubmit={(event) => submit(event, '/api/presence')}>
          <h3>Presence</h3>
          <label>Chat JID (optional)<input name="jid" defaultValue={activeJid || ''} placeholder="number@s.whatsapp.net" /></label>
          <label>State<select name="presence"><option>available</option><option>unavailable</option><option>composing</option><option>recording</option><option>paused</option></select></label>
          <button className="primary-button" type="submit" disabled={busy}><Globe2 size={15} /> Set presence</button>
        </form>
        <form className="tool-form" onSubmit={(event) => submit(event, '/api/presence', { action: 'subscribe' })}>
          <h3>Presence subscription</h3>
          <label>Contact or group JID<input name="jid" defaultValue={activeJid || ''} placeholder="number@s.whatsapp.net" /></label>
          <p className="tool-hint">Subscribe to availability and typing updates for this chat.</p>
          <button className="secondary-button" type="submit" disabled={busy}>Subscribe</button>
        </form>
      </div>
    )

    if (tab === 'messages') return (
      <div className="tool-grid">
        <form className="tool-form" onSubmit={(event) => submit(event, '/api/send', { kind: richKind })}>
          <h3>Rich messages</h3>
          <label>Recipient number, group, or broadcast JID<input name="to" defaultValue={activeJid || ''} placeholder="number@s.whatsapp.net" /></label>
          <label>Message type<select value={richKind} onChange={(event) => setRichKind(event.target.value)}><option value="poll">Poll</option><option value="location">Location</option><option value="contact">Contact card</option></select></label>
          {richKind === 'poll' && <><label>Question<input name="text" /></label><label>Options, one per line<textarea name="options" rows={4} placeholder="First option&#10;Second option" /></label></>}
          {richKind === 'location' && <><label>Map label<input name="text" /></label><div className="form-row"><label>Latitude<input name="latitude" type="number" step="any" /></label><label>Longitude<input name="longitude" type="number" step="any" /></label></div></>}
          {richKind === 'contact' && <><label>Contact name<input name="contactName" /></label><label>Phone number<input name="contactPhone" inputMode="tel" /></label></>}
          <button className="primary-button" type="submit" disabled={busy}><Send size={15} /> Send rich message</button>
        </form>
        <form className="tool-form" onSubmit={(event) => submit(event, '/api/message-action')}>
          <h3>Message actions</h3>
          <label>Chat JID<input name="jid" defaultValue={activeJid || ''} /></label>
          <label>Message ID<input name="id" required /></label>
          <label className="check-line"><input type="checkbox" name="fromMe" value="true" /> Sent by this account</label>
          <label>Action<select name="action"><option value="react">React</option><option value="edit">Edit text</option><option value="delete">Delete for everyone</option><option value="pin">Pin message</option><option value="unpin">Unpin message</option><option value="read">Mark read</option><option value="star">Star message</option><option value="unstar">Unstar message</option></select></label>
          <label>Replacement text<input name="text" placeholder="Edited message" /></label>
          <label>Reaction emoji<input name="emoji" placeholder="👍" /></label>
          <button className="secondary-button" type="submit" disabled={busy}><MessageSquareText size={15} /> Apply action</button>
        </form>
        <form className="tool-form" onSubmit={(event) => submit(event, '/api/chat-action')}>
          <h3>Chat actions</h3>
          <label>Chat JID<input name="jid" defaultValue={activeJid || ''} /></label>
          <label>Action<select name="action"><option value="archive">Archive</option><option value="unarchive">Unarchive</option><option value="mute">Mute 8 hours</option><option value="unmute">Unmute</option><option value="pin">Pin chat</option><option value="unpin">Unpin chat</option><option value="read">Mark read</option><option value="unread">Mark unread</option><option value="delete">Delete chat</option></select></label>
          <button className="secondary-button" type="submit" disabled={busy}><Settings2 size={15} /> Apply chat action</button>
        </form>
      </div>
    )

    if (tab === 'history') return (
      <div className="tool-grid">
        <form className="tool-form" onSubmit={(event) => submit(event, '/api/history')}>
          <h3>Fetch older messages</h3>
          <label>Chat JID<input name="jid" defaultValue={activeJid || ''} /></label>
          <label>Messages to request<select name="count"><option value="25">25</option><option value="50">50</option></select></label>
          <p className="tool-hint">Older messages arrive through WhatsApp sync and are stored locally in this chat database.</p>
          <button className="primary-button" type="submit" disabled={busy}><FileClock size={15} /> Fetch history</button>
        </form>
        <form className="tool-form" onSubmit={(event) => submit(event, '/api/chat-action')}>
          <h3>Clear or organize a chat</h3>
          <label>Chat JID<input name="jid" defaultValue={activeJid || ''} /></label>
          <label>Action<select name="action"><option value="archive">Archive</option><option value="mute">Mute</option><option value="pin">Pin</option><option value="delete">Delete chat</option></select></label>
          <button className="secondary-button" type="submit" disabled={busy}>Apply</button>
        </form>
      </div>
    )

    if (tab === 'lookup') return (
      <div className="tool-grid">
        <form className="tool-form" onSubmit={(event) => submit(event, '/api/lookup')}>
          <h3>WhatsApp contact lookup</h3>
          <label>Phone numbers<textarea name="numbers" rows={5} placeholder="15551234567" /></label>
          <p className="tool-hint">Enter up to 50 numbers with country code, one per line.</p>
          <button className="primary-button" type="submit" disabled={busy}><ContactRound size={15} /> Look up numbers</button>
        </form>
        <form className="tool-form" onSubmit={(event) => submit(event, '/api/usync/lids')}>
          <h3>Resolve phone numbers to LIDs</h3>
          <label>Phone numbers<textarea name="numbers" rows={5} placeholder="15551234567" /></label>
          <p className="tool-hint">Uses Baileys’ high-level USync mapping helper. WhatsApp does not expose a general reverse lookup for LIDs.</p>
          <button className="secondary-button" type="submit" disabled={busy}><ContactRound size={15} /> Resolve identifiers</button>
        </form>
      </div>
    )

    const calls = session?.callEvents || []
    return (
      <div className="tool-grid">
        <section className="tool-form"><h3>Recent events</h3><button className="secondary-button" type="button" onClick={() => run(() => jsonRequest('/api/activity'))}><Activity size={15} /> Load activity</button><p className="tool-hint">Connection, presence, and message events from this session.</p></section>
        <section className="tool-form"><h3>Calls</h3>{calls.length ? calls.map((call) => <div className="tool-call" key={call.id}><span>{call.status} · {call.from}</span><button className="secondary-button" type="button" onClick={() => run(() => jsonRequest('/api/calls/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: call.id }) }))}><PhoneOff size={14} /> Reject</button></div>) : <p className="tool-hint">No recent call events. Baileys can reject incoming calls but cannot carry call audio.</p>}</section>
      </div>
    )
  }

  return (
    <div className="dialog-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="tools-dialog" role="dialog" aria-modal="true" aria-labelledby="tools-title">
        <header className="dialog-header"><div><span className="eyebrow">WHATSAPP DESK</span><h2 id="tools-title">Account & tools</h2></div><button className="icon-button" type="button" aria-label="Close account tools" onClick={onClose}><X size={19} /></button></header>
        <nav className="tool-tabs" aria-label="Account and chat tools">
          {tabs.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'selected' : ''} type="button" onClick={() => { setTab(id); setError(''); setOutput('') }}><Icon size={14} />{label}</button>)}
        </nav>
        <div className="tools-content" key={tab}>
          {!session || session.connection !== 'open' ? <p className="tool-connect-notice">Connect WhatsApp to use these controls.</p> : tabContent()}
          {busy && <span className="tool-busy"><LoaderCircle className="spin" size={15} />Working…</span>}
          {error && <p className="inline-error" role="alert">{error}</p>}
          {output && <pre className="tool-result">{output}</pre>}
        </div>
      </section>
    </div>
  )
}
