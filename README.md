# StreamDrop

Key-based, end-to-end-encrypted file transfer with **no server at all**. The sender picks a file
and hands over a **connection code**; the receiver sends back a **reply code**; the two devices find
each other and stream the bytes **straight from one to the other**. The file is never uploaded,
never stored, and never proxied — there is nowhere for it to be stored, because there is no backend.

- **Nothing to deploy.** No Cloudflare, no Worker, no D1, no Durable Object, no account, no OAuth,
  no API key, no environment variables. The web app is static files; the APK needs nothing.
- **Nothing is stored anywhere.** The sender's tab encrypts each 4 MiB block on demand (AES-256-GCM,
  sealed manifest signed with Ed25519) and hands it directly to the receiver over WebRTC.
- **The key travels separately from the connection.** The code that introduces the two devices
  contains no key material, so an intercepted code is useless. Getting the file still needs the
  **Transfer Key**, which the UI tells you to send over a different channel.
- **The code works three ways, in both directions:** QR to scan with the camera, QR **imported from
  a screenshot in your gallery**, or plain text to paste. Keep the QR if you like; type or paste the
  code if you don't.
- **Expiry, download caps and Stop are enforced by the sender's own device**, which is the only
  place the bytes exist. Stopping closes every connection at once; there is no remote copy to chase.
- The trade, stated plainly and shown in the UI: **both people must be online at the same time**,
  and the sender's device is the speed limit (battery, backgrounding and uplink are real
  constraints). Full honesty here:
  [`docs/ARCHITECTURE-v5.md`](docs/ARCHITECTURE-v5.md#8-honest-costs-and-limits).

## Documentation

- [`docs/ARCHITECTURE-v5.md`](docs/ARCHITECTURE-v5.md) — **current** architecture. Read this first.
- [`docs/DIAGRAMS.md`](docs/DIAGRAMS.md) — the current diagrams, as images.
- [`docs/IMPLEMENTATION-DELTAS.md`](docs/IMPLEMENTATION-DELTAS.md) — protocol deltas, section by section.
- [`docs/ARCHITECTURE-v4.md`](docs/ARCHITECTURE-v4.md) · [`docs/ARCHITECTURE-v3.md`](docs/ARCHITECTURE-v3.md)
  · [`docs/DESIGN.md`](docs/DESIGN.md) · [`docs/DIAGRAMS-v2.1.md`](docs/DIAGRAMS-v2.1.md) — history.

## Repository layout

```
web app + mobile shell (no backend anywhere)
├── index.html, src/        # SPA (vanilla TypeScript + Vite): Send / Receive / My transfers
│                           #   container.ts  geometry + encrypt-on-demand ranges
│                           #   protocol.ts   BlockChannel, SenderAgent, ReceiverAgent
│                           #   rtc.ts        WebRTC glue + the connection-code codec
│                           #   serve.ts      LiveSession — the sender's whole "server"
│                           #   send.ts / receive.ts / dash.ts / vault.ts / qr.ts
├── public/                 # static assets (icon)
├── mobile/                 # Capacitor config (the APK bundles dist/ and needs no host)
├── scripts/                # diagram renderer · logo renderer · Capacitor/Android build helpers
├── .github/workflows/      # ci.yml (checks) · build-apk.yml (APK, built entirely on the runner)
└── docs/                   # ARCHITECTURE-v5.md · DIAGRAMS.md · deltas · older v2–v4 docs
```

## Setup

**Nothing.** There is no backend to create and no secret to store.

- **Web:** `npm install && npm run build`, then serve `dist/` from anything (or open it directly).
- **APK:** GitHub → **Actions → Build APK → Run workflow**. The runner builds the web assets,
  bundles them into the shell, grants the camera permission QR scanning needs, and uploads the APK.
  Optional release signing uses `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`,
  `ANDROID_KEY_ALIAS_PASSWORD`; nothing else is needed (no `PUBLIC_BASE_URL` — the app has nothing
  to point at).

### What a user does

1. **Sender:** pick a file, press *Start sharing*, then send the **connection code** to the receiver
   (QR, paste, or a link).
2. **Receiver:** paste/scan/import that code, then send the **reply code** back.
3. **Sender:** paste/scan the reply → the devices are connected.
4. **Sender:** send the **Transfer Key** over a *different* channel than the code.
5. **Receiver:** paste/scan the key → the file streams block by block, verified as it arrives.

### What each party stores

| Party | Stores |
|---|---|
| Sender | Their own file, and their keys in this device's vault (or a passphrase-sealed backup file they keep themselves) |
| Receiver | The downloaded file, if they choose to save it |
| Nobody | Cloud copies, account records, tokens, ciphertext, plaintext, or history — there is no server to hold any of it |

## Local development

```
npm install          # disposable node_modules only; no global installs
npm run dev:web      # vite dev server
npm run checks       # typecheck + vitest + production build
npm run diagrams     # re-render docs/DIAGRAMS.md into docs/assets
npm run logo         # re-render the icon
```

## Security model (short form)

- The **Transfer Key** is 32 random bytes generated in the sender's tab. HKDF derives every sub-key
  (block cipher, manifest seal, Ed25519 signing key, receiver proof). It never leaves the device
  except through you.
- The **connection code** carries the offer, the share ID, its fingerprint and the public
  window/cap/note — **no key material**. It is single-use, because one WebRTC offer admits exactly
  one receiver; a fresh code is minted after each connection.
- The receiver verifies the **Ed25519 signature** over the sealed manifest and the `receiverAuth`
  binding before a single block is written, and every block is **GCM-verified** with AAD bound to
  the share ID and the block index.
- The bytes travel over **DTLS *and* GCM**: two independent layers, and no third party in the path.
- Options for extra caution: **burn-after-read** (download caps), **split-key** (halves over two
  channels), **key backup passphrase** (PBKDF2 ×250k + AES-GCM; the backup file is useless without
  the passphrase).
- Cheap talk deserves a caveat: peer-to-peer means the two devices see each other's IP addresses,
  and the public STUN server used for address discovery sees them too. It never sees any data. Set
  the ICE list to empty in `src/rtc.ts` if you want same-network-only transfers.

## Testing

- `npm test` — the crypto core plus the transfer itself. `src/p2p.test.ts` runs a genuine end-to-end
  transfer (real keys, real header, real block encryption) over a simulated channel that delivers
  frames **out of order**, then compares all 8 MiB byte by byte. It also covers the connection-code
  codec, expired windows, download caps, and read failures.
- `npm run checks` — typecheck + tests + production build, exactly what CI runs.
- Not covered: the WebRTC handshake itself (ICE/DTLS/SCTP), which needs two real browsers.
