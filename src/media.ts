import { MediaKind } from './types';

export { MAX_MEDIA_BYTES } from './security';
const IMAGE_COMPRESS_THRESHOLD = 3_000_000;
const MAX_IMAGE_DIM = 1920;
export const MAX_VOICE_SECONDS = 180;

const EXT_MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  pdf: 'application/pdf',
  txt: 'text/plain',
};

export function canOpenFileInBrowser(mimeType: string, filename = ''): boolean {
  const mime = mimeType.toLowerCase().split(';')[0].trim();
  const base = filename.toLowerCase().split(/[\\/]/).pop() || '';
  const ext = base.includes('.') ? base.split('.').pop() || '' : '';
  return mime === 'application/pdf' || ext === 'pdf' || mime === 'text/plain' || ext === 'txt';
}

export function resolveTextBlobMime(
  bytes: Uint8Array | ArrayBuffer,
  mimeType: string,
  filename = ''
): string {
  const lowerMime = mimeType.toLowerCase();
  const baseMime = lowerMime.split(';')[0].trim();
  const baseName = filename.toLowerCase().split(/[\\/]/).pop() || '';
  const ext = baseName.includes('.') ? baseName.split('.').pop() || '' : '';
  if (baseMime !== 'text/plain' && ext !== 'txt') {
    return mimeType;
  }
  if (/;\s*charset=/i.test(lowerMime)) {
    return mimeType;
  }

  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let charset = 'utf-8';
  if (view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) {
    charset = 'utf-8';
  } else if (view.length >= 2 && view[0] === 0xff && view[1] === 0xfe) {
    charset = 'utf-16le';
  } else if (view.length >= 2 && view[0] === 0xfe && view[1] === 0xff) {
    charset = 'utf-16be';
  } else {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(view);
      charset = 'utf-8';
    } catch {
      try {
        new TextDecoder('euc-kr', { fatal: true }).decode(view);
        charset = 'euc-kr';
      } catch {
        charset = 'utf-8';
      }
    }
  }
  return `text/plain;charset=${charset}`;
}

export function inferMimeFromFilename(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  return EXT_MIME_MAP[ext] || 'application/octet-stream';
}

const MIME_DEFAULT_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

export function extractClipboardFiles(clipboardData: DataTransfer | null | undefined): File[] {
  if (!clipboardData) return [];
  const files: File[] = [];
  if (clipboardData.items) {
    for (const item of clipboardData.items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  if (files.length === 0 && clipboardData.files && clipboardData.files.length > 0) {
    files.push(...Array.from(clipboardData.files));
  }
  return files;
}

export function normalizePastedFile(file: File): File {
  if (file.name && file.name.trim()) return file;
  const mime = (file.type || '').toLowerCase().split(';')[0].trim();
  const ext = MIME_DEFAULT_EXT[mime] || 'bin';
  const prefix = mime.startsWith('image/') ? 'pasted-image' : 'pasted-file';
  const name = `${prefix}.${ext}`;
  return new File([file], name, {
    type: file.type || inferMimeFromFilename(name),
  });
}

export function classifyMime(mimeType: string, filename = ''): MediaKind {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const ext = filename.toLowerCase().split('.').pop() || '';
  if (['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'heic', 'heif'].includes(ext)) {
    return 'image';
  }
  if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'm4a', 'ogg', 'wav', 'aac', 'opus'].includes(ext)) return 'audio';
  return 'file';
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.floor(bytes))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export async function compressImageIfNeeded(
  file: File
): Promise<{ blob: Blob; mimeType: string; canRenderAsImage: boolean }> {
  const mime = (file.type || inferMimeFromFilename(file.name) || 'image/jpeg').toLowerCase();
  const isHeic = mime === 'image/heic' || mime === 'image/heif';
  if (
    !isHeic &&
    (file.size <= IMAGE_COMPRESS_THRESHOLD ||
      mime === 'image/gif' ||
      mime === 'image/svg+xml' ||
      !mime.startsWith('image/'))
  ) {
    return { blob: file, mimeType: mime, canRenderAsImage: true };
  }

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return { blob: file, mimeType: mime, canRenderAsImage: !isHeic };
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const outMime = mime === 'image/png' ? 'image/webp' : 'image/jpeg';
    const outBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), outMime, 0.82)
    );
    if (outBlob && (isHeic || outBlob.size < file.size)) {
      return { blob: outBlob, mimeType: outMime, canRenderAsImage: true };
    }
  } catch {
    // Fallback cleanly to original file on unsupported bitmap formats (e.g. HEIC)
  }
  return { blob: file, mimeType: mime, canRenderAsImage: !isHeic };
}

