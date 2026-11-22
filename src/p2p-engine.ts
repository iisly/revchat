import { joinRoom } from 'trystero';
import type { MessageAction, Room } from 'trystero';
import {
  SessionIdentity,
  decryptBytes,
  decryptJson,
  derivePairwiseAesKey,
  encryptBytes,
  encryptJson,
  generateSessionIdentity,
  importRoomKey,
  signText,
  verifyText,
} from './crypto';
import { MessageOutbox } from './outbox';
import {
  MAX_MEDIA_BYTES,
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_NICKNAME_LENGTH,
  MAX_PEERS_IN_ROOM,
  PeerRateLimiter,
  isAllowedReaction,
  sanitizeFilename,
  sanitizeId,
  sanitizeString,
  validateChatMessage,
  validateIncomingPacket,
  validateMediaMeta,
} from './security';
import {
  generateUUID,
  normalizeRoomId,
  sanitizeRoomKey,
} from './storage';
import {
  ChatMessage,
  ConnectionTransport,
  IceRouteType,
  MediaKind,
  P2PPacket,
  PeerInfo,
  RemoteCallStream,
  SignalingState,
  UserProfile,
} from './types';

const APP_ID = 'revchat-p2p-v2';
const PEER_PREFIX = 'revchat-p-';
const SEEN_PACKET_LIMIT = 4000;
const PING_INTERVAL_MS = 5000;
const PEER_TIMEOUT_MS = 20000;
const OUTBOX_TTL_MS = 20000;
const TYPING_SAFETY_TIMEOUT_MS = 4000;
const NAT_WARN_GRACE_MS = 4000;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

export interface P2PEngineCallbacks {
  onSignalingChange: (state: SignalingState) => void;
  onPeersChange: (peers: PeerInfo[]) => void;
  onChatMessage: (msg: ChatMessage) => void;
  onMessageAck: (messageId: string, ackPeerId: string) => void;
  onMessageFailed: (messageId: string) => void;
  onMessageReaction: (messageId: string, emoji: string, actorId: string) => void;
  onMessageDeleted: (messageId: string, senderId: string) => void;
  onMediaProgress: (transferId: string, pct: number, phase: 'sending' | 'receiving') => void;
  onMediaReceived: (transferId: string, blob: Blob, mimeType: string, verified: boolean) => void;
  onMediaCanceled: (transferId: string) => void;
  onMediaFailed: (transferId: string) => void;
  onTypingChange: (typingPeers: { peerId: string; nickname: string }[]) => void;
  onSystemLog: (text: string) => void;
  onCallStreamsChange: (streams: RemoteCallStream[]) => void;
  onLocalStreamUpdated: (
    stream: MediaStream | null,
    videoEnabled: boolean,
    audioMuted: boolean,
    isScreenShare: boolean
  ) => void;
}

interface ActiveMediaMeta {
  transferId: string;
  kind: MediaKind;
  name: string;
  mimeType: string;
  size: number;
  durationSec?: number;
  targetPeerId?: string;
  targetPeerName?: string;
  replyTo?: ChatMessage['replyTo'];
  senderLogicalId: string;
  senderName: string;
  encrypted: boolean;
  sig?: string;
}

export class P2PEngine {
  private profile: UserProfile;
  private callbacks: P2PEngineCallbacks;
  private roomId: string;
  private roomKeyStr: string | null;
  private roomAesKey: CryptoKey | null = null;

  private myPeerId: string;
  private identity: SessionIdentity | null = null;
  private identityReadyP: Promise<SessionIdentity | null>;

  private room: Room | null = null;
  private pktAction: MessageAction<P2PPacket> | null = null;
  private mediaAction: MessageAction<ArrayBuffer> | null = null;
  private roomUnsubs: Array<() => void> = [];
  private broadcastChannel: BroadcastChannel | null = null;

  private peers = new Map<string, PeerInfo>();
  private transportToLogical = new Map<string, string>();
  private logicalToTransport = new Map<string, string>();
  private pairwiseKeys = new Map<string, CryptoKey>();
  private incomingTransferToMsg = new Map<string, string>();
  private seenTransfers = new Set<string>();
  private activeUploadAborts = new Map<string, AbortController>();

  private signalingStatus: SignalingState['status'] = 'initializing';
  private natWarnedThisSession = false;
  private natWarnTimer: number | null = null;
  private lastDecryptWarnAt = 0;

  private seenPackets = new Set<string>();
  private seenPacketQueue: string[] = [];
  private rateLimiter = new PeerRateLimiter();
  private typingMap = new Map<string, { nickname: string; timer: number }>();
  private outbox = new MessageOutbox();

  private heartbeatTimer: number | null = null;
  private destroyed = false;

  // Call media state
  private localCallStream: MediaStream | null = null;
  private localHasVideo = false;
  private localAudioMuted = false;
  private isScreenShare = false;
  private cameraFacingMode: 'user' | 'environment' = 'user';
  private hasMultipleCameras = false;
  private remoteStreams = new Map<string, RemoteCallStream>();
  private remoteStreamCleanups = new Map<string, () => void>();
  private wakeLockSentinel: any = null;

  private readonly onVisibilityOrOnline = () => {
    if (this.destroyed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      if (this.localCallStream) {
        void this.acquireWakeLock();
      }
      this.sendHelloPacket();
      this.flushOutboxToAll();
    }
  };

  constructor(
    profile: UserProfile,
    initialRoomId: string,
    initialRoomKey: string | null,
    callbacks: P2PEngineCallbacks
  ) {
    this.profile = profile;
    this.roomId = normalizeRoomId(initialRoomId);
    this.roomKeyStr = sanitizeRoomKey(initialRoomKey);
    this.callbacks = callbacks;
    this.myPeerId = `${PEER_PREFIX}${sanitizeId(profile.clientId).toLowerCase()}`;
    this.identityReadyP = generateSessionIdentity().catch(() => null);
  }

