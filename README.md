# revchat

Minimal, ephemeral P2P chat built with TypeScript, Vite, and WebRTC.

## Features

- **Direct P2P Mesh**: Connect via room codes (`LOBBY`), peer follow codes (`FOLLOW`), shareable links, or QR codes.
- **Zero Storage**: No database, no chat logs on servers, and no `localStorage` persistence—everything lives strictly in memory and disappears when you close the tab.
- **Desktop & Mobile Ready**: Clean split layout on desktop and adaptive viewport drawer on mobile.

## How revchat works

- **Connect:** Enter a Room Code (or scan QR) to link via WebRTC.
- **Follow:** Paste a friend’s Peer Code to jump straight into their room.
- **Zero Traces:** No disk, no logs. Close the tab, and destroy everything.

## Slash Commands

### 1. Core Settings
| Command | Description |
| :--- | :--- |
| `/nick <name>` | Change your display nickname |
| `/room [code]` | Switch room (or random room if omitted) |
| `/follow <code>` | Follow a peer into their active room |

### 2. Chat Expression
| Command | Description |
| :--- | :--- |
| `/bold <text>` | Send bold message (`**text**`) |
| `/italic <text>` | Send italic message (`*text*`) |

### 3. Mini-Games (Strict Syntax)
| Command | Description |
| :--- | :--- |
| `/coin` | Flip a coin (`HEADS` / `TAILS`) |
| `/roll [max]` | Roll a dice (default `1-100`) |
| `/pick <a, b, ...>` | Randomly pick one from options |
| `/rps [r\|p\|s]` | Throw Rock, Paper, or Scissors (random if omitted) |
| `/8ball <question>` | Ask the Magic 8-Ball |

### 4. ASCII Emotes (In-place)
| Emote Command | Output |
| :--- | :--- |
| `/rev` | `🚩( ͡° ͜ʖ ͡°)🚩` (Signature) |
| `/shrug` | `¯\_(ツ)_/¯` |
| `/flip` | `(╯°□°）╯︵ ┻━┻` |
| `/unflip` | `┬─┬ ノ( ゜-゜ノ)` |
| `/lenny` | `( ͡° ͜ʖ ͡°)` |
| `/look` | `ಠ_ಠ` |
| `/gib` | `༼ つ ◕_◕ ༽つ` |
| `/fight` | `(ง'̀-'́)ง` |
| `/cry` | `(ಥ﹏ಥ)` |
| `/love` | `(｡♥‿♥｡)` |
| `/dance` | `♪┏(・o･)┛♪` |

### 5. Utility & Appearance
| Command | Description |
| :--- | :--- |
| `/clear` | Clear local chat view |
| `/size [s\|m\|l]` | Change main panel font size |
| `/theme [dark\|light]` | Switch theme (aliases: `/dark`, `/light`) |
| `/help` | Open commands & help guide |

### Mentions
| Trigger | Description |
| :--- | :--- |
| `@<nickname>` | Mention a peer in the room |
| `@me` | Automatically expands to your current nickname |