# Ofisi — Troubleshooting

Symptom → cause → fix, for the problems users and admins actually hit: documents that won't sync, collaboration peers that never connect, edits that seem lost, and imports/exports that fail. Start with the [Where the logs are](#1-where-the-logs-are) section — almost every diagnosis below leans on one server log line or one browser-console message. Endpoints, log lines, and limits quoted here are the real ones from this repository.

---

## 1. Where the logs are

**Server** — everything goes to **stdout/stderr** (Go `log` + Gin request log). There is no log file.

| Deployment | Command |
|------------|---------|
| Docker | `docker logs -f vulos-office` |
| systemd | `journalctl -u <your-unit> -f` |
| Fly.io | `fly logs -c fly.toml` |
| Foreground binary | it's already on your terminal |

Startup lines worth grepping for — they announce every mode decision:

```
vulos-office <version> starting
Config error: ... — using defaults          ← config.yaml missing/unreadable
[seam] integration mode: standalone|cloud
[sso] session introspection enabled|disabled
[cors] explicit origin allowlist ... | no VULOS_OFFICE_CORS_ORIGINS set ...
[rate-limit] write/collab endpoints: token-bucket cap=30 rate=10/s per IP
[v1] API-key introspection enabled | API-key path disabled
[local-files] auth enabled (multi-tenant): local-files ... disabled
Ofisi running → http://localhost:8080
```

**Browser** — open DevTools → Console. Collaboration failures log there (e.g. `[p2p] join from link failed: …`). DevTools → Network shows the exact failing request and status code.

**Health/version** — `GET /healthz` → `{"status":"ok","version":"…"}`, `GET /version`, Prometheus at `GET /metrics`.

**Security audit** — Settings → Admin → *Audit log* (or `data/audit.db`): every share/role change/invite/registration. Signing-envelope events live under `data/audit/<envelopeID>/`.

---

## 2. Server won't start / can't be reached

| Symptom | Cause | Fix |
|---------|-------|-----|
| Boot dies with `auth is enabled but no JWT signing secret is configured` | `auth.enabled: true` without a secret | `export VULOS_OFFICE_JWT_SECRET="$(openssl rand -hex 32)"` (or `VULOS_OFFICE_DEV=1` for local dev only) |
| Boot dies with `Storage init failed` | Bad `DATABASE_URL` / unreachable Postgres / unwritable `data_dir` | Check the URL and DB reachability; ensure the process can create `./data` (in Docker the writable dirs are `/srv/data`, `/srv/uploads`) |
| Starts but you expected your config | Log shows `Config error: … — using defaults` | The server reads `config.yaml` **from its working directory**. Run it from the directory that holds the file |
| Docker build fails resolving an npm dependency | Stale `node_modules`/lockfile in the build context, or a `file:third_party/*` vendored dep out of sync with `package-lock.json` | Build from the repo root with a clean context: `docker build -t ghcr.io/vul-os/ofisi:latest .`; if it persists, delete `node_modules` and re-run `npm install` before building |
| Container healthcheck failing | App not listening on 8080 or crash-looping | `docker logs`; confirm `server.addr` and the port mapping; hit `/healthz` from inside the container |

---

## 3. Document won't sync (peer-to-peer)

Collaboration is **peer-to-peer — there is no central document server** to check. Edits travel between browsers over an E2E-encrypted WebRTC room; the only server piece is content-blind peer **discovery** at `/api/peering/*`. In the Network tab you should see a WebSocket to `/api/peering/stream` (discovery) and a WebRTC connection — and **never** a `/v1/documents/*/collab/*` request (there is none).

