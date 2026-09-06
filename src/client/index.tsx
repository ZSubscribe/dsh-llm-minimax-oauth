/**
 * Settings panel that adds a "Login with MiniMax" button + status list.
 *
 * The bundled client module is consumed by the DSH Web UI's plugin
 * discovery loader, which mounts any default-exported React component under
 * Settings → Models. We export a default React component that wires the
 * `/minimax-oauth/*` JSON endpoints exposed by the host apply() above.
 *
 * @module dsh-llm-minimax-oauth/client
 */

import { useEffect, useState } from 'react'
import type { MiniMaxProviderProfile } from './const.ts'

export interface OauthSectionProps {
  /** Optional override for the panel position relative to other Settings rows. */
  insertBefore?: string
  /** Optional override of the panel title. */
  title?: string
}

interface StatusEntry {
  provider: MiniMaxProviderProfile
  logged_in: boolean
  expires_at?: string
  error?: string
}

export default function OauthSection(props: OauthSectionProps = {}) {
  const [status, setStatus] = useState<StatusEntry[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const res = await fetch('/minimax-oauth/status')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setStatus(await res.json())
    } catch (err) {
      setError((err as Error).message)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const startLogin = async (providerId: string) => {
    setBusy(providerId)
    setError(null)
    setInfo(null)
    let openedWindow: Window | null = null
    try {
      // Phase 1: request the device code. The server returns immediately
      // (well under a second) with the verification URL + user code; the
      // server keeps polling in the background and writes the token to
      // disk the moment the user authorizes.
      const endpoint = '/minimax-oauth/start'
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(errBody.error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as { userCode: string; verificationUri: string; expiresAt: number }

      // Open the browser from the client (DSH has no server-side
      // `openExternal` in the web harness — see `vendor/cordis` and the
      // absence of any matching API in `packages/extensions`). Pop-ups are
      // best-effort; a browser blocker or an unsupported target only
      // surfaces the URL in `info`, the user can copy it.
      try {
        openedWindow = window.open(data.verificationUri, '_blank', 'noopener,noreferrer')
      } catch {
        openedWindow = null
      }
      setInfo(
        `Open ${data.verificationUri} and enter code ${data.userCode}` +
          (openedWindow === null ? ' (popup blocked — open the URL manually).' : '.'),
      )

      // Phase 2: poll /status until logged_in flips, or the device-code
      // deadline elapses. Status changes (login success, refresh error,
      // terminal failure) come back through the same endpoint.
      const deadlineMs = data.expiresAt * 1000
      while (Date.now() < deadlineMs) {
        await new Promise((r) => setTimeout(r, 2000))
        try {
          const statusRes = await fetch('/minimax-oauth/status')
          if (!statusRes.ok) continue
          const entries = (await statusRes.json()) as StatusEntry[]
          setStatus(entries)
          const entry = entries.find((e) => e.provider.id === providerId)
          if (entry?.logged_in) {
            setInfo(null)
            return
          }
          if (entry?.error && entry.error !== 'not logged in') {
            // Stop polling on a terminal error; the user can read it in
            // the status card and retry.
            break
          }
        } catch {
          // transient — keep polling
        }
      }
      setError('Login flow did not complete before the device code expired.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
      // Close the popup only if we opened it AND it is still a blank
      // about: page (the user never navigated); otherwise the user is
      // still authorizing inside the popup and we must not close it.
      if (openedWindow !== null) {
        try {
          if (openedWindow.location.href === 'about:blank') openedWindow.close()
        } catch {
          // cross-origin — leave it alone
        }
      }
    }
  }

  const logout = async (providerId: string) => {
    setBusy(providerId)
    try {
      await fetch('/minimax-oauth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      })
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>{props.title ?? 'MiniMax (Global OAuth)'}</h3>
        <button onClick={refresh} disabled={!!busy}>
          Refresh
        </button>
      </header>
      {error && <div role="alert" style={{ color: 'crimson' }}>{error}</div>}
      {info && <div role="status" style={{ padding: 8, background: '#eef' }}>{info}</div>}
      {status.map((entry) => (
        <article
          key={entry.provider.id}
          style={{
            border: '1px solid var(--border, #ccc)',
            borderRadius: 6,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>{entry.provider.label}</strong>
            <span style={{ fontSize: 12, opacity: 0.7 }}>
              {entry.logged_in ? `logged in · expires ${entry.expires_at}` : 'not logged in'}
            </span>
          </div>
          {entry.error && <div style={{ color: 'crimson', fontSize: 12 }}>{entry.error}</div>}
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            OAuth: <code>{entry.provider.oauthBaseUrl}</code>
            <br />
            Inference: <code>{entry.provider.inferenceBaseUrl}</code>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {entry.logged_in ? (
              <button onClick={() => logout(entry.provider.id)} disabled={!!busy}>
                {busy === entry.provider.id ? 'Working…' : 'Log out'}
              </button>
            ) : (
              <button onClick={() => startLogin(entry.provider.id)} disabled={!!busy}>
                {busy === entry.provider.id ? 'Waiting for browser…' : 'Login with MiniMax'}
              </button>
            )}
          </div>
        </article>
      ))}
    </section>
  )
}
