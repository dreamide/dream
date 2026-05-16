# dream

Dream is a desktop IDE for working with AI coding agents.

## Features

- Multi-project workspace with project tabs
- View multiple chats at once
- Git status, branch, commit, push, and PR workflows
- File explorer, diff rendering, and editor launch integration
- Integrated terminal
- Built-in browser preview panel

## Requirements
- Claude Code CLI OR Codex CLI

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