| Symptom | Cause | Fix |
|---------|-------|-----|
| Editor shows "Offline"; nobody else appears | This deployment has **no peering fabric** (a bare standalone Ofisi binary does not mount `/api/peering/*`) **and no rendezvous URL configured** — peers can't discover each other | Run Ofisi behind a **Vulos OS / Ephor host** (provides `/api/peering/*`), **or** set `collab.rendezvous_url` / `VULOS_RENDEZVOUS_URL` to any self-hosted `vulos-relayd` (no OS or account needed — see [CONFIGURATION.md](CONFIGURATION.md)). Your edits still autosave to your storage regardless |
| `rendezvous_url` is set, but DevTools shows the rendezvous calls failing with a **CORS** error | The browser calls the configured relayd **directly** (cross-origin). Its rendezvous role must send CORS headers — an old relayd, or a reverse proxy in front of it that strips them, breaks discovery for every user | Check it directly: `curl -i -H "Origin: https://office.example.org" https://relay.example.org/rendezvous/ice` must return `Access-Control-Allow-Origin: *` (and must NOT return `Access-Control-Allow-Credentials`). Upgrade the relayd, or stop your proxy stripping the headers |
| `rendezvous_url` is set, but the browser blocks the request as **mixed content** | An `https` Ofisi page cannot call an `http://` relay | Put TLS on the relay and set `collab.rendezvous_url` to its `https://` URL. An `http` relay only works for an `http` (e.g. LAN/dev) Ofisi |
| An invite link opens but nobody connects | Discovery unreachable (proxy dropped the `/api/peering/stream` WebSocket) **or** both peers are behind hard NATs with no TURN | Forward `Upgrade`/`Connection` on the discovery WS and keep read timeouts long; ensure the host's ICE config includes a reachable STUN and, for hard NATs, a TURN server (see [ADMIN-GUIDE.md](ADMIN-GUIDE.md) §6) |
| Two people edit the same doc but never see each other | They opened **different** rooms — each `#vp2p=` link is its own room/key | Everyone must open the **same** invite link with the fragment intact (the `#vp2p=…` part). Forwarding the link text (not a re-share) is fine |
| A read-only peer's edits never land | Expected: the ro link holds the decryption key but **not** the RW-authority MAC, so rw peers cryptographically refuse its writes | Share the **read-write** link if the person should edit |
| `404` opening the document itself | You lost access, the doc was deleted, or you were never granted — no-access is deliberately `404` (no existence leak). (This is account file access, not collaboration.) | Confirm the share with the owner (Settings → Admin → audit log shows grants/revokes) |
| `429` on saves | Per-IP write token bucket (burst 30, refill 10/s) — usually many users behind one NAT/proxy IP, or a script | Back off; put real client IPs in front of the limiter; trusted internal tooling can run the server with `--no-rate-limit-writes` |

---

## 4. Collaboration peers not connecting (P2P / invite links)

| Symptom | Cause | Fix |
|---------|-------|-----|
| Presence pill says offline/local; peer count stays 0 | Neither transport is reachable: the peering fabric isn't there (standalone Ofisi does **not** serve `/api/peering/stream` or `/api/peering/ice` — those come from a Vulos OS / Ephor host) **and** no rendezvous URL is configured | Check Network tab: is the WebSocket to `/api/peering/stream` 404/failing, and does `GET /api/reachability` report a blank `rendezvous_url`? If both, that's expected on a bare standalone server — set `collab.rendezvous_url` (self-hosted relayd, no OS needed) or use account sharing instead |
| Invite link opens the doc but no P2P session starts | The `#vp2p=…` **fragment was lost** — chat apps, redirects, or link "sanitizers" often strip URL fragments | Re-copy the link from the share modal (Copy button) and send it through a channel that preserves `#…`; verify the received URL still contains `#vp2p=` |
| Console: `[p2p] join from link failed: …` | Malformed/tampered/truncated invite payload — join **fails closed** by design | Get a fresh link from the sharer (Rotate mints new ones) |
| Link worked yesterday, dead today | The sharer **rotated** the room — rotation revokes all previous links | Ask for the new link |
| Invited person can see but not edit | They got the **read-only** link (`cap=ro`) — read-only peers cryptographically cannot produce authoritative edits | Send the **rw** link |
| WebSocket upgrade fails behind a proxy | Proxy not forwarding `Upgrade`/`Connection` headers on `/api/peering/stream` | Enable WebSocket proxying for that path (nginx: `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`) |
| Peers connect but only via relay (slower) | WebRTC blocked (strict NAT/firewall/UDP filtered) — the fabric falls back to relay automatically | Acceptable; to get direct paths, allow UDP/STUN per your relay's ICE config (`GET /api/peering/ice`) |

---

## 5. Lost edits

Usually the edits are recoverable — check these in order:

