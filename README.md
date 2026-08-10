# Dream

Dream is a desktop IDE for working with multiple AI coding agents.

<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/8b863bec-76ff-4973-b6c3-a66b1683500f" />


## Features

- Multi-project workspace with project tabs
- View multiple chats at once
- Git status, branch, commit, push, and PR workflows
- File explorer, diff rendering, and editor launch integration
- Integrated terminal
- Built-in browser preview panel

## Requirements
At least one supported agent CLI:
- Codex
- Claude Code
- OpenCode
- Cursor Agent
- Amp ([`amp-acp`](https://github.com/tao12345666333/amp-acp) 0.9.0 or newer;
  install or update with `npm install -g amp-acp@latest`, then authenticate with
  `amp login` or adapter setup). Do not confuse it with the incompatible
  `acp-amp` executable. Amp's standard permission mode follows the permissions
  configured in Amp; Dream's full-access mode uses the adapter's `Bypass`
  option. The adapter does not currently expose Dream's read-only Plan mode.

## Download

### macOS
- [ARM64](https://files.dreamide.app/latest/Dream-mac-arm64.dmg)
- [x64](https://files.dreamide.app/latest/Dream-mac-x64.dmg)

### Windows
- [x64](https://files.dreamide.app/latest/Dream-windows-x64.exe)

### Linux
- [DEB x64](https://files.dreamide.app/latest/Dream-linux-x64.deb)
- [RPM x64](https://files.dreamide.app/latest/Dream-linux-x64.rpm)
- [AppImage x64](https://files.dreamide.app/latest/Dream-linux-x64.AppImage)

## Installation

Install dependencies:

```sh
pnpm install
```

## Development

```sh
pnpm dev
```

## Build

Create a production build:

```sh
pnpm build
```

Run the Electron app against the production build:

```sh
pnpm start
```

## Packaging

Build the renderer and package the Electron app:

```sh
pnpm package
```

Artifacts are written to `release/` by `electron-builder`.

Platform-specific and unpacked variants:

```sh
pnpm package:dir
pnpm package:mac
pnpm package:win
pnpm package:linux
```

## License

MIT
