# StreamDrop — protocol deltas (DESIGN.md v2.1 → v3)

Small, deliberate deviations from the v2.1 doc found during implementation.

> **Sections 1–8 are history** (the v1.0/v2.2 implementation). The shipped architecture is
> **v3**, described in sections 9–10 below and in `docs/ARCHITECTURE-v3.md`.

## 1. Manifest no longer embeds `driveFileId` or a ciphertext digest (v1.0)
- The header (containing the sealed manifest) is built **before** the upload session is
  created, so the resumable session can carry `x-upload-content-length` cleanly and there is
  no chicken-and-egg between the manifest and the Drive file ID.
- `driveFileId` was delivered to receivers by the server (lookup response, cross-checked
  against the signature-verified header digest) and by the QR payload in direct mode.
  In v3 the server withholds it entirely — the relay is the only byte path.
- `encSha256` → replaced by `ct_sha256` semantics change: the Worker stores the
  **SHA-256 of the header bytes** (without the 4-byte length prefix). Chunk integrity
  is already fully enforced per-chunk by AES-GCM with AAD = `idFp‖idx`, so the header
  digest anchors metadata integrity instead of duplicating chunk integrity.
- The lookup response includes `headerDigest`; receivers re-verify it over the
  received header bytes (unchanged in v3).

## 2. Drive file layout is exactly as designed (header at byte 0)
`[u32 LE headerLen][manifest IV 12B][sealed manifest][Ed25519 sig 64B] ‖ chunk blocks`
- `registry.sealed_manifest` stores the **full header bytes** (all of the above).
- The relay endpoint always ranges from `header_len` onward, so header bytes never
  flow to receivers through the Worker.

## 3. Chunks are 256 KiB-aligned for Google's resumable protocol
- Every non-final ciphertext block is an exact multiple of 256 KiB
  (`plainLen + 28 → ceil to alignment`), satisfying Google's PUT-size requirement in a
  single sequential pass; the receiver slices off the zero padding after GCM verification.
- Plausible plaintext chunk = 4 MiB; block = iv12 + ct(+16 tag) + padding.

## 4. Recovery bundle layout fixed by an explicit salt position
- The bundle = `[wrapSalt(16)][GCM iv(12)][ciphertext(+16 tag)]`.
- The **auth token** the client proves server-side is
  `sha256hex(PBKDF2-SHA256(passphrase, FIXED_SALT=0x00…00‖"sd-v-recfx", 250k))` —
  fixed salt (independent of the wrap salt), so the client can authenticate
  **before** it ever sees the bundle.
- Server check: `sha256hex(token) == registry.recover_token_hash`.
- Unwrap happens locally; the plaintext key never leaves the client.

## 5. Receiver-auth proof
- Sender stores `sha256hex(receiverAuth)` in `registry.receiver_auth_hash`;
  `/v1/download/:code_fp?k=<receiverAuthHex>` verifies against it. The Worker never
  learns `receiverAuth` itself (its pre-image).

## 6. Source-of-truth for refresh tokens (removed in v3)
- v1.0 kept one encrypted Google refresh token per Google-account row
  (AES-256-GCM under `TOKENS_SECRET`), shared by that account's transfers.
- v3 has **no refresh tokens at all**: sign-in is a browser-only Google Identity Services
  token, so there is nothing to store, share, rotate or revoke server-side.

## 7. Verified during local checks
- `tsc` strict for both web and worker bundles: OK
- Vitest crypto suite (9 tests): roundtrip with tampering detection, split-key XOR,
  checksum-tolerant code normalization, QR payload variants, recovery bundle, HKDF
  fingerprint stability: OK
- `vite build`: OK · `wrangler deploy --dry-run` (worker bundle + assets + D1): OK
- Remaining local gap: live Drive/OAuth testing requires the user's own Google/Cloudflare
  accounts — first run happens on their deployment.

## 8. BYO sign-in (superseded, then removed)
An interim "bring your own Google app" mode let a caller pass their own OAuth client
id/secret through the Worker (`GET /auth/google/start?client=byo&cid=…`, a `byo`-typed
state row, a fragment hand-off `/#byocallback=…`, and `POST /v1/auth/google/byo/exchange`
sealing `{refresh_token, client_id, client_secret}` under `TOKENS_SECRET`).

