# StreamDrop — Product & Technical Design (v2.1)

> ⚠️ **Historical.** This is the approved v2.1 design. What shipped is **v5** — no server at all:
> no Google, no OAuth, no Worker, no storage. A connection code introduces two devices and the
> bytes go straight between them over WebRTC. See [`ARCHITECTURE-v5.md`](ARCHITECTURE-v5.md) for
> what is actually implemented, and `IMPLEMENTATION-DELTAS.md` for the diffs. (v3 and v4 are kept
> for history: [`ARCHITECTURE-v3.md`](ARCHITECTURE-v3.md), [`ARCHITECTURE-v4.md`](ARCHITECTURE-v4.md).)

**One-sentence pitch:** Send any file from web or mobile by picking the file and pressing **Send** → you get a **Share ID** (`XK4Q9P`) plus a **Transfer Key** you hand over by QR or secret string. Only that key-holder can decrypt the file, which lives encrypted in **your own Google Drive**, and self-destructs on the timer you set — or instantly when you press **Kill**. Nobody else, including the operator, Cloudflare, or Google, can ever read it or alter it undetected.

---

## 1. Guiding principles

| # | Principle | Consequence |
|---|-----------|-------------|
| 1 | **Zero server storage** | File bytes live only in the *sender's* Google Drive, uploaded straight from the sender's browser/app. Operator's Cloudflare stores tiny metadata + sealed manifest (a few hundred bytes). |
| 2 | **ID locates. KEY authorizes. Nobody else.** | The 6-char Share ID is only a pointer. The 256-bit transfer key, generated in the sender's browser and never transmitted to any server, is the sole read-right. |
| 3 | **Receiver's read-right is a secret, not a URL** | KEY is shown as a QR (proximity hand-off) or secret string; never in any metadata the server holds. |
| 4 | **Integrity independent of trust** | Sender-derived Ed25519 signature over manifest + full-ciphertext SHA-256, verified client-side both before download and after re-reading the streamed bytes. |
| 5 | **Timed retention + hard kill** | 1–72 h slider (default 24). Receivers see "expired" instantly when it lapses; background deletion within ≤15 min; sender can kill instantly. |
| 6 | **Only timely downloads use storage** | Nothing survives beyond `expiresAt`. No permanent tier. |
| 7 | **Everything on free tiers** | Cloudflare Workers free + senders' Google Drive + GitHub Actions free minutes. Operator cost: $0. |
| 8 | **Every limitation has a named counter-move** | See §13 — each known weakness is either fixed, mitigated with a shipped feature, or explicitly listed as crypto-physics. |

---

## 2. Users & flows

### 2.1 Sender (first-time)

1. Opens the app (web or APK) → **Send** tab → "Sign in with Google".
2. Consent (once): **`drive.file`** scope (non-sensitive, per-file) → basic verification only, no security-assessment/CASA path required.
3. Picks a file (practical ~2 GB, see §9), optionally adjusts retention (1–72 h), optionally opens **Advanced** (see §2.2), presses **Send**.

### 2.2 Sender — what happens on Send

1. Browser/app generates locally:
   - **Share ID** — 6 chars Crockford base-32 + 1 checksum char (no `I/L/O/U`; tolerant of `0↔O`, `1↔L` on input).
   - **Transfer Key** — 256-bit random; the sole decryption capability.
2. Derived client-side (WebCrypto HKDF):
   - **FEK** → AES-256-GCM for file chunks.
   - **Manifest key** → encrypts the small signed manifest.
   - **Ed25519 signing keypair** (deterministic from the transfer key) — receiver derives the public verification key locally, so verification needs no server round-trip.
   - **UploadSecret**, **receiverAuth**, **namePad** — separate HKDF outputs for upload gating, download proof, and Drive filename masking.
3. File is chunked, AES-GCM encrypted client-side, and uploaded **directly into the sender's own Drive** via a resumable-upload URL; bytes go **browser → Google**, never through the Worker. Landing spot (visible folder created on first use):

   `My Drive/StreamDrop Keys/SD · XK4Q9P · (masked as SD-<ID>.sdk)`

