# Self-hosting a TURN server (coturn) for collaboration behind strict NAT

Diwan's real-time collaboration (Docs/Whiteboard invite links, Sheets/Slides
presence) is **direct peer-to-peer WebRTC by default** — see
[COLLABORATION.md](COLLABORATION.md) §3. No Vulos product, host box, or
account is required to make that work: the transport is Diwan's own
first-party `FabricClient` (`src/lib/collab/webrtc/fabric.js`).

Direct WebRTC needs help crossing NAT:

- **STUN** gets you there in the vast majority of cases — it just tells a peer
  its own publicly-visible address so the two sides can hole-punch straight to
  each other. Diwan defaults to the public Google STUN server for this; no
  setup required (see [CONFIGURATION.md](CONFIGURATION.md) `VITE_STUN_URLS`).
- **TURN** is needed only when hole-punching fails outright — most commonly
  when one peer is behind a **symmetric NAT** (common on some corporate/mobile
  networks and carrier-grade NAT). TURN relays the traffic between the two
  peers instead of connecting them directly. In Diwan's model this relay is
  still **content-blind**: the payload was already end-to-end sealed by the
  invite-link room key before it ever reaches the TURN server (see
  [COLLABORATION.md](COLLABORATION.md) §4) — TURN just moves bytes it cannot
  read.