**v3 removed all of it.** Per-user Google sign-in via Google Identity Services needs no
client secret and no redirect, so the entire credential-passing path (and the reason it
existed) disappeared. See §10.

## 9. v3 pivot — per-user sign-in, per-user metadata, a stateless Worker
Triggered by the requirement "every user signs in with their own Google account, credentials
in their own browser, metadata in their own storage, and nothing stored on Cloudflare".

- **Sign-in**: Google Identity Services **token model** in the browser (`openid email drive.file`).
  A public client id (per user — see §10); **no client secret exists**, no OAuth redirect, no code
  exchange, **no refresh tokens** — the ~1 h access token lives in a `Secure; SameSite=Strict`
  cookie on the user's device and is renewed silently. `src/gis.ts`.
- **All Drive I/O moves to the browser** (`src/drive.ts`): resumable upload straight to the
  sender's Drive, reader-only link share, `appProperties` metadata, plus
  `streamdrop-index.json` in the sender's own folder as the dashboard's source of truth.
- **Worker reduced** to `POST /v1/register`, `POST /v1/unregister`, `POST /v1/extend`,
  `POST /v1/transfer/recover`, `GET /v1/resolve/:fp`, `GET /v1/download/:fp`. Removed:
  auth routes, JWT signing, refresh-token storage, upload routes, transparency log, PoW,
  lookup/manage routes, cron */15 (now housekeeping only). Bundle 48 KiB → 14 KiB.
- **Schema**: one transient `registry` table (fingerprint, file id, digests, window, download
  counters, optional report email, optional passphrase-sealed key backup) + the `rate` limiter.
  No user accounts, no tokens, no ciphertext.
- **Relay holds no key of its own**: link-shared ciphertext is read anonymously using the key
  stored on that transfer's row (in v3 the **sender's own** — see §10). Expiry and download
  limits are therefore enforced **at the relay** (a link share cannot carry a Google-side
  `expirationTime`; that field only works for user/group permissions).
- **`resolve` never returns `driveFileId`** — keeping the relay the only byte path is what makes
  the window meaningful for a receiver who already holds the key.
- **Daily admin report** (`.github/workflows/daily-report.yml` + `scripts/daily-report.mjs`):
  scheduled job → 0 transfers = **no email at all**; ≥ 1 transfer = one `.xlsx` emailed via Gmail
  SMTP → on success the rows are marked reported. Missing mail secrets ⇒ artifact only, and
  **no marking and no pruning** (the audit trail is never dropped).
- **Known trade-offs**: link-shared ciphertext means the blob is readable (but not decryptable)
  by anyone who obtains the file id; expiry is relay-enforced rather than Google-enforced;
  burn-after-read counters are best-effort (a determined receiver may already hold the bytes);
  APK sign-in still requires the pending system-browser flow.

## 10. No shared Google setup + soft retention (superseded by §11)
Follow-up to §9, from the requirements "there should be no shared setup" and "the sender's
storage retains the file until the user deletes it, but receivers see it as expired".
**Note:** §10's *per-user* client id + API key was corrected by §11 — users now click once and
the deployment supplies the (public) identity. The soft-retention rules below still stand.

- **The operator owns no Google credential at all.** No client id, no API key, no secret in
  Cloudflare, GitHub, `wrangler.toml` or `.dev.vars`. `Env` is now just `{ DB, ASSETS }`; the
  `DRIVE_API_KEY` binding, the `wrangler secret put` step in `deploy-worker.yml`, the meta tag
  in `index.html` and every reference in the docs are gone.
- **Per-user credentials**: each sender creates their own Google Cloud project + OAuth client
  (web, JS origin only) + Drive-API-restricted API key, and pastes both into the app; they live
  in `localStorage` (`sd.clientId`, `sd.apiKey`) on that device. Receivers configure nothing.
