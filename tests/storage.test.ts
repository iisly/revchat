import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRoomUrl,
  createSessionProfile,
  generateRoomCode,
  normalizeRoomId,
  parseRoomFromUrl,
  saveSessionProfile,
} from '../src/storage';

describe('storage & URL routing module', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).sessionStorage;
    delete (globalThis as any).localStorage;
  });

  it('normalizes room IDs safely and generates prefix-free 6-char room codes', () => {
    expect(generateRoomCode()).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
    expect(normalizeRoomId('  hello world! ')).toBe('HELLO-WORLD');
    expect(normalizeRoomId('')).toBe('LOBBY');
    expect(normalizeRoomId('---')).toBe('LOBBY');
  });

  it('builds URL with hash fragment and strips legacy query parameters', () => {
    const url = buildRoomUrl('https://iisly.github.io/revchat/?room=OLD&peer=XYZ', 'room-777');
    expect(url).not.toContain('?room=');
    expect(url).not.toContain('peer=');
    expect(url).not.toContain('&k=');
    expect(url).toContain('#room=ROOM-777');

    expect(parseRoomFromUrl(url)).toBe('ROOM-777');
  });

  it('parses bare hashes, legacy query/key URLs, and defaults to LOBBY', () => {
    expect(parseRoomFromUrl('https://iisly.github.io/revchat/?room=devchat')).toBe('DEVCHAT');
    expect(parseRoomFromUrl('https://iisly.github.io/revchat/#dev-room')).toBe('DEV-ROOM');
    expect(parseRoomFromUrl('https://iisly.github.io/revchat/#room=TEST&k=oldkey')).toBe('TEST');
    expect(parseRoomFromUrl('https://iisly.github.io/revchat/')).toBe('LOBBY');
  });

  it('reuses clientId on reload but issues a fresh clientId on new/duplicated tabs', () => {
    const sMap = new Map<string, string>();
    const lMap = new Map<string, string>([['stale', 'value']]);
    (globalThis as any).sessionStorage = {
      getItem: (k: string) => sMap.get(k) ?? null,
      setItem: (k: string, v: string) => sMap.set(k, v),
      removeItem: (k: string) => sMap.delete(k),
      clear: () => sMap.clear(),
    };
    (globalThis as any).localStorage = {
      clear: () => lMap.clear(),
    };

    const p1 = createSessionProfile();
    expect(lMap.size).toBe(1);
    expect(p1.nickname).toBe(p1.clientId.toUpperCase());
    expect(p1.nickname).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
    expect(p1.fontSize).toBe(16);
    p1.nickname = 'CustomNick';
    p1.soundMuted = true;
    saveSessionProfile(p1);

    // Simulated reload: preserves same clientId + preferences
    const navSpy = vi
      .spyOn(performance, 'getEntriesByType')
      .mockReturnValue([{ type: 'reload' } as any]);
    const reloaded = createSessionProfile();
    expect(reloaded.clientId).toBe(p1.clientId);
    expect(reloaded.nickname).toBe('CustomNick');
    expect(reloaded.soundMuted).toBe(true);

    // Out-of-range fontSize clamps cleanly to MAX_FONT_SIZE (22px)
    const storedKey = Array.from(sMap.keys())[0];
    const modified = JSON.parse(sMap.get(storedKey)!);
    modified.fontSize = 99;
    sMap.set(storedKey, JSON.stringify(modified));
    const clamped = createSessionProfile();
    expect(clamped.fontSize).toBe(22);

    // Simulated duplicated/new tab navigation: issues distinct clientId so tabs don't collide
    navSpy.mockReturnValue([{ type: 'navigate' } as any]);
    const dupTab = createSessionProfile();
    expect(dupTab.clientId).not.toBe(p1.clientId);
    expect(dupTab.nickname).toBe('CustomNick');
    expect(dupTab.soundMuted).toBe(true);
  });
});
