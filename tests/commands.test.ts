import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FONT_SIZE,
  SLASH_COMMANDS,
  clampFontSize,
  expandInlineTokens,
  getMatchingMentions,
  getMatchingSlashCommands,
  parseFontSizeInput,
  runCoinFlip,
  runDiceRoll,
  runEightBall,
  runPick,
  runRps,
} from '../src/commands';

describe('commands module', () => {
  it('expands @me and inline ASCII emotes accurately', () => {
    expect(expandInlineTokens('@me says /shrug', 'Alice')).toBe('@Alice says ¯\\_(ツ)_/¯');
    expect(expandInlineTokens('email@me.com stays untouched', 'Alice')).toBe(
      'email@me.com stays untouched'
    );
  });

  it('exposes only the 7 core slash commands and matches start-of-input only', () => {
    const names = SLASH_COMMANDS.map((c) => c.cmd);
    expect(names).toEqual(['/nick', '/room', '/clear', '/size', '/theme', '/mute', '/help']);
    for (const removed of [
      '/bold',
      '/italic',
      '/coin',
      '/roll',
      '/pick',
      '/rps',
      '/8ball',
      '/flip',
      '/shrug',
      '/rev',
      '/dark',
      '/light',
      '/private',
      '/follow',
    ]) {
      expect(names).not.toContain(removed);
    }

    expect(getMatchingSlashCommands('/r').map((m) => m.cmd)).toEqual(['/room']);
    expect(getMatchingSlashCommands('hello /fl')).toEqual([]);
    expect(getMatchingSlashCommands('/r', true)).toEqual([]);
  });

  it('matches peer @mentions and @me', () => {
    const list = getMatchingMentions('hey @al', 'Bob', [
      { peerId: 'p1', nickname: 'Alice' },
      { peerId: 'p2', nickname: 'Charlie' },
    ]);
    expect(list.map((m) => m.tag)).toEqual(['@Alice']);
  });

  it('executes original mini-games faithfully', () => {
    expect(runCoinFlip('Bob').text).toMatch(/^🪙 COIN · (HEADS|TAILS)$/);
    expect(runCoinFlip('Bob', 'extra').error).toBe('Usage: /coin');

    expect(runDiceRoll('Bob').text).toMatch(/^🎲 DICE 1-6 · [1-6]$/);
    expect(runDiceRoll('Bob', '10').text).toMatch(/^🎲 DICE 1-10 · \d+$/);
    expect(runDiceRoll('Bob', '100').text).toMatch(/^🎲 DICE 1-100 · \d+$/);
    expect(runDiceRoll('Bob', '1').error).toBe('Usage: /roll [max]');
    expect(runDiceRoll('Bob', 'abc').error).toBe('Usage: /roll [max]');

    expect(runPick('Bob', 'onlyone').error).toBe('Usage: /pick option1, option2, ...');
    const pickRes = runPick('Bob', 'ice cream, fried chicken');
    expect(pickRes.text).toMatch(/^🎯 PICK · (ice cream|fried chicken) \(ice cream, fried chicken\)$/);

    expect(runRps('Bob').text).toMatch(/^🎲 RPS · (✊ ROCK|✋ PAPER|✌️ SCISSORS)$/);
    expect(runRps('Bob', 'r').text).toBe('✊ RPS · ROCK');
    expect(runRps('Bob', 'paper').text).toBe('✋ RPS · PAPER');
    expect(runRps('Bob', 'invalid').error).toBe('Usage: /rps [r|p|s]');

    expect(runEightBall('Bob', '').error).toBe('Usage: /8ball <question>');
    expect(runEightBall('Bob', 'Will it work?').text).toMatch(/^🎱 8-BALL · Will it work\? → .+/);
  });

  it('parses and clamps numeric text sizes consistently', () => {
    expect(clampFontSize(8)).toBe(12);
    expect(clampFontSize(30)).toBe(22);
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_FONT_SIZE);

    expect(parseFontSizeInput('16', 14)).toEqual({ px: 16 });
    expect(parseFontSizeInput('18px', 14)).toEqual({ px: 18 });
    expect(parseFontSizeInput('+', 14)).toEqual({ px: 16 });
    expect(parseFontSizeInput('-', 14)).toEqual({ px: 12 });
    expect(parseFontSizeInput('reset', 20)).toEqual({ px: DEFAULT_FONT_SIZE });

    expect(parseFontSizeInput('', 16).error).toContain('Text size: 16px.');
    expect(parseFontSizeInput('s', 18).error).toBe('Usage: /size <12-22|+|-|reset>');
    expect(parseFontSizeInput('99', 14).error).toBe('Usage: /size <12-22|+|-|reset>');
    expect(parseFontSizeInput('xl', 14).error).toBe('Usage: /size <12-22|+|-|reset>');
  });
});
