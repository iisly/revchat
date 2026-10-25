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
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_NICKNAME_LENGTH,
  MAX_PEERS_IN_ROOM,
  PeerRateLimiter,
  sanitizeId,
  sanitizeString,
  validateChatMessage,
  validateIncomingPacket,
} from './security';

const PEER_PREFIX = 'revchat-p-';
const ROOM_BEACON_PREFIX = 'revchat-r-';
const SEEN_PACKET_LIMIT = 1500;
const PING_INTERVAL_MS = 4000;
const PEER_TIMEOUT_MS = 12000;
const OUTBOX_TTL_MS = 12000;

const RTC_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

export interface P2PEngineCallbacks {
  onSignalingChange: (state: SignalingState) => void;
  onPeersChange: (peers: PeerInfo[]) => void;
  onChatMessage: (msg: ChatMessage) => void;
  onMessageAck: (messageId: string, ackPeerId: string) => void;
  onTypingChange: (typingPeers: { peerId: string; nickname: string }[]) => void;
  onSystemLog: (text: string) => void;
  onRoomFollowed: (newRoomId: string, peerNickname: string) => void;
}

export class P2PEngine {
  private profile: UserProfile;
  private callbacks: P2PEngineCallbacks;
  private roomId: string;

  private myPeerId: string;
  private personalPeer: Peer | null = null;
  private beaconPeer: Peer | null = null;
  private beaconInitializing = false;
  private isBeaconHost = false;
  private signalingStatus: SignalingState['status'] = 'initializing';
  private signalingError?: string;

  private peerConnections = new Map<string, DataConnection>();
  private beaconConnections = new Map<string, DataConnection>();
  private broadcastChannel: BroadcastChannel | null = null;
  private peers = new Map<string, PeerInfo>();
  private dialedPeerToFollow: string | null = null;

  private seenPackets = new Set<string>();
  private seenPacketQueue: string[] = [];
  private rateLimiter = new PeerRateLimiter();
  private typingMap = new Map<string, { nickname: string; timer: number }>();
  private pendingOutbox = new Map<string, { msg: ChatMessage; createdAt: number }>();

  private pingTimer: number | null = null;
  private destroyed = false;

