import { ALLOWED_REACTIONS } from './security';
import { PeerInfo } from './types';

export interface SlashCommandDef {
  cmd: string;
  usage: string;
  desc: string;
  needsArgs: boolean;
  instant?: boolean;
}

export interface AsciiEmoteItem {
  cmd: string;
  emote: string;
  label: string;
}

export const REACTION_EMOJIS = ALLOWED_REACTIONS;

export const EIGHT_BALL_ANSWERS = [
  'It is certain.',
  'Without a doubt.',
  'Yes — definitely.',
  'Most likely.',
  'Outlook good.',
  'Ask again later.',
  'Better not tell you now.',
  'Cannot predict now.',
  'Don’t count on it.',
  'My reply is no.',
  'Very doubtful.',
];

export const ASCII_EMOTE_LIST: AsciiEmoteItem[] = [
  { cmd: '/rev', emote: '(ง ͡° ͜ʖ ͡°)ง🏴', label: 'Rev L' },
  { cmd: '/revrev', emote: '🚩( ͡° ͜ʖ ͡°)🚩', label: 'Rev R' },
  { cmd: '/shrug', emote: '¯\\_(ツ)_/¯', label: 'Shrug' },
  { cmd: '/flip', emote: '(╯°□°）╯︵ ┻━┻', label: 'Table Flip' },
  { cmd: '/unflip', emote: '┬─┬ ノ( ゜-゜ノ)', label: 'Unflip' },
  { cmd: '/lenny', emote: '( ͡° ͜ʖ ͡°)', label: 'Lenny' },
  { cmd: '/look', emote: 'ಠ_ಠ', label: 'Disapprove' },
  { cmd: '/gib', emote: '༼ つ ◕_◕ ༽つ', label: 'Give' },
  { cmd: '/fight', emote: "(ง'̀-'́)ง", label: 'Fight' },
  { cmd: '/cry', emote: '(ಥ﹏ಥ)', label: 'Cry' },
  { cmd: '/love', emote: '(｡♥‿♥｡)', label: 'Love' },
  { cmd: '/dance', emote: '♪┏(・o･)┛♪', label: 'Dance' },
];

export const ASCII_EMOTES: Record<string, string> = Object.fromEntries(
  ASCII_EMOTE_LIST.map((item) => [item.cmd, item.emote])
);

export const DEFAULT_FONT_SIZE = 16;
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 22;
export const FONT_SIZE_STEP = 2;

export function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(px)));
}

export function parseFontSizeInput(
  raw: string,
  currentPx: number
): { px?: number; error?: string } {
  const arg = raw.trim().toLowerCase();
  if (!arg) {
    return {
      error: `Text size: ${currentPx}px. Usage: /size <${MIN_FONT_SIZE}-${MAX_FONT_SIZE}|+|-|reset>`,
    };
  }
  if (arg === 'reset') return { px: DEFAULT_FONT_SIZE };
  if (arg === '+') {
    return { px: clampFontSize(currentPx + FONT_SIZE_STEP) };
  }
  if (arg === '-') {
    return { px: clampFontSize(currentPx - FONT_SIZE_STEP) };
  }
  const match = arg.match(/^(\d+)(?:px)?$/);
  if (match) {
    const n = parseInt(match[1], 10);
    if (n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE) return { px: n };
  }
  return { error: `Usage: /size <${MIN_FONT_SIZE}-${MAX_FONT_SIZE}|+|-|reset>` };
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { cmd: '/nick', usage: '/nick <name>', desc: 'Change your display nickname', needsArgs: true },
  { cmd: '/room', usage: '/room [code]', desc: 'Switch room (or join a new random room if omitted)', needsArgs: false },
  { cmd: '/clear', usage: '/clear', desc: 'Clear local chat view', needsArgs: false, instant: true },
  { cmd: '/size', usage: '/size <12-22|+|-|reset>', desc: 'Change chat text size', needsArgs: false },
  { cmd: '/theme', usage: '/theme [dark|light]', desc: 'Switch dark/light theme', needsArgs: false },
  { cmd: '/mute', usage: '/mute', desc: 'Toggle notification sound', needsArgs: false, instant: true },
  { cmd: '/help', usage: '/help', desc: 'Open commands & help guide', needsArgs: false, instant: true },
];

