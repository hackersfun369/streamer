# StreamDrop v4 — architecture (superseded)

> **⚠️ Superseded by [`ARCHITECTURE-v5.md`](ARCHITECTURE-v5.md).** v5 removes the Cloudflare Worker,
> D1 and the per-transfer Durable Object entirely: the two devices are introduced by their users
> through a connection code and the bytes go straight from one to the other over WebRTC. The relay,
> the pointer registry, the daily report and every deploy step no longer exist. This document is
> kept for history.

> Supersedes [`ARCHITECTURE-v3.md`](ARCHITECTURE-v3.md) (Google Drive + OAuth + a stateless
> relay).

## Principle

**The file never leaves the sender's device, and no server stores it. Not for a second.**

v3 parked the *encrypted* bytes in the sender's Google Drive so a receiver could fetch them
later. v4 removes the parking space entirely: the sender's device keeps the plaintext, encrypts
each chunk on demand, and hands the ciphertext to the receiver **live** while the share is open.
The control plane is reduced to two things:

1. a **pointer** (so a typed 7-character Share ID can resolve), and
2. a **bridge** (a Durable Object that carries ciphertext from one device to another, in memory,
   for the duration of a request).

There is no Google project, no OAuth client, no consent screen, no API key, no refresh token, no
sign-in, no cloud drive, no bucket, and no stored blob. The app bundle and the deployment contain
**no credentials at all** — there is nothing left to configure or leak.

## Components

| Piece | Runs where | Holds |
|---|---|---|
| `src/` SPA | The user's browser | The plaintext file (a `File` handle), the transfer keys, the local vault, the live session |
| Worker (`worker/src/index.ts`) | Cloudflare | Nothing. It routes: registry endpoints + one Durable Object per transfer |
| `Session` Durable Object (`worker/src/session.ts`) | Cloudflare | One sender socket, one transfer's metadata (read from D1), short-lived download tokens. **Never file bytes** |
| D1 `registry` + `rate` | Cloudflare | A transient pointer row (sizes, digests, window, counts, optional passphrase-sealed key backup). Retired 30 days after expiry; deleted immediately on Kill |

## The byte path

```
sender device ──▶ ciphertext chunks ──▶  Durable Object  ──▶ range response ──▶ receiver
   (plaintext stays here)                (in-memory pipe, no storage)
```

The sender's `LiveSession` keeps a WebSocket to the transfer's Durable Object. For each read the
object asks the device for a specific range; the device slices its local file, encrypts those
chunks with the transfer key (which the server never sees), and returns the bytes, which the
object streams straight into the waiting HTTP response.

- The object is **not an origin server**. If the device is offline it answers `503 sender_offline`.
- The bridge is per transfer (`idFromName(codeFp)`), so all enforcement for a transfer is
  single-threaded — expiry, caps and counting cannot race.
- Nothing is buffered to storage: one 4 MiB range lives in memory only while it is being piped.

## Wire protocol

| Route | Caller | Purpose |
|---|---|---|
| `POST /v1/register` | sender | Publish/refresh the pointer. No keys, no blob location — sizes, digests, window |
| `POST /v1/unregister` | sender | Kill: proves key possession, deletes the row, **and closes the live session** |
| `POST /v1/extend` | sender | Push the window out (max 72 h from now), key-proven |
| `POST /v1/transfer/recover` | sender | Release a passphrase-sealed key backup (only a fingerprint of the derived token is stored) |
| `GET /v1/resolve/:codeFp` | anyone | Typed ID → metadata. Deliberately carries **no keys** |
| `GET /v1/session/:codeFp` | sender | WebSocket upgrade, key-proven → the device starts serving |
| `POST /v1/session/:codeFp/begin` | receiver | Key-proven; requires a **live** sender; counts the download; returns a short-lived token |
| `GET /v1/session/:codeFp/blob?t&off&len` | receiver | One ciphertext range (≤ 4 MiB) |
| `POST /v1/session/:codeFp/end` | receiver | Release the token |

Sender ⇄ object control frames: `{op:"read",id,off,len}` out, `[u32 id][bytes]` back; plus
`hello`, `reader`, `ping`/`pong`, `replaced`.

## Sending