- **The relay borrows, never owns**: `register` now requires `apiKey` (validated
  `^AIza[0-9A-Za-z_-]{20,60}$`) and stores it on the row; `driveRangeFetch(apiKey, …)` uses it.
  It is never returned by `resolve` and never appears in the daily report (the report SELECT
  deliberately excludes it). A revoked/restricted key surfaces as `502:sender_api_key_rejected`.
- **Soft retention**: nothing is auto-deleted. The blob stays in the sender's Drive until the
  sender presses Kill/Delete (which revokes the share, deletes the blob and drops the pointer).
  Expiry closes only the receiver-facing window, so rows are kept for **30 days past expiry**
  (receivers get a truthful `410 expired` instead of `404 not_found`) before the report job or
  the Worker's housekeeping retires them.
- **UI copy** now says so plainly: the send form calls the slider "Receivers may download for",
  the result card notes the file stays in the Drive, My transfers offers Kill *or* Delete for
  expired rows plus +24 h to reopen, and the receive screen explains that an expired transfer's
  file may still exist at the sender.

## 11. Correction to §10 — one-click sign-in, and no identity in the app
§10 removed the operator's Google credential, but it did so by making **every user** create a
Google Cloud project and paste a client id + API key. That is a bad application: it asks each
user for minutes of console work before they can send a single file. This section reverses the
UX while keeping the privacy properties of §10.

- **The application contains no identity.** Nothing is hardcoded and nothing is baked in at
  build time. The two **public** values of §10 are now *deployment configuration*:
  `GOOGLE_CLIENT_ID` and `DRIVE_API_KEY` in `wrangler.toml` → `[vars]`, handed to every browser
  at boot by the new **`GET /v1/config`** route (`Env` regains both as optional bindings; a
  Worker secret of the same name still overrides). `src/gis.ts` gained `loadRuntimeConfig()`
  and `src/main.ts` awaits it before the first render, so the sign-in button works on the very
  first click with no user setup.
- **Users do exactly one thing: click "Sign in with Google."** No Google Cloud project, no API
  key, no config. Each user still signs in with **their own** account, on their own quota, in
  their own Drive, with their own keys — only the *app registration* is shared, and a client id
  is a public value with no secret attached (like a domain name). Per-user overrides
  (`localStorage` `sd.clientId`) remain, but the card that offers them appears only when a
  deployment has no id at all.
- **Per-user API keys are gone** (`apiKey` removed from `RegisterPayload`, from the row, from
  the client, from `db.sql`). The relay reads link-shared ciphertext with the deployment's own
  public key, so nothing user-specific travels in `register` and nothing user-specific sits in
  D1.
- **Why no third option exists**: Google rejects API calls from unregistered origins and offers
  no API to create an OAuth client id. A deployment therefore needs either its own client id
  (users do nothing), a client id per user (everyone does console work), or no Google Drive at
  all (no asynchronous timed transfers).
- **Verified**: `npm run typecheck` (web + worker), `vitest` 9/9, `vite build`,
  `wrangler deploy --dry-run`, and a local Worker smoke test of `GET /v1/config`.

## 12. v4 — the file lives on the sender's device (every cloud dependency removed)
§11 made setup one click by putting the deployment's *public* client id in `wrangler.toml`, but it
still required one Google project, one OAuth client, one API key, one published consent screen, and
a relay that reached into a user's Drive. §12 removes the cloud rather than the identity: the
ciphertext is never stored anywhere, so there is no project, key or bucket left to justify.

- **Deleted**: `src/drive.ts`, `src/gis.ts`, `src/signin.ts`, `worker/src/drive-anon.ts`,
  `worker/src/routes/relay.ts`, `GET /v1/config`, `GET /v1/download/:fp`, the `drive_file_id`
  column, the GIS token cookie, and every `wrangler.toml` `[vars]` entry.
  `Env` is now exactly `{ DB, ASSETS, SESSIONS }`.
- **Added**: `worker/src/session.ts` — one SQLite-backed **Durable Object** per transfer
  (Durable Objects are available on the Workers **Free** plan) that holds the sender's WebSocket,
  mints short-lived download tokens, and pipes ≤ 4 MiB ciphertext ranges from the device to the
  receiver. `src/serve.ts` is the device half: it keeps the `File`, encrypts ranges on demand,
  caches three blocks, holds a screen wake lock, and reconnects with backoff.
