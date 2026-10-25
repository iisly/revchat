# revchat

Minimal, ephemeral P2P chat built with TypeScript, Vite, and WebRTC.

## Features

- **Direct P2P Mesh**: Connect via room codes (`LOBBY`), peer follow codes (`FOLLOW`), shareable links, or QR codes.
- **Zero Storage**: No database, no chat logs on servers, and no `localStorage` persistence—everything lives strictly in memory and disappears when you close the tab.
- **Desktop & Mobile Ready**: Clean split layout on desktop and adaptive viewport drawer on mobile.

## Slash Commands

| Command | Description |
| :--- | :--- |
| `/roll [max]` | Roll a dice (default `1-100`) |
| `/coin` | Flip a coin (`HEADS` / `TAILS`) |
| `/rps [r\|p\|s]` | Throw Rock, Paper, or Scissors (random if omitted) |
| `/8ball <question>` | Ask the Magic 8-Ball |
| `/pick <a, b, ...>` | Randomly pick one from any number of options |
| `/shout <text>` | Send big bold announcement |
| `/flip` / `/unflip` | `(╯°□°）╯︵ ┻━┻` / `┬─┬ ノ( ゜-゜ノ)` |
| `/shrug` / `/lenny` / `/look` | `¯\_(ツ)_/¯` / `( ͡° ͜ʖ ͡°)` / `ಠ_ಠ` |
| `/gib` / `/sparkle` / `/fight` | `༼ つ ◕_◕ ༽つ` / `(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧` / `(ง'̀-'́)ง` |
| `/bear` / `/cry` / `/love` / `/dance` | `ʕ•ᴥ•ʔ` / `(ಥ﹏ಥ)` / `(｡♥‿♥｡)` / `♪┏(・o･)┛♪` |
| `/me <action>` | Send an action message |
| `/nick <name>` | Change your nickname |
| `/room [code]` | Switch room (or random room if omitted) |
| `/follow <code>` | Follow a peer into their active room |
| `/size [s\|m\|l]` | Change main panel font size |
| `/clear` | Clear local chat screen |