4. Client registers only `{ id_fingerprint, drive_file_id, sealed_manifest, signature, ciphertext_sha256, retention_hours, max_downloads?, wrapped_key?, transfer_mode }` with the Worker. Zero plaintext, zero key material.
5. The sender's confirmation screen shows: giant **Share ID**, **QR containing `ID · KEY`**, copy-key and copy-ID buttons, and a deep link `https://<app>/r/XK4Q9P#k=<KEY>` (the `#` fragment never reaches the server).

**Advanced send options (opt-in, per transfer):**

| Option | Default | What it does |
|---|---|---|
| **Burn-after-read** (`max_downloads = 1`) | off | After the first successful download the transfer auto-deletes byte-file + manifest. A forwarded KEY becomes useless afterwards. |
| **Max downloads** (`max_downloads = N`) | off (unbounded) | Hard cap on total successful downloads. |
| **Split-key (2-of-2 codes)** | off | Sender gets two independent half-codes; the file only decrypts when both are combined. Hand the halves over **different channels** (e.g., ID + half A in a chat, half B shown on screen / spoken) and a single forwarded screenshot can unlock nothing. The QR convenience copy still carries both. |
| **Resilient mode** (transfer_mode = `direct`) | off (relay) | See §3.1 — bypasses the Worker entirely for the read path. |
| **Recovery passphrase** | off | Wraps (encrypts) the transfer key server-side with a passphrase-derived key so *the sender* can get the file back on another device. |
| **Public label** (optional short title e.g. "Q2 report") | empty | Plaintext, shown to anyone with the Share ID so nobody-gets-the-KEY receivers see context without secret access. |

### 2.3 Receiver

1. Opens **Receive** tab — no sign-in, identical on web & APK.
2. Enters the **Share ID** (6 boxes with checksum tolerance) or scans sender's QR / taps deep link.
3. Server replies with the **sealed manifest** (or `not found / expired / killed / consumed`). The card is **blank until the KEY is supplied** — knowing only the ID reveals zero readable content.
4. Receiver supplies the KEY via **QR scan**, **paste `ID · KEY`**, **paste KEY**, or deep link — **or, in split-key mode, enters the two half-codes** in separate fields. Manifest decrypts locally, Ed25519 signature verifies, ciphertext digest matches → app shows the **authenticated pre-download card** (real filename, size, type, "expires in 3 h 12 m · E2EE · signature verified").
5. Press Download —
   - **Relay mode:** ciphertext streams Drive → Worker → receiver; each chunk GCM-verified; full-file SHA-256 re-verified against the signed manifest before saving. Any mismatch → hard error, no partial file.
   - **Resilient mode:** the Drive file's leading bytes carry the sealed manifest + signature; the receiver fetches the whole ciphertext **directly from Google** using the link inside the QR/deep link, unseals and verifies locally — the Worker never enters the path at all.
6. On success the save completes (File System Access API on web, system save dialog via plugin on APK). `dl_count` is checked/decremented inline for burn/cap rules in relay mode.

### 2.4 Sender dashboard ("My transfers")

| Column | Notes |
|---|---|
| Share ID | giant, tap-copy, show QR |
| File | real name (locally unsealed) |
| Created / Expires | countdown chip; red < 1 h |
| Status | 🟢 Active · 🟡 Expired · 🔴 Killed · 🟣 Consumed (burn-after-read) · ⚠️ Orphaned (Drive file deleted externally) |
| Actions | **Kill now** · **Extend** (≤72 h from now) · Show QR · 📥 Export QR (PNG/PDF) as a personal backup |

---

## 3. Architecture

> Mermaid diagrams — architecture & trust zones, send/receive sequences (relay & direct mode), lifecycle states, secrets map, CI/CD — live in [`DIAGRAMS.md`](DIAGRAMS.md); ASCII below kept for greppability.

# Mermaid set lives in DIAGRAMS.md; this ASCII is kept for greppability.

