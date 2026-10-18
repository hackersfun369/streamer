# StreamDrop — diagrams (v5, the current architecture)

Rendered as images via `node scripts/render-diagrams.mjs` (mermaid.ink). The Mermaid source is kept
in collapsible blocks so the images can be regenerated at any time. The v2.1 set lives in
[`DIAGRAMS-v2.1.md`](DIAGRAMS-v2.1.md); the architecture itself is described in
[`ARCHITECTURE-v5.md`](ARCHITECTURE-v5.md).

---

## 1. System architecture — two devices, one third-party nobody, no server

![System architecture with trust zones](assets/v5-architecture.png)

<details><summary>Mermaid source</summary>

```mermaid
flowchart LR
    subgraph SD["🟦 SENDER DEVICE — the only place plaintext and keys exist"]
        direction TB
        SU["👤 Sender"]
        SF["the file<br/>stays here, untouched"]
        SC["Sender session<br/>- HKDF keys from the Transfer Key<br/>- AES-256-GCM per 4 MiB block<br/>- Ed25519-signed sealed manifest<br/>- CiphertextSource read → encrypt → forget"]
        SP["RTCPeerConnection<br/>+ SenderAgent"]
        SU --> SF --> SC --> SP
    end

    subgraph HC["🟨 THE HUMAN CHANNEL — a chat, a screen, a piece of paper"]
        direction TB
        HUM["the connection code out,<br/>the reply code back,<br/>and the Transfer Key<br/>on a DIFFERENT channel"]
    end

    subgraph RD["🟦 RECEIVER DEVICE — holds the key, receives only ciphertext"]
        direction TB
        RP["RTCPeerConnection<br/>+ ReceiverAgent"]
        RC["Receiver client<br/>- unseal the manifest<br/>- verify the Ed25519 signature<br/>- GCM-verify every block<br/>- check every range length"]
        RU["👤 Receiver"]
        RP --> RC --> RU
    end

    subgraph NET["🟩 NETWORK — no content, no accounts, no logs"]
        STUN["public STUN<br/>answers one question only:<br/>what is my address?"]
    end

    SP -->|"① connection code — QR · paste · gallery import · NO key material"| HUM
    HUM -->|"② reply code back the same way"| SP
    HUM -->|"③ Transfer Key — over a different channel, to the receiver"| RC
    SP <-->|"after the introduction: the encrypted data channel<br/>64 KiB frames · DTLS outside, AES-256-GCM inside"| RP
    SP -.->|"address discovery only"| STUN
    RP -.->|"address discovery only"| STUN
```

</details>

---

## 2. The handshake — what each artifact is and why the key is separate

![Handshake sequence](assets/v5-handshake.png)

<details><summary>Mermaid source</summary>

```mermaid
sequenceDiagram
    autonumber
    participant S as Sender device
    participant H as Human channel
    participant R as Receiver device
    participant N as Public STUN

    S->>N: ask for my public address
    N-->>S: srflx candidates
    Note over S: build offer, gather ICE to completion,<br/>wrap it with shareId + codeFp + window + cap
    S->>H: ① connection code — 793 chars, ~900 with a link
    H->>R: the human carries it
    Note over R: parse the code,<br/>check hkdfCodeFp ID === codeFp
    R->>R: build the SDP answer
    R->>H: ② reply code
    H->>S: the human carries it back
    Note over S: applyAnswer checks the codeFp matches
    S<<->>R: ICE succeeds — data channel opens
    H->>R: ③ Transfer Key — different channel
    R->>R: unseal manifest, verify Ed25519, check receiverAuth
    R->>S: begin — this counts as one download
    S-->>R: hello — header, geometry, window, quota
    loop every 4 MiB block
        R->>S: read offset + length
        S-->>R: framed ciphertext, 64 KiB per frame
        Note over R: GCM-verify, then write
    end
    R->>S: end
```

</details>