1. **Draft restore prompt dismissed?** Before every save the editor writes an IndexedDB draft (`vulos-office-drafts` DB); after a crash/offline reload it offers *restore pending draft*. If you're re-opening the doc and the prompt appears — accept it.
2. **Version history.** Every save produces version snapshots. Open the history panel → *Compare* (line-level diff for Docs) → **Restore**. Named snapshots/labels make the right one easy to find.
3. **Save conflict (409).** If a doc was edited from two devices without live collab, the second save gets `409 revision conflict`; the store reconciles against the server copy and retries. If a retry overwrote something you wanted, the pre-conflict content is still in version history.
4. **You were a viewer.** Ops silently rejected (`403`) mean your "edits" never left your tab. Roster shows you, but nothing persists. Ask for editor role, then re-apply your changes (your local text is still on screen until reload — copy it out first).
5. **E2E room, closed alone.** In an invite-link session the *server* never stored the room's live ops; your browser kept `localStorage` snapshots (`vulos_p2p_snap_*`) and your own saves went through your normal account autosave. Reopen the same doc in the same browser to recover local state.
6. **Undo confusion.** `Mod+Z` undoes *your* ops, not your collaborator's — "my undo didn't remove their paragraph" is correct behavior.

Prevention: watch the save-state indicator (dirty/saving/saved/error). An `error` state means the network write failed — the draft is safe locally, but don't close the browser until it turns *saved*.

---

## 6. Import failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Legacy binary .doc files aren't supported yet — please re-save as .docx …" | `.doc`/`.xls`/`.ppt` (pre-2007 binary) are intentionally unsupported | Re-save as `.docx`/`.xlsx`/`.pptx` or ODF in any office suite |
| "Cannot open .xyz files" | Extension outside the supported set (`md txt docx rtf html htm odt / xlsx xls csv tsv ods / pptx odp / pdf`) | Convert to a supported format |
| Import rejected for size / archive bounds | Guardrails against oversized or zip-bomb files (`importBounds`) | Split the file or reduce embedded media |
| Images missing after `.docx` import | Import never fetches remote images — only *embedded* images are carried over (as inline data) | Expected: re-insert externally-referenced images manually |
| Content looks stripped after HTML import | The sanitizer removed scripts/iframes/unsafe styles/non-raster images — fail-closed by design | Expected for unsafe markup; plain formatting survives |

## 7. Export failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| PDF export "does nothing" (Docs/Slides) | PDF export is print-based (`Mod+P` → print dialog); a popup/print blocker or kiosk browser can suppress it | Allow the print dialog; use the system "Save as PDF" printer |
| `/v1` slide export to `pptx` is missing the editor's positioned objects | The server renders the stored deck model (background, title, body copy); the editor's own PPTX export (pptxgenjs) additionally carries objects it positions client-side | Expected; use the editor's PPTX export button when you need the positioned layout |
| `400 unsupported format` from export endpoints | Format/type mismatch — server supports `doc→pdf,docx`, `sheet→xlsx`, `slide→pdf,pptx` | Use a supported pair (Docs ODT/MD/HTML and Sheets CSV/ODS are client-side exports) |
| Exported CSV/XLSX cells show a leading `'` before `=`/`+`/`-`/`@` | Formula-injection neutralization — deliberate protection for downstream spreadsheet apps | Expected; remove manually if you truly want live formulas in the target |
| `pdf generation failed` / `docx generation failed` (500) | Server-side renderer hit malformed content | Check server logs for the message; try the client-side export path; report with the doc structure |
| Image upload fails with type error | Only sniffed **raster** images are accepted (SVG and MIME-lies rejected); 10 MB cap per upload | Convert SVG→PNG; compress >10 MB images |

---

## 8. Stale or broken UI after an upgrade

Ofisi is a PWA with a service worker (`public/sw.js`): the app shell is cached **cache-first** with background revalidation, `/api/**` and `/collab/**` are never cached.

| Symptom | Cause | Fix |
|---------|-------|-----|
| Old UI still showing right after a server upgrade | The cached shell (`/`) served first; revalidation happens in the background | Reload once more (the new worker calls `skipWaiting` + `clients.claim`, so the second load is current); or hard-refresh |
| UI half-new/half-old, JS errors about missing chunks | Cached `index.html` referencing hashed chunks the new deploy no longer serves | Hard refresh (Shift-reload); worst case DevTools → Application → Service Workers → Unregister + Clear storage for the site |
| App "works offline" but shows no documents | Correct behavior — the shell is cached, server state is deliberately never cached | Go online; unsynced local work is protected by drafts (see §5) |

Confirm what the server is actually running with `GET /version` and compare against what the UI reports.

---

## 9. Presence & roster oddities

