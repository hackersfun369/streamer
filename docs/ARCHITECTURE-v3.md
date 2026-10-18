# StreamDrop v3 — architecture (superseded)

> **⚠️ Superseded by [`ARCHITECTURE-v5.md`](ARCHITECTURE-v5.md).** v3 parked the encrypted bytes in
> the sender's own Google Drive; v4 kept them on the sender's device and streamed them live through
> a Durable Object; **v5 has no server at all** — a connection code introduces the two devices and
> the bytes go device to device. Google, OAuth, the API key, the relay and the Durable Object no
> longer exist. This document is kept for history.

> `docs/DESIGN.md` v2.1 and `docs/DIAGRAMS-v2.1.md` describe the **previous** architecture
> (server-held OAuth refresh tokens, D1 transfer rows, code-exchange OAuth redirect).
> v3 replaced that. Where they disagree, this document wins.

## Principle

**Nothing user-specific is shared, and the application bundle ships no identity at all.**
Storage, keys, tokens, quota and metadata are per user. The only "identity" is the
deployment's own public OAuth client id — supplied as **configuration at runtime** (served by
`GET /v1/config` from `wrangler.toml` → `[vars]`), never compiled into the app. A Google
OAuth client id is public by design (every website offering "Sign in with Google" shows one)
and has no secret attached; it identifies *this deployment*, not any user.

| Concern | Where it lives in v3 |
|---|---|
| Google authorization | Each user signs in with **their own** account in the browser (Google Identity Services token model) |
| Google OAuth client id | The **deployment's** own public id, fetched at boot from `/v1/config`; a user may override it in their browser |
| Google API key | The **deployment's** own public, Drive-API-restricted key — used by the relay to read link-shared ciphertext. Never returned to receivers, never in the report |
| Client secret | **Does not exist** — not for the operator, not for any user |
| Refresh tokens | **None at all** — no offline access is ever requested, so none can leak |
| Access token | A `Secure; SameSite=Strict` cookie on the user's device, renewed silently by Google (~1 h), never sent to us |
| Ciphertext | The **sender's own** Google Drive, folder `StreamDrop Keys` |
| Transfer metadata | The sender's own Drive: `appProperties` on the file + `streamdrop-index.json` |
| Keys | The browser (local vault) + QR/link/paper; optionally a passphrase-sealed backup blob |
| Typed-ID pointer | A transient Cloudflare D1 row: fingerprint → file id + digests + expiry. No keys, no credentials, no plaintext, no identity beyond an optional report email |
| Daily audit | One `.xlsx` emailed to the admin by a scheduled GitHub Actions job |

## Components

1. **Static SPA** (`index.html`, `src/`) — does all cryptography and all Drive I/O in the browser.
2. **Registry + relay Worker** (`worker/src/`) — three jobs only:
   - `GET /v1/config` — the deployment's public runtime configuration (see above);
   - `POST /v1/register`, `GET /v1/resolve/:fp` — so a typed 7-character Share ID resolves to a pointer;
   - `GET /v1/download/:fp?k=…` — stateless byte relay from the sender's Drive to the receiver.
   The Worker stores **no** user credential; it reads link-shared ciphertext with the
   deployment's own public API key.
3. **Daily report job** (`.github/workflows/daily-report.yml` + `scripts/daily-report.mjs`) — reads rows, builds the `.xlsx`, emails it, then marks and (eventually) retires pointers.

## Deployment configuration (once, by whoever deploys this)

The app contains no identity. One person (the deployer) sets **two public values** in
`wrangler.toml` → `[vars]`, and they are served to every browser at boot:

1. `GOOGLE_CLIENT_ID` — Google Cloud Console → their own project → enable **Google Drive
   API** → OAuth consent screen (External; scope `…/auth/drive.file`) → Credentials →
   **OAuth client ID → Web application** → Authorized JavaScript origin = the app origin.
2. `DRIVE_API_KEY` — Credentials → **API key**, restricted to the **Google Drive API**.

Both are public, both belong to that one project, and neither can read any user's data.
Receivers configure **nothing** and need no Google account.

```
browser boots → GET /v1/config → { googleClientId }   (the app itself has no identity)
user clicks Sign in with Google
  → GIS token client (the deployment's client_id, scope: openid email drive.file)
  → access token (~1 h) in a Secure SameSite=Strict cookie, on this device only
  → Drive calls go browser → googleapis.com directly with that token
  → silent renewal on expiry; "Sign out" revokes the token at Google
```

