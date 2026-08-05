/**
 * Settings — the standalone self-hoster's control surface.
 *
 * Everything here is server-honest: it reads live facts from GET /api/system/info
 * (version, storage backend + data dir, auth mode, registered-user count,
 * standalone-vs-cloud integration mode, and the caller's admin status) rather
 * than hardcoding values. Sections:
 *
 *   Account      identity nameplate (editable display name), account id, mode,
 *                version, sign-out.
 *   Appearance   theme (light/dark/auto) + editor preferences.
 *   Security     auth mode (honest), self-service password change when per-user
 *                credentials exist; clear guidance otherwise.
 *   Storage      real backend (local/postgres), data + uploads dirs, object
 *                store (MinIO/S3/Tigris) status, and how to configure each.
 *   Admin        (admin only) invite tokens + audit log — the single-user
 *                self-hoster IS the admin, so this is folded into Settings.
 */

import { useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Save, Shield, Eye, EyeOff, CheckCircle2, AlertCircle, Loader2,
  Sun, Moon, Monitor, HardDrive, Server, Cloud, KeyRound,
  Database, Lock, LogOut, Folder, Boxes,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { api } from '../lib/api'
import { Button, IconButton, Input, Card, Tabs, Tooltip, useToast } from './ui'
import { useTheme } from './ui/useTheme'
import { InvitesPanel, AuditPanel } from '../apps/admin/AdminApp.jsx'

// ─── Local shape — `api.systemInfo` returns `unknown` by design; this
// documents just what this page reads. ─────────────────────────────────────
interface SystemInfo {
  account_id?: string
  version?: string
  is_admin?: boolean
  integration_mode?: string
  auth?: {
    mode?: string
    user_count?: number
  }
  storage?: {
    backend?: string
    data_dir?: string
    uploads_dir?: string
    object_store?: {
      active?: boolean
      kind?: string
      endpoint?: string
      bucket?: string
    }
  }
}

// ─── Row ─────────────────────────────────────────────────────────────────────
interface RowProps {
  label: string
  hint?: string
  children?: ReactNode
  stacked?: boolean
}

function Row({ label, hint, children, stacked }: RowProps) {
  return (
    <div className={[
      'px-5 py-4 gap-x-6 gap-y-3',
      stacked ? 'flex flex-col' : 'flex items-center justify-between flex-wrap',
    ].join(' ')}>
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink tracking-tightish">{label}</p>
        {hint && <p className="text-2xs text-ink-faint mt-0.5 leading-snug max-w-md">{hint}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}

// ─── Toggle ──────────────────────────────────────────────────────────────────
interface ToggleProps {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
}

function Toggle({ checked, onChange, label }: ToggleProps) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={[
        'relative inline-flex h-5 w-9 items-center rounded-pill transition-colors duration-base ease-out',
        'focus-visible:outline-none focus-visible:shadow-focus',
        checked ? 'bg-accent' : 'bg-line-strong',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-3.5 w-3.5 rounded-pill bg-white shadow-e1 transition-transform duration-base ease-spring',
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]',
        ].join(' ')}
      />
    </button>
  )
}

// ─── Segmented control ───────────────────────────────────────────────────────
interface SegmentedOption {
  value: string
  Icon?: LucideIcon
  label: string
}
interface SegmentedProps {
  value: string
  onChange: (v: string) => void
  options: SegmentedOption[]
}

