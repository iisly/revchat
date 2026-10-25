# revchat — Minimal P2P Chat Application

A lightweight, utilitarian, peer-to-peer (P2P) chatting web application engineered for both **Desktop (Web View)** and **Mobile View**.

## Key Features

- **Multi-Peer Room Mesh + Auto Host Failover**:
  - Enter any room code (e.g., `LOBBY` or `ROOM-4X9K`) or click **+ RANDOM**.
  - The first peer in a room acts as the WebRTC Rendezvous Beacon (`revchat-r-<room>`), introducing incoming peers so every participant automatically forms a **direct full-mesh WebRTC DataChannel** network.
  - If the room coordinator leaves, remaining peers maintain their mesh connections and automatically elect the next coordinator.
- **3-Layer Connectivity Engine**:
  1. **WebRTC Mesh via PeerJS (`WEBRTC`)**: Works across networks using room codes, direct peer codes, shareable links, or QR codes.
  2. **Instant Local Tab/Window Mesh (`LOCAL`)**: Uses `BroadcastChannel` + WebRTC so multiple tabs on the same browser discover and message each other in `<1ms` with zero config.
  3. **Serverless Manual WebRTC SDP (`SDP`)**: 100% zero-server fallback using raw `RTCPeerConnection` Offer/Answer token exchange.
- **Rich Chat Capabilities**:
  - Live per-peer RTT latency (`ms`) via `PING`/`PONG` heartbeats
  - Delivery acknowledgments (`✓` sent, `✓✓ N` acknowledged by `N` peers)
  - Late-joiner recent history synchronization
  - Private 1:1 direct messages (`[DM]`) inside or across rooms
  - Message reply quotes, live typing indicators, instant message search, and JSON transcript export
  - Slash commands: `/nick <name>`, `/room <code>`, `/me <action>`, `/shrug`, `/clear`, `/help`
- **Desktop & Mobile Ergonomics**:
  - **Web View (`>= 768px`)**: Persistent 2-column split view with full control panel and live peer telemetry.
  - **Mobile View (`< 768px`)**: Dynamic viewport (`visualViewport` height tracking so soft keyboards never cover the composer or header), slide-over room/peer drawer, `16px` inputs (prevents iOS auto-zoom), native Web Share API (`navigator.share`), and scannable SVG QR codes.

## Quick Start

```bash
npm install
npm run dev
```

