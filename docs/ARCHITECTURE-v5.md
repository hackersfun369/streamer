# StreamDrop v5 — architecture: no server at all

> **This is the current architecture.** v5 removes the last piece of infrastructure. v4 kept the
> file on the sender's device but still needed a Cloudflare Worker and one Durable Object per
> transfer to introduce the two devices and relay bytes. v5 has **no backend**: the people holding
> the devices introduce them to each other, and the bytes go straight from device to device.
> [`ARCHITECTURE-v4.md`](ARCHITECTURE-v4.md) and [`ARCHITECTURE-v3.md`](ARCHITECTURE-v3.md) are kept
> for history; [`DESIGN.md`](DESIGN.md) is the original v2.1 design.

---

## 1. The shape of it

```
   SENDER DEVICE                                   RECEIVER DEVICE
   ┌──────────────────────────────┐                ┌──────────────────────────────┐
   │ the file (plaintext, never   │                │                              │
   │ leaves except as GCM blocks) │                │                              │
   │                              │   ① code (QR / paste / link / gallery image)   │
   │  RtcpPeerConnection ═════════╪════════════════╪══► RtcpPeerConnection        │
   │        ▲                     │   ② reply (QR / paste / back the same way)     │
   │        │ encrypted ranges    │◄───────────────┼──────── RtcpPeerConnection   │
   │  SenderAgent ─ Ciphertext    │   ③ Transfer Key (a different channel)         │
   │  Source (read→encrypt→forget)│                │                              │
   └──────────────────────────────┘                └──────────────────────────────┘
              │                                                 │
              └──────────── public STUN (address discovery only) ┘
```

Three things, in three places, for three jobs:

| Thing | Where it lives | What it does |
|---|---|---|
| **Connection code** | shown by the sender, carried by a human | finds the two devices; single-use |
| **Reply code** | produced by the receiver, carried back | completes the introduction |
| **Transfer Key** | shown by the sender on a *different* channel | the only thing that decrypts |

Everything else is ciphertext moving over a data channel between two browsers.

**There is no:** Worker, D1, Durable Object, cron, mailer, OAuth, cloud storage, account, token,
registry, or deployment step. The web app is static files; the APK bundles those files and needs
nothing at all.

---

## 2. Why the humans are in the loop

Two devices that have never met cannot find each other without an intermediary — that is a fact
about networks, not a design choice. So the introduction is *carried* instead of *hosted*:

1. The sender's browser gathers ICE candidates, builds an SDP offer, and packs it — with the
   transfer's public metadata — into one compact string. It shows that string as a **QR code** and
   as **copyable text**.
2. The receiver takes that code — pasted, scanned with the camera, **imported from a screenshot in
   the gallery**, or opened from a link — and their browser builds the SDP answer. Out comes a
   **reply code**, the same three ways back (QR, text).
3. The sender pastes or scans the reply. ICE does the rest: the two browsers punch through their
   NATs and open an encrypted data channel.
4. The **Transfer Key** arrives separately — pasted, scanned, or imported. Only then does the
   ciphertext mean anything.

### One code admits one receiver

A WebRTC offer is bound to exactly one `RTCPeerConnection`, so a code cannot be shared. After a
connection is established the session mints a **fresh code** immediately, and the same thing
happens after a failed attempt. The UI therefore talks about "the current code for the next
receiver" rather than a stable address.

### The key stays out of the code

The code carries the offer, the share ID, the ID's fingerprint, and the public window/cap/note. It
never carries the key. That is the whole security model in one sentence: **the code can be
intercepted and the file still stays shut.**

There is also an explicit "receive link" button that puts the code *and* the key in a single URL.
It exists because sometimes one channel is all you have, and the UI says plainly what it costs:
anyone who sees that link can open the file. It is a deliberate downgrade, not the default.

---

## 3. The connection code, byte for byte

```
SDC1.<base64url( deflate-raw( JSON ) )>
SDC0.<base64url( JSON )>                 ← fallback when CompressionStream is unavailable
```

```jsonc
{
  "v": 5,
  "t": "offer",            // "answer" on the way back
  "shareId": "4Q9P2KF",    // the human-visible 7-char ID
  "codeFp": "9f2c…",       // hex64: HKDF(ID) — proves the ID survived the trip
  "expiresAt": 1792327746089,
  "maxDownloads": 3,       // or null
  "publicLabel": "contract draft v3",
  "sdp": "v=0\r\n…"        // the offer (or answer), candidates already gathered
}
```

