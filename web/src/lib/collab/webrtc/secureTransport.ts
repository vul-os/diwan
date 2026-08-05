/**
 * secureTransport.js — Diwan's WebRTC fabric credential-transport guard (internal).
 *
 * The fabric client is a TRUST-BOUNDARY participant: it holds a short-lived
 * Bearer JWT (the box/app session token) and attaches it to two kinds of
 * outbound request —
 *
 *   • the signaling WebSocket   (signaling.js: Sec-WebSocket-Protocol / ?token=)
 *   • the relay + ICE HTTP calls (fabric.js: Authorization: Bearer …)
 *
 * If the target URL is plaintext (`ws://` / `http://`) to a non-loopback host,
 * that credential travels in the clear — readable by any on-path attacker and
 * captured in proxy / access logs. The endpoint-selection layer already gates
 * its *credentialed health probe* behind an https allowlist (endpoints.js), but
 * the signaling socket and the relay fetches had no equivalent guard: a caller
 * (or a poisoned injected endpoint) supplying `ws://evil.example` would leak the
 * token. This module is the single choke point that decides whether a URL is
 * safe to carry a credential.
 *
 * Policy (fail-closed): a credential may be attached ONLY to
 *   • same-origin / relative URLs         ('' or path-only → inherit page origin)
 *   • `wss://`  or `https://` URLs         (TLS in transit)
 *   • `ws://`   or `http://` to a LOOPBACK host (localhost / 127.0.0.0-8 / ::1)
 *     — the local-dev / self-host-behind-a-TLS-terminator escape hatch.
 * Everything else is rejected so the caller fails closed instead of leaking.
 *
 * Pure JS — no deps, safe to import from any subpath bundle.
 */

/**
 * True when `hostname` is a loopback address where plaintext is acceptable for
 * local development (the token never leaves the machine).
 *
 * @param hostname  URL.hostname (IPv6 keeps its surrounding brackets)
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = (hostname || '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '[::1]') return true
  // 127.0.0.0/8 — any 127.x.y.z is loopback.
  if (/^127(?:\.\d{1,3}){3}$/.test(h)) return true
  return false
}

/**
 * Decide whether a credential (Bearer JWT / WS token) may be attached to a
 * request bound for `rawUrl`. Fail-closed: unknown / unparseable / plaintext-
 * remote URLs return false so the caller refuses to leak the token.
 *
 * @param rawUrl  absolute URL, or '' / a relative path for same-origin
 */
export function tokenTransportSecure(rawUrl: string | null | undefined): boolean {
  // Same-origin: '' (fabric relay base default) or a relative path inherit the
  // page's own origin, which is as secure as the page the SDK loaded from.
  if (rawUrl == null || rawUrl === '') return true

  let u
  try {
    const base =
      typeof location !== 'undefined' && location.href ? location.href : undefined
    u = new URL(rawUrl, base)
  } catch {
    // Unparseable even with the page origin as base → cannot prove it is safe.
    return false
  }

  const proto = u.protocol
  if (proto === 'https:' || proto === 'wss:') return true
  if (proto === 'http:' || proto === 'ws:') return isLoopbackHost(u.hostname)
  // Any other scheme (blob:, data:, file:, javascript:, …) is never a valid
  // credentialed transport.
  return false
}