  private readonly onVisibilityOrOnline = () => {
    if (this.destroyed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    this.ensureRoomConnectivity();
    this.sendHeartbeats();
  };

  constructor(profile: UserProfile, initialRoomId: string, callbacks: P2PEngineCallbacks) {
    this.profile = profile;
    this.roomId = normalizeRoomId(initialRoomId);
    this.callbacks = callbacks;
    this.myPeerId = `${PEER_PREFIX}${sanitizeId(profile.clientId).toLowerCase()}`;
  }

  public start(): void {
    this.initLocalBroadcast(this.roomId);
    this.initPersonalPeer();

    this.pingTimer = window.setInterval(() => this.sendHeartbeats(), PING_INTERVAL_MS);

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onVisibilityOrOnline);
      document.addEventListener('visibilitychange', this.onVisibilityOrOnline);
    }
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.broadcastLeave();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.clearAllTyping();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onVisibilityOrOnline);
      document.removeEventListener('visibilitychange', this.onVisibilityOrOnline);
    }
    this.teardownRoomConnections();
    if (this.personalPeer) {
      this.personalPeer.destroy();
      this.personalPeer = null;
    }
  }

  public getMyPeerId(): string {
    return this.myPeerId;
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
    this.clearAllTyping();
    this.pendingOutbox.clear();
    this.emitPeersChange();
    this.emitTypingChange();
    this.emitSignalingState();

    this.initLocalBroadcast(this.roomId);
    this.initRoomBeaconOrJoin(this.roomId);
  }

  private teardownRoomConnections(preserveConn?: DataConnection): void {
    for (const conn of this.peerConnections.values()) {
      if (conn === preserveConn) continue;
      try {
        conn.close();
      } catch {
        // ignore
      }
    }
    this.peerConnections.clear();

    for (const conn of this.beaconConnections.values()) {
      if (conn === preserveConn) continue;
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
    this.beaconInitializing = false;
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

  private initLocalBroadcast(roomId: string): void {
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      const bc = new BroadcastChannel(`revchat_local_${roomId}`);
      this.broadcastChannel = bc;
      bc.onmessage = (ev) => {
        const packet = validateIncomingPacket(ev.data);
        if (!packet || packet.senderId === this.myPeerId) return;
        if (packet.roomId !== this.roomId) return;
        if (!this.rateLimiter.allow(packet.senderId)) return;
        this.upsertPeer(packet.senderId, packet.senderName, 'local-broadcast');
        this.handleIncomingPacket(packet, 'local-broadcast');
      };
      this.sendHelloPacket();
    } catch {
      // BroadcastChannel not supported
    }
  }

  private initPersonalPeer(): void {
    if (this.destroyed) return;
    if (this.personalPeer) {
      try {
        this.personalPeer.destroy();
      } catch {
        // ignore
      }
      this.personalPeer = null;
    }

    this.signalingStatus = 'initializing';
    this.emitSignalingState();

    try {
      const peer = new Peer(this.myPeerId, {
        debug: 0,
        config: { iceServers: RTC_ICE_SERVERS },
      });
      this.personalPeer = peer;

      peer.on('open', (id) => {
        if (this.destroyed || this.personalPeer !== peer) return;
        this.myPeerId = id;
        this.signalingStatus = 'ready';
        this.signalingError = undefined;
        this.emitSignalingState();

        if (!this.isBeaconHost && !this.beaconPeer && !this.beaconInitializing) {
          this.initRoomBeaconOrJoin(this.roomId);
        } else if (!this.isBeaconHost) {
          this.connectToRoomBeacon(this.roomId);
        }
      });

      peer.on('connection', (conn) => {
        this.pruneDeadConnections();
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
        if (this.destroyed || this.personalPeer !== peer) return;
        this.signalingStatus = 'offline';
        this.emitSignalingState();
        if (typeof navigator === 'undefined' || navigator.onLine !== false) {
          try {
            peer.reconnect();
          } catch {
            // ignore
          }
        }
      });

      peer.on('error', (err: any) => {
        if (this.destroyed || this.personalPeer !== peer) return;
        const errType = err?.type || '';
        if (errType === 'unavailable-id') {
          const suffix = Math.floor(100 + Math.random() * 899);
          this.myPeerId = `${PEER_PREFIX}${sanitizeId(this.profile.clientId).toLowerCase()}-${suffix}`;
          this.initPersonalPeer();
          return;
        }
        if (errType === 'peer-unavailable') return;
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
    if (this.destroyed || this.roomId !== roomId || this.beaconInitializing) return;
    const beaconId = this.getBeaconIdForRoom(roomId);
    if (this.beaconPeer) {
      try {
        this.beaconPeer.destroy();
      } catch {
        // ignore
      }
      this.beaconPeer = null;
    }

    this.beaconInitializing = true;
    try {
      const beacon = new Peer(beaconId, {
        debug: 0,
        config: { iceServers: RTC_ICE_SERVERS },
      });
      this.beaconPeer = beacon;

      beacon.on('open', () => {
        this.beaconInitializing = false;
        if (this.destroyed || this.roomId !== roomId || this.beaconPeer !== beacon) {
          try {
            beacon.destroy();
          } catch {
            // ignore
          }
          return;
        }
        this.isBeaconHost = true;
        this.emitSignalingState();
        this.callbacks.onSystemLog(`Room [${roomId}] ready (acting as room coordinator).`);
      });

      beacon.on('connection', (conn) => {
        this.pruneDeadConnections();
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

      beacon.on('disconnected', () => {
        if (this.destroyed || this.beaconPeer !== beacon) return;
        if (typeof navigator === 'undefined' || navigator.onLine !== false) {
          try {
            beacon.reconnect();
          } catch {
            // ignore
          }
        }
      });

      beacon.on('error', (err: any) => {
        this.beaconInitializing = false;
        const errType = err?.type || '';
        if (errType === 'peer-unavailable') return;
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
        if (errType === 'unavailable-id') {
          this.connectToRoomBeacon(roomId);
        }
      });
    } catch {
      this.beaconInitializing = false;
      this.connectToRoomBeacon(roomId);
    }
  }

  private connectToRoomBeacon(roomId: string): void {
    if (!this.personalPeer || this.personalPeer.disconnected || this.personalPeer.destroyed) {
      return;
    }
    if (this.isBeaconHost) return;
    this.pruneDeadConnections();
    const beaconId = this.getBeaconIdForRoom(roomId);
    const existing = this.beaconConnections.get(beaconId);
    if (existing && this.isConnAlive(existing)) return;
    this.beaconConnections.delete(beaconId);

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

  public connectToDirectPeer(targetInput: string, followRoom = true): boolean {
    const cleaned = sanitizeId(targetInput).toLowerCase();
    if (!cleaned) return false;
    const fullPeerId = cleaned.startsWith(PEER_PREFIX)
      ? cleaned
      : cleaned.startsWith('revchat-')
      ? cleaned
      : `${PEER_PREFIX}${cleaned}`;

    if (fullPeerId === this.myPeerId) return false;
    if (followRoom) {
      this.dialedPeerToFollow = fullPeerId;
    }

    this.pruneDeadConnections();
    const existingConn = this.peerConnections.get(fullPeerId);
    if (existingConn && this.isConnAlive(existingConn)) {
      if (followRoom) {
        this.safeSendConn(
          existingConn,
          this.createPacket('HELLO', {
            nickname: this.profile.nickname,
            isBeaconHost: this.isBeaconHost,
          })
        );
      }
      return true;
    }
    this.peerConnections.delete(fullPeerId);
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
      if (followRoom) {
        this.callbacks.onSystemLog(`Following peer ${fullPeerId}...`);
      }
      return true;
    } catch {
      return false;
    }
  }

  private followPeerIntoRoom(
    targetRoomId: string,
    peerNickname: string,
    preserveConn: DataConnection,
    remotePeerId: string
  ): void {
    const normalized = normalizeRoomId(targetRoomId);
    if (normalized === this.roomId) return;

    this.broadcastLeave();
    this.teardownRoomConnections(preserveConn);
    this.roomId = normalized;
    this.peers.clear();
    this.clearAllTyping();
    this.pendingOutbox.clear();
    this.peerConnections.set(remotePeerId, preserveConn);

    this.callbacks.onRoomFollowed(this.roomId, peerNickname);
    this.emitPeersChange();
    this.emitTypingChange();
    this.emitSignalingState();

    this.initLocalBroadcast(this.roomId);
    this.initRoomBeaconOrJoin(this.roomId);

    const helloPacket = this.createPacket('HELLO', {
      nickname: this.profile.nickname,
      isBeaconHost: this.isBeaconHost,
    });
    this.safeSendConn(preserveConn, helloPacket);
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

      if (
        this.dialedPeerToFollow &&
        (remotePeerId === this.dialedPeerToFollow ||
          remotePeerId.startsWith(`${this.dialedPeerToFollow}-`))
      ) {
        return;
      }

      const helloPacket = this.createPacket('HELLO', {
        nickname: this.profile.nickname,
        isBeaconHost: this.isBeaconHost,
      });
      this.safeSendConn(conn, helloPacket);

      const knownPeerIds = Array.from(this.peers.keys()).slice(0, MAX_PEERS_IN_ROOM);
      if (!knownPeerIds.includes(this.myPeerId)) {
        knownPeerIds.push(this.myPeerId);
      }
      const peerListPacket = this.createPacket('PEER_LIST', {
        peers: knownPeerIds,
      });
      this.safeSendConn(conn, peerListPacket);
    });

    conn.on('data', (raw: unknown) => {
      const packet = validateIncomingPacket(raw);
      if (!packet) return;
      if (!this.rateLimiter.allow(packet.senderId)) return;

      if (
        this.dialedPeerToFollow &&
        (packet.senderId === this.dialedPeerToFollow ||
          packet.senderId.startsWith(`${this.dialedPeerToFollow}-`) ||
          remotePeerId === this.dialedPeerToFollow)
      ) {
        this.dialedPeerToFollow = null;
        if (packet.roomId && packet.roomId !== this.roomId) {
          this.followPeerIntoRoom(packet.roomId, packet.senderName, conn, packet.senderId);
        } else {
          this.safeSendConn(
            conn,
            this.createPacket('HELLO', {
              nickname: this.profile.nickname,
              isBeaconHost: this.isBeaconHost,
            })
          );
        }
      }

      if (packet.roomId !== this.roomId) return;

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

    let closedHandled = false;
    const handleClose = () => {
      if (closedHandled) return;
      closedHandled = true;
      if (isBeaconChannel) {
        if (this.beaconConnections.get(remotePeerId) === conn) {
          this.beaconConnections.delete(remotePeerId);
        }
      } else {
        if (this.peerConnections.get(remotePeerId) === conn) {
          this.peerConnections.delete(remotePeerId);
        }
      }
    };

    conn.on('open', () => {
      const pc = (conn as any).peerConnection as RTCPeerConnection | undefined;
      if (!pc) return;
      const checkState = () => {
        const cState = pc.connectionState;
        const iState = pc.iceConnectionState;
        if (
          cState === 'failed' ||
          cState === 'closed' ||
          iState === 'failed' ||
          iState === 'closed'
        ) {
          handleClose();
        }
      };
      pc.addEventListener('connectionstatechange', checkState);
      pc.addEventListener('iceconnectionstatechange', checkState);
    });

    conn.on('close', handleClose);
    conn.on('error', handleClose);
  }

  private isConnAlive(conn: DataConnection | undefined | null): boolean {
    if (!conn || !conn.open) return false;
    const pc = (conn as any).peerConnection as RTCPeerConnection | undefined;
    if (pc) {
      const cState = pc.connectionState;
      const iState = pc.iceConnectionState;
      if (
        cState === 'failed' ||
        cState === 'closed' ||
        cState === 'disconnected' ||
        iState === 'failed' ||
        iState === 'closed' ||
        iState === 'disconnected'
      ) {
        return false;
      }
    }
    return true;
  }

  private pruneDeadConnections(): void {
    for (const [id, conn] of this.peerConnections.entries()) {
      if (!this.isConnAlive(conn)) {
        try {
          conn.close();
        } catch {
          // ignore
        }
        this.peerConnections.delete(id);
      }
    }
    for (const [id, conn] of this.beaconConnections.entries()) {
      if (!this.isConnAlive(conn)) {
        try {
          conn.close();
        } catch {
          // ignore
        }
        this.beaconConnections.delete(id);
      }
    }
  }

  private ensureRoomConnectivity(): void {
    if (this.destroyed) return;
    this.rateLimiter.prune();
    this.pruneDeadConnections();

    if (!this.personalPeer || this.personalPeer.destroyed || this.signalingStatus === 'offline') {
      this.initPersonalPeer();
    } else if (this.personalPeer.disconnected) {
      try {
        this.personalPeer.reconnect();
      } catch {
        this.initPersonalPeer();
      }
    }

    if (this.signalingStatus === 'ready') {
      if (this.isBeaconHost) {
        if (!this.beaconPeer || this.beaconPeer.destroyed) {
          this.initRoomBeaconOrJoin(this.roomId);
        } else if (this.beaconPeer.disconnected) {
          try {
            this.beaconPeer.reconnect();
          } catch {
            this.initRoomBeaconOrJoin(this.roomId);
          }
        }
      } else if (!this.beaconInitializing && this.beaconConnections.size === 0) {
        this.connectToRoomBeacon(this.roomId);
      }
    }

    this.sendHelloPacket();
    this.flushPendingOutbox();
  }

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
    if (this.broadcastChannel && packet.roomId === this.roomId) {
      try {
        this.broadcastChannel.postMessage(packet);
      } catch {
        // ignore
      }
    }

    for (const conn of this.peerConnections.values()) {
      if (conn !== excludeConn && conn.open) {
        this.safeSendConn(conn, packet);
      }
    }

    for (const conn of this.beaconConnections.values()) {
      if (conn !== excludeConn && conn.open) {
        this.safeSendConn(conn, packet);
      }
    }
  }

  private safeSendConn(conn: DataConnection, packet: P2PPacket): void {
    try {
      if (conn.open) {
        conn.send(packet);
      }
    } catch {
      // ignore
    }
  }

  private handleIncomingPacket(
    packet: P2PPacket,
    transport: ConnectionTransport,
    sourceConn?: DataConnection
  ): void {
    if (packet.senderId === this.myPeerId) return;
    if (packet.roomId !== this.roomId) return;
    if (this.markPacketSeen(packet.packetId)) return;

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
        const pong = this.createPacket(
          'PONG',
          { targetId: packet.senderId, sentAt: packet.timestamp },
          1
        );
        this.dispatchPacketToAll(pong);
        this.flushPendingOutbox();
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
            this.connectToDirectPeer(peerId, false);
          }
        }
        break;
      }

      case 'CHAT_MSG': {
        const msg = validateChatMessage(packet.payload?.message, this.roomId);
        if (!msg) break;
        msg.senderId = packet.senderId;
        if (msg.targetPeerId && msg.targetPeerId !== this.myPeerId && msg.senderId !== this.myPeerId) {
          break;
        }
        this.clearPeerTyping(packet.senderId);
        this.callbacks.onChatMessage(msg);

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
          this.pendingOutbox.delete(messageId);
          this.callbacks.onMessageAck(messageId, ackPeerId);
        }
        break;
      }

      case 'TYPING': {
        const isTyping = Boolean(packet.payload?.isTyping);
        if (isTyping) {
          this.setPeerTyping(packet.senderId, packet.senderName);
        } else {
          this.clearPeerTyping(packet.senderId);
        }
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
          this.clearPeerTyping(packet.senderId);
          this.emitPeersChange();
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
      if (transport === 'peerjs-mesh') {
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

  public sendChatMessage(
    text: string,
    replyTo?: ChatMessage['replyTo'],
    whisperPeer?: { peerId: string; nickname: string }
  ): ChatMessage {
    const cleanText = sanitizeString(text, MAX_MESSAGE_TEXT_LENGTH).trim();
    const now = Date.now();
    const msg: ChatMessage = {
      id: generateUUID(),
      roomId: this.roomId,
      senderId: this.myPeerId,
      senderName: this.profile.nickname,
      text: cleanText,
      timestamp: now,
      replyTo,
      targetPeerId: whisperPeer?.peerId,
      targetPeerName: whisperPeer?.nickname,
      ackedBy: [],
    };

    this.pendingOutbox.set(msg.id, { msg, createdAt: now });
    this.pruneDeadConnections();
    if (this.peerConnections.size === 0 && this.beaconConnections.size === 0) {
      this.ensureRoomConnectivity();
    }
    this.broadcastPacket('CHAT_MSG', { message: msg }, 3);
    return msg;
  }

  private flushPendingOutbox(): void {
    const now = Date.now();
    for (const [id, entry] of this.pendingOutbox.entries()) {
      if (now - entry.createdAt > OUTBOX_TTL_MS || entry.msg.roomId !== this.roomId) {
        this.pendingOutbox.delete(id);
        continue;
      }
      this.broadcastPacket('CHAT_MSG', { message: entry.msg }, 3);
    }
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
    this.rateLimiter.prune();
    this.pruneDeadConnections();
    const now = Date.now();
    this.broadcastPacket('PING', { sentAt: now }, 1);

    for (const [id, entry] of this.pendingOutbox.entries()) {
      if (now - entry.createdAt > OUTBOX_TTL_MS || entry.msg.roomId !== this.roomId) {
        this.pendingOutbox.delete(id);
      }
    }

    let changed = false;
    for (const [id, peer] of this.peers.entries()) {
      if (now - peer.lastSeenAt > PEER_TIMEOUT_MS) {
        this.peers.delete(id);
        this.clearPeerTyping(id);
        const staleConn = this.peerConnections.get(id);
        if (staleConn) {
          try {
            staleConn.close();
          } catch {
            // ignore
          }
          this.peerConnections.delete(id);
        }
        changed = true;
      }
    }
    if (changed) {
      this.emitPeersChange();
    }
  }

  private broadcastLeave(): void {
    try {
      this.broadcastPacket('LEAVE', {}, 2);
    } catch {
      // ignore
    }
  }

  private setPeerTyping(peerId: string, nickname: string): void {
    const existing = this.typingMap.get(peerId);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const timer = window.setTimeout(() => {
      this.typingMap.delete(peerId);
      this.emitTypingChange();
    }, 3800);
    this.typingMap.set(peerId, { nickname, timer });
    this.emitTypingChange();
  }

  private clearPeerTyping(peerId: string): void {
    const existing = this.typingMap.get(peerId);
    if (existing) {
      clearTimeout(existing.timer);
      this.typingMap.delete(peerId);
      this.emitTypingChange();
    }
  }

  private clearAllTyping(): void {
    for (const info of this.typingMap.values()) {
      clearTimeout(info.timer);
    }
    this.typingMap.clear();
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