- **Protocol**: `GET /v1/session/:fp` (sender socket, key-proven) ·
  `POST …/begin` (key-proven, requires a live sender, counts the download, returns a token) ·
  `GET …/blob?t&off&len` (one range) · `POST …/end`. `unregister` now also posts `/close` to the
  object, so Kill closes the sender's socket as well as dropping the pointer.
- **Crypto is untouched.** The ciphertext layout (`[header][block 0]…`), the sealed header, the
  signed manifest and every key are byte-identical to v3; only the transport changed. The receiver
  verifies the signature and header digest before pulling a single block.
- **Semantics**: the window and the download cap are enforced per range request by the object that
  owns the socket, so they cannot race. Retention is no longer "soft" — there is nothing retained.
  The real costs (sender must be online, battery/backgrounding, the sender's uplink is the speed
  limit, no resume, per-device transfer list) are documented in `ARCHITECTURE-v4.md` and stated in
  the UI instead of being hidden.
- **Daily report**: unchanged in shape, but `owner_email` is always null now (no sign-in ⇒ no
  identity), so the `.xlsx` describes transfers rather than senders.
- **Schema**: `worker/db.sql` was replaced by `worker/migrations/0001_init.sql`; the first v4
  migration resets the pointer table, because v3 rows referenced Drive blobs that no longer exist.
- **Verified**: web + worker `tsc`, `vitest` 9/9, `vite build`, `wrangler deploy --dry-run`
  (SESSIONS + DB + ASSETS), and `scripts/smoke-live-bridge.mjs` — 23 assertions against a real
  Durable Object locally, from `503 sender_offline` before the device attaches through to the
  socket being closed by Kill.

## 13. v5 — no server at all (the Worker, D1 and Durable Objects are gone)
§12 kept the file on the sender's device but still needed Cloudflare to *introduce* two devices and
to *carry* the bytes. §13 removes the introduction and the carriage too: the people holding the two
devices introduce them, and the bytes go straight from one to the other over a WebRTC data channel.
There is no backend left to delete a dependency from.

- **Deleted outright**: `worker/` (router, `session.ts` Durable Object, registry, D1, rate
  limiting, `drive-anon.ts`, `routes/relay.ts`), `wrangler.toml`, `worker/migrations/`,
  `.dev.vars.example`, `.wrangler/`, `src/api.ts`, `src/drive.ts`, `src/gis.ts`, `src/signin.ts`,
  `.github/workflows/deploy-worker.yml`, `.github/workflows/daily-report.yml`,
  `scripts/daily-report.mjs`, `scripts/smoke-live-bridge.mjs`, `docs/GOOGLE-SETUP.md`, the `/v1`
  dev proxy in `vite.config.ts`, and the `PUBLIC_BASE_URL` secret the APK build used to point at a
  host. **The daily `.xlsx` admin report is gone with it**, and it cannot come back without one:
  "no transfers → no email, ≥ 1 transfer → a daily report" needs something that aggregates a day
  across senders, and every way to build that is a server. Senders keep their own record instead —
  the **My transfers** list, which is now the honest local answer to "what did I send?".
- **Added — the transport**: `src/rtc.ts` (invite/answer codec, non-trickle ICE with a 4 s gather
  timeout, `RtcChannel` implementing `BlockChannel`) and `src/protocol.ts`
  (`SenderAgent`/`ReceiverAgent`, framing, policy). Public STUN only
  (`stun.l.google.com`, `stun1…`) — it answers "what is my address?" and never sees data.
- **Added — encryption on demand**: `src/container.ts` (`geometryFor` + `CiphertextSource`:
  `range(off, len)` reads the slice, encrypts it, caches three blocks and forgets). No copy of the
  file is made and no ciphertext is ever written anywhere.