  public async start(): Promise<void> {
    this.identity = await this.identityReadyP;
    if (this.destroyed) return;

    if (this.roomKeyStr) {
      this.roomAesKey = await importRoomKey(this.roomKeyStr);
    }

    await this.joinActiveRoom();

    this.heartbeatTimer = window.setInterval(() => this.onHeartbeatTick(), PING_INTERVAL_MS);

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onVisibilityOrOnline);
      document.addEventListener('visibilitychange', this.onVisibilityOrOnline);
    }
    this.emitSignalingState();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.leaveCall();
    this.broadcastLeaveSync();

    this.clearNatWarnTimer();
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearAllTyping();

    for (const ctrl of this.activeUploadAborts.values()) {
      ctrl.abort();
    }
    this.activeUploadAborts.clear();

    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onVisibilityOrOnline);
      document.removeEventListener('visibilitychange', this.onVisibilityOrOnline);
    }

    void this.teardownRoom();
  }

  public getMyPeerId(): string {
    return this.myPeerId;
  }

  public updateProfile(profile: UserProfile): void {
    const oldNick = this.profile.nickname;
    this.profile = profile;
    if (oldNick !== profile.nickname) {
      const safeNick = sanitizeString(profile.nickname, MAX_NICKNAME_LENGTH, 'peer').trim();
      if (!safeNick) return;
      void this.signDataString(`NICK:${this.myPeerId}:${safeNick}`).then((sig) => {
        if (this.destroyed) return;
        const packet = this.createBasePacket('NICK_CHANGE', { nickname: safeNick }, 1);
        packet.sig = sig;
        this.sendRawBroadcast(packet);
      });
    }
  }

  public async switchRoom(newRoomId: string, newRoomKey: string | null): Promise<void> {
    const normalized = normalizeRoomId(newRoomId);
    const cleanKey = sanitizeRoomKey(newRoomKey);
    if (normalized === this.roomId && cleanKey === this.roomKeyStr) return;

    this.leaveCall();
    this.broadcastLeaveSync();
    for (const ctrl of this.activeUploadAborts.values()) {
      ctrl.abort();
    }
    this.activeUploadAborts.clear();
    await this.teardownRoom();

    this.natWarnedThisSession = false;
    this.roomId = normalized;
    this.roomKeyStr = cleanKey;
    this.roomAesKey = cleanKey ? await importRoomKey(cleanKey) : null;
    this.remoteStreams.clear();
    this.peers.clear();
    this.transportToLogical.clear();
    this.logicalToTransport.clear();
    this.pairwiseKeys.clear();
    this.incomingTransferToMsg.clear();
    this.seenTransfers.clear();
    this.clearAllTyping();
    this.outbox.clear();

    this.emitPeersChange();
    this.emitTypingChange();
    this.emitSignalingState();

    await this.joinActiveRoom();
  }

  private buildRtcConfig(): RTCConfiguration {
    return { iceServers: [...DEFAULT_ICE_SERVERS] };
  }

  private clearRemoteStreamCleanups(): void {
    for (const fn of this.remoteStreamCleanups.values()) {
      fn();
    }
    this.remoteStreamCleanups.clear();
  }

  private clearNatWarnTimer(): void {
    if (this.natWarnTimer !== null) {
      clearTimeout(this.natWarnTimer);
      this.natWarnTimer = null;
    }
  }

  private async teardownRoom(): Promise<void> {
    this.clearNatWarnTimer();
    this.clearRemoteStreamCleanups();
    for (const unsub of this.roomUnsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    this.roomUnsubs = [];
    this.pktAction = null;
    this.mediaAction = null;

    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.close();
      } catch {
        // ignore
      }
      this.broadcastChannel = null;
    }

    if (this.room) {
      const old = this.room;
      this.room = null;
      try {
        await old.leave();
      } catch {
        // ignore
      }
    }
  }

  private bindOrVerifyTransportPeer(
    transportPeerId: string | undefined,
    logicalId: string
  ): boolean {
    if (!transportPeerId) return true;
    const boundLogical = this.transportToLogical.get(transportPeerId);
    if (boundLogical && boundLogical !== logicalId) {
      return false;
    }
    const boundTransport = this.logicalToTransport.get(logicalId);
    if (boundTransport && boundTransport !== transportPeerId) {
      const activePeers = this.room ? this.room.getPeers() : {};
      if (boundTransport in activePeers) {
        return false;
      }
      this.transportToLogical.delete(boundTransport);
      this.pairwiseKeys.delete(logicalId);
    }
    this.transportToLogical.set(transportPeerId, logicalId);
    this.logicalToTransport.set(logicalId, transportPeerId);
    return true;
  }

  private removePeerState(logicalId: string): void {
    const streamCleanup = this.remoteStreamCleanups.get(logicalId);
    if (streamCleanup) {
      streamCleanup();
      this.remoteStreamCleanups.delete(logicalId);
    }
    this.peers.delete(logicalId);
    this.pairwiseKeys.delete(logicalId);
    const tid = this.logicalToTransport.get(logicalId);
    if (tid) {
      this.logicalToTransport.delete(logicalId);
      if (this.transportToLogical.get(tid) === logicalId) {
        this.transportToLogical.delete(tid);
      }
    }
    this.clearPeerTyping(logicalId);
    if (this.remoteStreams.delete(logicalId)) {
      this.callbacks.onCallStreamsChange(Array.from(this.remoteStreams.values()));
    }
    this.emitPeersChange();
  }

  private async joinActiveRoom(): Promise<void> {
    if (this.destroyed) return;
    this.signalingStatus = 'initializing';
    this.emitSignalingState();

    this.initLocalBroadcast(this.roomId);

    try {
      const room = joinRoom(
        {
          appId: APP_ID,
          identity: 'none',
          password: this.roomKeyStr || undefined,
          maxUsers: MAX_PEERS_IN_ROOM,
          maxReceiveBytes: MAX_MEDIA_BYTES + 131_072,
          rtcConfig: this.buildRtcConfig(),
          relayConfig: {
            redundancy: 5,
            warnOnRelayFailure: false,
          },
        },
        this.roomId
      );
      this.room = room;

      const pktAction = room.makeAction<P2PPacket>('pkt');
      const mediaAction = room.makeAction<ArrayBuffer>('media');
      this.pktAction = pktAction;
      this.mediaAction = mediaAction;

      this.roomUnsubs.push(
        pktAction.onMessage((raw, ctx) => {
          const packet = validateIncomingPacket(raw);
          if (!packet || packet.senderId === this.myPeerId) return;
          if (packet.roomId !== this.roomId) return;
          if (!this.rateLimiter.allow(packet.senderId)) return;
          if (!this.bindOrVerifyTransportPeer(ctx.peerId, packet.senderId)) return;

          void this.handleIncomingPacket(packet, 'trystero-mesh', ctx.peerId);
        }),

        mediaAction.onReceive((ctx) => {
          if (ctx.byteLength > MAX_MEDIA_BYTES + 131_072) return false;
          const meta = this.parseMediaMeta(ctx.metadata);
          if (!meta) return false;
          if (meta.senderLogicalId === this.myPeerId) return false;
          if (meta.targetPeerId && meta.targetPeerId !== this.myPeerId) return false;
          if (!this.rateLimiter.allow(meta.senderLogicalId)) return false;

          if (this.seenTransfers.has(meta.transferId)) return false;
          if (!this.bindOrVerifyTransportPeer(ctx.peerId, meta.senderLogicalId)) return false;

          this.ensurePlaceholderMediaMessage(meta);
          return true;
        }),

        mediaAction.onReceiveProgress((pct, ctx) => {
          const meta = this.parseMediaMeta(ctx.metadata);
          if (!meta) return;
          this.callbacks.onMediaProgress(meta.transferId, Math.round(pct * 100), 'receiving');
        }),

        mediaAction.onMessage((rawBuf, ctx) => {
          const meta = this.parseMediaMeta(ctx.metadata);
          if (!meta) return;
          if (!this.bindOrVerifyTransportPeer(ctx.peerId, meta.senderLogicalId)) return;
          void this.handleIncomingMediaBinary(rawBuf, meta, ctx.peerId);
        }),

        room.onPeerJoin(({ peerId: transportPeerId }) => {
          this.clearNatWarnTimer();
          // Send direct HELLO + any pending outbox messages upon direct WebRTC readiness
          this.sendHelloPacketToTarget(transportPeerId);
          if (this.localCallStream) {
            void room.addStream(this.localCallStream, {
              target: transportPeerId,
              metadata: { hasVideo: this.localHasVideo, isScreenShare: this.isScreenShare },
            }).catch(() => {});
          }
        }),

        room.onPeerLeave(({ peerId: transportPeerId }) => {
          const logicalId = this.transportToLogical.get(transportPeerId);
          this.transportToLogical.delete(transportPeerId);
          if (logicalId) {
            if (this.logicalToTransport.get(logicalId) === transportPeerId) {
              this.logicalToTransport.delete(logicalId);
            }
            const peer = this.peers.get(logicalId);
            if (peer && peer.transport === 'trystero-mesh') {
              const name = peer.nickname;
              this.removePeerState(logicalId);
              this.callbacks.onSystemLog(`${name} disconnected.`);
            }
          }
        }),

        room.onPeerStream((stream, ctx) => {
          const logicalId = this.transportToLogical.get(ctx.peerId) || ctx.peerId;
          const prevCleanup = this.remoteStreamCleanups.get(logicalId);
          if (prevCleanup) {
            prevCleanup();
            this.remoteStreamCleanups.delete(logicalId);
          }

          const peerInfo = this.peers.get(logicalId);
          const metaObj = ctx.metadata as Record<string, unknown> | undefined;
          const hasVideo =
            typeof metaObj?.hasVideo === 'boolean'
              ? metaObj.hasVideo
              : stream.getVideoTracks().some((t) => t.readyState === 'live');
          const isScreenShare = Boolean(metaObj?.isScreenShare);
          const nickname = peerInfo?.nickname || logicalId.slice(-6);

          const entry: RemoteCallStream = {
            peerId: logicalId,
            nickname,
            stream,
            hasVideo,
            isScreenShare,
          };
          this.remoteStreams.set(logicalId, entry);
          if (peerInfo) {
            peerInfo.inCall = true;
            peerInfo.hasVideo = hasVideo;
            peerInfo.isScreenShare = isScreenShare;
            this.emitPeersChange();
          }
          this.callbacks.onCallStreamsChange(Array.from(this.remoteStreams.values()));

          const cleanups: Array<() => void> = [];
          const boundTracks = new Set<MediaStreamTrack>();

          const syncTrackState = () => {
            if (this.remoteStreams.get(logicalId)?.stream !== stream) return;
            const tracks = stream.getTracks();
            const active = tracks.length > 0 && tracks.some((t) => t.readyState === 'live');
            if (!active) {
              this.remoteStreamCleanups.get(logicalId)?.();
              this.remoteStreamCleanups.delete(logicalId);
              this.remoteStreams.delete(logicalId);
              if (peerInfo) {
                peerInfo.inCall = false;
                peerInfo.hasVideo = false;
                peerInfo.isScreenShare = false;
                this.emitPeersChange();
              }
              this.callbacks.onCallStreamsChange(Array.from(this.remoteStreams.values()));
            } else {
              const cur = this.remoteStreams.get(logicalId);
              if (cur) {
                cur.hasVideo = stream.getVideoTracks().some((t) => t.readyState === 'live');
                if (!cur.hasVideo) cur.isScreenShare = false;
                this.callbacks.onCallStreamsChange(Array.from(this.remoteStreams.values()));
              }
            }
          };

          const bindTrackEnded = (t: MediaStreamTrack) => {
            if (boundTracks.has(t)) return;
            boundTracks.add(t);
            t.addEventListener('ended', syncTrackState);
            cleanups.push(() => t.removeEventListener('ended', syncTrackState));
          };

          const onAddTrack = (ev: MediaStreamTrackEvent) => {
            if (ev.track) bindTrackEnded(ev.track);
            syncTrackState();
          };

          stream.addEventListener('removetrack', syncTrackState);
          stream.addEventListener('addtrack', onAddTrack);
          cleanups.push(() => {
            stream.removeEventListener('removetrack', syncTrackState);
            stream.removeEventListener('addtrack', onAddTrack);
          });
          for (const t of stream.getTracks()) {
            bindTrackEnded(t);
          }

          this.remoteStreamCleanups.set(logicalId, () => {
            for (const fn of cleanups) {
              fn();
            }
          });
        }),

        room.onError((err) => {
          if (err.code === 'peer-connect-failed') {
            if (this.natWarnedThisSession) return;
            if (this.peers.size > 0 || Object.keys(room.getPeers()).length > 0) return;
            if (this.natWarnTimer === null) {
              const roomAtError = room;
              this.natWarnTimer = window.setTimeout(() => {
                this.natWarnTimer = null;
                if (this.destroyed || this.room !== roomAtError || this.natWarnedThisSession) return;
                if (this.peers.size > 0 || Object.keys(roomAtError.getPeers()).length > 0) return;
                this.natWarnedThisSession = true;
                this.callbacks.onSystemLog(
                  'Could not connect directly to a peer (restricted network/firewall).'
                );
              }, NAT_WARN_GRACE_MS);
            }
          } else if (err.code === 'decrypt-failed') {
            this.warnDecryptMismatch(
              'Peer connection rejected: room key mismatch. Share the full invite link.'
            );
          }
        })
      );

      await room.ready;
      if (this.destroyed || this.room !== room) return;

      this.signalingStatus = 'ready';
      this.emitSignalingState();
      this.sendHelloPacket();
    } catch {
      this.signalingStatus = 'offline';
      this.emitSignalingState();
    }
  }

  private initLocalBroadcast(roomId: string): void {
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      const bc = new BroadcastChannel(`revchat_local_v2_${roomId}`);
      this.broadcastChannel = bc;
      bc.onmessage = (ev) => {
        const raw = ev.data;
        if (raw && raw.__bcMedia === true) {
          const meta = this.parseMediaMeta(raw.meta);
          if (!meta || meta.senderLogicalId === this.myPeerId) return;
          if (meta.targetPeerId && meta.targetPeerId !== this.myPeerId) return;
          this.ensurePlaceholderMediaMessage(meta);
          void this.handleIncomingMediaBinary(raw.bytes, meta, undefined);
          return;
        }
        const packet = validateIncomingPacket(raw);
        if (!packet || packet.senderId === this.myPeerId) return;
        if (packet.roomId !== this.roomId) return;
        if (!this.rateLimiter.allow(packet.senderId)) return;
        void this.handleIncomingPacket(packet, 'local-broadcast', undefined);
      };
      this.sendHelloPacket();
    } catch {
      // BroadcastChannel unavailable
    }
  }

  private createBasePacket(type: P2PPacket['type'], payload: any, ttl = 1): P2PPacket {
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

  private sendPacketAll(type: P2PPacket['type'], payload: any, ttl = 1): void {
    const packet = this.createBasePacket(type, payload, ttl);
    this.sendRawBroadcast(packet);
  }

  private sendRawBroadcast(packet: P2PPacket): void {
    if (this.broadcastChannel && packet.roomId === this.roomId) {
      try {
        this.broadcastChannel.postMessage(packet);
      } catch {
        // ignore
      }
    }
    if (this.pktAction) {
      void this.pktAction.send(packet).catch(() => {});
    }
  }

  private sendRawUnicast(packet: P2PPacket, targetLogicalId: string, transportPeerId?: string): void {
    const targetTid = transportPeerId || this.logicalToTransport.get(targetLogicalId);
    if (targetTid && this.pktAction) {
      void this.pktAction.send(packet, { target: targetTid }).catch(() => {});
      return;
    }
    // Local same-browser tab peer fallback
    if (this.broadcastChannel && packet.roomId === this.roomId) {
      try {
        this.broadcastChannel.postMessage(packet);
      } catch {
        // ignore
      }
    }
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

  private helloPayload() {
    return {
      nickname: this.profile.nickname,
      signPubKey: this.identity?.signPubB64,
      ecdhPubKey: this.identity?.ecdhPubB64,
      inCall: Boolean(this.localCallStream),
      hasVideo: this.localHasVideo,
      isScreenShare: this.isScreenShare,
    };
  }

  private sendHelloPacket(): void {
    this.sendPacketAll('HELLO', this.helloPayload(), 1);
  }

  private sendHelloPacketToTarget(transportPeerId: string): void {
    const packet = this.createBasePacket('HELLO', this.helloPayload(), 1);
    if (this.pktAction) {
      void this.pktAction.send(packet, { target: transportPeerId }).catch(() => {});
    }
  }

  private async signDataString(canonical: string): Promise<string | undefined> {
    if (!this.identity) return undefined;
    try {
      return await signText(this.identity.signKeyPair.privateKey, canonical);
    } catch {
      return undefined;
    }
  }

  private async handleIncomingPacket(
    packet: P2PPacket,
    transport: ConnectionTransport,
    sourceTransportPeerId?: string
  ): Promise<void> {
    if (packet.senderId === this.myPeerId) return;
    if (packet.roomId !== this.roomId) return;
    if (this.markPacketSeen(packet.packetId)) return;

    if (packet.type !== 'LEAVE') {
      const nickHint =
        packet.type === 'NICK_CHANGE' && this.peers.has(packet.senderId)
          ? this.peers.get(packet.senderId)!.nickname
          : packet.senderName;
      await this.upsertPeer(
        packet.senderId,
        nickHint,
        transport,
        packet.type === 'HELLO' ? packet.payload : undefined
      );
    }

    switch (packet.type) {
      case 'HELLO': {
        // Re-advertise our identity back unicast & flush any pending messages meant for this peer
        const pong = this.createBasePacket(
          'PONG',
          {
            targetId: packet.senderId,
            sentAt: packet.timestamp,
            ...this.helloPayload(),
          },
          0
        );
        this.sendRawUnicast(pong, packet.senderId, sourceTransportPeerId);
        await this.flushOutboxForPeer(packet.senderId, sourceTransportPeerId);
        break;
      }

      case 'CHAT_MSG': {
        let msgObj = packet.payload?.message ?? packet.payload;
        let encrypted = false;
        let verified = false;

        if (packet.enc && typeof packet.payload?.cipher === 'string') {
          const candidates: Array<CryptoKey | null | undefined> =
            packet.payload?.dmTarget === this.myPeerId
              ? [this.pairwiseKeys.get(packet.senderId), this.roomAesKey]
              : [this.roomAesKey];

          let decrypted: any = null;
          for (const candidate of candidates) {
            if (!candidate) continue;
            decrypted = await decryptJson<any>(candidate, packet.payload.cipher);
            if (decrypted) break;
          }

          if (!decrypted) {
            this.warnDecryptMismatch(
              'Could not decrypt an incoming E2EE message (room key or passphrase mismatch).'
            );
            break;
          }
          msgObj = decrypted?.message ?? decrypted;
          encrypted = true;
        }

        const msg = validateChatMessage(msgObj, this.roomId);
        if (!msg) break;
        msg.senderId = packet.senderId;
        if (msg.targetPeerId && msg.targetPeerId !== this.myPeerId && msg.senderId !== this.myPeerId) {
          break;
        }

        const peerInfo = this.peers.get(packet.senderId);
        if (peerInfo?.signPubKey) {
          if (!packet.sig) break;
          verified = await verifyText(
            peerInfo.signPubKey,
            `MSG:${msg.id}:${msg.senderId}:${msg.timestamp}:${msg.text}`,
            packet.sig
          );
          if (!verified) break;
        }
        msg.encrypted = encrypted || Boolean(this.roomAesKey);
        msg.verified = verified;

        this.clearPeerTyping(packet.senderId);
        this.callbacks.onChatMessage(msg);

        // Unicast ACK strictly to sender (no room amplification)
        const ack = this.createBasePacket(
          'CHAT_ACK',
          { messageId: msg.id, ackPeerId: this.myPeerId },
          0
        );
        this.sendRawUnicast(ack, packet.senderId, sourceTransportPeerId);
        break;
      }

      case 'CHAT_ACK': {
        const messageId = sanitizeId(packet.payload?.messageId);
        const ackPeerId = sanitizeId(packet.payload?.ackPeerId);
        if (messageId && ackPeerId && ackPeerId === packet.senderId) {
          this.outbox.acknowledge(messageId, ackPeerId);
          this.callbacks.onMessageAck(messageId, ackPeerId);
        }
        break;
      }

      case 'REACTION': {
        const messageId = sanitizeId(packet.payload?.messageId);
        const emoji = String(packet.payload?.emoji || '');
        if (!messageId || !isAllowedReaction(emoji)) break;
        const peerInfo = this.peers.get(packet.senderId);
        if (peerInfo?.signPubKey) {
          if (!packet.sig) break;
          const ok = await verifyText(peerInfo.signPubKey, `REACT:${messageId}:${emoji}`, packet.sig);
          if (!ok) break;
        }
        this.callbacks.onMessageReaction(messageId, emoji, packet.senderId);
        break;
      }

      case 'DELETE_MSG': {
        const messageId = sanitizeId(packet.payload?.messageId);
        if (!messageId) break;
        const peerInfo = this.peers.get(packet.senderId);
        if (peerInfo?.signPubKey) {
          if (!packet.sig) break;
          const ok = await verifyText(
            peerInfo.signPubKey,
            `DEL:${messageId}:${packet.senderId}`,
            packet.sig
          );
          if (!ok) break;
        }
        this.callbacks.onMessageDeleted(messageId, packet.senderId);
        break;
      }

      case 'MEDIA_CANCEL': {
        const transferId = sanitizeId(packet.payload?.transferId);
        if (!transferId) break;
        this.seenTransfers.add(transferId);
        this.callbacks.onMediaCanceled(transferId);
        break;
      }

      case 'CALL_STATE': {
        const peer = this.peers.get(packet.senderId);
        const inCall = Boolean(packet.payload?.inCall);
        const hasVideo = Boolean(packet.payload?.hasVideo);
        const isScreenShare = Boolean(packet.payload?.isScreenShare);
        if (peer) {
          peer.inCall = inCall;
          peer.hasVideo = hasVideo;
          peer.isScreenShare = isScreenShare;
          this.emitPeersChange();
        }
        const curStream = this.remoteStreams.get(packet.senderId);
        if (!inCall && curStream) {
          this.remoteStreams.delete(packet.senderId);
          this.callbacks.onCallStreamsChange(Array.from(this.remoteStreams.values()));
        } else if (inCall && curStream) {
          curStream.hasVideo = hasVideo;
          curStream.isScreenShare = isScreenShare;
          this.callbacks.onCallStreamsChange(Array.from(this.remoteStreams.values()));
        }
        break;
      }

      case 'TYPING': {
        if (Boolean(packet.payload?.isTyping)) {
          this.setPeerTyping(packet.senderId, packet.senderName);
        } else {
          this.clearPeerTyping(packet.senderId);
        }
        break;
      }

      case 'PING': {
        // Strict unicast PONG back to ping sender only
        const pong = this.createBasePacket(
          'PONG',
          {
            targetId: packet.senderId,
            sentAt: Number(packet.payload?.sentAt) || packet.timestamp,
          },
          0
        );
        this.sendRawUnicast(pong, packet.senderId, sourceTransportPeerId);
        break;
      }

      case 'PONG': {
        if (packet.payload?.signPubKey || packet.payload?.ecdhPubKey) {
          await this.upsertPeer(packet.senderId, packet.senderName, transport, packet.payload);
        }
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
        if (existing?.signPubKey) {
          if (!packet.sig) break;
          const ok = await verifyText(
            existing.signPubKey,
            `NICK:${packet.senderId}:${newNick}`,
            packet.sig
          );
          if (!ok) break;
        }
        if (existing) {
          const oldNick = existing.nickname;
          existing.nickname = newNick;
          existing.lastSeenAt = Date.now();
          const remoteStream = this.remoteStreams.get(packet.senderId);
          if (remoteStream) {
            remoteStream.nickname = newNick;
            this.callbacks.onCallStreamsChange(Array.from(this.remoteStreams.values()));
          }
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
          const name = existing.nickname;
          this.removePeerState(packet.senderId);
          this.callbacks.onSystemLog(`${name} left the room.`);
        }
        break;
      }
    }
  }

  private async upsertPeer(
    peerId: string,
    nickname: string,
    transport: ConnectionTransport,
    helloData?: any
  ): Promise<void> {
    if (!peerId || peerId === this.myPeerId) return;
    if (!this.peers.has(peerId) && this.peers.size >= MAX_PEERS_IN_ROOM) return;
    this.clearNatWarnTimer();
    const safeNick = sanitizeString(nickname, MAX_NICKNAME_LENGTH, peerId.slice(-6)).trim();
    const now = Date.now();

    const signPubKey = typeof helloData?.signPubKey === 'string' ? helloData.signPubKey : undefined;
    const ecdhPubKey = typeof helloData?.ecdhPubKey === 'string' ? helloData.ecdhPubKey : undefined;

    const existing = this.peers.get(peerId);
    if (existing) {
      existing.nickname = safeNick || existing.nickname;
      existing.lastSeenAt = now;
      if (transport === 'trystero-mesh') {
        existing.transport = transport;
      } else if (existing.iceRoute === 'unknown') {
        existing.iceRoute = 'local';
      }
      if (!existing.signPubKey && signPubKey) {
        existing.signPubKey = signPubKey;
      }
      if (!existing.ecdhPubKey && ecdhPubKey) {
        existing.ecdhPubKey = ecdhPubKey;
        if (this.identity && !this.pairwiseKeys.has(peerId)) {
          const derived = await derivePairwiseAesKey(this.identity.ecdhKeyPair.privateKey, ecdhPubKey);
          if (derived) this.pairwiseKeys.set(peerId, derived);
        }
      }
      if (typeof helloData?.inCall === 'boolean') existing.inCall = helloData.inCall;
      if (typeof helloData?.hasVideo === 'boolean') existing.hasVideo = helloData.hasVideo;
      if (typeof helloData?.isScreenShare === 'boolean') existing.isScreenShare = helloData.isScreenShare;
    } else {
      if (ecdhPubKey && this.identity && !this.pairwiseKeys.has(peerId)) {
        const derived = await derivePairwiseAesKey(this.identity.ecdhKeyPair.privateKey, ecdhPubKey);
        if (derived) this.pairwiseKeys.set(peerId, derived);
      }
      this.peers.set(peerId, {
        peerId,
        nickname: safeNick || peerId.slice(-6),
        transport,
        rttMs: transport === 'local-broadcast' ? 1 : null,
        iceRoute: transport === 'local-broadcast' ? 'local' : 'unknown',
        signPubKey,
        ecdhPubKey,
        inCall: Boolean(helloData?.inCall),
        hasVideo: Boolean(helloData?.hasVideo),
        isScreenShare: Boolean(helloData?.isScreenShare),
        lastSeenAt: now,
      });
      this.callbacks.onSystemLog(`${safeNick || peerId} joined.`);
    }
    this.emitPeersChange();
  }

  public async sendChatMessage(
    text: string,
    replyTo?: ChatMessage['replyTo'],
    whisperPeer?: { peerId: string; nickname: string },
    forcedId?: string
  ): Promise<ChatMessage> {
    const cleanText = sanitizeString(text, MAX_MESSAGE_TEXT_LENGTH).trim();
    const now = Date.now();
    const msg: ChatMessage = {
      id: forcedId || generateUUID(),
      roomId: this.roomId,
      senderId: this.myPeerId,
      senderName: this.profile.nickname,
      text: cleanText,
      timestamp: now,
      replyTo,
      targetPeerId: whisperPeer?.peerId,
      targetPeerName: whisperPeer?.nickname,
      ackedBy: [],
      encrypted: Boolean(this.roomAesKey || whisperPeer),
      verified: true,
      deliveryState: 'sent',
    };

    const peerIds = Array.from(this.peers.keys());
    this.outbox.enqueue(msg, peerIds, now);
    await this.transmitChatMessage(msg, whisperPeer?.peerId);
    return msg;
  }

  public async retryChatMessage(msg: ChatMessage): Promise<void> {
    msg.deliveryState = 'sent';
    this.outbox.enqueue(msg, Array.from(this.peers.keys()), Date.now());
    await this.transmitChatMessage(msg, msg.targetPeerId);
  }

  private async transmitChatMessage(
    msg: ChatMessage,
    dmTargetId?: string,
    targetTransportPeerId?: string
  ): Promise<void> {
    const sig = await this.signDataString(
      `MSG:${msg.id}:${this.myPeerId}:${msg.timestamp}:${msg.text}`
    );

    let encKey: CryptoKey | null = null;
    if (dmTargetId) {
      encKey = this.pairwiseKeys.get(dmTargetId) || this.roomAesKey;
    } else {
      encKey = this.roomAesKey;
    }

    let payload: any;
    let enc = false;
    if (encKey) {
      payload = {
        cipher: await encryptJson(encKey, msg),
        ...(dmTargetId ? { dmTarget: dmTargetId } : {}),
      };
      enc = true;
    } else {
      payload = { message: msg };
    }

    const packet = this.createBasePacket('CHAT_MSG', payload, 1);
    packet.sig = sig;
    packet.enc = enc;

    if (dmTargetId) {
      this.sendRawUnicast(packet, dmTargetId, targetTransportPeerId);
    } else if (targetTransportPeerId && this.pktAction) {
      void this.pktAction.send(packet, { target: targetTransportPeerId }).catch(() => {});
    } else {
      this.sendRawBroadcast(packet);
    }
  }

  private async flushOutboxForPeer(logicalPeerId: string, transportPeerId?: string): Promise<void> {
    const pending = this.outbox.getMessagesForPeer(logicalPeerId, this.roomId, Date.now(), OUTBOX_TTL_MS);
    for (const msg of pending) {
      await this.transmitChatMessage(msg, msg.targetPeerId, transportPeerId);
    }
  }

  private flushOutboxToAll(): void {
    const msgs = this.outbox.getAllPendingMessages(this.roomId, Date.now(), OUTBOX_TTL_MS);
    for (const msg of msgs) {
      void this.transmitChatMessage(msg, msg.targetPeerId);
    }
  }

  public async sendReaction(messageId: string, emoji: string): Promise<void> {
    if (!isAllowedReaction(emoji)) return;
    const sig = await this.signDataString(`REACT:${messageId}:${emoji}`);
    const packet = this.createBasePacket('REACTION', { messageId, emoji }, 1);
    packet.sig = sig;
    this.sendRawBroadcast(packet);
  }

  public async deleteMessage(messageId: string): Promise<void> {
    const sig = await this.signDataString(`DEL:${messageId}:${this.myPeerId}`);
    const packet = this.createBasePacket('DELETE_MSG', { messageId }, 1);
    packet.sig = sig;
    this.sendRawBroadcast(packet);
  }

  private parseMediaMeta(raw: unknown): ActiveMediaMeta | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const attachment = validateMediaMeta(r);
    if (!attachment) return null;
    const senderLogicalId = sanitizeId(r.senderLogicalId);
    if (!senderLogicalId) return null;
    const senderName = sanitizeString(r.senderName, MAX_NICKNAME_LENGTH, 'peer').trim() || 'peer';
    const targetPeerId = r.targetPeerId ? sanitizeId(r.targetPeerId) : undefined;
    const targetPeerName = r.targetPeerName
      ? sanitizeString(r.targetPeerName, MAX_NICKNAME_LENGTH)
      : undefined;

    let replyTo: ChatMessage['replyTo'] | undefined;
    if (r.replyTo && typeof r.replyTo === 'object') {
      const rp = r.replyTo as Record<string, unknown>;
      const rId = sanitizeId(rp.id);
      const rSender = sanitizeString(rp.senderName, MAX_NICKNAME_LENGTH);
      const rText = sanitizeString(rp.text, 120);
      if (rId && rSender && rText) {
        replyTo = { id: rId, senderName: rSender, text: rText };
      }
    }

    return {
      transferId: attachment.transferId,
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      durationSec: attachment.durationSec,
      targetPeerId: targetPeerId || undefined,
      targetPeerName: targetPeerName || undefined,
      replyTo,
      senderLogicalId,
      senderName,
      encrypted: Boolean(r.encrypted),
      sig: typeof r.sig === 'string' ? r.sig.slice(0, 256) : undefined,
    };
  }

  private ensurePlaceholderMediaMessage(meta: ActiveMediaMeta): void {
    if (this.incomingTransferToMsg.has(meta.transferId)) return;
    const msgId = meta.transferId;
    this.incomingTransferToMsg.set(meta.transferId, msgId);

    const msg: ChatMessage = {
      id: msgId,
      roomId: this.roomId,
      senderId: meta.senderLogicalId,
      senderName: meta.senderName,
      text: '',
      timestamp: Date.now(),
      replyTo: meta.replyTo,
      targetPeerId: meta.targetPeerId,
      targetPeerName: meta.targetPeerName,
      ackedBy: [],
      encrypted: meta.encrypted || Boolean(this.roomAesKey),
      attachment: {
        transferId: meta.transferId,
        kind: meta.kind,
        name: meta.name,
        mimeType: meta.mimeType,
        size: meta.size,
        durationSec: meta.durationSec,
        progress: 0,
        status: 'receiving',
      },
    };
    this.callbacks.onChatMessage(msg);
  }

  private async handleIncomingMediaBinary(
    rawBuf: ArrayBuffer,
    meta: ActiveMediaMeta,
    sourceTransportPeerId?: string
  ): Promise<void> {
    if (this.seenTransfers.has(meta.transferId)) return;
    this.seenTransfers.add(meta.transferId);

    let bytes: Uint8Array | null = new Uint8Array(rawBuf);
    if (meta.encrypted) {
      const key =
        meta.targetPeerId === this.myPeerId
          ? this.pairwiseKeys.get(meta.senderLogicalId) || this.roomAesKey
          : this.roomAesKey;
      if (!key) {
        this.callbacks.onMediaCanceled(meta.transferId);
        return;
      }
      bytes = await decryptBytes(key, bytes);
      if (!bytes) {
        this.callbacks.onMediaCanceled(meta.transferId);
        return;
      }
    }

    if (bytes.byteLength > MAX_MEDIA_BYTES) {
      this.callbacks.onMediaCanceled(meta.transferId);
      return;
    }

    const peerInfo = this.peers.get(meta.senderLogicalId);
    let verified = false;
    if (peerInfo?.signPubKey) {
      if (!meta.sig) {
        this.callbacks.onMediaCanceled(meta.transferId);
        return;
      }
      verified = await verifyText(
        peerInfo.signPubKey,
        `MEDIA:${meta.transferId}:${meta.senderLogicalId}:${meta.name}:${meta.size}`,
        meta.sig
      );
      if (!verified) {
        this.callbacks.onMediaCanceled(meta.transferId);
        return;
      }
    }

    const exactBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const blob = new Blob([exactBuf as ArrayBuffer], { type: meta.mimeType });
    this.callbacks.onMediaReceived(meta.transferId, blob, meta.mimeType, verified);

    const ack = this.createBasePacket(
      'CHAT_ACK',
      { messageId: meta.transferId, ackPeerId: this.myPeerId },
      0
    );
    this.sendRawUnicast(ack, meta.senderLogicalId, sourceTransportPeerId);
  }

  public async sendMediaAttachment(
    blob: Blob,
    meta: { kind: MediaKind; name: string; mimeType: string; durationSec?: number },
    replyTo?: ChatMessage['replyTo'],
    whisperPeer?: { peerId: string; nickname: string },
    onCreated?: (msg: ChatMessage) => void
  ): Promise<ChatMessage> {
    const transferId = generateUUID();
    const safeName = sanitizeFilename(meta.name);
    const rawBuf = await blob.arrayBuffer();
    if (rawBuf.byteLength > MAX_MEDIA_BYTES) {
      throw new Error('File exceeds 25 MB limit.');
    }

    const sig = await this.signDataString(
      `MEDIA:${transferId}:${this.myPeerId}:${safeName}:${rawBuf.byteLength}`
    );

    const encKey = whisperPeer
      ? this.pairwiseKeys.get(whisperPeer.peerId) || this.roomAesKey
      : this.roomAesKey;

    let wireBytes = new Uint8Array(rawBuf);
    let encrypted = false;
    if (encKey) {
      wireBytes = new Uint8Array(await encryptBytes(encKey, wireBytes));
      encrypted = true;
    }

    const targetTid = whisperPeer ? this.logicalToTransport.get(whisperPeer.peerId) : undefined;
    const hasLocalOnlyPeer = whisperPeer
      ? !targetTid && this.peers.get(whisperPeer.peerId)?.transport === 'local-broadcast'
      : Array.from(this.peers.values()).some(
          (p) => p.transport === 'local-broadcast' && !this.logicalToTransport.has(p.peerId)
        );
    const hasWebRtcTargets = whisperPeer
      ? Boolean(targetTid)
      : this.logicalToTransport.size > 0;
    const willStreamWebRtc = Boolean(this.mediaAction && hasWebRtcTargets);

    const msg: ChatMessage = {
      id: transferId,
      roomId: this.roomId,
      senderId: this.myPeerId,
      senderName: this.profile.nickname,
      text: '',
      timestamp: Date.now(),
      replyTo,
      targetPeerId: whisperPeer?.peerId,
      targetPeerName: whisperPeer?.nickname,
      ackedBy: [],
      encrypted: encrypted || Boolean(this.roomAesKey),
      verified: true,
      deliveryState: willStreamWebRtc ? 'sending' : 'sent',
      attachment: {
        transferId,
        kind: meta.kind,
        name: safeName,
        mimeType: meta.mimeType,
        size: rawBuf.byteLength,
        durationSec: meta.durationSec,
        progress: willStreamWebRtc ? 0 : 100,
        status: willStreamWebRtc ? 'sending' : 'ready',
      },
    };

    onCreated?.(msg);

    const metadata = {
      transferId,
      kind: meta.kind,
      name: safeName,
      mimeType: meta.mimeType,
      size: rawBuf.byteLength,
      ...(meta.durationSec !== undefined ? { durationSec: meta.durationSec } : {}),
      ...(whisperPeer ? { targetPeerId: whisperPeer.peerId, targetPeerName: whisperPeer.nickname } : {}),
      ...(replyTo ? { replyTo } : {}),
      senderLogicalId: this.myPeerId,
      senderName: this.profile.nickname,
      encrypted,
      ...(sig ? { sig } : {}),
    };

    const wireCopy = wireBytes.buffer.slice(
      wireBytes.byteOffset,
      wireBytes.byteOffset + wireBytes.byteLength
    );

    let sentViaBc = false;
    if (this.broadcastChannel && hasLocalOnlyPeer) {
      try {
        this.broadcastChannel.postMessage({
          __bcMedia: true,
          meta: metadata,
          bytes: wireCopy,
        });
        sentViaBc = true;
      } catch {
        // ignore structured clone failure
      }
    }

    if (willStreamWebRtc && this.mediaAction) {
      const ctrl = new AbortController();
      this.activeUploadAborts.set(transferId, ctrl);
      const sendOpts: Parameters<typeof this.mediaAction.send>[1] = {
        metadata,
        signal: ctrl.signal,
        onProgress: (pct) => {
          this.callbacks.onMediaProgress(transferId, Math.min(99, Math.round(pct * 100)), 'sending');
        },
        ...(targetTid ? { target: targetTid } : {}),
      };
      void this.mediaAction
        .send(wireCopy, sendOpts)
        .then(() => {
          this.activeUploadAborts.delete(transferId);
          this.callbacks.onMediaProgress(transferId, 100, 'sending');
        })
        .catch((err: any) => {
          this.activeUploadAborts.delete(transferId);
          if (ctrl.signal.aborted) return;
          if (err?.kind === 'rejected' && sentViaBc) {
            this.callbacks.onMediaProgress(transferId, 100, 'sending');
            return;
          }
          this.callbacks.onMediaFailed(transferId);
        });
    }

    return msg;
  }

  public cancelMediaTransfer(transferId: string): void {
    const ctrl = this.activeUploadAborts.get(transferId);
    if (ctrl) {
      ctrl.abort();
      this.activeUploadAborts.delete(transferId);
    }
    this.sendPacketAll('MEDIA_CANCEL', { transferId }, 1);
    this.callbacks.onMediaCanceled(transferId);
  }

  public sendTyping(isTyping: boolean): void {
    this.sendPacketAll('TYPING', { isTyping }, 0);
  }

  // =========================================================================
  // CALLS (VOICE / VIDEO / SCREEN SHARE)
  // =========================================================================
  public canSwitchCamera(): boolean {
    return this.hasMultipleCameras;
  }

  private async detectMultipleCameras(): Promise<void> {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) {
        this.hasMultipleCameras = false;
        return;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.hasMultipleCameras = devices.filter((d) => d.kind === 'videoinput').length >= 2;
    } catch {
      this.hasMultipleCameras = false;
    }
  }

  public async startCall(options: { video: boolean }): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone / camera access requires HTTPS or localhost.');
    }
    if (this.localCallStream) {
      this.leaveCall();
    }

    const constraints: MediaStreamConstraints = {
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: options.video ? { facingMode: this.cameraFacingMode } : false,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    await this.detectMultipleCameras();
    this.localCallStream = stream;
    this.localHasVideo = options.video;
    this.localAudioMuted = false;
    this.isScreenShare = false;

    for (const track of stream.getTracks()) {
      if (track.kind === 'audio') {
        track.addEventListener('mute', () => {
          this.callbacks.onSystemLog('Microphone interrupted by OS/phone call.');
        });
      }
    }

    void this.acquireWakeLock();

    if (this.room) {
      await this.room.addStream(stream, {
        metadata: { hasVideo: options.video, isScreenShare: false },
      });
    }
    this.sendPacketAll(
      'CALL_STATE',
      { inCall: true, hasVideo: options.video, isScreenShare: false },
      1
    );
    this.callbacks.onLocalStreamUpdated(stream, this.localHasVideo, this.localAudioMuted, false);
  }

  public toggleMute(): boolean {
    if (!this.localCallStream) return false;
    this.localAudioMuted = !this.localAudioMuted;
    for (const t of this.localCallStream.getAudioTracks()) {
      t.enabled = !this.localAudioMuted;
    }
    this.callbacks.onLocalStreamUpdated(
      this.localCallStream,
      this.localHasVideo,
      this.localAudioMuted,
      this.isScreenShare
    );
    return this.localAudioMuted;
  }

  public async toggleVideo(): Promise<boolean> {
    if (!this.localCallStream) return false;
    const existingVideo = this.localCallStream.getVideoTracks()[0];

    if (existingVideo && this.localHasVideo && !this.isScreenShare) {
      this.localCallStream.removeTrack(existingVideo);
      existingVideo.stop();
      this.localHasVideo = false;
      if (this.room) {
        await this.room.addStream(this.localCallStream, {
          metadata: { hasVideo: false, isScreenShare: false },
        });
      }
      this.sendPacketAll('CALL_STATE', { inCall: true, hasVideo: false, isScreenShare: false }, 1);
      this.callbacks.onLocalStreamUpdated(
        this.localCallStream,
        false,
        this.localAudioMuted,
        false
      );
      return false;
    }

    const camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: this.cameraFacingMode },
    });
    await this.detectMultipleCameras();
    const newTrack = camStream.getVideoTracks()[0];
    if (!this.localCallStream || !newTrack) {
      for (const t of camStream.getTracks()) t.stop();
      return this.localHasVideo;
    }

    if (existingVideo) {
      this.localCallStream.removeTrack(existingVideo);
      existingVideo.stop();
    }
    this.localCallStream.addTrack(newTrack);
    this.localHasVideo = true;
    this.isScreenShare = false;
    if (this.room) {
      await this.room.addStream(this.localCallStream, {
        metadata: { hasVideo: true, isScreenShare: false },
      });
    }

    this.sendPacketAll(
      'CALL_STATE',
      { inCall: true, hasVideo: this.localHasVideo, isScreenShare: false },
      1
    );
    this.callbacks.onLocalStreamUpdated(
      this.localCallStream,
      this.localHasVideo,
      this.localAudioMuted,
      false
    );
    return this.localHasVideo;
  }

  public async switchCamera(): Promise<void> {
    if (!this.localCallStream || !this.localHasVideo || this.isScreenShare) return;
    const oldTrack = this.localCallStream.getVideoTracks()[0];
    if (!oldTrack) return;

    const nextFacing = this.cameraFacingMode === 'user' ? 'environment' : 'user';
    const nextStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: nextFacing },
    });
    const newTrack = nextStream.getVideoTracks()[0];
    if (!this.localCallStream || !newTrack) {
      for (const t of nextStream.getTracks()) t.stop();
      return;
    }

    this.cameraFacingMode = nextFacing;
    if (this.room) {
      await this.room.replaceTrack(oldTrack, newTrack);
    }
    this.localCallStream.removeTrack(oldTrack);
    oldTrack.stop();
    this.localCallStream.addTrack(newTrack);
    this.callbacks.onLocalStreamUpdated(
      this.localCallStream,
      this.localHasVideo,
      this.localAudioMuted,
      false
    );
  }

  public async toggleScreenShare(): Promise<boolean> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Screen sharing is not supported in this browser.');
    }
    if (!this.localCallStream) {
      await this.startCall({ video: false });
    }
    if (!this.localCallStream) return false;

    const existingVideo = this.localCallStream.getVideoTracks()[0];
    if (!this.isScreenShare) {
      const disp = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const dispTrack = disp.getVideoTracks()[0];
      if (!dispTrack) return false;
      this.isScreenShare = true;
      this.localHasVideo = true;

      dispTrack.addEventListener('ended', () => {
        if (this.isScreenShare) {
          void this.stopScreenShare();
        }
      });

      if (existingVideo) {
        this.localCallStream.removeTrack(existingVideo);
        existingVideo.stop();
      }
      this.localCallStream.addTrack(dispTrack);
      if (this.room) {
        await this.room.addStream(this.localCallStream, {
          metadata: { hasVideo: true, isScreenShare: true },
        });
      }
      this.sendPacketAll('CALL_STATE', { inCall: true, hasVideo: true, isScreenShare: true }, 1);
      this.callbacks.onLocalStreamUpdated(
        this.localCallStream,
        true,
        this.localAudioMuted,
        true
      );
      return true;
    } else {
      await this.stopScreenShare();
      return false;
    }
  }

  private async stopScreenShare(): Promise<void> {
    if (!this.localCallStream) return;
    this.isScreenShare = false;
    const track = this.localCallStream.getVideoTracks()[0];
    if (track) {
      this.localCallStream.removeTrack(track);
      track.stop();
    }
    this.localHasVideo = false;
    if (this.room) {
      await this.room.addStream(this.localCallStream, {
        metadata: { hasVideo: false, isScreenShare: false },
      });
    }
    this.sendPacketAll('CALL_STATE', { inCall: true, hasVideo: false, isScreenShare: false }, 1);
    this.callbacks.onLocalStreamUpdated(
      this.localCallStream,
      false,
      this.localAudioMuted,
      false
    );
  }

  public leaveCall(): void {
    const stream = this.localCallStream;
    if (!stream) return;
    this.localCallStream = null;
    this.localHasVideo = false;
    this.localAudioMuted = false;
    this.isScreenShare = false;

    if (this.room) {
      try {
        this.room.removeStream(stream);
      } catch {
        // ignore
      }
    }
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // ignore
      }
    }
    void this.releaseWakeLock();
    this.sendPacketAll('CALL_STATE', { inCall: false, hasVideo: false, isScreenShare: false }, 1);
    this.callbacks.onLocalStreamUpdated(null, false, false, false);
  }

  private async acquireWakeLock(): Promise<void> {
    try {
      const wl = (navigator as any).wakeLock;
      if (wl?.request && !this.wakeLockSentinel) {
        this.wakeLockSentinel = await wl.request('screen');
        this.wakeLockSentinel.addEventListener?.('release', () => {
          this.wakeLockSentinel = null;
        });
      }
    } catch {
      // WakeLock unsupported or denied
    }
  }

  private async releaseWakeLock(): Promise<void> {
    try {
      if (this.wakeLockSentinel) {
        await this.wakeLockSentinel.release();
        this.wakeLockSentinel = null;
      }
    } catch {
      this.wakeLockSentinel = null;
    }
  }

  // =========================================================================
  // HEARTBEAT & ICE DIAGNOSTICS
  // =========================================================================
  private onHeartbeatTick(): void {
    if (this.destroyed) return;
    this.rateLimiter.prune();
    const now = Date.now();
    this.sendPacketAll('PING', { sentAt: now }, 0);

    const failedIds = this.outbox.pruneExpired(now, OUTBOX_TTL_MS);
    if (this.peers.size > 0) {
      for (const failedId of failedIds) {
        this.callbacks.onMessageFailed(failedId);
      }
    }

    const expiredIds: string[] = [];
    for (const [id, peer] of this.peers.entries()) {
      if (now - peer.lastSeenAt > PEER_TIMEOUT_MS) {
        expiredIds.push(id);
      }
    }
    for (const id of expiredIds) {
      this.removePeerState(id);
    }

    void this.refreshIceRoutes();
  }

  private async refreshIceRoutes(): Promise<void> {
    if (!this.room) return;
    try {
      const peerInfos = this.room.getPeers();
      let updated = false;
      for (const [transportId, info] of Object.entries(peerInfos)) {
        const logicalId = this.transportToLogical.get(transportId);
        if (!logicalId) continue;
        const localInfo = this.peers.get(logicalId);
        if (!localInfo || !info.connection || localInfo.iceRoute !== 'unknown') continue;

        const route = await this.inspectConnectionRoute(info.connection);
        if (route !== 'unknown') {
          localInfo.iceRoute = route;
          updated = true;
        }
      }
      if (updated) this.emitPeersChange();
    } catch {
      // ignore stats failures
    }
  }

  private async inspectConnectionRoute(pc: RTCPeerConnection): Promise<IceRouteType> {
    try {
      const stats = await pc.getStats();
      let selectedPair: any = null;
      const candidates = new Map<string, any>();

      stats.forEach((report: any) => {
        if (report.type === 'remote-candidate' || report.type === 'local-candidate') {
          candidates.set(report.id, report);
        } else if (
          report.type === 'candidate-pair' &&
          (report.selected || report.state === 'succeeded')
        ) {
          if (!selectedPair || report.selected) {
            selectedPair = report;
          }
        }
      });

      if (!selectedPair) return 'unknown';
      const localCand = candidates.get(selectedPair.localCandidateId);
      const remoteCand = candidates.get(selectedPair.remoteCandidateId);
      if (
        localCand?.candidateType === 'relay' ||
        remoteCand?.candidateType === 'relay'
      ) {
        return 'relay';
      }
      return 'direct';
    } catch {
      return 'unknown';
    }
  }

  private broadcastLeaveSync(): void {
    try {
      this.sendPacketAll('LEAVE', {}, 0);
    } catch {
      // ignore
    }
  }

  private setPeerTyping(peerId: string, nickname: string): void {
    const existing = this.typingMap.get(peerId);
    if (existing) clearTimeout(existing.timer);
    const timer = window.setTimeout(() => {
      this.typingMap.delete(peerId);
      this.emitTypingChange();
    }, TYPING_SAFETY_TIMEOUT_MS);
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

  private warnDecryptMismatch(message: string): void {
    const now = Date.now();
    if (now - this.lastDecryptWarnAt < 10_000) return;
    this.lastDecryptWarnAt = now;
    this.callbacks.onSystemLog(message);
  }

  private emitSignalingState(): void {
    this.callbacks.onSignalingChange({
      status: this.signalingStatus,
      myPeerId: this.myPeerId,
      roomId: this.roomId,
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