```
┌──────────────┐            ┌──────────────┐
│   Sender     │            │   Receiver   │
│  Web / APK   │            │  Web / APK   │
└──────┬───────┘            └──────┬───────┘
       │ ① sign in w/ Google       │ ① Share ID (+ KEY via QR/paste/fragment)
       │ ② AES-GCM encrypt locally │ ② unseal manifest, verify Ed25519 sig
       │ ③ resumable upload        │ ③ (relay) GCM-check each streamed chunk
       ▼                           │    or (direct) fetch from Google
┌────────── StreamDrop Worker (Cloudflare — control plane only) ──────────────┐
│ • static SPA (identical bundle for web & APK)                               │
│ • POST /v1/upload/init     → mints Google resumable-upload URL              │
│ • POST /v1/upload/finish   → stores sealed manifest + signature (no plain)  │
│ • GET  /v1/lookup/:idFp    → returns sealed manifest, expiry/kill-guarded   │
│ • GET  /v1/download/:idFp  → relay-mode only: streams Drive bytes           │
│ • POST /v1/transfer/kill, /extend, /list  (sender-JWT)                      │
│ • CRON (every 15 min)      → deletes expired Drive files; purges metadata   │
└────────┬─────────────────────────────────────────┬─────────────────────────┘
         ▼                                         ▼
   ┌─────────────┐                        ┌────────────────────┐
   │ Google Drive│  ciphertext only, in   │ Cloudflare D1      │
   │ (sender's   │  sender's own account  │  metadata only     │
   │  account)   │                        │  5 GB free         │
   └─────────────┘                        └────────────────────┘
```

