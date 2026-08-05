// no-broker-dep:allow-file: names vulos-relayd/Pier describing the OPTIONAL 'external relay'
// topology this harness can boot for testing — RendezvousURL defaults empty (verified by
// backend/config/config_test.go's TestDefault_RendezvousURLEmpty); the 'builtin' topology is
// the default and needs no relay binary at all.
/**
 * stack.ts — boots the REAL stack the peer-to-peer claim depends on.
 *
 * Nothing here is mocked. Two topologies are supported, and the DEFAULT is the
 * one that matters most:
 *
 *   • 'builtin' (default) — ONE standalone `diwan` binary, serving its OWN
 *     peer-discovery surface at /api/rendezvous/* (backend/rendezvous). Two
 *     browsers load that one server and collaborate peer-to-peer through it. This
 *     is the shape an operator actually deploys: one binary, one VPS, no other
 *     product involved at all. It needs no external checkout, no external
 *     binary, and no network beyond loopback — so it ALWAYS runs and can never be
 *     silently skipped.
 *
 *     "One shared server" is not a weaker claim than the two-server shape below,
 *     it is a different one. What the two-server shape proved was that no
 *     DOCUMENT server sits between the peers. Here that is proved differently and
 *     just as concretely: the room key lives in the invite link's URL fragment and
 *     never reaches the server, so every discovery payload it handles is
 *     ciphertext it cannot read, and the edits themselves are asserted to have
 *     crossed a direct WebRTC data channel.
 *
 *   • 'external' — two standalone `diwan` binaries (separate ports, separate data
 *     dirs) with their built-in surface DISABLED, both pointed at a separately
 *     supplied `vulos-relayd` (Pier) via `collab.rendezvous_url`. This proves the
 *     other supported posture: discovery delegated to an operator's own relay,
 *     with nothing of ours in the discovery path at all.
 *
 *     It requires a PREBUILT relayd binary in VULOS_RELAYD_BIN. This module does
 *     NOT clone, fetch or build anything from another repository. A test that
 *     pulls a moving external repo at run time is not a test of this repo: when
 *     that repo was renamed (`vulos-relay` → `ephor`) the job started failing for
 *     a reason that had nothing to do with the code under test, while the claim it
 *     was supposed to guard went unchecked.
 *
 * Everything is torn down in reverse order; ports are probed rather than slept on.
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Diwan's own built-in rendezvous mount prefix — must match
 * backend/rendezvous.Prefix and what GET /api/reachability advertises as
 * `builtin_rendezvous_prefix`.
 */
export const BUILTIN_PREFIX = '/api/rendezvous'

/**
 * A prebuilt `vulos-relayd`, supplied explicitly by whoever wants the 'external'
 * topology exercised. Absent by default and never inferred from a sibling
 * directory: an implicit path is how a suite ends up quietly testing whatever
 * happens to be checked out next door.
 */
export const RELAYD_BIN = process.env.VULOS_RELAYD_BIN || ''

/** True when the 'external' topology can run at all. */
export function relaydBinAvailable(): boolean {
  return !!RELAYD_BIN && existsSync(RELAYD_BIN)
}

