import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BlobUrlRegistry,
  canOpenFileInBrowser,
  classifyMime,
  extractClipboardFiles,
  inferMimeFromFilename,
  normalizePastedFile,
  resolveTextBlobMime,
} from '../src/media';

describe('media classification and file helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('infers MIME types cleanly from common filenames and extensions', () => {
    expect(inferMimeFromFilename('photo.JPG')).toBe('image/jpeg');
    expect(inferMimeFromFilename('iphone.heic')).toBe('image/heic');
    expect(inferMimeFromFilename('report.pdf')).toBe('application/pdf');
    expect(inferMimeFromFilename('notes.txt')).toBe('text/plain');
    expect(inferMimeFromFilename('archive.bin')).toBe('application/octet-stream');
  });

  it('classifies media kinds accurately even with generic MIME types', () => {
    expect(classifyMime('image/png', 'shot.png')).toBe('image');
    expect(classifyMime('application/octet-stream', 'photo.jfif')).toBe('image');
    expect(classifyMime('video/mp4', 'clip.mp4')).toBe('video');
    expect(classifyMime('audio/ogg', 'note.opus')).toBe('audio');
    expect(classifyMime('application/pdf', 'spec.pdf')).toBe('file');
  });

  it('allows browser OPEN only for PDF and TXT files', () => {
    expect(canOpenFileInBrowser('application/pdf', 'doc.pdf')).toBe(true);
    expect(canOpenFileInBrowser('application/octet-stream', 'report.PDF')).toBe(true);
    expect(canOpenFileInBrowser('text/plain', 'notes.txt')).toBe(true);
    expect(canOpenFileInBrowser('application/octet-stream', 'log.TXT')).toBe(true);
    expect(canOpenFileInBrowser('text/csv', 'sales.csv')).toBe(false);
    expect(canOpenFileInBrowser('application/json', 'package.json')).toBe(false);
    expect(canOpenFileInBrowser('application/octet-stream', 'app.ts')).toBe(false);
    expect(canOpenFileInBrowser('application/octet-stream', 'README')).toBe(false);
    expect(canOpenFileInBrowser('application/zip', 'bundle.zip')).toBe(false);
  });

  it('tracks and revokes created URLs via BlobUrlRegistry', () => {
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-1');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    const registry = new BlobUrlRegistry();
    const plain = new Blob(['hello revchat'], { type: 'text/plain' });
    const url = registry.create(plain);
    expect(createSpy).toHaveBeenCalledWith(plain);

    registry.revoke(url);
    expect(revokeSpy).toHaveBeenCalledWith(url);
    registry.revoke(url);
    expect(revokeSpy).toHaveBeenCalledTimes(1);

    const url2 = registry.create(plain);
    registry.revokeAll();
    expect(revokeSpy).toHaveBeenCalledWith(url2);
  });

  it('detects charset for plain text files when missing', () => {
    const utf8Bytes = new TextEncoder().encode('안녕하세요 revchat');
    expect(resolveTextBlobMime(utf8Bytes, 'text/plain', 'memo.txt')).toBe(
      'text/plain;charset=utf-8'
    );

    // EUC-KR / CP949 for "한글" (0xC7 0xD1 0xB1 0xDB)
    const eucKrBytes = new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb]);
    expect(resolveTextBlobMime(eucKrBytes, 'application/octet-stream', 'ansi.txt')).toBe(
      'text/plain;charset=euc-kr'
    );

    // UTF-16LE BOM
    const utf16LeBytes = new Uint8Array([0xff, 0xfe, 0x48, 0x00]);
    expect(resolveTextBlobMime(utf16LeBytes, 'text/plain', 'u16.txt')).toBe(
      'text/plain;charset=utf-16le'
    );

    // Preserves explicit charset and non-txt MIME types
    expect(resolveTextBlobMime(utf8Bytes, 'text/plain;charset=utf-8', 'memo.txt')).toBe(
      'text/plain;charset=utf-8'
    );
    expect(resolveTextBlobMime(utf8Bytes, 'application/pdf', 'doc.pdf')).toBe('application/pdf');
  });

  it('extracts and normalizes clipboard files across items and files fallbacks', () => {
    const pastedPng = new File([new Uint8Array([1, 2, 3])], '', { type: 'image/png' });
    const fakeTransferWithItems = {
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => pastedPng },
      ],
      files: [],
    } as unknown as DataTransfer;

    expect(extractClipboardFiles(fakeTransferWithItems)).toEqual([pastedPng]);

    const namedFile = new File(['abc'], 'notes.txt', { type: 'text/plain' });
    const fakeTransferFilesOnly = {
      items: [{ kind: 'string', getAsFile: () => null }],
      files: [namedFile],
    } as unknown as DataTransfer;

    expect(extractClipboardFiles(fakeTransferFilesOnly)).toEqual([namedFile]);
    expect(extractClipboardFiles(null)).toEqual([]);

    const normImg = normalizePastedFile(pastedPng);
    expect(normImg.name).toBe('pasted-image.png');
    expect(normImg.type).toBe('image/png');

    const unnamedPdf = new File(['%PDF'], '', { type: 'application/pdf' });
    expect(normalizePastedFile(unnamedPdf).name).toBe('pasted-file.pdf');

    expect(normalizePastedFile(namedFile)).toBe(namedFile);
  });
});
