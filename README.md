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

## Download

### macOS
- [ARM64](https://github.com/dreamide/dream/releases/latest/download/Dream-mac-arm64.dmg)
- [x64](https://github.com/dreamide/dream/releases/latest/download/Dream-mac-x64.dmg)

### Windows
- [x64](https://github.com/dreamide/dream/releases/latest/download/Dream-windows-x64.exe)

### Linux
- [DEB x64](https://github.com/dreamide/dream/releases/latest/download/Dream-linux-amd64.deb)
- [RPM x64](https://github.com/dreamide/dream/releases/latest/download/Dream-linux-x86_64.rpm)
- [AppImage x64](https://github.com/dreamide/dream/releases/latest/download/Dream-linux-x86_64.AppImage)

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

No environment variables are required to package locally. Pushing a `v*` tag runs the
`Package installers` workflow, which builds all platforms and publishes the installers and
`latest*.yml` update metadata to [GitHub Releases](https://github.com/dreamide/dream/releases).
Installer filenames are unversioned (for example `Dream-mac-arm64.dmg`) so
`releases/latest/download/<file>` links always point at the newest stable release. The app
auto-updates from those releases via `electron-updater`.

Platform-specific and unpacked variants:

```sh
pnpm package:dir
pnpm package:mac
pnpm package:win
pnpm package:linux
```

## License

MIT