This document is about that second case: running your **own** TURN server
([coturn](https://github.com/coturn/coturn)) and pointing Diwan at it, so a
deployment with peers behind strict NAT doesn't need to depend on any other
Vulos product (a host box or a `vulos-relayd`) just to get a relay fallback.

## Do you need this at all?

Try without TURN first. STUN alone is enough for the large majority of
networks. Only set up coturn if you see collaborators repeatedly stuck at a
"connecting" presence pill that never reaches "Live" when both are on
networks you don't control (e.g. one or both behind hotel/mobile/corporate
NAT). `docs/TROUBLESHOOTING.md` has the general connectivity checklist.

## 1. Install coturn

### Option A — apt (Debian/Ubuntu)

```sh
sudo apt update
sudo apt install -y coturn

# Enable the systemd service (disabled by default on Debian/Ubuntu packages).
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

Edit `/etc/turnserver.conf` (replace the packaged one) with the minimal
config in step 2, then:

```sh
sudo systemctl restart coturn
sudo systemctl enable coturn
sudo journalctl -u coturn -f   # watch the logs while you test
```

### Option B — Docker

```sh
mkdir -p ~/coturn && cd ~/coturn
# Save the turnserver.conf from step 2 into ./turnserver.conf, then:

docker run -d --name coturn --restart unless-stopped \
  --network host \
  -v "$PWD/turnserver.conf:/etc/coturn/turnserver.conf:ro" \
  coturn/coturn -c /etc/coturn/turnserver.conf
```

`--network host` matters here: coturn needs to bind a **wide UDP port range**
for the actual media/data relay (see `min-port`/`max-port` below), and
Docker's default bridge networking would require publishing every one of
those ports individually. Host networking is the standard way to run coturn
in a container.

## 2. Minimal working `turnserver.conf`

```ini
# The realm coturn advertises — any stable name works; clients don't need to
# match a DNS zone, but it's conventional to use one.
realm=turn.example.org

# Standard TURN/STUN ports.
listening-port=3478
tls-listening-port=5349

# TLS certs for turns:// (recommended for any public deployment — an https
# page cannot reliably reach an unencrypted turn:// relay through some
# corporate proxies, and it keeps credentials off the wire in cleartext).
cert=/etc/letsencrypt/live/turn.example.org/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.org/privkey.pem

# The actual relay port range (the UDP ports coturn allocates per session to
# carry the relayed media/data). Keep this reasonably sized — each concurrent
# relayed session consumes one port from this range for its lifetime.
min-port=49152
max-port=49452

# REQUIRED: the server's own public IP, so coturn advertises a reachable
# relay candidate instead of a private/NAT'd address. If coturn sits behind
# its own NAT (e.g. a cloud VM with a private+public IP pair), use the
# "private-ip/public-ip" form instead:
#   external-ip=203.0.113.10/10.0.0.5
external-ip=203.0.113.10

# Long-term credential mechanism — see step 3 for the two ways to set
# credentials that pair with VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL.
lt-cred-mech

# Static credential (simplest — pick a strong, random password):
user=diwan:CHANGE_ME_TO_A_LONG_RANDOM_SECRET

# Recommended hardening.
fingerprint
no-multicast-peers
no-cli
# Refuse to relay to addresses on your own private network (SSRF guard —
# stops a malicious peer from using your TURN server to reach your LAN).
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
```

### Static credential vs. time-limited credential

The config above uses `user=diwan:CHANGE_ME_TO_A_LONG_RANDOM_SECRET` — a
single static username/password pair. That's the simplest option and is fine
for a self-hosted deployment where you control who gets the credential (it
goes straight into `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL` — see step
3). It is a shared secret, though: anyone who has it can relay through your
server indefinitely.

For a public multi-tenant deployment, coturn also supports **time-limited
credentials** derived from a `static-auth-secret` (HMAC-SHA1 over
`<unix-timestamp>:<username>`), which expire automatically:

```ini
use-auth-secret
static-auth-secret=CHANGE_ME_TO_A_LONG_RANDOM_SECRET
```

Minting a fresh time-limited credential per session requires a small bit of
server-side code (Diwan does not currently generate these — the static
`lt-cred-mech` credential above is the supported path today). See coturn's own
[`README.turnserver`](https://github.com/coturn/coturn/blob/master/README.turnserver)
for the exact HMAC recipe if you want to add that later.

## 3. Firewall

Open, at minimum:

| Port(s) | Protocol | Purpose |
|---------|----------|---------|
| 3478 | UDP + TCP | STUN/TURN control (`listening-port`) |
| 5349 | UDP + TCP | STUN/TURN control over TLS (`tls-listening-port`) |
| 49152–49452 (or whatever you set) | UDP | The actual relay traffic (`min-port`–`max-port`) |

```sh
# ufw example
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 5349/tcp
sudo ufw allow 5349/udp
sudo ufw allow 49152:49452/udp
```

If coturn is behind a cloud provider's own security group / firewall (AWS,
Hetzner, etc.), open the same ports there too — the OS-level firewall alone
is not enough.

## 4. Point Diwan at it

Set these at build time (they are `VITE_*`, so they're baked into the
frontend bundle — see [CONFIGURATION.md](CONFIGURATION.md)):

```sh
export VITE_TURN_URL="turn:turn.example.org:3478,turns:turn.example.org:5349"
export VITE_TURN_USERNAME="diwan"
export VITE_TURN_CREDENTIAL="CHANGE_ME_TO_A_LONG_RANDOM_SECRET"   # matches user= above

npm run build:frontend
```

`VITE_STUN_URLS` is optional here — the public Google STUN default already
covers the STUN half; only set it if you want your own STUN server too (e.g.
`turn:turn.example.org:3478` doubles as a STUN server without credentials).

If you'd rather not bake credentials into the static bundle, a host page can
inject the same configuration at runtime instead, before Diwan's bundle
loads:

```html
<script>
  window.__VULOS_ENDPOINTS__ = {
    turn: { urls: ['turn:turn.example.org:3478'], username: 'diwan', credential: '…' },
  }
</script>
```

## 5. Verify it

```sh
# coturn's own connectivity check (needs the `turnutils_uclient` tool, ships
# with the coturn package):
turnutils_uclient -T -u diwan -w 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET' turn.example.org

# From a browser, https://icetest.info or https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
# — set "TURN URI" / username / credential to your values and confirm a
# "relay" candidate is gathered (not just "srflx"/"host").
```

In Diwan itself: open DevTools → Network on two browsers behind different
strict NATs, start a collaboration session, and confirm the presence pill
reaches "Live" — if `chrome://webrtc-internals` (or `about:webrtc` in
Firefox) shows the active candidate pair as `relay`, TURN did the work that
STUN alone couldn't.

## Reference

- coturn project: <https://github.com/coturn/coturn>
- Diwan's ICE configuration code: `src/lib/collab/webrtc/call/ice.js`
- How the fallback ICE list is used: `src/lib/collab/webrtc/fabric.js` (`_fetchICE`)
- The wider collaboration/transport model: [COLLABORATION.md](COLLABORATION.md) §3
- All `VITE_STUN_URLS`/`VITE_TURN_*` variables: [CONFIGURATION.md](CONFIGURATION.md)
