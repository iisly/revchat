import Peer, { DataConnection } from 'peerjs';
import {
  ChatMessage,
  ConnectionTransport,
  P2PPacket,
  PeerInfo,
  SignalingState,
  UserProfile,
} from './types';
import { generateUUID, normalizeRoomId } from './storage';
import {
  decodeBase64Utf8,
  encodeBase64Utf8,
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_NICKNAME_LENGTH,
  MAX_PEERS_IN_ROOM,
  MAX_RAW_PACKET_BYTES,
  PeerRateLimiter,
  safeJsonParse,
  sanitizeId,
  sanitizeString,
  validateChatMessage,
  validateIncomingPacket,
} from './security';

const PEER_PREFIX = 'revchat-p-';
const ROOM_BEACON_PREFIX = 'revchat-r-';
const SEEN_PACKET_LIMIT = 1500;
const PING_INTERVAL_MS = 4000;

interface ManualPendingSession {
  pc: RTCPeerConnection;
  dc?: RTCDataChannel;
}

export interface P2PEngineCallbacks {
  onSignalingChange: (state: SignalingState) => void;
  onPeersChange: (peers: PeerInfo[]) => void;
  onChatMessage: (msg: ChatMessage, isHistorySync: boolean) => void;
  onMessageAck: (messageId: string, ackPeerId: string) => void;
  onTypingChange: (typingPeers: { peerId: string; nickname: string }[]) => void;
  onSystemLog: (text: string) => void;
  getRecentRoomMessages: (roomId: string) => ChatMessage[];
}

export class P2PEngine {
  private profile: UserProfile;
  private callbacks: P2PEngineCallbacks;
  private roomId: string;

  private myPeerId: string;
  private personalPeer: Peer | null = null;
  private beaconPeer: Peer | null = null;
  private isBeaconHost = false;
  private signalingStatus: SignalingState['status'] = 'initializing';
  private signalingError?: string;

  // Active peer connections by remote personal peerId
  private peerConnections = new Map<string, DataConnection>();
  // Beacon connections (remote peers connected to our beacon instance, or our connection to remote beacon)
  private beaconConnections = new Map<string, DataConnection>();
  // Manual WebRTC data channels by remote peerId
  private manualChannels = new Map<string, { pc: RTCPeerConnection; dc: RTCDataChannel }>();
  private pendingManual: ManualPendingSession | null = null;

  // Local BroadcastChannel for instant same-browser multi-tab discovery & mesh
  private broadcastChannel: BroadcastChannel | null = null;

  // Metadata about known connected peers in the current room
  private peers = new Map<string, PeerInfo>();

  // Deduplication cache for packet IDs
  private seenPackets = new Set<string>();
  private seenPacketQueue: string[] = [];

  // Per-peer rate limiter against floods / relay storms
  private rateLimiter = new PeerRateLimiter();

  // Typing status map: peerId -> { nickname, expiresAt }
  private typingMap = new Map<string, { nickname: string; expiresAt: number }>();

  // Timers
  private pingTimer: number | null = null;
  private beaconCheckTimer: number | null = null;
  private typingCleanupTimer: number | null = null;
  private destroyed = false;

  constructor(profile: UserProfile, initialRoomId: string, callbacks: P2PEngineCallbacks) {
    this.profile = profile;
    this.roomId = normalizeRoomId(initialRoomId);
    this.callbacks = callbacks;
    this.myPeerId = `${PEER_PREFIX}${sanitizeId(profile.clientId).toLowerCase()}`;
  }

  public start(): void {
    this.initLocalBroadcast(this.roomId);
    this.initPersonalPeer();
    this.initRoomBeaconOrJoin(this.roomId);

    this.pingTimer = window.setInterval(() => this.sendHeartbeats(), PING_INTERVAL_MS);
    this.typingCleanupTimer = window.setInterval(() => this.cleanupTyping(), 1000);
    this.beaconCheckTimer = window.setInterval(() => this.ensureRoomConnectivity(), 9000);
  }