Measured on a realistic data-channel SDP:

| | size |
|---|---|
| SDP with 3 candidates + fingerprint | 854 chars |
| **connection code (deflated)** | **793 chars** |
| full receive link (code + 32-byte key) | 899 chars |

That is small enough to paste into any chat, small enough that a QR at error-correction M is easy
to scan off a phone screen, and small enough to be worth the deflate step — without it the code
would be ~1 400 characters and the QR would be much denser.

Candidate gathering is deliberately **non-trickle**: the browser waits (at most 4 s) for
`iceGatheringState === "complete"` so the code is self-contained. A code with partial candidates
still works on the same network, and the timeout means a slow STUN server can never stall a share.

---

## 4. The data-channel protocol

Same conversation v4's Durable Object had, minus the relay and minus HTTP. Both sides sit behind a
small `BlockChannel` interface, which is what makes the whole thing testable in Node.

| Direction | Message | Meaning |
|---|---|---|
| receiver → sender | `{"op":"begin"}` | open a download (counts against the cap) |
| sender → receiver | `{"op":"hello", …}` | header, geometry, window, remaining quota |
| receiver → sender | `{"op":"read", id, off, len}` | fetch one ciphertext range |
| sender → receiver | `[u32 id][u32 off][payload]` | frames of that range, ≤ 64 KiB each |
| sender → receiver | `{"op":"read-done", id, len}` | that range is finished (and how long it was) |
| receiver → sender | `{"op":"end"}` | finished |
| either → other | `{"op":"error", code, id?}` | refusal |

Constants and why:

| Constant | Value | Reason |
|---|---|---|
| `FRAME_CHUNK` | 64 KiB | the safe cross-browser data-channel message size |
| `MAX_RANGE` | `CHUNK_SIZE + 512 KiB` | a padded ciphertext block is 4.25 MiB — a cap of one plaintext chunk would truncate it |
| read ordering | by offset, not arrival | frames carry their offset, so a transport that reorders still assembles correctly |
| `read.done` | shortens the expected length | a clamped or empty range completes instead of hanging |
| backpressure | wait at 4 MiB buffered, low-water 256 KiB | never queue a whole file into the channel |
| `READ_TIMEOUT_MS` | 30 s | a stalled sender fails loudly; the receiver retries once |

`CiphertextSource` keeps a 3-block cache (≤ 12.75 MiB) so the note "buttons hammered twice" case
does not re-encrypt 8 MiB twice.

### Error codes

| Code | Meaning |
|---|---|
| `expired` | the sender's promised window closed |
| `consumed` | the download limit was reached |
| `sender_closed` | the sender stopped sharing (or closed the tab) |
| `sender_offline` / `sender_timeout` | the sender's device is not answering |
| `read_failed` | the sender's device couldn't read that part of the file |
| `bad_frame` | a malformed frame (defensive; never seen in practice) |

---

## 5. The container and the keys — unchanged since v3

The crypto core was **not touched** in v5. A transfer made today is byte-compatible with the v3
container, which is why the file-shuttle route stays available for free.

```
[ u32 headerLen ][ iv(12) ][ sealed manifest ][ Ed25519 signature (64) ][ block 0 ][ block 1 ] …
```

* **Manifest** (sealed with AES-256-GCM under `manifestKey`, signed with `signPriv`): name, mime,
  size, chunk size, chunk count, timestamps, `receiverAuth`.
* **Blocks**: 4 MiB of plaintext each, AES-256-GCM, AAD `sd-v1-chunk|<codeFp>|<index>` — so a chunk
  cannot be swapped between transfers or reordered within one.
* Non-final blocks are zero-padded to the 256 KiB alignment the original Drive design required
  (hence a full block being 4.25 MiB on the wire). The receiver trims the padding.

| Key | Derivation | Purpose |
|---|---|---|
| `codeFp` | `sha256(HKDF(ID))` | binds the ID; the transfer's real name |
| `fek` | `HKDF(transferKey, "sd-v1-file")` | block encryption |
| `manifestKey` | `HKDF(transferKey, "sd-v1-manifest")` | seals the manifest |
| `signPriv` / `signPub` | `HKDF(transferKey, "sd-v1-sign")` | Ed25519 over the sealed manifest |
| `receiverAuth` | `HKDF(transferKey, "sd-v1-receiver")` | proves possession of the key |
| `uploadSecret` | `HKDF(transferKey, "sd-v1-upload")` | **vestigial** — it authenticated Drive uploads in v3; kept so keys stay byte-identical |