**Why a Worker instead of Pages:** free Workers plan includes static-asset hosting (requests to static assets **don't count against the 100 k/day limit**), cron triggers, and D1.

**Why D1 over KV:** KV free = 1,000 writes/day — too tight. D1 free = 100 k row-writes/day, 5 M row-reads/day, real SQL indexes.

### 3.1 Transfer modes (new in v2.1 — this is limitation #3's fix)

| | **Relay (default)** | **Resilient / direct (opt-in)** |
|---|---|---|
| Byte path | Drive → Worker → receiver | Drive (public "anyone with link") → receiver, Worker untouched |
| Enforces burn-after-read / max downloads | ✅ (server counts) | ❌ (unbounded while retention lasts) |
| Operator can deny service? | ⚠️ yes (can block lookups — both typed-ID and QR receivers need a lookup for the manifest) | ✅ for QR/deep-link receivers (the QR carries the Drive link + KEY + sig-check material, so even a blocked lookup is harmless) · ⚠️ best-effort for typed-ID receivers |
| Google API egress counted on our project | yes (~file bytes) | no (uses Google's normal link CDN) |
| Expiry enforcement | live (row check) | cron delete ≤15 min after expiry |
| Extra requirement | none | Drive file must be link-shared (content is ciphertext, so "anyone" still can't read it) · sender must keep the app's delete-authority for auto-purge — revoking it pauses byte-expiry (warned + logged) |

Sender picks per transfer; the QR/deep link is identical either way.

---

## 4. Data model (D1)

```sql
CREATE TABLE transfers (
  id            TEXT PRIMARY KEY,
  code_fp       TEXT NOT NULL UNIQUE,      -- SHA-256(HKDF(ID,"fp")) — the ID is never stored
  drive_file_id TEXT NOT NULL,
  drive_folder  TEXT,
  sealed_manifest BLOB NOT NULL,
  signature     BLOB NOT NULL,             -- Ed25519 over sealed_manifest || ciphertext_sha256
  size_bytes    INTEGER NOT NULL,          -- ciphertext size only
  retention_h   INTEGER NOT NULL,
  transfer_mode TEXT NOT NULL DEFAULT 'relay',   -- 'relay' | 'direct'
  max_downloads INTEGER,                   -- NULL = unbounded, 1 = burn-after-read
  dl_count      INTEGER DEFAULT 0,
  wrapped_key   BLOB,                      -- optional recovery bundle: PBKDF2(pass)→AES-256-GCM wrapped TK
  recover_salt  BLOB,
  owner_sub     TEXT NOT NULL,
  owner_email   TEXT,
  refresh_tok   BLOB,                      -- AES-256-GCM encrypted with Worker secret
  status        TEXT NOT NULL DEFAULT 'active', -- active|expired|killed|consumed|orphaned
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  last_dl_at    INTEGER
);
CREATE INDEX idx_owner   ON transfers(owner_sub, status, expires_at DESC);
CREATE INDEX idx_expires ON transfers(status, expires_at);

CREATE TABLE auth_google (
  sub             TEXT PRIMARY KEY,
  email           TEXT,
  email_verified  INTEGER,
  picture         TEXT,
  drive_folder_id TEXT,
  updated_at      INTEGER,
  revoked         INTEGER DEFAULT 0
);
CREATE INDEX idx_revoked ON auth_google(revoked);
```

No plaintext, no raw IDs, no transfer keys — never stored anywhere, not even encrypted, unless the sender *deliberately* opts into the passphrase-wrapped recovery bundle.

---

## 5. API surface (v1)

| Method & route | Auth | Purpose |
|---|---|---|
| `GET  /v1/config` | – | Build info, retention min/max, mode support. |
| `POST /v1/auth/google` | Google ID-token | Verify `iss/aud/exp` (JWKS) → app JWT (12 h). |
| `POST /v1/upload/init` | app JWT + Bearer UploadSecret | Verify Drive folder; mint Google resumable upload URL + `driveFileId`. |
| `POST /v1/upload/finish` | UploadSecret | Store `{sealed_manifest, signature, size, retention, mode, max_downloads?, wrapped_key?}`; flip to `active`. **Last write ever — no update/replace/append APIs exist.** |
| `GET  /v1/lookup/:idFp` | – | `{status, sealed_manifest, signature, mode}` only if `active` **and** `now < expires_at` **and** `dl_count < max_downloads` (or NULL). Inline-lazy: if the row is overdue for deletion, also performs the Drive delete via `waitUntil` (this is limitation #4's real fix). |
| `GET  /v1/download/:idFp` | query `k` = SHA-256(HKDF(KEY,"sd v1 receiver auth")) — verified inside the sealed manifest & re-checked server-side | Relay-mode stream from Drive. On 200 stream start, `dl_count++`; if it reaches `max_downloads`, flip status to `consumed` and delete the Drive file inline. |
| `POST /v1/transfer/kill` | app JWT | Instant Drive delete; status → `killed`. Receiver path short-circuits. |
| `POST /v1/transfer/extend` | app JWT | Push `expires_at` up to a cap of 72 h from *now* (no indefinite stacking). |
| `POST /v1/transfer/recover` | `{idFp, passphrase}` | PBKDF2(pass, recover_salt) → unwrap `wrapped_key` → returns nothing but `ok` (the client re-fetches the sealed manifest and unseals with the recovered TK). Rate-limited hard. |
| `GET  /v1/transfers` | app JWT | Sender dashboard. |
| `POST /v1/account/disconnect` | app JWT | Revoke Google token; delete `refresh_tok`. |
| `GET  /v1/log/recent` | – | Hash-chained transparency-log entries (fingerprinted, never raw IDs): every kill / expire / purge / early-termination event is appended with `prev_hash` chaining. |
| `GET  /v1/log/head` | – | Current chain-head hash; the SPA footer shows it, and a nightly GitHub Action commit (v1.1) publishes it to the public repo so history rewriting is cross-checkable from outside. |
| `GET  /v1/health` | – | Worker + D1 + Google liveness. |
| `GET  /*` | – | SPA shell + static assets (these count as **free** on Cloudflare). |

**Cron (every 15 min — same single trigger, just `*/15`):**
1. Mark `expired` for overdue rows (`status='active' AND expires_at < now`).
2. For each `expired`/`killed`/`consumed`/`orphaned` row with a refresh token → Drive `files.delete` → purge sealed manifest, refresh token; write a small audit stub.
3. Orphan-sweep: rows where Drive says 404 → mark `orphaned`.

Worst-case lag between a transfer expiring and Drive bytes being deleted: **≤15 min** (and zero for any transfer that anyone touches, because of inline-lazy deletion). If exact-to-second deletion is ever needed, a Durable Object alarm can replace cron (listed as v1.1 roadmap).

---

## 6. Security design

### 6.1 Threat model — who can read / who can write

| Who | Read | Write | Why |
|---|---|---|---|
| Sender | ✅ | ✅ | They hold the transfer key. |
| Receiver with **ID + KEY** | ✅ | ❌ read-only | Each chunk GCM-authenticated; manifest Ed25519-signed. |
| Receiver with **ID only** | ❌ | ❌ | Sealed manifest can't be decrypted without the KEY. `dl_count`/expiry still gate access. |
| Operator / Worker | ❌ | ❌ (silent tamper) — ✅ *deny service* only | Sees only ciphertext; Ed25519 + GCM catch any swap/forge. |
| Google | ❌ | ❌ (they could theoretically swap bytes) | Same receiver-side checks catch it. |
| DB thief | ❌ | ❌ | No IDs (fingerprints only), no transfer keys (never stored unless passphrase-wrapped — and a *strong* passphrase is required). |
| Network mitm | ❌ | ❌ | TLS + GCM + signature. |
| Brute-forcer of Share ID | ❌ | ❌ | Rate-limited; the ID alone is a pointer. |

> **Residual crypto-physics:** a receiver who holds the KEY can read, and if they hand the KEY onward that other person can read too. That's not a break — that's what a key **is**. Mitigations shipped: burn-after-read / max-downloads (bound the number of readers per transfer), short retention, one-tap Kill, QR proximity hand-off, and the new **Split-key 2-of-2 mode** (§6.5) so a single forwarded screenshot can't unlock anything.

### 6.2 Crypto

```
shareCode   = 6 chars Crockford + 1 checksum                      ── public pointer
transferKey = 32 bytes random                                 ── the read-right (client-only)

codeFp      = SHA-256( HKDF(shareCode,"sd v1 id fp") )         ── stored lookup key
uploadSec   = HKDF(transferKey,"sd v1 upload secret")          ── Bearer for sender upload routes
fek         = HKDF(transferKey,"sd v1 file key")               ── AES-256-GCM chunks
manifestKey = HKDF(transferKey,"sd v1 manifest key")           ── AES-256-GCM manifest envelope
sigPriv     = Ed25519 from HKDF(transferKey,"sd v1 sign seed") ── deterministic per-transfer keypair
receiverAuth= SHA-256( HKDF(transferKey,"sd v1 receiver auth") ) ── download proof
namePad     = HKDF(transferKey,"sd v1 name pad")               ── Drive filename masking
wrappedKey  = PBKDF2(pass, salt, 250k) → AES-256-GCM(transferKey) — only if recovery option is on

manifest (plaintext inside the sealed envelope):
 {v:1, name, size, mime, chunk_size, chunk_count, ct_sha256, created_at,
  expires_at, receiver_auth, transfer_mode, hdr_len}
signature = Ed25519(sigPriv, sealed_manifest || ct_sha256)
chunk = [12-byte IV || AES-256-GCM(fek, iv, chunk, aad=idFp || chunkIdx || manifestDigest)]
Drive file bytes = [hdr_len || sealed_manifest || signature] || chunk0 || chunk1 …
```

- Filenames are masked on Drive (`SD-<ID>.sdk`), the real name lives in the sealed manifest, decrypted only locally by sender/receiver. Generic `application/octet-stream` MIME is sent to Drive so neither Drive metadata nor anything in transit leaks the file type.
- Version tag `v1` in the envelope allows future algorithm rotation without breaking in-flight transfers.

### 6.3 Tokens & auth

- Google OAuth (code + PKCE) via `accounts.google.com/gsi/client` (web) and a WebView PKCE loop (APK), sharing one OAuth client with the APK's signing SHA-256 registered. `drive.file` is non-sensitive → basic verification only.
- ID token verified server-side (JWKS) → 12 h app JWT.
- Refresh tokens stored AES-256-GCM-encrypted with a Worker secret; never logged; revocable from the app's Disconnect or from Google's security page.
- Rate limits (D1 counters): `auth/google` 10/min/IP; `upload/init` 30/h/account; `lookup` 30/min/IP + 500/min global; `download` 5/min/IP (relay); `recover` 5/h/IP. 3 consecutive failures per IP/10 min unlock a small 8-bit hashcash challenge.

### 6.4 Write-path immutability

- `upload/finish` is the **last write** anyone can make to a transfer's content. No update / replace / append endpoint exists.
- Receivers are read-only by design — no endpoint accepts uploads keyed by a Share ID.
- Sender's Google account compromise is an account-security problem outside this app; even then the receiver will detect post-hoc tampering via the signature.

### 6.5 Split-key hand-off (forward-resistance)

```
halfA = 32 bytes random
TK    = 32 bytes random
halfB = halfA XOR TK        ← standard 2-of-2 XOR envelope, zero entropy loss
```

Neither half decrypts anything alone; combining both recovers the transfer key, after which the receiver's experience is byte-for-byte the same as ordinary mode. The sender hands half A and half B over **different channels** (e.g., ID + half A in a chat message, half B shown on screen / spoken / via another app) — so a single forwarded screenshot or captured message can no longer decrypt anything, and a leaked screenshot of one half is useless without the other.

Boundaries we accept honestly:
- If a receiver gets **both halves via the same channel**, the split degrades to plain mode (burn-after-read still bounds it). The sender UI warns about this.
- A receiver who deliberately publishes *both* halves — or simply photographs the decrypted plaintext — has shared the read-right. That is inherent to any system where a receiver can read; no web/mobile product can prevent the user copying what they see. Per-receiver identities were rejected (destroys anonymous receipt), and DRM-style device enclaves are out of scope for a free web/mobile app.

### 6.6 Transparency log & operator honesty

What a hostile operator will *always* be able to do on their own machines: refuse service, and (via the stored delete-authority that powers cron deletion) delete a transfer early. v1 makes both **loud instead of silent**:

- **Hash-chained audit in D1** (`transparency` table): every `kill / expire / purge / early-termination` event appends `{seq, ts, type, transfer_fp, prev_hash}` with `this_hash = SHA-256(prev_hash || seq || ts || data)`. Publicly verifiable at `GET /v1/log/recent` and `/v1/log/head`.
- **Attributed status in the receiver UI**: the card says whether a transfer "expired" (per its own timestamps), was "terminated early by the operator", or "never existed" — so abuse is **attributable**, not plausible as expiry.
- **Nightly external anchor** (v1.1): a GitHub Action commits each day's chain-head hash into the public repo's `audit/` file; outside parties can diff repo history against the served log — a rewritten chain becomes *evident*, not undetectable.
- **Split-key & resilient mode** (§3.1, §6.5) reduce the practical attack surface: direct-mode QR receivers need no operator at all on the byte path.

What this does *not* change: an operator can still simply switch off their servers, or serve a fake-but-internally-consistent chain. The separation this design guarantees is precise: **the operator can stop serving; they can never read, forge, or falsify silently.**

---

- Sender picks 1–72 h on send. `expires_at` is enforced **live** on every lookup/download.
- **Hourly→15-min cron** (`*/15`) handles byte deletion;**inline-lazy deletion** runs on any touch, so a transfer only lingers if literally nobody ever requests it again.
- **Kill** = instant delete + status flip.
- **Burn-after-read / max-downloads** = enforced in relay mode only; the moment the cap is reached the transfer self-deletes (byte file + manifest). In resilient/direct mode, caps can't be counted by the server — so the sender of a direct-mode transfer is warned upfront that it's unbounded until expiry.
- Sender's dashboard shows countdowns, Extend, Kill, and Export-QR for personal backup.

---

## 8. Mobile app (Capacitor)

- One codebase — the SPA — wrapped by **Capacitor 8**. File pick via `<input type=file>` (routes to SAF), save via the **Filesystem** plugin + Share sheet, QR scan via `@capacitor-mlkit/barcode-scanner`.
- `capacitor.config.json` → `appId: io.streamdrop.app`, primary server = deployed Worker URL; APK is a hardened shell around the same SPA.
- Android only for now (per your ask — APK built by GitHub Actions). The architecture is iOS-agnostic; adding `@capacitor/ios` later changes nothing.

---

## 9. Limits & quotas

| Resource | Free-tier budget | How the app stays inside it |
|---|---|---|
| Cloudflare Workers requests | 100 k/day **account-wide** | Static-asset requests are **free & unlimited**; only API hits count, ~4–10 per transfer. Relay-mode + heavy direct-mode keeps this comfortably under. |
| Worker CPU | 10 ms/req | Streaming/passthrough; all crypto client-side. |
| D1 writes/day | 100 k rows | Metadata + status flips only. |
| D1 reads/day | 5 M rows | Lookups + dashboards. |
| D1 storage | 5 GB | Sealed manifests (bytes) + account rows. |
| R2 | not used | Files live in senders' Drives. |
| Cloudflare cron triggers | 5/account | 1 used, `*/15`. |
| Google Drive per-file/day | 5 TB/file; 750 GB/day uploads | Surfaced as friendly errors. |
| Google Drive API egress | 1 TB/day per project (new 2026 model) | Spent only by relay-mode downloads; direct-mode bypasses us entirely. |
| **Practical max file size** | **~2 GB in v1** | Chunked streaming could technically go further; keeping a conservative cap makes the UI honest. Config parameter — raise it in a later build if testing shows it's safe. |

---

## 10. Accessibility

- Full keyboard operation, visible focus rings, logical tab order; Enter/Space on custom controls.
- Screen readers: every state change announced via `aria-live="polite"`; expiry announced every 60 s, not every second.
- Contrast ≥ 4.5:1, never color-alone (chips pair color + icon/text).
- `prefers-reduced-motion` respected.
- Font zoom respected (APK WebView too); touch targets ≥ 44 px; Send button bottom-anchored.
- Plain language ("this file can be downloaded for 3 more hours").
- Paste-tolerant & QR-scan-friendly so the KEY hand-off is accessible whether or not you can point a camera.

---

## 11. Build, CI/CD, repo layout

```
streamdrop/
├── web/                # vanilla TS + Vite SPA (send.ts receive.ts dash.ts crypto.ts api.ts ui.ts qr.ts)
├── worker/             # Cloudflare Worker control plane + db.sql + wrangler.toml
├── mobile/             # capacitor.config.json + package.json (android/ generated by capacitor, committed to CI only)
├── .github/workflows/  # deploy-worker.yml, build-apk.yml
└── docs/DESIGN.md
```

`build-apk.yml` runs entirely on GitHub-hosted runners: checkout → Node → `npm ci` → `vite build` → `cap add android` (idempotent) → `cap sync android` → Temurin 21 + Android SDK → `./gradlew assembleRelease` → optional `apksigner sign` if keystore secrets are present → upload-artifact + optional GitHub Release on tags.

Nothing ever runs on your machine: no Android Studio, no SDK, no Java, no keystores.

---

## 12. Non-goals (v1)

iOS build · multi-file bundles (repeat sends instead) · recipient lists / email · transcoding / preview · public gallery · accounts other than Google.

---

## 13. Limitations — solved, mitigated, or residual

Every limitation that was raised has been given a specific treatment. **None are left unaddressed.**

| # | Limitation | Status | Treatment shipped |
|---|---|---|---|
| 1 | "Receiver who has the KEY can forward it" | ✅ **Mitigated (bounded)** + residual by definition | **Burn-after-read** (max_downloads = 1) and **max-downloads = N** — both delete or lock the transfer the moment the cap is hit, so a forwarded KEY goes dead. QR proximity hand-off keeps the KEY out of chats. Short retention adds another bound. *Residual:* a KEY is a read-right; that's what it **is**, not a bug. |
| 2 | Pre-key receiver sees "a transfer exists" and nothing readable | ✅ **Solved (by design), plus made useful** | The blank pre-key card is the intended zero-leak state; the **Public label** option lets a sender voluntarily show a short title so ID-only recipients have context. |
| 3 | Operator can deny service (block lookup/kill) | ✅ **Mitigated** + residual | **Resilient (direct-to-Drive) mode** removes the Worker from the byte path entirely — a receiver holding the QR downloads straight from Google even if the operator parking-lots the lookup. Sender can also Always delete their own Drive file directly. *Residual:* a hostile operator will always be able to refuse *their own* domain; that's what "hostile operator" means — the mitigation is an out they can censor, not a server they can silence. |
| 4 | Cron granularity = 1 h delete lag | ✅ **Solved** | Single trigger changed to `*/15` (still 1 of the 5 free cron slots) + **inline-lazy deletion** on any lookup/download touch. Worst case 15 min, typical case seconds. A DO alarm can give exact-second deletion (v1.1). |
| 5 | Cloudflare free 100 k requests/day is account-wide | ✅ **Mitigated** + honest | Static assets are **free and not counted**; only ~4–10 API requests per transfer count. Deploy this as the sole Worker on its own Cloudflare account (or accept the shared pool). No paid tier needed below serious scale. |
| 6 | "Upload plaintext metadata is predictable" | ✅ **Solved** | Drive filename is masked; Drive MIME is forced to `application/octet-stream`; TLS hides the contents and even chunk boundaries. A network observer sees only "some bytes went to googleapis.com" and the total size — size is unavoidable on any upload, to any provider. |

**The two remaining residuals, now with shipped counter-moves:**

**Residual A — receiver forwards the KEY**
- Shipped in v1: burn-after-read / max-downloads (bounds total readers), short retention, one-tap Kill, QR proximity hand-off — **plus the new Split-key 2-of-2 mode** (§6.5): the file only decrypts when two independent half-codes are combined, so a single forwarded screenshot or captured message unlocks nothing. Hand the halves over different channels and forwardability disappears in practice.
- Floor that remains: if the holder deliberately re-publishes both halves (or simply photographs the decrypted file), the read-right is theirs to give away. Per-receiver identities would fix it but destroy anonymous receipt; DRM-style device enclaves are out of scope for a free web/mobile app. This is true of every file-transfer product that has ever existed — plaintext, once seen, can be re-sent by the person who saw it.

**Residual B — hostile operator can refuse service / delete transfers early**
- Shipped in v1: **direct-mode QR bypass** (§3.1 — the QR carries the Drive link + KEY + sig-check material, and the sealed manifest lives in the file's first bytes, so a receiver holding the sender's QR needs the Worker for *nothing*; blocked lookups can't stop reads) and the **hash-chained transparency log** (§6.6) with fingerprint-only entries, receiver-visible status attribution ("expired" vs "terminated early by operator"), and a v1.1 GitHub-committed daily anchor that makes log rewriting cross-checkable.
- Floor that remains: the operator can always turn off their own machines or serve a fake-but-internally-consistent chain. What they *cannot* ever do is read, alter, or forge — that's the line this design refuses to move.

**Other residuals, unchanged:**
- The optional **recovery passphrase** wraps the sender's transfer key on our server. A **weak** passphrase + a DB leak means an attacker could unwrap that one transfer's read-right. Mitigation: enforce passphrase strength ≥ 12 chars, PBKDF2 × 250k, opt-in only.
- Total file size is visible to a network observer. Always true, everywhere, not a StreamDrop gap.

---

## 14. Roadmap

- **v1 (this build):** send/receive web + APK, E2EE + Ed25519 verification, retention & kill, burn-after-read / max downloads, **split-key (2-of-2) send option**, resilient direct mode **with QR-carried Drive link + KEY** (operator-independent reads), recovery passphrase, 15-min cron + inline-lazy delete, QR + paste + deep link, signed dashboard, **hash-chained transparency log**.
- **v1.1 (planned, non-breaking):** Durable-Object alarm exact-time deletion · nightly external chain-anchor via GitHub Action · shared-passphrase second factor · WASM cipher pipeline to raise the file-size ceiling.
- **Non-goals are permanent:** no public gallery, no accounts other than Google, no server-side plaintext ever.

---

## 15. Answers to your original asks, one by one

| You wanted | Where |
|---|---|
| File transfer web + mobile | §2, §3, §8 |
| Sender select file → Send → ID/Key shown | §2.2 (giant Share ID + QR with KEY) |
| Receiver types key in Receive tab → download | §2.3 |
| Sender sets retention hours | §2.2 step 3 (1–72 h slider) |
| Only timely downloads use storage | §7 + §13#4 |
| Users use their own Google storage | §1#1, §3 |
| Expired ⇒ disabled to send & receive | §7 (live check) + cron-driven delete |
| Force-disable (Kill) | §2.4, §7 |
| No one can read | §6.1 |
| No one can write | §6.1, §6.4 |
| Receiver forwarding the KEY is bounded / made hard | §6.5 (split-key) + §13 Residual A |
| Operator abuse is loud & attributable, not silent | §6.6 (transparency log) + §13 Residual B |
| Deploy on Cloudflare free tier | §3, §11 |
| APK via GitHub Actions, not on your device | §11 |
| All limitations solved before green | §13 — fix/mitigation table, residuals honestly labeled |

---

*If this v2.1 is acceptable, the next message starts implementation.*
