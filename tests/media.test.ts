import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BlobUrlRegistry,
  classifyFilePreview,
  classifyMime,
  inferMimeFromFilename,
  parseDelimitedTable,
  readBlobPreviewText,
} from '../src/media';

describe('media classification and file preview helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('infers MIME types cleanly from common filenames and extensions', () => {
    expect(inferMimeFromFilename('photo.JPG')).toBe('image/jpeg');
    expect(inferMimeFromFilename('iphone.heic')).toBe('image/heic');
    expect(inferMimeFromFilename('report.pdf')).toBe('application/pdf');
    expect(inferMimeFromFilename('data.csv')).toBe('text/csv');
    expect(inferMimeFromFilename('config.json')).toBe('application/json');
    expect(inferMimeFromFilename('archive.bin')).toBe('application/octet-stream');
  });

  it('classifies media kinds accurately even with generic MIME types', () => {
    expect(classifyMime('image/png', 'shot.png')).toBe('image');
    expect(classifyMime('application/octet-stream', 'photo.jfif')).toBe('image');
    expect(classifyMime('video/mp4', 'clip.mp4')).toBe('video');
    expect(classifyMime('audio/ogg', 'note.opus')).toBe('audio');
    expect(classifyMime('application/pdf', 'spec.pdf')).toBe('file');
  });

  it('classifies previewable text, code, csv, and pdf files while excluding binaries', () => {
    expect(classifyFilePreview('application/pdf', 'doc.pdf')).toBe('pdf');
    expect(classifyFilePreview('application/octet-stream', 'report.PDF')).toBe('pdf');
    expect(classifyFilePreview('text/csv', 'sales.csv')).toBe('csv');
    expect(classifyFilePreview('application/octet-stream', 'table.tsv')).toBe('csv');
    expect(classifyFilePreview('application/json', 'package.json')).toBe('text');
    expect(classifyFilePreview('application/octet-stream', 'app.ts')).toBe('text');
    expect(classifyFilePreview('application/octet-stream', 'README')).toBe('text');
    expect(classifyFilePreview('application/zip', 'bundle.zip')).toBe('none');
    expect(classifyFilePreview('application/octet-stream', 'firmware.exe')).toBe('none');
  });

  it('parses RFC-4180 CSV and TSV tables with quotes, escaped quotes, CRLF, and caps', () => {
    const csv = '\uFEFFname,role,note\r\n"Kim, Min",admin,"says ""hi"""\r\nLee,member,\r\n';
    const parsed = parseDelimitedTable(csv, ',');
    expect(parsed.truncated).toBe(false);
    expect(parsed.rows).toEqual([
      ['name', 'role', 'note'],
      ['Kim, Min', 'admin', 'says "hi"'],
      ['Lee', 'member', ''],
    ]);

    const tsv = 'a\tb\tc\n1\t2\t3\n4\t5\t6\n';
    const capped = parseDelimitedTable(tsv, '\t', 2, 2);
    expect(capped.truncated).toBe(true);
    expect(capped.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('reads Blob text previews without fetch and maps URLs via BlobUrlRegistry', async () => {
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-1');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('fetch should not be called'));

    const registry = new BlobUrlRegistry();
    const plain = new Blob(['hello revchat'], { type: 'text/plain' });
    const url = registry.create(plain);
    expect(createSpy).toHaveBeenCalledWith(plain);
    expect(registry.get(url)).toBe(plain);

    await expect(readBlobPreviewText(registry.get(url)!, 5)).resolves.toEqual({
      text: 'hello',
      truncated: true,
      isBinary: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    registry.revoke(url);
    expect(revokeSpy).toHaveBeenCalledWith(url);
    expect(registry.get(url)).toBeUndefined();

    const binary = new Blob([new Uint8Array([65, 66, 0, 67])], {
      type: 'application/octet-stream',
    });
    const binRes = await readBlobPreviewText(binary);
    expect(binRes.isBinary).toBe(true);
    expect(binRes.truncated).toBe(false);
  });
});