A "download" is one `begin`. The key is only ever used on the receiving device, and the sender's
device is the only place plaintext exists.

---

## 6. Where policy lives now

In v4 the promises (window, cap, Kill) were enforced by a Durable Object — a single-threaded
authority that could not race. In v5 they are enforced by the sender's own tab, which is *also* the
only place the bytes exist.

| Promise | Enforced by | Notes |
|---|---|---|
| Download window | the sender's tab (checked on every range) | refused with `expired` |
| Download cap | the sender's tab (`dlCount` shared across connections) | refused with `consumed` |
| Stop / Kill | closes every peer connection immediately | nothing is left anywhere to revoke |
| "The receiver sees a closed transfer" | the channel closes | the receiver's UI says why |

This is not a weaker position than the server version, and it is worth being precise about why:
there is no server-side copy that could outlive a Kill, so there is nothing to revoke remotely.
The honest cost is the mirror image — the sender cannot enforce anything while their device is
asleep, because while their device is asleep there is nothing to serve.

---

## 7. Threat model

**Protected**

* *Confidentiality.* Blocks are AES-256-GCM; the key never leaves the sender's device and never
  travels with the code. An observer who captures the entire session — code, reply, and every
  ciphertext frame — has nothing.
* *Authenticity.* The manifest is signed with a key derived from the Transfer Key, and the
  receiver checks `receiverAuth`. A substituted manifest fails signature verification; a modified
  header fails GCM.
* *Integrity per block.* Every block is authenticated with AAD binding the ID and the block index,
  so a block cannot be replayed into another transfer, reordered, or silently truncated (the
  receiver also checks the length of every range).
* *No third party in the data path.* The bytes go browser to browser over DTLS *and* GCM. No
  service — not even one we could nominally choose — holds a copy.

**Not protected**

* *Metadata.* Peer-to-peer means the two devices learn each other's IP addresses — that is inherent
  to a direct connection, not a bug. The public STUN server sees those addresses too (it never sees
  data).
* *The existence of a share.* The code is not secret: anyone who has it can complete a handshake
  and pull ciphertext. They cannot decrypt it. `publicLabel` and the file size are visible.
* *The merged link.* If you press "receive link", anyone who sees the URL can open the file.
* *A compromised endpoint.* If the sender's device is compromised, encryption cannot help.
* *Abuse.* With no server there is no rate limiting for anyone to do: the only thing an attacker can
  hammer is the sender's device, which can Stop.
* *Forward secrecy.* One static key per transfer, no ratchet. If the Transfer Key leaks later, a
  recorded session can be decrypted.
* *Denial by network.* Some networks (symmetric NAT, restrictive corporate/mobile) refuse a direct
  path. Without a TURN relay there is no fallback except a different network.

**Why a man-in-the-middle cannot win.** A MITM sitting in the chat could substitute their own code
and reply — but the key arrives over a *different* channel, and the signing key is derived from it.
The attacker would have to be in both channels to forge a manifest the receiver would accept.
Putting the key in the same channel (the merged link) is exactly the case where this collapses, and
the UI says so.

---

## 8. Honest costs and limits

| Limit | Why | What it costs in practice |
|---|---|---|
| **Both devices must be online at the same time** | the connection is live, not a mailbox | someone has to wait; this is the one real trade of the whole design |
| **No relay fallback** | no TURN server (it would be infrastructure again) | a minority of network pairs fail; retry or switch network |
| **The sender's uplink is the speed limit** | the sender is the server | a phone on 4G sending 2 GB is slow and eats battery |
| **Sleeping kills it** | background tabs and locked phones are throttled; the screen wake lock is best-effort | keep the tab in the foreground |
| **One code per receiver** | one offer ↔ one peer connection | a handshake per receiver; the codes rotate automatically |
| **No resume** | no server-side state to resume from | a dropped connection restarts the block loop |
| **The transfer list is per device** | the vault is `localStorage` | another device shows a different list; key backups cover the gap |
| **No daily admin report** | it needs somewhere to aggregate a day across senders | dropped; each sender keeps their own record (see §11) |
| **The download window is a promise, not a lock** | the sender's device is the only authority | if the sender's clock or tab is off, expiry is meaningless — but so is everything else |

Browser support: WebRTC everywhere; `CompressionStream` on Chrome 80+/Safari 16.4+/Firefox 113+
(with the `SDC0.` fallback for older ones); `BarcodeDetector` where available for camera scanning,
with **jsQR** as a portable decoder for both the camera and **gallery/image import**, so QR import
works on every platform rather than only Chrome.