/**
 * Picks an audio MIME type prioritizing MP4/AAC so iOS Safari, Android Chrome, and Desktop
 * browsers can all reliably decode received voice notes inside <audio controls>.
 */
function pickBestAudioMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  const candidates = [
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      // ignore
    }
  }
  return '';
}

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private timer: number | null = null;
  private startAt = 0;
  private canceled = false;
  private stopping = false;
  private mimeType = '';

  public async start(
    onTick: (sec: number) => void,
    onAutoStop: (result: { blob: Blob; mimeType: string; durationSec: number } | null) => void
  ): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error('Voice recording is not supported in this browser.');
    }

    if (this.recorder || this.stream) {
      this.cancel();
    }

    this.canceled = false;
    this.stopping = false;
    this.chunks = [];
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    this.mimeType = pickBestAudioMimeType();
    this.recorder = this.mimeType
      ? new MediaRecorder(this.stream, { mimeType: this.mimeType })
      : new MediaRecorder(this.stream);

    this.recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        this.chunks.push(ev.data);
      }
    };

    this.startAt = Date.now();
    this.recorder.start(250);
    onTick(0);

    this.timer = window.setInterval(async () => {
      const elapsed = Math.floor((Date.now() - this.startAt) / 1000);
      onTick(elapsed);
      if (elapsed >= MAX_VOICE_SECONDS) {
        const res = await this.stop();
        onAutoStop(res);
      }
    }, 500);
  }

  public async stop(): Promise<{ blob: Blob; mimeType: string; durationSec: number } | null> {
    if (this.stopping) return null;
    this.stopping = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const rec = this.recorder;
    const stream = this.stream;
    const durationSec = Math.max(1, Math.round((Date.now() - this.startAt) / 1000));

    if (!rec || rec.state === 'inactive') {
      this.cleanupStream(stream);
      this.recorder = null;
      this.stream = null;
      this.stopping = false;
      return null;
    }

    try {
      const result = await new Promise<{ blob: Blob; mimeType: string; durationSec: number } | null>(
        (resolve) => {
          rec.onstop = () => {
            this.cleanupStream(stream);
            if (this.canceled || this.chunks.length === 0) {
              resolve(null);
              return;
            }
            const finalMime = rec.mimeType || this.mimeType || 'audio/mp4';
            const blob = new Blob(this.chunks, { type: finalMime });
            resolve({ blob, mimeType: finalMime, durationSec });
          };
          try {
            rec.stop();
          } catch {
            this.cleanupStream(stream);
            resolve(null);
          }
        }
      );

      this.recorder = null;
      this.stream = null;
      this.chunks = [];
      return result;
    } finally {
      this.stopping = false;
    }
  }

  public cancel(): void {
    this.canceled = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.stop();
      }
    } catch {
      // ignore
    }
    this.cleanupStream(this.stream);
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
  }

  private cleanupStream(stream: MediaStream | null): void {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // ignore
      }
    }
  }
}

export class BlobUrlRegistry {
  private urls = new Set<string>();

  public create(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    this.urls.add(url);
    return url;
  }

  public revoke(url?: string): void {
    if (!url || !this.urls.has(url)) return;
    URL.revokeObjectURL(url);
    this.urls.delete(url);
  }

  public revokeAll(): void {
    for (const url of this.urls) {
      URL.revokeObjectURL(url);
    }
    this.urls.clear();
  }
}