| Symptom | Cause | Fix |
|---------|-------|-----|
| A collaborator's avatar lingers after they closed the tab | Crash/network drop skipped the clean "gone" beacon; roster entries expire on a ~15 s TTL | Wait ~15 s — it clears itself |
| Same person appears once, though connected via P2P *and* server | Rosters from both transports are merged by account id, deduplicated | Expected |
| A "viewer" shows a live caret | Viewers legitimately appear in presence and show carets; their content edits are still refused (`403`) | Expected — presence ≠ write access |
| Nobody shows in the roster but sync works | Presence endpoint (`POST /v1/documents/:id/collab/presence`) blocked or rate-limited separately from ops | Check Network tab for that POST's status |

---

## 10. Signing & envelopes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Signer link (`/sign/<token>`) not working | Envelope cancelled, signer already completed/declined, or token expired (signing tokens are TTL-bounded, like share links) | Check envelope status (`/envelopes` dashboard or `GET /api/sign/:id/status`); re-send |
| Signer can't act "yet" in a sequential envelope | Sequential routing — earlier signers must finish first | Watch the status page; or use parallel routing when order doesn't matter |
| Need to prove a sealed PDF is authentic | — | Public verify page `/verify` (or `POST /api/sign/verify`); the server's signing public key is at `GET /api/sign/pubkey`; the audit manifest downloads via `GET /api/sign/:id/manifest` |
| Completed-envelope files missing after restore | Sealed PDFs live in `data/sealed/`, envelope audit in `data/audit/<envelopeID>/` | Ensure those directories are in your backup set (see [ADMIN-GUIDE.md](ADMIN-GUIDE.md) §7) |

---

## 11. Control-plane-attached deployments (CP seam)

Only relevant when `VULOS_CP_BASE_URL` / `IDENTITY_URL` are set — with them unset none of this code runs.

| Symptom | Cause | Fix |
|---------|-------|-----|
| `402` on writes/uploads/invites | Entitlements/quota gate: over storage quota, seats exhausted, or account suspended (entitlements from the control plane) | Resolve on the control-plane side; standalone installs never see 402 (unlimited local entitlements) |
| `503 API key validation unavailable` on `/v1` with `vk_` keys | Control plane unreachable during key introspection — **fail-closed** by design | Restore CP reachability; introspection results are cached ~60 s per key, so brief blips mostly ride through |
| All SSO logins failing `401` | `IDENTITY_URL` introspection failing **closed** (provider down, wrong `VULOS_CP_TOKEN`) | Check the `[sso]` startup line and the provider's `/api/session/introspect`; native JWT login (if enabled) still works |
| Features vanished after a CP outage | Entitlements fetch fails **open** on transient outages — so this usually isn't the CP | Check `[seam]` log line; verify you're in the mode you think you are |

---

## 12. Embedding & CORS

When embedding `ofisi` library panels or calling the API from another origin:

| Symptom | Cause | Fix |
|---------|-------|-----|
| Browser console: CORS error, request never reaches handlers | Origin not in `VULOS_OFFICE_CORS_ORIGINS` | Set the exact origins (comma-separated); the startup log echoes the allowlist |
| Requests succeed but cookies/session ignored cross-origin | With `VULOS_OFFICE_CORS_ORIGINS` unset, all origins are allowed **without credentials** | Set the allowlist — credentialed CORS requires explicit origins |
| Embedded editor loads but collab endpoints 401 | The embedding page's session isn't valid for Ofisi | Use `Authorization: Bearer` (session JWT or `vk_` key) from the host app, or SSO via `IDENTITY_URL` |

---

## 13. Database & migration issues (Postgres)

| Symptom | Cause | Fix |
|---------|-------|-----|
| Boot: `Storage init failed` with a pg error | Bad `DATABASE_URL`/`VULOS_DATABASE_URL`, TLS mode, or permissions | Verify the URL (`sslmode=require` for Neon); the role needs to create/use the `office` schema |
| Tables missing after pointing at a fresh DB | First boot creates them automatically, but a locked-down role may not be able to | Run `./vulos-office migrate up` with an adequately-privileged URL; `migrate status` lists what exists |
| Two products colliding in one database | They shouldn't — Ofisi confines itself to the `office` schema | Confirm the other product misbehaved; Ofisi tables are all under `office.*` |
| Switched local→Postgres and documents "disappeared" | Storage backends don't auto-migrate content between each other | Point back at the original `data_dir` to recover; export/import documents, or keep one backend |

---

## 14. Sharing & sign-in oddities