function Segmented({ value, onChange, options }: SegmentedProps) {
  return (
    <div className="flex items-center gap-0.5 p-0.5 bg-bg-elev2 border border-line rounded-md">
      {options.map(({ value: v, Icon, label }) => {
        const active = value === v
        return (
          <Tooltip key={v} label={label} side="bottom">
            <button
              onClick={() => onChange(v)}
              aria-pressed={active}
              className={[
                'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sm text-xs font-medium capitalize',
                'tracking-tightish transition-[background,color] duration-fast ease-out',
                active ? 'bg-paper text-ink shadow-e1' : 'text-ink-faint hover:text-ink-muted',
              ].join(' ')}
            >
              {Icon && <Icon size={13} />}
              {label}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}

// ─── ThemePicker ─────────────────────────────────────────────────────────────
function ThemePicker() {
  const { theme, setTheme } = useTheme()
  return (
    <Segmented
      value={theme}
      onChange={setTheme}
      options={[
        { value: 'light',  Icon: Sun,     label: 'Light' },
        { value: 'dark',   Icon: Moon,    label: 'Dark'  },
        { value: 'system', Icon: Monitor, label: 'Auto'  },
      ]}
    />
  )
}

// ─── Mono key/value chip ─────────────────────────────────────────────────────
function Code({ children }: { children?: ReactNode }) {
  return (
    <code className="text-2xs font-mono bg-bg-elev2 text-ink-muted border border-line px-2.5 py-1 rounded-md break-all">
      {children}
    </code>
  )
}

interface PillProps {
  tone?: 'ok' | 'neutral' | 'info'
  Icon?: LucideIcon
  children?: ReactNode
}

function Pill({ tone = 'neutral', Icon, children }: PillProps) {
  const tones: Record<string, string> = {
    ok:      'text-success bg-success-bg border-success',
    neutral: 'text-ink-faint bg-bg-elev2 border-line',
    info:    'text-accent-press bg-accent-tint border-accent-tint-2',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 text-2xs font-semibold px-2.5 py-1 rounded-pill border tracking-tightish ${tones[tone]}`}>
      {Icon && <Icon size={11} />}{children}
    </span>
  )
}

// ─── Section header inside a card ────────────────────────────────────────────
function SectionLabel({ Icon, children }: { Icon?: LucideIcon; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-5 pt-4 pb-1">
      {Icon && <Icon size={13} className="text-ink-faint" />}
      <span className="mono-label">{children}</span>
    </div>
  )
}

export default function Settings() {
  const navigate = useNavigate()
  const { status, logout } = useAuthStore()
  const { showToast, toast } = useToast()

  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [infoLoading, setInfoLoading] = useState(true)
  const [tab, setTab] = useState('account')

  useEffect(() => {
    let live = true
    api.systemInfo()
      .then(d => { if (live) setInfo(d as SystemInfo) })
      .catch(() => { if (live) setInfo(null) })
      .finally(() => { if (live) setInfoLoading(false) })
    return () => { live = false }
  }, [])

  // ── App preferences (localStorage) ──────────────────────────────────────────
  const [autosaveDelay, setAutosaveDelay] = useState(() =>
    parseInt(localStorage.getItem('vulos_autosave_delay') ?? '2000'))
  const [spellcheck, setSpellcheck] = useState(() =>
    localStorage.getItem('vulos_spellcheck') !== 'false')
  const [defaultView, setDefaultView] = useState(() =>
    localStorage.getItem('vulos_default_view') ?? 'grid')

  const savePrefs = () => {
    localStorage.setItem('vulos_autosave_delay', String(autosaveDelay))
    localStorage.setItem('vulos_spellcheck', String(spellcheck))
    localStorage.setItem('vulos_default_view', defaultView)
    showToast('Preferences saved')
  }

  // ── Identity (local display name) ───────────────────────────────────────────
  interface Identity {
    displayName: string
    accountId: string
  }
  const readIdentity = (): Identity => {
    try {
      const p = JSON.parse(localStorage.getItem('presence_identity') || '{}') as Partial<Identity>
      if (p?.displayName) return p as Identity
    } catch { /* ignore */ }
    return { displayName: 'You', accountId: '' }
  }
  const [identity, setIdentity] = useState<Identity>(readIdentity)
  const [nameDraft, setNameDraft] = useState(identity.displayName)
  const accountId = info?.account_id && info.account_id !== 'self' ? info.account_id : identity.accountId

  const saveName = () => {
    const next = { ...identity, displayName: nameDraft.trim() || 'You' }
    setIdentity(next)
    try { localStorage.setItem('presence_identity', JSON.stringify(next)) } catch { /* ignore */ }
    showToast('Display name updated')
  }

  // ── Password change (per-user store) ────────────────────────────────────────
  const [curPw, setCurPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [savingPw, setSavingPw] = useState(false)

  const changePassword = async () => {
    if (!newPw || newPw !== confirmPw) {
      showToast('New passwords do not match', 'error'); return
    }
    setSavingPw(true)
    try {
      await api.changePassword(curPw, newPw)
      setCurPw(''); setNewPw(''); setConfirmPw('')
      showToast('Password updated')
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed to update password', 'error')
    } finally {
      setSavingPw(false)
    }
  }

  const authMode = info?.auth?.mode // 'disabled' | 'shared' | 'per-user'
  const isAdmin = !!info?.is_admin

  const TABS = [
    { value: 'account',    label: 'Account' },
    { value: 'appearance', label: 'Appearance' },
    { value: 'security',   label: 'Security' },
    { value: 'storage',    label: 'Storage' },
    ...(isAdmin ? [{ value: 'admin', label: 'Admin' }] : []),
  ]

  return (
    <div className="flex-1 overflow-auto bg-bg">
      {/* ── Topbar ── */}
      <div className="sticky top-0 z-10 flex items-center gap-3 px-5 h-11 bg-paper border-b border-line">
        <Tooltip label="Back" side="bottom">
          <IconButton size="sm" onClick={() => void navigate(-1)}><ArrowLeft size={15} /></IconButton>
        </Tooltip>
        <h1 className="text-sm font-semibold text-ink tracking-tightish flex-1">Settings</h1>
        <ThemePicker />
      </div>

      <div className="max-w-2xl mx-auto px-6 py-8 space-y-6">

        {/* ── Account nameplate ── */}
        <div className="flex items-center gap-4 px-5 py-4 bg-paper border border-line rounded-lg">
          <div className="w-11 h-11 rounded-full bg-accent-tint border border-accent flex items-center justify-center flex-shrink-0">
            <span className="text-base font-semibold text-accent-press select-none">
              {(identity.displayName || 'Y').slice(0, 1).toUpperCase()}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-serif text-lg text-ink leading-tight truncate">{identity.displayName}</p>
            <p className="text-2xs text-ink-faint tracking-tightish mt-0.5 truncate">
              {accountId || 'Local account'}
            </p>
          </div>
          {!infoLoading && info && (
            <Pill tone="info" Icon={info.integration_mode === 'cloud' ? Cloud : Server}>
              {info.integration_mode === 'cloud' ? 'Cloud-linked' : 'Self-hosted'}
            </Pill>
          )}
        </div>

        {/* ── Tabs ── */}
        <Card>
          <Tabs value={tab} onChange={setTab} items={TABS} />

          {/* ════ ACCOUNT ════ */}
          {tab === 'account' && (
            <div>
              <Row label="Display name" hint="Shown on presence, comments, and your cursor. Stored locally on this device.">
                <div className="flex items-center gap-2">
                  <Input value={nameDraft} onChange={e => setNameDraft(e.target.value)} size="sm" className="w-44" placeholder="Your name" />
                  <Button variant="secondary" size="sm" onClick={saveName} disabled={nameDraft.trim() === identity.displayName}>
                    <Save size={13} /> Save
                  </Button>
                </div>
              </Row>
              <div className="border-t border-line">
                <Row label="Account ID" hint="Your verified login identity on this server.">
                  <Code>{accountId || 'self (single-user)'}</Code>
                </Row>
              </div>
              <div className="border-t border-line">
                <Row label="Version" hint="The build this instance is running.">
                  <Code>{infoLoading ? '…' : (info?.version || 'unknown')}</Code>
                </Row>
              </div>
              {status?.enabled && (
                <div className="border-t border-line px-5 py-3 flex justify-end bg-bg-elev2">
                  <Button variant="destructive" size="sm" onClick={() => { void logout() }}>
                    <LogOut size={13} /> Sign out
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* ════ APPEARANCE ════ */}
          {tab === 'appearance' && (
            <div>
              <Row label="Theme" hint="Light, dark, or follow your operating system.">
                <ThemePicker />
              </Row>
              <div className="border-t border-line">
                <Row label="Autosave delay" hint="How long after you stop typing before changes are saved.">
                  <select
                    value={autosaveDelay}
                    onChange={e => setAutosaveDelay(Number(e.target.value))}
                    className="h-8 text-sm text-ink bg-paper border border-line rounded-md px-3 transition-[border-color,box-shadow] duration-fast ease-out focus:outline-none focus:border-accent focus:shadow-focus tracking-tightish"
                  >
                    <option value={1000}>1 second</option>
                    <option value={2000}>2 seconds</option>
                    <option value={3000}>3 seconds</option>
                    <option value={5000}>5 seconds</option>
                  </select>
                </Row>
              </div>
              <div className="border-t border-line">
                <Row label="Spell check" hint="Enable browser spell checking in document editors.">
                  <Toggle checked={spellcheck} onChange={setSpellcheck} label="Spell check" />
                </Row>
              </div>
              <div className="border-t border-line">
                <Row label="Default file view" hint="Grid or list view on app home pages.">
                  <Segmented
                    value={defaultView}
                    onChange={setDefaultView}
                    options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]}
                  />
                </Row>
              </div>
              <div className="border-t border-line px-5 py-3 flex justify-end bg-bg-elev2">
                <Button variant="primary" size="sm" onClick={savePrefs}>
                  <Save size={13} /> Save preferences
                </Button>
              </div>
            </div>
          )}

          {/* ════ SECURITY ════ */}
          {tab === 'security' && (
            <div>
              <Row label="Authentication" hint="How this server gates access. Configured in config.yaml.">
                {infoLoading ? (
                  <Loader2 size={14} className="animate-spin text-ink-faint" />
                ) : authMode === 'disabled' ? (
                  <Pill tone="neutral" Icon={AlertCircle}>Disabled</Pill>
                ) : authMode === 'per-user' ? (
                  <Pill tone="ok" Icon={CheckCircle2}>Per-user accounts</Pill>
                ) : (
                  <Pill tone="ok" Icon={Lock}>Shared password</Pill>
                )}
              </Row>

              {!infoLoading && authMode === 'per-user' && typeof info?.auth?.user_count === 'number' && (
                <div className="border-t border-line">
                  <Row label="Registered accounts" hint="People with their own credentials on this instance.">
                    <Code>{info.auth.user_count}</Code>
                  </Row>
                </div>
              )}

              {/* Per-user: working self-service password change */}
              {!infoLoading && authMode === 'per-user' && (
                <>
                  <SectionLabel Icon={KeyRound}>Change password</SectionLabel>
                  <div className="px-5 pb-4 pt-1 space-y-2.5">
                    <Input
                      type={showPw ? 'text' : 'password'} value={curPw}
                      onChange={e => setCurPw(e.target.value)} placeholder="Current password" size="sm"
                    />
                    <Input
                      type={showPw ? 'text' : 'password'} value={newPw}
                      onChange={e => setNewPw(e.target.value)} placeholder="New password (min 10 chars)" size="sm"
                      trailing={
                        <button type="button" onClick={() => setShowPw(v => !v)} className="text-ink-faint hover:text-ink transition-colors">
                          {showPw ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                      }
                    />
                    <Input
                      type={showPw ? 'text' : 'password'} value={confirmPw}
                      onChange={e => setConfirmPw(e.target.value)} placeholder="Confirm new password" size="sm"
                    />
                    <div className="flex justify-end pt-1">
                      <Button variant="primary" size="sm" onClick={() => void changePassword()}
                        disabled={!curPw || !newPw || savingPw}>
                        {savingPw ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                        Update password
                      </Button>
                    </div>
                  </div>
                </>
              )}

              {/* Shared / disabled: honest guidance */}
              {!infoLoading && authMode === 'shared' && (
                <div className="border-t border-line px-5 py-4">
                  <p className="text-2xs text-ink-faint leading-relaxed">
                    This instance uses a single shared password from <Code>config.yaml</Code> (<code className="font-mono">auth.password</code>).
                    Change it there and restart the server. To enable per-user accounts and self-service password
                    changes, register an account, then mint invites from the Admin tab.
                  </p>
                </div>
              )}
              {!infoLoading && authMode === 'disabled' && (
                <div className="border-t border-line px-5 py-4">
                  <p className="text-2xs text-ink-faint leading-relaxed">
                    Login is turned off — anyone who can reach this server has full access. This is fine for a
                    trusted local machine. To require a password, set <code className="font-mono">auth.enabled: true</code> in <Code>config.yaml</Code>,
                    set a strong <code className="font-mono">DIWAN_JWT_SECRET</code>, and restart.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ════ STORAGE ════ */}
          {tab === 'storage' && (
            <div>
              {infoLoading ? (
                <div className="px-5 py-8 flex justify-center"><Loader2 size={16} className="animate-spin text-ink-faint" /></div>
              ) : (
                <>
                  <Row label="File store" hint="Where documents and their version history are persisted.">
                    <Pill tone="info" Icon={info?.storage?.backend === 'postgres' ? Database : HardDrive}>
                      {info?.storage?.backend === 'postgres' ? 'PostgreSQL' : 'Local files'}
                    </Pill>
                  </Row>
                  <div className="border-t border-line">
                    <Row label="Data directory" hint="On-disk location of the local file/version store.">
                      <Code>{info?.storage?.data_dir || './data'}</Code>
                    </Row>
                  </div>
                  <div className="border-t border-line">
                    <Row label="Uploads directory" hint="Where embedded images and attachments are written.">
                      <Code>{info?.storage?.uploads_dir || './uploads'}</Code>
                    </Row>
                  </div>

                  <SectionLabel Icon={Boxes}>Object storage (blobs)</SectionLabel>
                  <div className="px-5 pb-1">
                    {info?.storage?.object_store?.active ? (
                      <div className="space-y-3 pb-3">
                        <div className="flex items-center justify-between gap-4">
                          <span className="text-sm text-ink">Backend</span>
                          <Pill tone="ok" Icon={CheckCircle2}>
                            {info.storage.object_store.kind === 'minio' ? 'MinIO / S3' : 'Tigris'} · connected
                          </Pill>
                        </div>
                        {info.storage.object_store.endpoint && (
                          <div className="flex items-center justify-between gap-4">
                            <span className="text-sm text-ink-muted">Endpoint</span>
                            <Code>{info.storage.object_store.endpoint}</Code>
                          </div>
                        )}
                        {info.storage.object_store.bucket && (
                          <div className="flex items-center justify-between gap-4">
                            <span className="text-sm text-ink-muted">Bucket</span>
                            <Code>{info.storage.object_store.bucket}</Code>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-2xs text-ink-faint leading-relaxed pb-3">
                        No object store configured — blobs are served from the local <Code>data_dir</Code>.
                        To use S3-compatible storage (MinIO / AWS S3 / Tigris), set <code className="font-mono">VULOS_MINIO_ENDPOINT</code>,
                        <code className="font-mono"> VULOS_MINIO_BUCKET</code>, and credentials, then restart. See <Code>SELFHOST.md</Code>.
                      </p>
                    )}
                  </div>

                  <div className="border-t border-line px-5 py-3 bg-bg-elev2">
                    <p className="text-2xs text-ink-faint leading-relaxed flex items-start gap-2">
                      <Folder size={12} className="mt-0.5 flex-shrink-0" />
                      Storage is configured in <code className="font-mono">config.yaml</code> and environment variables, not from this UI,
                      so configuration stays reproducible and version-controllable.
                    </p>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ════ ADMIN (admin only) ════ */}
          {tab === 'admin' && isAdmin && (
            <div className="p-5 space-y-8">
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Shield size={14} className="text-accent-press" />
                  <p className="mono-label">Invite tokens</p>
                </div>
                <InvitesPanel onError={(m: string) => m && showToast(m, 'error')} />
              </div>
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Shield size={14} className="text-accent-press" />
                  <p className="mono-label">Audit log</p>
                </div>
                <AuditPanel onError={(m: string) => m && showToast(m, 'error')} />
              </div>
            </div>
          )}
        </Card>

        <p className="text-center text-2xs text-ink-faint tracking-eyebrow uppercase pb-4">
          Diwan — open-source, self-hostable office suite
          {' · '}
          <a
            href="/licenses.txt"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-ink-muted"
          >
            Third-party licenses
          </a>
        </p>
      </div>

      {toast}
    </div>
  )
}
