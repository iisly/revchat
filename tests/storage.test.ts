import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRoomUrl,
  createSessionProfile,
  generateRoomCode,
  generateRoomKey,
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
    const key = generateRoomKey();
    const url = buildRoomUrl('https://iisly.github.io/revchat/?room=OLD&peer=XYZ', 'room-777', key);
    expect(url).not.toContain('?room=');
    expect(url).not.toContain('peer=');
    expect(url).toContain(`#room=ROOM-777&k=${key}`);

    const parsed = parseRoomFromUrl(url);
    expect(parsed.roomId).toBe('ROOM-777');
    expect(parsed.roomKey).toBe(key);
  });

  it('falls back cleanly to legacy query URLs and defaults to LOBBY', () => {
    expect(parseRoomFromUrl('https://iisly.github.io/revchat/?room=devchat')).toEqual({
      roomId: 'DEVCHAT',
      roomKey: null,
    });
    expect(parseRoomFromUrl('https://iisly.github.io/revchat/')).toEqual({
      roomId: 'LOBBY',
      roomKey: null,
    });
  });

  it('drops invalid short fragment keys', () => {
    const parsed = parseRoomFromUrl('https://iisly.github.io/revchat/#room=TEST&k=short');
    expect(parsed).toEqual({ roomId: 'TEST', roomKey: null });
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
    expect(lMap.size).toBe(0);
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

    // Legacy 'l' string fontSize migrates cleanly to 20px
    const storedKey = Array.from(sMap.keys())[0];
    const legacy = JSON.parse(sMap.get(storedKey)!);
    legacy.fontSize = 'l';
    sMap.set(storedKey, JSON.stringify(legacy));
    const migrated = createSessionProfile();
    expect(migrated.fontSize).toBe(20);

    // Simulated duplicated/new tab navigation: issues distinct clientId so tabs don't collide
    navSpy.mockReturnValue([{ type: 'navigate' } as any]);
    const dupTab = createSessionProfile();
    expect(dupTab.clientId).not.toBe(p1.clientId);
    expect(dupTab.nickname).toBe('CustomNick');
    expect(dupTab.soundMuted).toBe(true);
  });
});