**Why the key is not in the code.** A man-in-the-middle who sits in the chat can substitute their
own code — but the signing key is derived from the Transfer Key travelling on a different channel,
so a forged manifest fails verification. The "receive link" button merges the two on purpose and
says plainly that anyone holding that URL can open the file.

---

## 3. Sender: from a file to a live share

![Sender flow](assets/v5-send-flow.png)

<details><summary>Mermaid source</summary>

```mermaid
flowchart TD
    A["pick a file · window 1–72 h · optional cap<br/>optional split-key · optional backup passphrase"] --> B["createSender<br/>7-char ID + 32-byte Transfer Key<br/>HKDF → fek, manifestKey, signPriv, receiverAuth"]
    B --> C["buildHeader<br/>seal manifest + Ed25519 sign it"]
    C --> D["geometryFor — no copy of the file is made<br/>blockLens and offsets only"]
    D --> E["live session starts<br/>mint connection code 1"]
    E --> F{"receiver sends a reply code?"}
    F -->|"yes, codeFp matches"| G["applyAnswer → ICE connects"]
    G --> H["data channel opens<br/>attach SenderAgent"]
    H --> I["mint the NEXT code immediately<br/>one offer admits one receiver"]
    I --> F
    H --> J["on read — CiphertextSource.range<br/>read slice → encrypt → cache 3 blocks → forget"]
    J --> K["frame into 64 KiB messages<br/>wait when 4 MiB is queued"]
    K --> J
    F -->|"attempt failed"| L["mint a fresh code and say so"]
    L --> F
    E --> M{"Stop pressed ·<br/>window closed ·<br/>cap reached?"}
    M -->|"yes"| N["close every peer connection<br/>nothing is left anywhere to revoke"]
```

</details>

---

## 4. Receiver: from a code to a verified file

![Receiver flow](assets/v5-receive-flow.png)

<details><summary>Mermaid source</summary>

```mermaid
flowchart TD
    A["connection code in — paste · camera scan · import a screenshot"] --> B["parseInvite<br/>v=5, t=offer, sdp, shareId, codeFp"]
    B --> C{"hkdfCodeFp ID === codeFp?"}
    C -->|"no"| X["refuse — the code is damaged"]
    C -->|"yes"| D["acceptInvite → answer, show the reply code<br/>copy it · show its QR · save the PNG"]
    D --> E["ICE connects — or connectionState 'failed'<br/>and the UI says the network is blocking it"]
    E --> F["begin → hello<br/>header, geometry, window, quota"]
    F --> G["enter the Transfer Key<br/>paste · scan · import the key QR"]
    G --> H["unsealHeader + verify Ed25519 signature<br/>check receiverAuth"]
    H -->|"fails"| Y["that key does not open this transfer"]
    H -->|"ok"| I["download: one block at a time"]
    I --> J["read offset+len → frames by offset<br/>30 s timeout, one retry"]
    J --> K["decryptChunk with AAD sd-v1-chunk ID index<br/>GCM-verified before anything is written"]
    K --> L["write to the file picker, or spill to a Blob past 512 MiB"]
    L --> I
    L --> M["end — done"]
```

</details>

---

## 5. The wire protocol — the same conversation v4's relay had, minus the relay

![Wire protocol](assets/v5-wire-protocol.png)

<details><summary>Mermaid source</summary>

```mermaid
sequenceDiagram
    autonumber
    participant R as ReceiverAgent
    participant C as BlockChannel — data channel or, in tests, a fake
    participant S as SenderAgent

    R->>S: begin
    Note over S: window open? cap left?<br/>no → error expired or consumed
    S-->>R: hello shareId codeFp headerLen sizeBytes sizePlain expiresAt maxDownloads dlCount sealedManifest
    R->>S: read id=1 off=headerLen len=4456448
    Note over S: CiphertextSource.range — cached or re-encrypted
    S-->>R: u32 id · u32 off · 64 KiB payload — repeated
    S-->>R: read-done id=1 len=4456448
    Note over R: assemble by offset, not by arrival order<br/>read-done only ever SHORTENS the expected length
    R->>S: read id=2 off=… len=1028
    S-->>R: read-done id=2 len=1028
    R->>S: end
    Note over R,S: any refusal — error code with the id for a read,<br/>without an id for the whole download
```