---

## 9. Deployment — and how little there is of it

| Target | What it needs |
|---|---|
| **Web app** | any static host, or nothing at all: `dist/` can be opened directly |
| **Android APK** | nothing. The APK bundles `dist/` and Capacitor serves it from `https://localhost`, which is a secure context — so `crypto.subtle`, the camera, and the clipboard all work offline |

There are **no secrets, no environment variables and no deploy workflow**. CI does only quality:

* `ci.yml` — typecheck, 19 tests, production build.
* `build-apk.yml` — build the web assets, normalise the Capacitor config (stripping any leftover
  server URL from the v3/v4 era so the app can never look for a host again), generate the Android
  project, **add the CAMERA permission** that QR scanning needs, and build a signed APK.

---

## 10. Source map

| File | Responsibility |
|---|---|
| `src/crypto.ts` | **unchanged** key derivation, header sealing/signing, chunk encryption, QR payloads |
| `src/container.ts` | ciphertext geometry + `CiphertextSource` (read → encrypt → forget, 3-block cache) |
| `src/protocol.ts` | `BlockChannel`, `SenderAgent`, `ReceiverAgent`, framing, caps/expiry enforcement |
| `src/rtc.ts` | `RTCPeerConnection` glue, non-trickle ICE, the connection-code codec, `RtcChannel` |
| `src/serve.ts` | `LiveSession` — the sender's "server": code rotation, connections, stats, Stop |
| `src/qr.ts` | QR rendering and decoding (camera, gallery import, jsQR fallback) |
| `src/send.ts` | the live share card: code out, reply in, key separately |
| `src/receive.ts` | code in, reply out, unlock, block loop, sink |
| `src/dash.ts` | per-device transfer list, local window extension, Stop/Kill |
| `src/vault.ts` | sender key vault + passphrase-sealed key backup files (no server) |
| `src/p2p.test.ts` | connection-code codec + a real byte-exact transfer over a simulated channel |
| `src/crypto.test.ts` | the crypto core (unchanged since v3) |

---

## 11. What was removed in v5

Deleted outright: `worker/` (router, Durable Object, registry, D1, rate limiting), `wrangler.toml`,
`worker/migrations/`, `.dev.vars.example`, `src/api.ts`, `src/drive.ts`, `src/gis.ts`,
`src/signin.ts`, `worker/src/drive-anon.ts`, `worker/src/routes/relay.ts`,
`.github/workflows/deploy-worker.yml`, `.github/workflows/daily-report.yml`,
`scripts/daily-report.mjs`, `scripts/smoke-live-bridge.mjs`, `docs/GOOGLE-SETUP.md`, the `/v1`
dev proxy, and the `PUBLIC_BASE_URL` secret.

Dependencies removed: `wrangler`, `@cloudflare/workers-types`, `exceljs`, `nodemailer`,
`@types/nodemailer`, `@capacitor/mlkit-barcode-scanning`, `@capacitor/filesystem`,
`@capacitor/app`. Added: `jsqr` (portable QR decoding).

**The daily admin report is gone, and it has to be.** "No transfers → no email; ≥ 1 transfer → a
daily `.xlsx`" requires something that aggregates a day across senders. With no server there is no
such place, and inventing one would put back the exact dependency this version deletes. The
replacement is local and works without anyone's help: every sender's **My transfers** list is their
own record of what they sent, when, and how much went out.

---

## 12. Verification

`npm run checks` = typecheck + tests + production build. The tests that matter most:

* **A real transfer, byte-exact.** `src/p2p.test.ts` builds genuine keys, seals a genuine header,
  runs `SenderAgent` against `ReceiverAgent` over a channel that deliberately delivers frames
  **out of order**, decrypts every block, and compares all 8 MiB byte by byte.
* **The aligned-block regression.** The same test caught a real bug: a padded full block is
  4.25 MiB, so the original 4 MiB range cap truncated every full block. The cap is now
  `CHUNK_SIZE + 512 KiB`.
* **Policy.** Expired windows refuse with `expired`; a cap of one refuses the second `begin` with
  `consumed`; a failing read reports `read_failed` instead of hanging.
* **The codec.** Invite and answer round-trip, the deflated and plain forms both parse, direction
  confusion is caught, and a damaged code is refused rather than trusted.

Not covered by tests, because it needs real hardware: the WebRTC handshake itself (ICE, DTLS,
SCTP). Everything on either side of it is tested; the handshake needs two real browsers.
