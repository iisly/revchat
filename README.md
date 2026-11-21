# revchat

Minimal, ephemeral P2P web chat.

> We live in an era where chasing wealth has become the default.  
> Yet behind excessive wealth, there is always someone's pain.  
> Let us choose genuine happiness and love instead.  
> revchat is built to connect people freely, as equals.

## Features

- **Hostless P2P Mesh**: Connects peers directly via WebRTC (`trystero` over multi-relay Nostr signaling + same-browser `BroadcastChannel` fallback) — no central chat server, no database, and zero server logs.
- **Instant Room Join**: Enter `#LOBBY`, type any shared room code, or generate a `RANDOM` room code and share the URL hash link (`#room=...`) or scannable QR code via **INVITE**.
- **P2P Media & Voice Notes**: Send files, auto-compressed images, videos, and recorded voice notes up to 25 MB with progress tracking and cancellation.
- **WebRTC Room Calls**: Built-in audio calls, camera toggle/flip, and screen sharing with a persistent remote audio pool.
- **Ephemeral PWA Shell**: Installable PWA (`manifest.webmanifest` + app-shell service worker), unread title/favicon badge, light/dark themes, adjustable chat text sizing, and mobile drawer swipe gestures.