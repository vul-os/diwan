/**
 * P2PShareModal — "Share → collaborate via link (P2P)" (WAVE-25).
 *
 * The invite-flow UI for Vulos Office's secure local/P2P collaboration mode.
 * Generates rw/ro invite links for a document. Opening one of these links (route
 * /docs/collab#vp2p=…) joins the room; this modal is only the SHARER side.
 *
 * Security posture surfaced to the user (honestly):
 *   • The link contains the room key IN THE FRAGMENT — anyone it is forwarded to
 *     can join with that capability. We say so.
 *   • The relay never sees the doc: content is end-to-end encrypted under the key
 *     in the link. We say so.
 *   • To revoke, mint a new link (rotate the room key). We offer a "New room" btn.
 *
 * Availability posture (also honest): a standalone Office binary never mounts
 * `/api/peering/*` — links minted here would look real but never connect
 * anyone, UNLESS this deployment has a rendezvous URL configured
 * (config.yaml `collab.rendezvous_url` / VULOS_RENDEZVOUS_URL), in which case
 * the session runs against that relayd directly with no host box at all (see
 * transportSelection.js, docs/COLLABORATION.md §3). useP2PCollab's
 * startShare() resolves the three-way transport BEFORE minting a room and,
 * only when NEITHER is reachable, rejects instead of resolving with links —
 * so callers pass `unavailable` here rather than leaving this modal stuck on
 * "Preparing room…" forever (the previous behaviour when startShare's error
 * was simply swallowed by the caller).
 */

import { useState } from 'react'
import { Link2, Copy, Check, Eye, Pencil, Shield, RefreshCw, AlertTriangle } from 'lucide-react'
import { Modal, Button } from '../../../components/ui'

export default function P2PShareModal({ open, onClose, links, onRotate, roomId, unavailable = false }) {
  const [copied, setCopied] = useState(null) // 'rw' | 'ro' | null

  const copy = async (which, value) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(which)
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1600)
    } catch {
      // Clipboard denied (insecure context / permissions) — select fallback.
      setCopied(null)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Collaborate via link (P2P)" size="lg">
      <Modal.Body className="space-y-4">
        <p className="text-xs text-ink-muted leading-relaxed">
          Share a link to co-edit this document peer-to-peer — no cloud account or
          server needed. Edits sync directly between browsers and are{' '}
          <strong className="text-ink">end-to-end encrypted</strong>: the relay
          only ever routes ciphertext and can never read the document.
        </p>

        {unavailable ? (
          <div className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/5 px-3 py-2.5">
            <AlertTriangle size={13} className="text-danger mt-0.5 flex-shrink-0" />
            <div className="text-2xs text-ink leading-relaxed space-y-1">
              <p className="font-medium">P2P collaboration isn't available on this server.</p>
              <p className="text-ink-faint">
                This is a standalone Office deployment — it doesn't serve the peering
                fabric (<code>/api/peering/*</code>) that invite links need to connect
                peers, and no rendezvous URL is configured either. Use account-based
                sharing instead, run Office behind a Vulos OS / Ephor host, or
                (no OS or account needed) point this deployment at any self-hosted
                relayd's rendezvous URL — see docs/CONFIGURATION.md.
              </p>
            </div>
          </div>
        ) : !links ? (
          <div className="flex items-center gap-2 text-xs text-ink-faint py-6 justify-center">
            <RefreshCw size={14} className="animate-spin" />
            Preparing room…
          </div>
        ) : (
          <>
            <LinkRow
              icon={<Pencil size={13} />}
              label="Editor link"
              hint="Can read and edit"
              value={links.rwLink}
              copied={copied === 'rw'}
              onCopy={() => copy('rw', links.rwLink)}
              tone="accent"
            />
            <LinkRow
              icon={<Eye size={13} />}
              label="View-only link"
              hint="Can read live edits, cannot change the document"
              value={links.roLink}
              copied={copied === 'ro'}
              onCopy={() => copy('ro', links.roLink)}
              tone="muted"
            />

            <div className="flex items-start gap-2 rounded-md bg-bg-elev2 border border-line px-3 py-2.5">
              <Shield size={13} className="text-ink-faint mt-0.5 flex-shrink-0" />
              <div className="text-2xs text-ink-faint leading-relaxed space-y-1">
                <p>
                  Anyone with a link can join with that capability — treat links
                  like the key they are. To revoke access, start a new room; old
                  links then stop working.
                </p>
                {roomId && (
                  <p className="font-mono opacity-70">room {roomId.slice(0, 12)}…</p>
                )}
              </div>
            </div>
          </>
        )}
      </Modal.Body>
      <Modal.Footer>
        {links && onRotate && (
          <Button variant="ghost" size="sm" onClick={onRotate}>
            <RefreshCw size={13} /> New room
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={onClose}>Done</Button>
      </Modal.Footer>
    </Modal>
  )
}

function LinkRow({ icon, label, hint, value, copied, onCopy, tone }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-ink">
        <span className={tone === 'accent' ? 'text-accent-press' : 'text-ink-muted'}>{icon}</span>
        {label}
        <span className="text-2xs font-normal text-ink-faint">— {hint}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0 flex items-center gap-1.5 rounded-md border border-line bg-bg-elev2 px-2.5 py-1.5">
          <Link2 size={12} className="text-ink-faint flex-shrink-0" />
          <input
            readOnly
            value={value}
            onFocus={(e) => e.target.select()}
            className="flex-1 min-w-0 bg-transparent text-2xs font-mono text-ink-muted outline-none"
          />
        </div>
        <Button variant="secondary" size="sm" onClick={onCopy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}