1. Keys are generated in the tab (`createSender`), the manifest is built and signed, and the
   header is sealed exactly as in v3 — **the crypto core is unchanged**.
2. The ciphertext layout is *computed*, never materialised: `[header][block 0][block 1]…`, where
   each block is `encryptChunkPadded(...)` of that chunk. Total size = header + Σ block lengths.
3. `POST /v1/register` publishes the pointer; the vault keeps the keys on this device.
4. `LiveSession.start()` opens the socket, requests a screen wake lock, and idles. Per range it
   reads only the chunks it needs, encrypts, sends, and forgets (a 3-block cache smooths retries).

## Receiving

1. `GET /v1/resolve/:codeFp` → metadata + the sealed header (unreadable without the key).
2. The receiver supplies the Transfer Key; the manifest is unsealed and the Ed25519 signature and
   header digest are verified **before** anything is downloaded.
3. `begin` proves the key and counts the download. If the sender's device is asleep the screen
   says so and polls for up to two minutes instead of failing.
4. Blocks are pulled one at a time, decrypted with GCM (what is written to disk is only ever
   authenticated plaintext), and streamed into the destination file.

## Enforcement is now stronger, not weaker

| Rule | v3 | v4 |
|---|---|---|
| Window | relay checked `expires_at` | object checks it per range request, in the same object that owns the socket |
| Download cap | incremented at download start | incremented at `begin`, checked before a token is issued |
| Kill | delete blob + drop pointer | drop pointer **and** close the device's socket — the file was never copied, so nothing lingers anywhere |
| Soft retention | blob stayed in the sender's Drive until deleted | nothing is retained anywhere; "expired" simply means the device stops serving |

## The honest costs (accepted, and stated in the UI)

These are the price of "the file lives on the user's device". They are not bugs.

1. **The sender must be online.** A receiver can only download while the sender's share is open.
   There is no "download tomorrow".
2. **Battery and backgrounding.** A phone must stay awake with the app in the foreground; we
   request a screen wake lock, but a suspended WebView or a killed background tab stops the
   transfer. Desktops are happy in a background tab.
3. **The sender's uplink is the speed limit**, and every download spends the sender's bandwidth
   (once per receiver, not once per transfer as with cloud storage).
4. **No resume.** A failed download restarts (and `begin` counts again). Blocks are independently
   authenticated, so nothing corrupt is ever written, but partial progress is not reused.
5. **The transfer list is per device** (the local vault) — which is now correct, because only the
   device holding the file can serve it.
6. **The APK works** here (no WebView OAuth ban), but the same "keep it in the foreground" rule
   applies, and a foreground service is still future work.

## Free-tier budget (Cloudflare Workers Free)

- **Durable Objects are available on the free plan** (SQLite-backed). Limits: 100k requests/day,
  13,000 GB-s/day, 5 GB SQL, 32 MiB per received WebSocket message.
- One range request per 4 MiB of transfer ⇒ ~256 requests per GB, so the 100k/day budget covers
  hundreds of GB/day of relayed bytes.
- Idle senders cost nothing: the WebSocket hibernation API keeps the socket alive without duration
  charges, and only tokens (a few dozen bytes) are written to the object's SQLite storage.
- Egress from the Worker is not billed; the bytes cross Cloudflare's network but are never stored.

## Threat model

- The bridge, the Worker and D1 all see **ciphertext and metadata only**: sizes, timings, counts,
  a sealed header, and a hash of the receiver's key proof. Never the key, never a filename, never
  plaintext.
- A receiver without the key learns only that a Share ID exists.
- The Ed25519-signed manifest and the header digest make a malicious relay detectable: tampering
  fails *before* a download starts.
- The operator can refuse service or observe traffic patterns; they cannot read a byte.

## Removed in v4 (do not look for these)

`src/drive.ts`, `src/gis.ts`, `src/signin.ts`, `worker/src/drive-anon.ts`, `worker/src/routes/relay.ts`,
`GET /v1/config`, `GET /v1/download/:fp`, the `drive_file_id` column, the API key, the OAuth client
id, `docs/GOOGLE-SETUP.md`'s console walkthrough (historical), and every `[vars]` entry in
`wrangler.toml`.