| Symptom | Cause | Fix |
|---------|-------|-----|
| Share link says password required, recipient never set one | Working as intended — the link owner set a password; name/content are hidden until it's entered | Owner shares the password out-of-band or mints a new link without one |
| Share link dead | Expired (expiry is capped at one year) or revoked | Mint a new link |
| Everything returns `404` for one user | ACL denies read — no-access is reported as `404` on purpose | Owner re-shares; check the audit log for a revoke |
| Login locked out | `auth.max_attempts` exceeded → `lockout_minutes` lockout | Wait it out (default 15 min); admins can verify attempts in logs |
| After enabling auth, "open from server folder" vanished | `/api/local-files*` routes are disabled in multi-user mode (cross-tenant exposure guard); the log says so | Expected; upload files through the normal Open dialog |
| Whole team suddenly can't log in after upgrade from shared-password era | Per-user credential store is empty | `./vulos-office migrate-credential -admin <account>` (safe to re-run), then mint invites |

---

## 15. Built-in limits (so you can tell a bug from a guardrail)

All verified against the code; hitting one of these is expected behavior, not a fault:

| Limit | Value | Where it bites |
|-------|-------|----------------|
| Upload size | 10 MB per file, raster images only (content-sniffed) | Inserting images |
| Write/collab rate | Per-IP token bucket: burst 30, refill 10/s (`429`) | Scripts, shared NAT/proxy IPs |
| Login attempts | `auth.max_attempts` (default 5) → lockout `lockout_minutes` (default 15) | Repeated bad passwords |
| Session lifetime | `auth.session_hours` (default 24) → then `401` | Long-lived tabs |
| Share-link expiry | Capped at 1 year, whatever was requested | "Eternal" links |
| Op publish batching | ~250 ms coalescing per client | Not a lag bug — sub-second by design |
| Presence heartbeat / TTL | ~8 s / ~15 s | Ghost avatars linger ≤15 s |
| SSE reconnect grace | ~8 s before the editor reports degraded | Blips shorter than this are invisible |
| Local snapshots | Debounced ~3 s to `localStorage` | Instant-crash may lose ≤3 s of *local snapshot* (drafts still cover saves) |
| Import bounds | File-size and archive-entry caps on imports | Zip-bomb-ish or oversized files |
| Server export formats | doc→`pdf`,`docx`; sheet→`xlsx`; slide→`pdf`,`pptx` | Automation via API |

---

## 16. Quick diagnostic: which collaboration path am I on?

Thirty seconds in DevTools → Network answers most collab tickets. (Collaboration is peer-to-peer — you should **never** see a `/v1/documents/*/collab/*` request; there is no document server.)

1. **WebSocket to `/api/peering/stream` connected?** Host-box peer discovery is up. If it's `404`, check `GET /api/reachability`'s `rendezvous_url`: non-blank means discovery is instead going straight to that self-hosted relayd (no Vulos OS involved); blank means this is a bare standalone server with neither transport configured — collaboration is local-only until you run behind a Vulos OS/Ephor host **or** set `collab.rendezvous_url`.
2. **`#vp2p=` in the address bar?** You're in a collaboration room. Everyone must have the **same** link (fragment intact). A WebRTC connection should follow discovery (via whichever transport won the check above) — the document bytes travel inside it, not any HTTP request.
3. **See a `/v1/documents/*/collab/*` request at all?** That's a **regression** — Ofisi has no server-mediated collab endpoint. File an issue.
4. **None of the above?** You're local-only: autosave + drafts still protect the work; check auth (`/api/auth/status`) and connectivity.

---

## 17. Still stuck? Gather this before filing an issue

1. `GET /version` output and how you deployed (binary/Docker/Fly/bundle).
2. Server log excerpt around the failure (see §1 — include the startup mode lines).
3. Browser console + the failing request's method/path/status from the Network tab.
4. Whether the doc was in an account share, a share link, or a `#vp2p=` E2E session — the three paths fail differently (see [COLLABORATION.md](COLLABORATION.md) §9).

Security-sensitive findings: follow [SECURITY.md](../SECURITY.md) instead of a public issue.

---

## See also

- [USER-GUIDE.md](USER-GUIDE.md) — everyday use of Docs, Sheets, Slides, and Signing
- [COLLABORATION.md](COLLABORATION.md) — how the peer-to-peer CRDT sync and E2E rooms actually work
- [ADMIN-GUIDE.md](ADMIN-GUIDE.md) — deployment, configuration, storage, backup
- [CONFIGURATION.md](CONFIGURATION.md) — the full environment-variable matrix
- [API.md](API.md) — the `/v1` REST API and its status codes
