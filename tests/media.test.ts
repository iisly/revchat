import { describe, expect, it } from 'vitest';
import {
  classifyFilePreview,
  classifyMime,
  inferMimeFromFilename,
  parseDelimitedTable,
} from '../src/media';

describe('media classification and file preview helpers', () => {
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
});
