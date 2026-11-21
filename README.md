# revchat

Minimal, ephemeral P2P web chat.

> We live in an era where chasing wealth has become the default.  
> Yet behind excessive wealth, there is always someone's pain.  
> Let us choose genuine happiness and love instead.  
> revchat is built to connect people freely, as equals.

## Features

- **Hostless P2P Mesh**: Connects peers directly via WebRTC (`trystero` over multi-relay Nostr signaling + same-browser `BroadcastChannel` fallback) — no central chat server, no database, and zero server logs.
- **Instant Room Join**: Enter `#LOBBY`, type any shared room code, or generate a `RANDOM` room code and share the URL hash link (`#room=...`) or scannable QR code via **INVITE**.
- **Rich Messaging**: Real-time Markdown formatting (`**bold**`, `*italic*`, `~~strike~~`, inline `` `code` ``, fenced code blocks, `> quote`), `@mentions`, message replies, emoji reactions, author deletion, delivery ACKs, and in-room search.
- **1:1 Private DMs**: Direct messages and private attachments use ephemeral ECDH P-256 pairwise AES-256-GCM keys and unicast delivery.
- **P2P Media & Voice Notes**: Send files, auto-compressed images, videos, and recorded voice notes up to 25 MB with progress tracking and cancellation.
- **WebRTC Room Calls**: Built-in audio calls, camera toggle/flip, and screen sharing with a persistent remote audio pool.
- **Streamlined Composer & Commands**: `+` menu for Calls, Voice Notes, Files/Media, and Mini-games (`/coin`, `/roll`, `/pick`, `/rps`, `/8ball`); `☺` picker for ASCII emotes; core slash commands (`/nick`, `/room`, `/clear`, `/size`, `/theme`, `/mute`, `/help`).
- **Ephemeral PWA Shell**: Installable PWA (`manifest.webmanifest` + app-shell service worker), unread title/favicon badge, light/dark themes, adjustable chat text sizing, and mobile drawer swipe gestures.

## Architecture & Security

- **Signaling**: Multi-relay Nostr (`@trystero-p2p/nostr`, `redundancy: 5`) with SHA-256 hashed room topics and AES-GCM encrypted SDP handshakes. Relays only broker initial peer discovery and WebRTC signaling; they never receive chat messages, files, or call media.
- **Transport & Verification**: WebRTC DTLS (DataChannel) and SRTP (audio/video), per-session non-extractable ECDSA P-256 signatures verified on `CHAT_MSG`, `REACTION`, `DELETE_MSG`, `NICK_CHANGE`, and `MEDIA`, WebRTC transport-to-peer ID binding against spoofing, and ECDH P-256 pairwise AES-256-GCM for 1:1 DMs.
- **Ephemeral Privacy & Client Hardening**: Clears `localStorage` on startup, keeps only tab-scoped settings in `sessionStorage`, stores messages/media strictly in RAM (revoking Blob URLs on clear/room switch/tab close), and enforces a strict CSP, `no-referrer`, HTML escaping, prototype-pollution filtering, 60-packet/5s peer rate limiting, and 25 MB payload caps.
- **P2P Trade-offs**: Rooms are open to anyone who knows the room name, and direct WebRTC P2P connections expose peer IP addresses via ICE candidates to connected peers in the same room.

## Development

Requires **Node.js >= 22.14.0**.

```bash
npm install
npm run dev        # Start local dev server (127.0.0.1:5173)
npm run dev:lan    # Expose dev server on LAN for mobile testing
npm test           # Run Vitest unit & crypto tests
npm run build      # Typecheck (tsc) and build production bundle to dist/
npm run preview    # Preview production build locally
```
