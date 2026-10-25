# revchat

Minimal, ephemeral P2P chat built with TypeScript, Vite, and WebRTC.

## Features

- **Direct P2P Mesh**: Connect via room codes (`LOBBY`), peer dial codes, shareable links, or QR codes.
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
| `/flip` / `/unflip` | Table flip / put table back |
| `/shrug` / `/lenny` | Append classic ASCII emotes |
| `/me <action>` | Send an action message |
| `/nick <name>` | Change your nickname |
| `/room [code]` | Switch room (or random room if omitted) |
| `/clear` | Clear local chat screen |