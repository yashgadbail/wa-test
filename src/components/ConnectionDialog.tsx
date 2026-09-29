import { useEffect, useState } from 'react'
import { Check, LoaderCircle, QrCode, RotateCcw, Smartphone, X } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getSession, requestPairing, requestQr, resetSession } from '../api'
import { useAppState } from '../state'

type Props = { onClose: () => void }

export default function ConnectionDialog({ onClose }: Props) {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<'qr' | 'phone'>('qr')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const phone = useAppState((state) => state.pairingPhone)
  const setPhone = useAppState((state) => state.setPairingPhone)
  const { data: session } = useQuery({ queryKey: ['session'], queryFn: getSession, refetchInterval: 1200 })

  useEffect(() => {
    if (session?.qr) setMode('qr')
  }, [session?.qr])

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try {
      await action()
      await queryClient.invalidateQueries({ queryKey: ['session'] })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleReset() {
    if (!window.confirm('Clear the saved WhatsApp session on this computer? You will need to link this device again.')) return
    await run(resetSession)
  }

  const connected = session?.connection === 'open'
  const waiting = session?.pairingPending && !session?.pairingCode

  return (
    <div className="dialog-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title">
        <header className="dialog-header">
          <div><span className="eyebrow">DEVICE</span><h2 id="connection-title">WhatsApp connection</h2></div>
          <button className="icon-button" type="button" aria-label="Close connection settings" onClick={onClose}><X size={19} /></button>
        </header>
        {connected ? (
          <div className="linked-state"><span className="linked-mark"><Check size={20} /></span><div><strong>Connected</strong><small>{session?.user?.name || session?.user?.id}</small></div></div>
        ) : (
          <>
            <div className="mode-tabs" role="tablist" aria-label="Link method">
              <button className={mode === 'qr' ? 'selected' : ''} type="button" onClick={() => setMode('qr')}><QrCode size={15} /> QR code</button>
              <button className={mode === 'phone' ? 'selected' : ''} type="button" onClick={() => setMode('phone')}><Smartphone size={15} /> Phone number</button>
            </div>
            {mode === 'qr' ? (
              <div className="link-method">
                <div className="qr-frame">
                  {session?.qr ? <img src={session.qr} alt="WhatsApp device-link QR code" /> : waiting ? <LoaderCircle className="spin" size={28} /> : <QrCode size={34} strokeWidth={1.4} />}
                </div>
                <p>{session?.qr ? 'Open WhatsApp on your phone and scan this code.' : waiting ? 'Waiting for WhatsApp to prepare a fresh QR code…' : session?.error || 'Start a fresh device link to show a QR code.'}</p>
                <button className="primary-button" type="button" disabled={busy || waiting} onClick={() => run(requestQr)}>
                  {busy ? <LoaderCircle className="spin" size={16} /> : <QrCode size={16} />}
                  {waiting ? 'Preparing QR code' : 'Generate QR code'}
                </button>
              </div>
            ) : (
              <form className="link-method" onSubmit={(event) => { event.preventDefault(); void run(() => requestPairing(phone)) }}>
                <label htmlFor="pairing-phone">Phone number with country code</label>
                <input id="pairing-phone" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="15551234567" inputMode="tel" />
                {session?.pairingCode ? <div className="pairing-code" aria-live="polite">{session.pairingCode}</div> : <p>Enter the one-time code in WhatsApp under Linked Devices.</p>}
                <button className="primary-button" type="submit" disabled={busy || waiting || Boolean(session?.pairingCode) || phone.replace(/\D/g, '').length < 7}>
                  {busy || waiting ? <LoaderCircle className="spin" size={16} /> : <Smartphone size={16} />}
                  {session?.pairingCode ? 'Code ready' : waiting ? 'Request in progress' : 'Request pairing code'}
                </button>
              </form>
            )}
          </>
        )}
        {(error || session?.error) && <p className="inline-error" role="alert">{error || session?.error}</p>}
        {session?.error?.startsWith('Session logged out') && <button className="text-button" type="button" disabled={busy} onClick={() => void handleReset()}><RotateCcw size={14} /> Clear expired session</button>}
      </section>
    </div>
  )
}