export function expandInlineTokens(text: string, myNickname: string): string {
  let res = text.replace(/(^|\s)@me(?=\s|$)/gi, (_full, lead) => `${lead}@${myNickname}`);
  res = res.replace(/(^|\s)(\/[a-z0-9]+)(?=\s|$)/gi, (full, lead, token) => {
    const emote = ASCII_EMOTES[token.toLowerCase()];
    return emote ? `${lead}${emote}` : full;
  });
  return res;
}

export function getMatchingSlashCommands(
  rawInput: string,
  dismissed = false
): SlashCommandDef[] {
  if (dismissed || rawInput.includes('\n')) return [];
  if (!rawInput.startsWith('/') || rawInput.includes(' ')) return [];
  const prefix = rawInput.toLowerCase();
  return SLASH_COMMANDS.filter((item) => item.cmd.startsWith(prefix));
}

export function getMatchingMentions(
  rawInput: string,
  myNickname: string,
  peers: Pick<PeerInfo, 'peerId' | 'nickname'>[],
  dismissed = false
): Array<{ tag: string; label: string; desc: string }> {
  if (dismissed || rawInput.includes('\n')) return [];

  const match = rawInput.match(/(?:^|\s)(@[a-zA-Z0-9_\-\uAC00-\uD7A3]*)$/i);
  if (!match) return [];
  const token = match[1].toLowerCase();

  const list: Array<{ tag: string; label: string; desc: string }> = [
    { tag: '@me', label: `@me (${myNickname})`, desc: 'Your display nickname' },
  ];

  for (const peer of peers) {
    if (
      peer.nickname &&
      !list.some((it) => it.tag.toLowerCase() === `@${peer.nickname.toLowerCase()}`)
    ) {
      list.push({
        tag: `@${peer.nickname}`,
        label: `@${peer.nickname}`,
        desc: 'Member',
      });
    }
  }

  return list.filter((item) => item.tag.toLowerCase().startsWith(token));
}

export interface GameCommandResult {
  text?: string;
  error?: string;
}

export function runCoinFlip(_nick: string, argStr = ''): GameCommandResult {
  if (argStr.trim()) {
    return { error: 'Usage: /coin' };
  }
  const side = Math.random() < 0.5 ? 'HEADS' : 'TAILS';
  return { text: `🪙 COIN · ${side}` };
}

export function runDiceRoll(_nick: string, argStr = ''): GameCommandResult {
  let max = 6;
  const trimmed = argStr.trim();
  if (trimmed) {
    const parsed = parseInt(trimmed, 10);
    if (isNaN(parsed) || parsed < 2) {
      return { error: 'Usage: /roll [max]' };
    }
    max = Math.min(1_000_000, parsed);
  }
  const val = Math.floor(Math.random() * max) + 1;
  return { text: `🎲 DICE 1-${max} · ${val}` };
}

export function runPick(_nick: string, argStr: string): GameCommandResult {
  const clean = argStr.trim();
  if (!clean) {
    return { error: 'Usage: /pick option1, option2, ...' };
  }
  const items = (clean.includes(',') ? clean.split(',') : clean.split(/\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length < 2) {
    return { error: 'Usage: /pick option1, option2, ...' };
  }
  const chosen = items[Math.floor(Math.random() * items.length)];
  return { text: `🎯 PICK · ${chosen} (${items.join(', ')})` };
}

export function runRps(_nick: string, argStr = ''): GameCommandResult {
  const hands = ['✊ ROCK', '✋ PAPER', '✌️ SCISSORS'];
  const trimmed = argStr.trim();
  if (!trimmed) {
    const pick = hands[Math.floor(Math.random() * hands.length)];
    return { text: `🎲 RPS · ${pick}` };
  }
  const choice = trimmed.toLowerCase();
  let pick = '';
  if (choice === 'r' || choice === 'rock') pick = '✊ RPS · ROCK';
  else if (choice === 'p' || choice === 'paper') pick = '✋ RPS · PAPER';
  else if (choice === 's' || choice === 'scissors') pick = '✌️ RPS · SCISSORS';
  else {
    return { error: 'Usage: /rps [r|p|s]' };
  }
  return { text: pick };
}

export function runEightBall(_nick: string, argStr: string): GameCommandResult {
  const q = argStr.trim();
  if (!q) {
    return { error: 'Usage: /8ball <question>' };
  }
  const ans = EIGHT_BALL_ANSWERS[Math.floor(Math.random() * EIGHT_BALL_ANSWERS.length)];
  return { text: `🎱 8-BALL · ${q} → ${ans}` };
}