- **The connection code is the introduction, and its size was a design constraint.** It is
  `SDC1.<base64url(deflate-raw(JSON))>` (`SDC0.` uncompressed as a fallback, and the parser accepts
  both). A realistic 854-character data-channel SDP becomes a **793-character** code — short enough
  to paste into any chat and small enough that the QR stays easy to scan. Deflating is what makes
  the difference; without it a code is ~1 400 characters.
- **The code works as text *and* as an image, and the user asked for both**: the Receive tab takes
  the code as **typed/pasted text** ("the key in the receive tab"), as a **camera scan**, or as an
  **image imported from the gallery** (`src/qr.ts` → `importQrImage`, `decodeQrImage`). Decoding
  prefers the platform `BarcodeDetector` and falls back to **jsQR**, which is why gallery import
  works on Firefox and Safari too and not only on Chrome. The sender needs the same three ways for
  the *reply* code, and both screens offer QR + copy + save-PNG for the transfer key as well.
- **Protocol over the data channel** (v4's Durable Object conversation, minus HTTP and minus the
  relay): `{op:"begin"}` → `{op:"hello", …}` → `{op:"read", id, off, len}` → `[u32 id][u32 off]
  [payload]` frames of ≤ 64 KiB → `{op:"read-done", id, len}` → `{op:"end"}`, plus
  `{op:"error", code, id?}`. Frames are assembled **by offset, not by arrival order**, and
  `read-done` only ever *shortens* the expected length, so a clamped or empty range completes
  instead of leaving the receiver waiting forever for bytes that will never come.
- **Two real bugs the new tests caught, both fixed**:
  1. `MAX_RANGE` was 4 MiB, but a non-final ciphertext block is padded to the 256 KiB alignment and
     is therefore **4.25 MiB** — the cap silently truncated every full block. It is now
     `CHUNK_SIZE + 512 KiB`. (The v4 range endpoint had the same latent cap; the smoke test used a
     file small enough to hide it.)
  2. A read that came back shorter than requested could hang the receiver. Hence `read-done`, the
     expected-length bookkeeping, and a length check on every range in `receive.ts`.
- **Policy moved into the sender's tab** (`src/serve.ts` `LiveSession`): window and cap are checked
  on every range (`expired`, `consumed`), Stop closes every peer connection at once, and a fresh
  connection code is minted after each connection because **one WebRTC offer admits exactly one
  receiver**. Nothing is weakened by this: there is no server-side copy that could outlive a Stop,
  so there is nothing to revoke remotely.
- **Recovery is a file the sender keeps**: `src/vault.ts` writes
  `streamdrop-<ID>.keybackup.json` (salt + the passphrase-sealed key, PBKDF2 ×250k + AES-GCM) and
  reads it back on any device. No server is consulted, because there is none.
- **The APK is now genuinely self-contained**: `mobile/capacitor.config.json` no longer carries a
  `server.url`, so Capacitor serves the bundled `dist/` from `https://localhost` (a secure context,
  so `crypto.subtle`, the camera and the clipboard all work offline), and
  `scripts/patch-android-manifest.mjs` adds the `CAMERA` permission QR scanning needs.
  `scripts/apply-mobile-config.mjs` *strips* any leftover server URL rather than injecting one.
  Four details only a real build surfaced: the helpers had ESM bodies in `.cjs` files (fatal under
  `"type": "module"`); Capacitor 8 refuses to run unless the directory it runs from is a package
  root, so `mobile/package.json` exists purely to satisfy that; `android-actions/setup-android@v3`
  had to be dropped, because it aborts with "Failed to find package 'tools'" while installing a
  package Google removed from the SDK repository years ago — the `ubuntu-latest` image already
  ships `ANDROID_HOME` with platform `android-36`, build-tools 36 and platform-tools, which is
  everything `compileSdk 36` needs; and `assembleRelease` emits an *unsigned* APK that Android will
  not install, so the workflow always signs — with the repository keystore when
  `ANDROID_KEYSTORE_B64` is set, otherwise with a throwaway debug key, which keeps "Run workflow"
  one-click.