/** Reserve a free localhost port by binding and immediately releasing it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 0
      srv.close(() => resolve(port))
    })
  })
}

interface WaitForOptions {
  timeout?: number
  interval?: number
  what?: string
}

/** Poll `check()` until it returns truthy or the deadline passes. No fixed sleeps. */
async function waitFor(check: () => Promise<boolean> | boolean, { timeout = 30_000, interval = 100, what = 'condition' }: WaitForOptions = {}): Promise<void> {
  const deadline = Date.now() + timeout
  let lastErr: Error | undefined
  for (;;) {
    try {
      if (await check()) return
    } catch (err) {
      lastErr = err as Error
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}${lastErr ? `: ${lastErr.message}` : ''}`)
    }
    await new Promise((r) => setTimeout(r, interval))
  }
}

async function httpOk(url: string): Promise<boolean> {
  const res = await fetch(url)
  return res.ok
}

export interface BuiltBinaries {
  officeBin: string
}

/**
 * Build the Diwan binary under test. The frontend is built first because the
 * binary embeds dist/ via go:embed — without it the server would serve a stale or
 * absent app and every browser assertion would be meaningless.
 */
export async function buildBinaries(outDir: string): Promise<BuiltBinaries> {
  const officeBin = path.join(outDir, 'diwan-e2e')
  await execFileAsync('npx', ['vite', 'build'], { cwd: REPO_ROOT, timeout: 300_000, maxBuffer: 64 << 20 })
  await execFileAsync('go', ['build', '-o', officeBin, '.'], { cwd: REPO_ROOT, timeout: 300_000, maxBuffer: 64 << 20 })
  return { officeBin }
}

function spawnLogged(bin: string, args: string[], opts: Parameters<typeof spawn>[2], name: string, logs: string[]): ChildProcess {
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  const push = (chunk: Buffer | string) => {
    const line = chunk.toString()
    logs.push(`[${name}] ${line.trimEnd()}`)
  }
  proc.stdout?.on('data', push)
  proc.stderr?.on('data', push)
  proc.on('error', (err) => logs.push(`[${name}] spawn error: ${err.message}`))
  return proc
}

export type RendezvousMode = 'builtin' | 'external' | 'none'

export interface StackOptions {
  rendezvous?: RendezvousMode
  offices?: number
  localOnlyOffice?: boolean
}

export interface OfficeInstance {
  name: string
  url: string
  dir: string
  port: number
  builtin: boolean
  rendezvousUrl: string
}

export interface Stack {
  root: string
  mode: RendezvousMode
  relayUrl: string
  relayAdminUrl: string
  offices: OfficeInstance[]
  localOnly: OfficeInstance | null
  logs: string[]
  stop: () => void
}

interface StartOfficeOptions {
  rendezvousUrl?: string
  builtin?: boolean
}

/**
 * Boot the stack.
 *
 *   rendezvous='builtin'  — Diwan serves discovery itself (default; no external anything)
 *   rendezvous='external' — discovery delegated to VULOS_RELAYD_BIN; built-in surface OFF
 *   rendezvous='none'     — no discovery at all (the honest local-only negative control)
 *   offices                how many Diwan instances to boot
 *   localOnlyOffice         also boot one with NO discovery
 */
export async function startStack({ rendezvous = 'builtin', offices = 1, localOnlyOffice = false }: StackOptions = {}): Promise<Stack> {
  const root = mkdtempSync(path.join(tmpdir(), 'diwan-p2p-'))
  const logs: string[] = []
  const procs: ChildProcess[] = []

  const { officeBin } = await buildBinaries(root)

  // ── optional external relayd ───────────────────────────────────────────────
  let relayUrl = ''
  let relayAdminUrl = ''
  if (rendezvous === 'external') {
    if (!relaydBinAvailable()) {
      throw new Error(
        'the external-relay topology needs a prebuilt vulos-relayd: set VULOS_RELAYD_BIN. ' +
        'This suite deliberately does not clone or build another repository.',
      )
    }
    const relayPort = await freePort()
    const relayAdminPort = await freePort()
    // No -tokens-file: relayd starts ROLE-ONLY when it is given no agent grants,
    // and its reverse-tunnel surface then authorizes nobody (an explicit deny-all
    // token store, not an empty one that might fail open). That is exactly the
    // shape this suite wants — a pure rendezvous node — and it means the tunnel
    // role cannot be what makes any assertion pass.
    const relayd = spawnLogged(RELAYD_BIN, [
      '-rendezvous',
      // The rendezvous surface is served on the relay's APEX host, so any -domain
      // that our 127.0.0.1 Host header does not match as a tunnel subdomain works.
      '-domain', 'rdv.e2e.invalid',
      '-addr', `127.0.0.1:${relayPort}`,
      '-admin-addr', `127.0.0.1:${relayAdminPort}`,
      // No public STUN: every candidate in this suite is a loopback host
      // candidate, and reaching out to a public STUN server would make the test
      // depend on internet access and add gathering latency for nothing.
      '-rendezvous-disable-public-stun',
    ], { cwd: root }, 'relayd', logs)
    procs.push(relayd)
    relayUrl = `http://127.0.0.1:${relayPort}`
    relayAdminUrl = `http://127.0.0.1:${relayAdminPort}`
    await waitFor(() => httpOk(`${relayUrl}/rendezvous/healthz`), { what: 'relayd rendezvous' })
  }

  // ── standalone Diwan instances ────────────────────────────────────────────
  const startOffice = async (name: string, { rendezvousUrl = '', builtin = false }: StartOfficeOptions = {}): Promise<OfficeInstance> => {
    const dir = path.join(root, name)
    mkdirSync(path.join(dir, 'data'), { recursive: true })
    mkdirSync(path.join(dir, 'uploads'), { recursive: true })
    const port = await freePort()
    const cfgPath = path.join(dir, 'config.yaml')
    writeFileSync(cfgPath, [
      'server:',
      `  addr: "127.0.0.1:${port}"`,
      '  data_dir: "./data"',
      '  uploads_dir: "./uploads"',
      'auth:',
      '  enabled: false',
      'storage:',
      '  type: "local"',
      'collab:',
      `  builtin_rendezvous: ${builtin ? 'true' : 'false'}`,
      `  rendezvous_url: "${rendezvousUrl}"`,
      '',
    ].join('\n'))

    const proc = spawnLogged(officeBin, ['-config', cfgPath], {
      cwd: dir,
      // DEPLOY_MODE stays standalone: this is exactly the bare binary the claim
      // is about — it mounts no /api/peering/*.
      env: { ...process.env, DEPLOY_MODE: 'standalone', DIWAN_PUBLIC_URL: '' },
    }, name, logs)
    procs.push(proc)

    const url = `http://127.0.0.1:${port}`
    try {
      await waitFor(() => httpOk(`${url}/api/reachability`), { what: `${name} (${url})` })
    } catch (err) {
      // Attach what the child process actually SAID. Without this a boot failure
      // surfaces only as "timed out waiting for office1", and the server's own
      // explanation — a port already taken, a data dir it cannot write, a config
      // it rejected — is discarded in exactly the run that needed it.
      const tail = logs.slice(-40).join('\n') || '(the process produced no output)'
      throw new Error(`${(err as Error).message}\n──── ${name} output ────\n${tail}\n────────────────────────`, { cause: err })
    }
    return { name, url, dir, port, builtin, rendezvousUrl }
  }

  const officeOpts: StartOfficeOptions = {
    builtin: rendezvous === 'builtin',
    rendezvousUrl: rendezvous === 'external' ? relayUrl : '',
  }
  const officeList: OfficeInstance[] = []
  for (let i = 0; i < offices; i++) {
    officeList.push(await startOffice(`office${i + 1}`, officeOpts))
  }
  const localOnly = localOnlyOffice
    ? await startOffice('office-local-only', { builtin: false, rendezvousUrl: '' })
    : null

  // Not async: kill() and rmSync() are both synchronous. Stack.stop is typed
  // () => void; callers already `await stack.stop()`, which works fine on a
  // non-Promise return (await on a non-thenable just resolves immediately).
  const stop = (): void => {
    for (const p of procs.reverse()) {
      try { p.kill('SIGKILL') } catch { /* already gone */ }
    }
    try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  return { root, mode: rendezvous, relayUrl, relayAdminUrl, offices: officeList, localOnly, logs, stop }
}

export interface RendezvousResolveResult {
  status: number
  body: unknown
}

/**
 * Ask a RENDEZVOUS SERVER ITSELF what it knows about a key.
 *
 * This is the ground truth for "the signalling really went through that server":
 * the presence record is the server's own soft state, written by an
 * Ed25519-signed announce, and read back here from the server's origin (from
 * Node, so no CORS is involved). A client cannot fabricate it.
 *
 * Presence (rather than a metrics counter) is deliberate: a counter only says
 * "some announce happened", while a presence record keyed by the exact key the
 * browser signed says THIS peer got through — which is the claim under test.
 *
 * @param baseUrl origin of the rendezvous server
 * @param key base64url Ed25519 key to look up
 * @param prefix mount prefix ('/rendezvous' for relayd, '/api/rendezvous' for
 *   Diwan's built-in surface)
 */
export async function rendezvousResolve(baseUrl: string, key: string, prefix = '/rendezvous'): Promise<RendezvousResolveResult> {
  const res = await fetch(`${baseUrl}${prefix}/resolve/${encodeURIComponent(key)}`)
  let body: unknown = null
  try { body = await res.json() } catch { /* non-JSON (e.g. 404 text) */ }
  return { status: res.status, body }
}

/** Back-compat alias used by the external-relay suite. */
export function relayResolve(relayUrl: string, key: string): Promise<RendezvousResolveResult> {
  return rendezvousResolve(relayUrl, key, '/rendezvous')
}

interface CreateDocResponse {
  id?: string
  file?: { id?: string }
  data?: { id?: string }
}

/** Create a document on a Diwan instance through its real HTTP API. */
export async function createDoc(officeUrl: string, name: string): Promise<string> {
  const res = await fetch(`${officeUrl}/api/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type: 'doc', content: { _html: '<p></p>' } }),
  })
  if (!res.ok) throw new Error(`create doc on ${officeUrl}: HTTP ${res.status} ${await res.text()}`)
  const body = await res.json() as CreateDocResponse
  const id = body.id || body.file?.id || body.data?.id
  if (!id) throw new Error(`create doc on ${officeUrl}: no id in ${JSON.stringify(body)}`)
  return id
}