  public destroy(): void {
    this.destroyed = true;
    this.broadcastLeave();
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.typingCleanupTimer) clearInterval(this.typingCleanupTimer);
    if (this.beaconCheckTimer) clearInterval(this.beaconCheckTimer);
    this.teardownRoomConnections();
    if (this.personalPeer) {
      this.personalPeer.destroy();
      this.personalPeer = null;
    }
  }

  public getMyPeerId(): string {
    return this.myPeerId;
  }

  public getShortPeerCode(): string {
    return this.profile.clientId.toUpperCase();
  }

  public getRoomId(): string {
    return this.roomId;
  }

  public updateProfile(profile: UserProfile): void {
    const oldNick = this.profile.nickname;
    this.profile = profile;
    if (oldNick !== profile.nickname) {
      this.broadcastPacket(
        'NICK_CHANGE',
        { nickname: sanitizeString(profile.nickname, MAX_NICKNAME_LENGTH, 'peer') },
        2
      );
    }
  }

  public switchRoom(newRoomId: string): void {
    const normalized = normalizeRoomId(newRoomId);
    if (normalized === this.roomId) return;

    this.broadcastLeave();
    this.teardownRoomConnections();
    this.roomId = normalized;
    this.peers.clear();
    this.typingMap.clear();
    this.emitPeersChange();
    this.emitTypingChange();
    this.emitSignalingState();

    this.initLocalBroadcast(this.roomId);
    this.initRoomBeaconOrJoin(this.roomId);
  }

  private teardownRoomConnections(): void {
    for (const conn of this.peerConnections.values()) {
      try {
        conn.close();
      } catch {
        // ignore
      }
    }
    this.peerConnections.clear();

    for (const conn of this.beaconConnections.values()) {
      try {
        conn.close();
      } catch {
        // ignore
      }
    }
    this.beaconConnections.clear();

    if (this.beaconPeer) {
      try {
        this.beaconPeer.destroy();
      } catch {
        // ignore
      }
      this.beaconPeer = null;
    }
    this.isBeaconHost = false;

    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.close();
      } catch {
        // ignore
      }
      this.broadcastChannel = null;
    }
  }

  // =========================================================================
  // 1. LOCAL BROADCAST CHANNEL (Same-Device Multi-Tab Zero-Config Mesh)
  // =========================================================================
  private initLocalBroadcast(roomId: string): void {
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      const bc = new BroadcastChannel(`revchat_local_${roomId}`);
      this.broadcastChannel = bc;
      bc.onmessage = (ev) => {
        const packet = validateIncomingPacket(ev.data);
        if (!packet || packet.senderId === this.myPeerId) return;
        if (!this.rateLimiter.allow(packet.senderId)) return;
        this.upsertPeer(packet.senderId, packet.senderName, 'local-broadcast');
        this.handleIncomingPacket(packet, 'local-broadcast');
      };

      // Announce presence immediately on local broadcast channel
      this.sendHelloPacket();
    } catch {
      // BroadcastChannel not supported or blocked
    }
  }

  // =========================================================================
  // 2. PEERJS PERSONAL NODE + ROOM RENDEZVOUS BEACON
  // =========================================================================
  private initPersonalPeer(): void {
    this.signalingStatus = 'initializing';
    this.emitSignalingState();

    try {
      const peer = new Peer(this.myPeerId, {
        debug: 0,
      });
      this.personalPeer = peer;

      peer.on('open', (id) => {
        this.myPeerId = id;
        this.signalingStatus = 'ready';
        this.signalingError = undefined;
        this.emitSignalingState();
        this.connectToRoomBeacon(this.roomId);
      });

      peer.on('connection', (conn) => {
        if (this.peerConnections.size >= MAX_PEERS_IN_ROOM) {
          try {
            conn.close();
          } catch {
            // ignore
          }
          return;
        }
        this.setupDataConnection(conn, false);
      });

      peer.on('disconnected', () => {
        if (this.destroyed) return;
        this.signalingStatus = 'offline';
        this.emitSignalingState();
        setTimeout(() => {
          if (this.personalPeer && !this.personalPeer.destroyed && this.personalPeer.disconnected) {
            try {
              this.personalPeer.reconnect();
            } catch {
              // ignore
            }
          }
        }, 3000);
      });

      peer.on('error', (err: any) => {
        const errType = err?.type || '';
        if (errType === 'unavailable-id') {
          // Another tab on same device holds our personal ID; append random suffix
          const suffix = Math.floor(100 + Math.random() * 899);
          this.myPeerId = `${PEER_PREFIX}${sanitizeId(this.profile.clientId).toLowerCase()}-${suffix}`;
          try {
            peer.destroy();
          } catch {
            // ignore
          }
          this.initPersonalPeer();
          return;
        }
        if (errType === 'peer-unavailable') {
          // Normal when probing a room beacon or peer that isn't online yet
          return;
        }
        this.signalingError = err?.message || String(err);
        if (this.signalingStatus === 'initializing') {
          this.signalingStatus = 'offline';
        }
        this.emitSignalingState();
      });
    } catch (err: any) {
      this.signalingStatus = 'error';
      this.signalingError = err?.message || 'Failed to initialize WebRTC Peer';
      this.emitSignalingState();
    }
  }

  private getBeaconIdForRoom(roomId: string): string {
    const clean = normalizeRoomId(roomId).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return `${ROOM_BEACON_PREFIX}${clean}`;
  }

  private initRoomBeaconOrJoin(roomId: string): void {
    const beaconId = this.getBeaconIdForRoom(roomId);
    if (this.beaconPeer) {
      try {
        this.beaconPeer.destroy();
      } catch {
        // ignore
      }
      this.beaconPeer = null;
    }

    try {
      const beacon = new Peer(beaconId, { debug: 0 });
      this.beaconPeer = beacon;

      beacon.on('open', () => {
        if (this.destroyed || this.roomId !== roomId) {
          beacon.destroy();
          return;
        }
        this.isBeaconHost = true;
        this.emitSignalingState();
        this.callbacks.onSystemLog(`Room [${roomId}] ready (acting as room coordinator).`);
      });

      beacon.on('connection', (conn) => {
        if (this.beaconConnections.size >= MAX_PEERS_IN_ROOM) {
          try {
            conn.close();
          } catch {
            // ignore
          }
          return;
        }
        this.setupDataConnection(conn, true);
      });

      beacon.on('error', (err: any) => {
        const errType = err?.type || '';
        if (errType === 'unavailable-id') {
          // Someone else is already the room coordinator! Destroy our candidate beacon and connect to theirs.
          this.isBeaconHost = false;
          try {
            beacon.destroy();
          } catch {
            // ignore
          }
          if (this.beaconPeer === beacon) {
            this.beaconPeer = null;
          }
          this.emitSignalingState();
          this.connectToRoomBeacon(roomId);
        }
      });
    } catch {
      this.connectToRoomBeacon(roomId);
    }
  }

  private connectToRoomBeacon(roomId: string): void {
    if (!this.personalPeer || this.personalPeer.disconnected || this.personalPeer.destroyed) {
      return;
    }
    if (this.isBeaconHost) {
      return;
    }
    const beaconId = this.getBeaconIdForRoom(roomId);
    if (this.beaconConnections.has(beaconId)) {
      return;
    }

    try {
      const conn = this.personalPeer.connect(beaconId, {
        reliable: true,
        metadata: {
          senderId: this.myPeerId,
          nickname: this.profile.nickname,
          roomId: this.roomId,
        },
      });
      this.setupDataConnection(conn, true);
    } catch {
      // ignore
    }
  }

  public connectToDirectPeer(targetInput: string): boolean {
    const cleaned = sanitizeId(targetInput).toLowerCase();
    if (!cleaned) return false;
    const fullPeerId = cleaned.startsWith(PEER_PREFIX)
      ? cleaned
      : cleaned.startsWith('revchat-')
      ? cleaned
      : `${PEER_PREFIX}${cleaned}`;

    if (fullPeerId === this.myPeerId) return false;
    if (this.peerConnections.has(fullPeerId)) return true;
    if (this.peerConnections.size >= MAX_PEERS_IN_ROOM) return false;
    if (!this.personalPeer || this.personalPeer.destroyed) return false;

    try {
      const conn = this.personalPeer.connect(fullPeerId, {
        reliable: true,
        metadata: {
          senderId: this.myPeerId,
          nickname: this.profile.nickname,
          roomId: this.roomId,
        },
      });
      this.setupDataConnection(conn, false);
      this.callbacks.onSystemLog(`Dialing peer ${fullPeerId}...`);
      return true;
    } catch {
      return false;
    }
  }

  private setupDataConnection(conn: DataConnection, isBeaconChannel: boolean): void {
    const remotePeerId = sanitizeId(conn.peer);
    if (!remotePeerId) {
      try {
        conn.close();
      } catch {
        // ignore
      }
      return;
    }

    conn.on('open', () => {
      if (isBeaconChannel) {
        this.beaconConnections.set(remotePeerId, conn);
      } else {
        this.peerConnections.set(remotePeerId, conn);
      }

      // Send our HELLO packet over this connection
      const helloPacket = this.createPacket('HELLO', {
        nickname: this.profile.nickname,
        isBeaconHost: this.isBeaconHost,
      });
      this.safeSendConn(conn, helloPacket);

      // Send known peer list so all peers form a direct full mesh
      const knownPeerIds = Array.from(this.peers.keys()).slice(0, MAX_PEERS_IN_ROOM);
      if (!knownPeerIds.includes(this.myPeerId)) {
        knownPeerIds.push(this.myPeerId);
      }
      const peerListPacket = this.createPacket('PEER_LIST', {
        peers: knownPeerIds,
      });
      this.safeSendConn(conn, peerListPacket);

      // Sync recent room history if enabled
      if (this.profile.syncHistoryOnJoin) {
        const recent = this.callbacks.getRecentRoomMessages(this.roomId).slice(-50);
        if (recent.length > 0) {
          const syncPacket = this.createPacket('HISTORY_SYNC', {
            messages: recent,
          });
          this.safeSendConn(conn, syncPacket);
        }
      }
    });

    conn.on('data', (raw: unknown) => {
      const packet = validateIncomingPacket(raw);
      if (!packet) return;
      if (!this.rateLimiter.allow(packet.senderId)) return;

      // Associate connection with the actual personal senderId if it came through a direct channel
      if (packet.senderId && packet.senderId !== this.myPeerId && !isBeaconChannel) {
        this.peerConnections.set(packet.senderId, conn);
      }

      this.upsertPeer(
        packet.senderId,
        packet.senderName,
        'peerjs-mesh',
        Boolean(packet.payload?.isBeaconHost)
      );
      this.handleIncomingPacket(packet, 'peerjs-mesh', conn);
    });

    const handleClose = () => {
      if (isBeaconChannel) {
        this.beaconConnections.delete(remotePeerId);
      } else {
        this.peerConnections.delete(remotePeerId);
        if (this.peers.has(remotePeerId)) {
          this.peers.delete(remotePeerId);
          this.emitPeersChange();
        }
      }
    };

    conn.on('close', handleClose);
    conn.on('error', handleClose);
  }

  private ensureRoomConnectivity(): void {
    if (this.destroyed) return;
    this.rateLimiter.prune();
    if (!this.isBeaconHost && this.beaconConnections.size === 0) {
      // Try claiming the beacon if the previous beacon host left, or reconnecting to it
      this.initRoomBeaconOrJoin(this.roomId);
    }
    this.sendHelloPacket();
  }

  // =========================================================================
  // 3. MANUAL SERVERLESS WEBRTC SDP ENGINE (Zero-Server Offer/Answer)
  // =========================================================================
  public async createManualOffer(): Promise<string> {
    if (this.pendingManual) {
      try {
        this.pendingManual.pc.close();
      } catch {
        // ignore
      }
    }

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });

    const dc = pc.createDataChannel('revchat', { ordered: true });
    this.pendingManual = { pc, dc };
    this.bindManualDataChannel(pc, dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitForIceGathering(pc, 2200);

    const tokenObj = {
      t: 'offer',
      p: this.myPeerId,
      n: this.profile.nickname,
      r: this.roomId,
      sdp: pc.localDescription?.sdp || offer.sdp,
    };

    return encodeBase64Utf8(tokenObj);
  }

  public async acceptManualOfferAndCreateAnswer(offerToken: string): Promise<string> {
    const decoded = decodeBase64Utf8<{ t?: string; sdp?: string }>(offerToken);
    if (!decoded || decoded.t !== 'offer' || typeof decoded.sdp !== 'string') {
      throw new Error('Invalid or oversized Offer Token');
    }

    if (this.pendingManual) {
      try {
        this.pendingManual.pc.close();
      } catch {
        // ignore
      }
    }

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });

    this.pendingManual = { pc };
    pc.ondatachannel = (event) => {
      this.bindManualDataChannel(pc, event.channel);
    };

    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: decoded.sdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.waitForIceGathering(pc, 2200);

    const tokenObj = {
      t: 'answer',
      p: this.myPeerId,
      n: this.profile.nickname,
      r: this.roomId,
      sdp: pc.localDescription?.sdp || answer.sdp,
    };

    return encodeBase64Utf8(tokenObj);
  }

  public async completeManualHandshake(answerToken: string): Promise<void> {
    if (!this.pendingManual) {
      throw new Error('No pending Offer found. Generate an Offer first.');
    }
    const decoded = decodeBase64Utf8<{ t?: string; sdp?: string }>(answerToken);
    if (!decoded || decoded.t !== 'answer' || typeof decoded.sdp !== 'string') {
      throw new Error('Invalid or oversized Answer Token');
    }

    await this.pendingManual.pc.setRemoteDescription(
      new RTCSessionDescription({ type: 'answer', sdp: decoded.sdp })
    );
  }

  private bindManualDataChannel(pc: RTCPeerConnection, dc: RTCDataChannel): void {
    let remoteId = '';

    dc.onopen = () => {
      const hello = this.createPacket('HELLO', {
        nickname: this.profile.nickname,
        isBeaconHost: this.isBeaconHost,
      });
      try {
        dc.send(JSON.stringify(hello));
      } catch {
        // ignore
      }

      if (this.profile.syncHistoryOnJoin) {
        const recent = this.callbacks.getRecentRoomMessages(this.roomId).slice(-50);
        if (recent.length > 0) {
          const syncPacket = this.createPacket('HISTORY_SYNC', { messages: recent });
          try {
            dc.send(JSON.stringify(syncPacket));
          } catch {
            // ignore
          }
        }
      }
    };

    dc.onmessage = (ev) => {
      if (typeof ev.data !== 'string' || ev.data.length > MAX_RAW_PACKET_BYTES) return;
      const parsed = safeJsonParse(ev.data, MAX_RAW_PACKET_BYTES);
      const packet = validateIncomingPacket(parsed);
      if (!packet) return;
      if (!this.rateLimiter.allow(packet.senderId)) return;

      remoteId = packet.senderId;
      this.manualChannels.set(remoteId, { pc, dc });
      this.upsertPeer(packet.senderId, packet.senderName, 'manual-webrtc');
      this.handleIncomingPacket(packet, 'manual-webrtc');
    };

    dc.onclose = () => {
      if (remoteId) {
        this.manualChannels.delete(remoteId);
        this.peers.delete(remoteId);
        this.emitPeersChange();
      }
    };
  }

  private waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }, timeoutMs);
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  // =========================================================================
  // 4. PACKET ROUTING, DEDUPLICATION, AND CHAT LOGIC
  // =========================================================================
  private markPacketSeen(packetId: string): boolean {
    if (this.seenPackets.has(packetId)) return true;
    this.seenPackets.add(packetId);
    this.seenPacketQueue.push(packetId);
    if (this.seenPacketQueue.length > SEEN_PACKET_LIMIT) {
      const oldest = this.seenPacketQueue.shift();
      if (oldest) this.seenPackets.delete(oldest);
    }
    return false;
  }

  private createPacket(type: P2PPacket['type'], payload: any, ttl = 2): P2PPacket {
    const packet: P2PPacket = {
      packetId: generateUUID(),
      type,
      roomId: this.roomId,
      senderId: this.myPeerId,
      senderName: this.profile.nickname,
      timestamp: Date.now(),
      ttl,
      payload,
    };
    this.markPacketSeen(packet.packetId);
    return packet;
  }

  private broadcastPacket(type: P2PPacket['type'], payload: any, ttl = 2): P2PPacket {
    const packet = this.createPacket(type, payload, ttl);
    this.dispatchPacketToAll(packet);
    return packet;
  }

  private dispatchPacketToAll(packet: P2PPacket, excludeConn?: DataConnection): void {
    // 1. BroadcastChannel (same-device tabs)
    if (this.broadcastChannel && packet.roomId === this.roomId) {
      try {
        this.broadcastChannel.postMessage(packet);
      } catch {
        // ignore
      }
    }

    // 2. Direct PeerJS mesh connections
    for (const conn of this.peerConnections.values()) {
      if (conn !== excludeConn && conn.open) {
        this.safeSendConn(conn, packet);
      }
    }

    // 3. Beacon connections (relay fallback)
    for (const conn of this.beaconConnections.values()) {
      if (conn !== excludeConn && conn.open) {
        this.safeSendConn(conn, packet);
      }
    }

    // 4. Manual WebRTC channels
    const serialized = JSON.stringify(packet);
    if (serialized.length <= MAX_RAW_PACKET_BYTES) {
      for (const { dc } of this.manualChannels.values()) {
        if (dc.readyState === 'open') {
          try {
            dc.send(serialized);
          } catch {
            // ignore
          }
        }
      }
    }
  }

  private safeSendConn(conn: DataConnection, packet: P2PPacket): void {
    try {
      if (conn.open) {
        conn.send(packet);
      }
    } catch {
      // ignore send errors
    }
  }

  private handleIncomingPacket(
    packet: P2PPacket,
    transport: ConnectionTransport,
    sourceConn?: DataConnection
  ): void {
    if (packet.senderId === this.myPeerId) return;
    if (this.markPacketSeen(packet.packetId)) return;

    // Relay packet if TTL > 1 (enables Hub Relay & Manual-WebRTC Bridge across room peers!)
    if (packet.ttl > 1) {
      const relayed: P2PPacket = { ...packet, ttl: packet.ttl - 1 };
      this.dispatchPacketToAll(relayed, sourceConn);
    }

    switch (packet.type) {
      case 'HELLO': {
        const nick = sanitizeString(packet.payload?.nickname, MAX_NICKNAME_LENGTH, packet.senderName);
        this.upsertPeer(
          packet.senderId,
          nick,
          transport,
          Boolean(packet.payload?.isBeaconHost)
        );
        // Reply with PONG so they immediately get RTT
        const pong = this.createPacket(
          'PONG',
          { targetId: packet.senderId, sentAt: packet.timestamp },
          1
        );
        this.dispatchPacketToAll(pong);
        break;
      }

      case 'PEER_LIST': {
        const rawList = packet.payload?.peers;
        if (!Array.isArray(rawList)) break;
        const list = rawList.slice(0, MAX_PEERS_IN_ROOM);
        for (const rawPeerId of list) {
          const peerId = sanitizeId(rawPeerId).toLowerCase();
          if (
            peerId &&
            peerId !== this.myPeerId &&
            !this.peerConnections.has(peerId) &&
            peerId.startsWith(PEER_PREFIX)
          ) {
            this.connectToDirectPeer(peerId);
          }
        }
        break;
      }

      case 'CHAT_MSG': {
        const msg = validateChatMessage(packet.payload?.message, this.roomId);
        if (!msg) break;
        // Enforce that senderId matches the authenticated packet senderId
        msg.senderId = packet.senderId;
        // If private whisper to someone else, ignore display (already relayed if needed)
        if (msg.targetPeerId && msg.targetPeerId !== this.myPeerId && msg.senderId !== this.myPeerId) {
          break;
        }
        this.typingMap.delete(packet.senderId);
        this.emitTypingChange();
        this.callbacks.onChatMessage(msg, false);

        // Send delivery ACK back
        const ack = this.createPacket(
          'CHAT_ACK',
          { messageId: msg.id, ackPeerId: this.myPeerId },
          2
        );
        this.dispatchPacketToAll(ack);
        break;
      }

      case 'CHAT_ACK': {
        const messageId = sanitizeId(packet.payload?.messageId);
        const ackPeerId = sanitizeId(packet.payload?.ackPeerId);
        if (messageId && ackPeerId && ackPeerId === packet.senderId) {
          this.callbacks.onMessageAck(messageId, ackPeerId);
        }
        break;
      }

      case 'HISTORY_SYNC': {
        if (!this.profile.syncHistoryOnJoin) break;
        const rawMessages = packet.payload?.messages;
        if (!Array.isArray(rawMessages)) break;
        const capped = rawMessages.slice(-50);
        for (const rawMsg of capped) {
          const validMsg = validateChatMessage(rawMsg, this.roomId);
          if (validMsg && !validMsg.targetPeerId) {
            this.callbacks.onChatMessage(validMsg, true);
          }
        }
        break;
      }

      case 'TYPING': {
        const isTyping = Boolean(packet.payload?.isTyping);
        if (isTyping) {
          this.typingMap.set(packet.senderId, {
            nickname: packet.senderName,
            expiresAt: Date.now() + 3800,
          });
        } else {
          this.typingMap.delete(packet.senderId);
        }
        this.emitTypingChange();
        break;
      }

      case 'PING': {
        const pong = this.createPacket(
          'PONG',
          { targetId: packet.senderId, sentAt: Number(packet.payload?.sentAt) || packet.timestamp },
          1
        );
        this.dispatchPacketToAll(pong);
        break;
      }

      case 'PONG': {
        const sentAt = Number(packet.payload?.sentAt);
        if (packet.payload?.targetId === this.myPeerId && Number.isFinite(sentAt) && sentAt > 0) {
          const rtt = Math.min(60000, Math.max(1, Date.now() - sentAt));
          const existing = this.peers.get(packet.senderId);
          if (existing) {
            existing.rttMs = rtt;
            existing.lastSeenAt = Date.now();
            this.emitPeersChange();
          }
        }
        break;
      }

      case 'NICK_CHANGE': {
        const newNick = sanitizeString(
          packet.payload?.nickname,
          MAX_NICKNAME_LENGTH,
          packet.senderName
        ).trim();
        if (!newNick) break;
        const existing = this.peers.get(packet.senderId);
        if (existing) {
          const oldNick = existing.nickname;
          existing.nickname = newNick;
          existing.lastSeenAt = Date.now();
          this.emitPeersChange();
          if (oldNick !== newNick) {
            this.callbacks.onSystemLog(`${oldNick} is now known as ${newNick}`);
          }
        }
        break;
      }

      case 'LEAVE': {
        const existing = this.peers.get(packet.senderId);
        if (existing) {
          this.peers.delete(packet.senderId);
          this.typingMap.delete(packet.senderId);
          this.emitPeersChange();
          this.emitTypingChange();
          this.callbacks.onSystemLog(`${existing.nickname} left the room.`);
        }
        break;
      }
    }
  }

  private upsertPeer(
    peerId: string,
    nickname: string,
    transport: ConnectionTransport,
    isBeaconHost?: boolean
  ): void {
    if (!peerId || peerId === this.myPeerId) return;
    if (!this.peers.has(peerId) && this.peers.size >= MAX_PEERS_IN_ROOM) return;
    const safeNick = sanitizeString(nickname, MAX_NICKNAME_LENGTH, peerId.slice(-6)).trim();
    const now = Date.now();
    const existing = this.peers.get(peerId);
    if (existing) {
      existing.nickname = safeNick || existing.nickname;
      existing.lastSeenAt = now;
      existing.state = 'connected';
      if (transport === 'peerjs-mesh' || transport === 'manual-webrtc') {
        existing.transport = transport;
      }
      if (typeof isBeaconHost === 'boolean') {
        existing.isRoomBeaconHolder = isBeaconHost;
      }
    } else {
      this.peers.set(peerId, {
        peerId,
        nickname: safeNick || peerId.slice(-6),
        transport,
        state: 'connected',
        rttMs: transport === 'local-broadcast' ? 1 : null,
        isRoomBeaconHolder: isBeaconHost,
        connectedAt: now,
        lastSeenAt: now,
      });
      this.callbacks.onSystemLog(`${safeNick || peerId} connected (${transport}).`);
    }
    this.emitPeersChange();
  }

  // =========================================================================
  // 5. PUBLIC ACTIONS (SEND CHAT, TYPING, HEARTBEATS)
  // =========================================================================
  public sendChatMessage(
    text: string,
    replyTo?: ChatMessage['replyTo'],
    whisperPeer?: { peerId: string; nickname: string }
  ): ChatMessage {
    const cleanText = sanitizeString(text, MAX_MESSAGE_TEXT_LENGTH).trim();
    const msg: ChatMessage = {
      id: generateUUID(),
      roomId: this.roomId,
      senderId: this.myPeerId,
      senderName: this.profile.nickname,
      text: cleanText,
      timestamp: Date.now(),
      replyTo,
      targetPeerId: whisperPeer?.peerId,
      targetPeerName: whisperPeer?.nickname,
      ackedBy: [],
    };

    this.broadcastPacket('CHAT_MSG', { message: msg }, 3);
    return msg;
  }

  public sendTyping(isTyping: boolean): void {
    this.broadcastPacket('TYPING', { isTyping }, 1);
  }

  private sendHelloPacket(): void {
    this.broadcastPacket(
      'HELLO',
      { nickname: this.profile.nickname, isBeaconHost: this.isBeaconHost },
      2
    );
  }

  private sendHeartbeats(): void {
    if (this.destroyed) return;
    const now = Date.now();
    this.broadcastPacket('PING', { sentAt: now }, 1);

    // Prune stale broadcast-only peers that haven't responded in 18s
    let changed = false;
    for (const [id, peer] of this.peers.entries()) {
      if (now - peer.lastSeenAt > 18000) {
        this.peers.delete(id);
        this.typingMap.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.emitPeersChange();
      this.emitTypingChange();
    }
  }

  private broadcastLeave(): void {
    try {
      this.broadcastPacket('LEAVE', {}, 2);
    } catch {
      // ignore
    }
  }

  private cleanupTyping(): void {
    const now = Date.now();
    let changed = false;
    for (const [peerId, info] of this.typingMap.entries()) {
      if (now > info.expiresAt) {
        this.typingMap.delete(peerId);
        changed = true;
      }
    }
    if (changed) {
      this.emitTypingChange();
    }
  }

  private emitSignalingState(): void {
    this.callbacks.onSignalingChange({
      status: this.signalingStatus,
      myPeerId: this.myPeerId,
      roomId: this.roomId,
      isBeaconHost: this.isBeaconHost,
      errorMessage: this.signalingError,
    });
  }

  private emitPeersChange(): void {
    const list = Array.from(this.peers.values()).sort((a, b) =>
      a.nickname.localeCompare(b.nickname)
    );
    this.callbacks.onPeersChange(list);
  }

  private emitTypingChange(): void {
    const list = Array.from(this.typingMap.entries()).map(([peerId, info]) => ({
      peerId,
      nickname: info.nickname,
    }));
    this.callbacks.onTypingChange(list);
  }
}
