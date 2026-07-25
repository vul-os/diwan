/**
 * stack.mjs — boots the REAL stack the OS-free P2P claim depends on.
 *
 * Nothing here is mocked. It builds and runs:
 *
 *   • one `vulos-relayd` (from the sibling Ephor checkout, UNMODIFIED)
 *     with the rendezvous role enabled on a temp port, and
 *   • two STANDALONE `vulos-office` binaries — separate ports, separate data
 *     dirs, separate config files — each pointed at that relayd via
 *     `collab.rendezvous_url`, plus optionally a third with NO rendezvous
 *     configured for the negative case.
 *
 * Two SEPARATE Ofisi servers (not one server + two tabs) is the honest shape:
 * the claim is that peers collaborate with no shared document server, so the
 * two browsers must have no server in common. The only thing they share is the
 * relayd — and the room key, which travels in the invite link's URL fragment
 * and never reaches any server.
 *
 * Everything is torn down in reverse order; ports are probed rather than slept
 * on.
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Where the Ephor checkout lives. Overridable so CI (or a differently
 * laid-out working copy) can point at it explicitly. That repo is READ-ONLY
 * here: we only `go build` it to an output path OUTSIDE the checkout.
 */
export const RELAY_REPO =
  process.env.VULOS_RELAY_REPO || path.resolve(REPO_ROOT, '..', 'ephor')

/** Returns true when the relay checkout needed to run this suite is present. */
export function relayRepoAvailable() {
  return existsSync(path.join(RELAY_REPO, 'cmd', 'vulos-relayd', 'main.go'))
}