</details>

---

## 6. The container and the keys — unchanged since v3

![Container and keys](assets/v5-container.png)

<details><summary>Mermaid source</summary>

```mermaid
flowchart TD
    subgraph CT["ciphertext, as it goes over the wire"]
        HDR["header<br/>u32 headerLen · iv 12 · sealed manifest · Ed25519 signature 64"]
        B0["block 0<br/>4.25 MiB = 4 MiB padded to 256 KiB + iv/tag"]
        B1["block 1<br/>4.25 MiB"]
        BN["block n — last<br/>plaintext + 28 · no padding"]
        HDR --> B0 --> B1 --> BN
    end

    TK["Transfer Key — 32 random bytes<br/>never leaves the sender's device<br/>never travels with the connection code"] --> K1["HKDF sd-v1-file → fek<br/>block encryption"]
    TK --> K2["HKDF sd-v1-manifest → manifestKey<br/>seals the manifest"]
    TK --> K3["HKDF sd-v1-sign → signPriv / signPub<br/>signs the sealed manifest"]
    TK --> K4["HKDF sd-v1-receiver → receiverAuth<br/>proves the key is the right one"]
    TK --> K5["HKDF sd-v1-upload → uploadSecret<br/>VESTIGIAL — only Drive uploads used it"]
    ID["7-char Share ID<br/>6 data + 1 checksum, Crockford base32"] --> K6["HKDF sd-v1-id → codeFp = sha256<br/>the transfer's real name and the ID's fingerprint"]

    K1 -.->|"encrypts"| B0
    K2 -.->|"unseals"| HDR
    K3 -.->|"verifies"| HDR
    K6 -.->|"AAD binds every block to this ID"| B0
```

</details>

---

## 7. Lifecycle — there is nothing to clean up, and that is the point

![Lifecycle](assets/v5-lifecycle.png)

<details><summary>Mermaid source</summary>

```mermaid
stateDiagram-v2
    [*] --> Preparing: sender picks a file
    Preparing --> Waiting: keys built, code minted
    Waiting --> Connected: reply code applied, ICE succeeds
    Waiting --> Waiting: attempt failed — mint a fresh code
    Connected --> Serving: begin — counted against the cap
    Serving --> Connected: block loop finished
    Serving --> Waiting: connection closed — next code already minted
    Connected --> Waiting: receiver disconnected
    Waiting --> Closed: window expired
    Connected --> Closed: window expired
    Serving --> Stopped: Stop pressed or cap reached
    Waiting --> Stopped: Stop pressed
    Closed --> [*]: no cleanup — nothing was stored
    Stopped --> [*]: connections closed, codes dead, nothing left behind
```

</details>

---

## 8. CI/CD — quality on the runner, and an APK that needs no host

![CI/CD](assets/v5-cicd.png)

<details><summary>Mermaid source</summary>

```mermaid
flowchart LR
    subgraph GH["🟪 GitHub Actions — no local toolchain, no device work"]
        CI["ci.yml — push and pull requests<br/>typecheck → 19 tests → production build"]
        APK["build-apk.yml — manual or tag v*<br/>build assets → normalise Capacitor config<br/>cap add android · cap sync<br/>add the CAMERA permission<br/>gradle assembleRelease"]
        REL[("GitHub Releases<br/>APK attached on tags")]
    end

    subgraph OUT["artifacts"]
        DIST["dist/ — static files<br/>host anywhere, or nowhere"]
        MOB["APK — bundles dist/, served from https://localhost<br/>a secure context: camera, clipboard, crypto all work offline"]
    end

    CI --> DIST
    APK --> MOB
    APK --> REL
    DIST -.->|"no deploy step exists"| NOTE["there is no backend to deploy"]
```

</details>
