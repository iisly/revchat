# revchat

Minimal, ephemeral P2P chat built with TypeScript, Vite, WebRTC and PeerJS.

## How revchat works

- **Connect:** Join a room via Room Code or QR link.
- **Follow:** Jump into a friend's room via Peer Code.
- **Stateless:** No disk, no logs. Close the tab to wipe everything.

## Commands

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
| `/rev` | `(ง ͡° ͜ʖ ͡°)ง🏴` (Signature) |
| `/revrev` | `🚩( ͡° ͜ʖ ͡°)🚩` (Signature) |
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

### 6. Mentions
| Trigger | Description |
| :--- | :--- |
| `@<nickname>` | Mention a peer in the room |
| `@me` | Automatically expands to your current nickname |