/** Reserve a free localhost port by binding and immediately releasing it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** Poll `check()` until it returns truthy or the deadline passes. No fixed sleeps. */
async function waitFor(check, { timeout = 30_000, interval = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  let lastErr
  for (;;) {
    try {
      if (await check()) return
    } catch (err) {
      lastErr = err
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}${lastErr ? `: ${lastErr.message}` : ''}`)
    }
    await new Promise((r) => setTimeout(r, interval))
  }
}

async function httpOk(url) {
  const res = await fetch(url)
  return res.ok
}

/**
 * Build the binaries under test. The relayd build writes its output into our
 * temp dir — the Ephor checkout is never modified.
 */
export async function buildBinaries(outDir) {
  const officeBin = path.join(outDir, 'vulos-office-e2e')
  // A prebuilt relayd wins when supplied: CI can build the relay once (and
  // pin its revision), and a local run is not blocked by whatever state the
  // sibling checkout happens to be in.
  const prebuilt = process.env.VULOS_RELAYD_BIN
  const relaydBin = prebuilt && existsSync(prebuilt) ? prebuilt : path.join(outDir, 'vulos-relayd')

  // The Ofisi binary embeds dist/ (go:embed), so the frontend must be built
  // first or the server would serve a stale/absent app.
  await execFileAsync('npx', ['vite', 'build'], { cwd: REPO_ROOT, timeout: 300_000, maxBuffer: 64 << 20 })
  await execFileAsync('go', ['build', '-o', officeBin, '.'], { cwd: REPO_ROOT, timeout: 300_000, maxBuffer: 64 << 20 })
  if (relaydBin !== prebuilt) {
    try {
      await execFileAsync('go', ['build', '-o', relaydBin, './cmd/vulos-relayd'], {
        cwd: RELAY_REPO, timeout: 300_000, maxBuffer: 64 << 20,
      })
    } catch (err) {
      // Be explicit about WHOSE build broke: this suite never modifies the
      // relay repo, so a compile error there is that checkout's state, not a
      // failure of the claim under test.
      throw new Error(
        `could not build vulos-relayd from ${RELAY_REPO} (this suite never modifies that repo). ` +
        `Point VULOS_RELAYD_BIN at a prebuilt binary to run anyway.\n${err.message}`,
      )
    }
  }

  return { relaydBin, officeBin }
}

function spawnLogged(bin, args, opts, name, logs) {
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  const push = (chunk) => {
    const line = chunk.toString()
    logs.push(`[${name}] ${line.trimEnd()}`)
  }
  proc.stdout.on('data', push)
  proc.stderr.on('data', push)
  proc.on('error', (err) => logs.push(`[${name}] spawn error: ${err.message}`))
  return proc
}

/**
 * Boot relayd + N standalone Ofisi instances.
 *
 * @param {object} opts
 * @param {number} [opts.offices=2]  Ofisi instances WITH the rendezvous configured
 * @param {boolean} [opts.localOnlyOffice=false] also boot one with NO rendezvous
 * @returns {Promise<object>} the live stack (URLs, logs, stop())
 */
export async function startStack({ offices = 2, localOnlyOffice = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ofisi-p2p-'))
  const logs = []
  const procs = []

  const { relaydBin, officeBin } = await buildBinaries(root)

  // ── relayd: rendezvous role on, tunnel role unused ────────────────────────
  const relayPort = await freePort()
  const relayAdminPort = await freePort()
  // No -tokens-file: relayd starts ROLE-ONLY when it is given no agent grants,
  // and its reverse-tunnel surface then authorizes nobody (an explicit deny-all
  // token store, not an empty one that might fail open). That is exactly the
  // shape this suite wants — a pure rendezvous node — and it means the tunnel
  // role cannot be what makes any assertion below pass.
  const relayd = spawnLogged(relaydBin, [
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

  const relayUrl = `http://127.0.0.1:${relayPort}`
  const relayAdminUrl = `http://127.0.0.1:${relayAdminPort}`
  await waitFor(() => httpOk(`${relayUrl}/rendezvous/healthz`), { what: 'relayd rendezvous' })

  // ── standalone Ofisi instances ────────────────────────────────────────────
  const startOffice = async (name, rendezvousUrl) => {
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
      `  rendezvous_url: "${rendezvousUrl}"`,
      '',
    ].join('\n'))

    const proc = spawnLogged(officeBin, ['-config', cfgPath], {
      cwd: dir,
      // DEPLOY_MODE stays standalone: this is exactly the bare binary the claim
      // is about — it mounts no /api/peering/*.
      env: { ...process.env, DEPLOY_MODE: 'standalone', VULOS_OFFICE_PUBLIC_URL: '' },
    }, name, logs)
    procs.push(proc)

    const url = `http://127.0.0.1:${port}`
    await waitFor(() => httpOk(`${url}/api/reachability`), { what: `${name} (${url})` })
    return { name, url, dir, port }
  }

  const officeList = []
  for (let i = 0; i < offices; i++) {
    officeList.push(await startOffice(`office${i + 1}`, relayUrl))
  }
  const localOnly = localOnlyOffice ? await startOffice('office-local-only', '') : null

  const stop = async () => {
    for (const p of procs.reverse()) {
      try { p.kill('SIGKILL') } catch { /* already gone */ }
    }
    try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  return { root, relayUrl, relayAdminUrl, offices: officeList, localOnly, logs, stop }
}

/**
 * Ask the RELAY ITSELF what it knows about a rendezvous key.
 *
 * This is the ground truth for "the signaling really went through the relayd":
 * the presence record is the relay's own soft state, written by an Ed25519-signed
 * announce, and read back here straight from the relay's origin (from Node, so no
 * CORS is involved). A client cannot fabricate it.
 *
 * Presence (rather than relayd's /metrics, which does now carry rendezvous
 * counters) is deliberate: a counter only says "some announce happened", while a
 * presence record keyed by the exact key the browser signed says THIS peer got
 * through — which is the claim under test.
 *
 * @returns {Promise<{status: number, body: any}>}
 */
export async function relayResolve(relayUrl, key) {
  const res = await fetch(`${relayUrl}/rendezvous/resolve/${encodeURIComponent(key)}`)
  let body = null
  try { body = await res.json() } catch { /* non-JSON (e.g. 404 text) */ }
  return { status: res.status, body }
}

/** Create a document on an Ofisi instance through its real HTTP API. */
export async function createDoc(officeUrl, name) {
  const res = await fetch(`${officeUrl}/api/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type: 'doc', content: { _html: '<p></p>' } }),
  })
  if (!res.ok) throw new Error(`create doc on ${officeUrl}: HTTP ${res.status} ${await res.text()}`)
  const body = await res.json()
  const id = body.id || body.file?.id || body.data?.id
  if (!id) throw new Error(`create doc on ${officeUrl}: no id in ${JSON.stringify(body)}`)
  return id
}
