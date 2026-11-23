export type ConnectionTransport = 'trystero-mesh' | 'local-broadcast';

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

export interface MediaAttachment {
  transferId: string;
  kind: MediaKind;
  name: string;
  mimeType: string;
  size: number;
  url?: string;
  progress?: number;
  status: 'sending' | 'receiving' | 'ready' | 'error' | 'canceled';
}

export interface PeerInfo {
  peerId: string;
  nickname: string;
  transport: ConnectionTransport;
  rttMs: number | null;
  signPubKey?: string;
  ecdhPubKey?: string;
  inCall?: boolean;
  hasVideo?: boolean;
  isScreenShare?: boolean;
  audioMuted?: boolean;
  deafened?: boolean;
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
  targetPeerId?: string;
  targetPeerName?: string;
  system?: boolean;
  ackedBy: string[];
  attachment?: MediaAttachment;
  reactions?: Record<string, string[]>;
  deleted?: boolean;
  deliveryState?: 'sending' | 'sent' | 'delivered' | 'failed';
}

export type PacketType =
  | 'HELLO'
  | 'CHAT_MSG'
  | 'CHAT_ACK'
  | 'TYPING'
  | 'PING'
  | 'PONG'
  | 'NICK_CHANGE'
  | 'LEAVE'
  | 'REACTION'
  | 'DELETE_MSG'
  | 'MEDIA_CANCEL'
  | 'CALL_STATE';

export interface P2PPacket {
  packetId: string;
  type: PacketType;
  roomId: string;
  senderId: string;
  senderName: string;
  timestamp: number;
  payload: any;
  sig?: string;
  enc?: boolean;
}

export interface UserProfile {
  clientId: string;
  nickname: string;
  theme: 'light' | 'dark' | 'auto';
  fontSize: number;
  soundMuted: boolean;
}

export interface SignalingState {
  status: 'initializing' | 'ready' | 'offline';
}

export interface RemoteCallStream {
  peerId: string;
  nickname: string;
  stream: MediaStream;
  hasVideo: boolean;
  isScreenShare?: boolean;
  audioMuted?: boolean;
  deafened?: boolean;
}