- **Crypto is still untouched.** `src/crypto.ts` was not modified in v5, so containers, keys and
  codes remain byte-identical to v3/v4 and a v3-era ciphertext file stays readable. `uploadSecret`
  survives in `SenderSet` as a vestigial derivation (Drive uploads were its only consumer) purely to
  keep the key material identical.
- **Docs**: `ARCHITECTURE-v5.md` is now authoritative; v3/v4 and `DESIGN.md` carry banners pointing
  at it; `DIAGRAMS.md` was rewritten for v5 and re-rendered through mermaid.ink into eight new
  images (`docs/assets/v5-*.png`). **Honest loss:** the Mermaid *source* of the v2.1 diagram set was
  overwritten while replacing `DIAGRAMS.md`, so `DIAGRAMS-v2.1.md` is now an image gallery of the
  surviving v2.1 PNGs rather than regenerable source.
- **Verified**: `tsc` clean, **19/19 tests** (`vitest`), production `vite build` clean. The test
  that matters most is in `src/p2p.test.ts`: real keys, a real sealed header, `SenderAgent` against
  `ReceiverAgent` over a channel that delivers frames **out of order**, every block GCM-decrypted
  with AAD bound to the share ID and index, then an 8 MiB byte-by-byte comparison. The WebRTC
  handshake itself (ICE/DTLS/SCTP) is the one thing not covered, because it needs two real browsers.

---

## 14. v6 UI — the key rides in the code (two scans, zero typing)
The v5 flow was honest but heavy: code out, reply back, and then the receiver **typed the Transfer
Key** — a third exchange on top of the two the no-server model already forces, and five cards of
options on the Send screen. The redesign collapses the handshake to the network's own minimum:

- **The key is now inside the connection code by default.** encodeInvite/parseInvite carry
  optional k (single key) or ka+kb (split halves) alongside the SDP; a v5 code *without* a key
  still parses, and an old build that receives a key-carrying code simply ignores the extra fields, so
  the wire format is backward and forward compatible without a version bump. The key costs ~25 chars
  (64 hex chars deflate well): measured 690 → **705 chars**, QR v18-22 at ECC M, ~3.4 px/module at
  340 px — still easy to scan, verified with the real encoder before building the UI around it.
- **The receiver types nothing.** eceive.ts auto-unlocks from the code's key and shows one Save
  button; the separate-key path (Options → *keep the key out of the code*) still exists and still
  asks for the key, because some people want the two-channel property. The sender's card states the
  trade on the QR itself: whoever holds the code can download until Stop.
- **The sender is one screen.** Pick a file (drag-and-drop included) → *Create transfer* → one QR
  with Copy code/Copy link; everything else (window presets, download cap, receiver note, split key,
  backup passphrase) moved under a single *Options* disclosure. Live stats (served, speed, ETA,
  downloads) replace the fixed-card zoo, a **screen wake lock** keeps the phone from sleeping
  mid-transfer, and pasting the reply works *anywhere on the page*, not just in the input.
- **A real design system replaced the default stylesheet**: one accent gradient, glass cards on a
  dark base, a 3-step indicator, progress bars, toasts, a key-viewer modal on the transfers list —
  with prefers-reduced-motion honoured and AA contrast kept. Fixed on the way: an author
  display:block on <video> was beating the UA [hidden] rule, leaving an empty black preview
  on screen ([hidden]{display:none!important} now says it once, hard).
- **Crypto still untouched.** src/crypto.ts is byte-identical; the vault rows, backups and
  containers all keep working. Tests grew 19 → **24**, including two that pin the new contract:
  derive a key set *only from what the code carried* and unseal a real header with it — and prove a
  different transfer's key still fails.
- **Verified in a real browser** (Chromium, two tabs = two devices): file pick → transfer created →
  705-char code with the key inside → QR rendered → receiver tab consumed the deep link and produced
  the reply → sender accepted it (both views screenshotted). Raw WebRTC itself cannot connect in
  this environment — ICE gathers **zero candidates** even for a bare `RTCPeerConnection` pair with
  no ICE servers at all — so the handshake stall was environmental, not a regression; the
  ICE/DTLS/SCTP hop still needs two real devices, as in v5.

