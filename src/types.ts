export type ConnectionTransport = 'peerjs-mesh' | 'manual-webrtc' | 'local-broadcast';

export type PeerConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface PeerInfo {
  peerId: string;
  nickname: string;
  transport: ConnectionTransport;
  state: PeerConnectionState;
  rttMs: number | null;
  isRoomBeaconHolder?: boolean;
  connectedAt: number;
  lastSeenAt: number;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  replyTo?: {
    id: string;
    senderName: string;
    text: string;
  };
  targetPeerId?: string; // If set, private whisper (1:1) message inside or outside room
  targetPeerName?: string;
  system?: boolean;
  ackedBy: string[]; // List of peerIds that acknowledged receipt
  editedAt?: number;
}

export type PacketType =
  | 'HELLO'
  | 'PEER_LIST'
  | 'CHAT_MSG'
  | 'CHAT_ACK'
  | 'TYPING'
  | 'PING'
  | 'PONG'
  | 'HISTORY_SYNC'
  | 'NICK_CHANGE'
  | 'LEAVE';

export interface P2PPacket {
  packetId: string;
  type: PacketType;
  roomId: string;
  senderId: string;
  senderName: string;
  timestamp: number;
  ttl: number;
  payload: any;
}

export interface UserProfile {
  clientId: string;
  nickname: string;
  theme: 'light' | 'dark' | 'auto';
  soundEnabled: boolean;
  syncHistoryOnJoin: boolean;
}

export interface SignalingState {
  status: 'initializing' | 'ready' | 'offline' | 'error';
  myPeerId: string;
  roomId: string;
  isBeaconHost: boolean;
  errorMessage?: string;
}