If a deployment provides no id, the Send tab shows an optional advanced card where a user may
paste their own — off by default, never required.

**Why this is the only shape that works.** Google refuses API calls from unregistered origins
and offers no API to create an OAuth client id, so a deployment must have exactly one of:
its own client id (this design, users do nothing), a client id per user (users each spend
minutes in a console), or no Google Drive at all (no asynchronous timed transfers).

## Send

1. Encrypt locally: AES-256-GCM per 4 MiB chunk, keys from HKDF(TransferKey), manifest sealed + Ed25519-signed.
2. Create `StreamDrop Keys` if needed; resumable-upload `[header][blocks]` **straight to the sender's Drive** (browser → Google; our Worker never sees the bytes on the way in).
3. Link-share **reader-only, discovery off** so the relay can read the ciphertext.
4. `POST /v1/register` → publish the pointer (fingerprint, file id, digests, window, optional report email, optional passphrase-sealed key backup). No key travels.
5. Mirror metadata into `appProperties` + `streamdrop-index.json` **in the sender's Drive**.

## Receive

1. `GET /v1/resolve/:fp` → metadata + the sealed header (never the drive file id: the relay is the only path, which is what keeps the window enforceable).
2. Unseal the header, verify the Ed25519 signature and the header digest → tamper detection.
3. `GET /v1/download/:fp?k=<receiverAuth>` → the Worker checks the key proof and the window, then streams (Range-aware) with the **deployment's** public Drive key. No user credentials of any kind are involved.
4. Decrypt chunk-by-chunk in the browser (Streams + File System Access when available).

## Retention is soft; deletion is the sender's call

- **The blob stays in the sender's Drive until the sender deletes it.** Expiry closes only
  the receiver-facing window — nothing is auto-deleted, ever.
- A receiver who arrives after the window gets a truthful **"expired"** (410) for **30 days**;
  after that, the temporary pointer is retired and the ID stops resolving (the ciphertext is
  still in the sender's Drive, and still useless to anyone without the key).
- **Kill / Delete** in *My transfers* = revoke the Drive permission + delete the blob + drop
  the pointer (key-proven). That is the only path that removes a file.

## Daily admin report

| Transfers since last report | Result |
|---|---|
| 0 | **no email**, nothing sent, no pruning |
| ≥ 1 | one `.xlsx` emailed to the admin (`REPORT_EMAIL`) via Gmail SMTP |

After a **successful** send the run marks the day's rows reported and retires only pointers
already 30 days past expiry; the workbook is also kept as a workflow artifact. If the mail
secrets are absent the report is still produced as an artifact and **nothing is marked or
deleted** (the audit trail is never dropped silently).

## Crypto deltas retained from v1

The cryptographic core is unchanged and still covered by `src/crypto.test.ts`:
Crockford base-32 code with checksum, HKDF schedule (`sd-v1-{id,upload,file,manifest,sign,receiver}`),
`codeFp = sha256hex(HKDF(code6))`, 256 KiB-aligned padded GCM blocks with
AAD `sd-v1-chunk|codeFp|idx`, header `[u32 LE len][iv12][sealed manifest][sig64]`,
recovery bundle `[wrapSalt16][iv12][ct]`, receiver proof `sha256hex(receiverAuth)`.

## Honest trade-offs

- The relay needs *some* Google key to read a link-shared file anonymously, so the deployment
  carries one public, Drive-API-restricted key (in `wrangler.toml` → `[vars]`, or a Worker
  secret of the same name). Restrict it to the Drive API (never by referrer/IP — a Worker has
  no fixed IP). It grants quota, not data access, and is never sent to receivers.
- The blob is link-shared, so anyone who learns its file id can download ciphertext. The id
  is never published (`resolve` deliberately withholds it) and the bytes are inert without
  the key.
- Expiry is relay-enforced rather than Google-enforced (Google only allows
  `permission.expirationTime` on user/group permissions, not on `anyone` link shares).
- Burn-after-read is best-effort: a receiver who already has the bytes keeps them.
- APK sign-in still needs the pending system-browser flow (Google blocks OAuth in WebViews).
