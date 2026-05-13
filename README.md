# dream

dream is a desktop IDE for working with AI coding agents.

## Features

- Multi-project workspace with project tabs and per-project state
- Chat interface for Codex and Claude Code-backed coding sessions
- Integrated terminal runner powered by `node-pty`
- Built-in browser preview panel for local web apps
- Git status, branch, commit, push, and PR workflows
- File explorer, diff rendering, and editor launch integration
- Persisted chats, browser tabs, settings, and theme preferences

## Requirements

- Node.js
- pnpm
- Codex CLI on `PATH` for Codex-backed chats
- Claude Code authentication for Claude-backed chats

Install dependencies:

```sh
pnpm install
```

## Development

Start the Electron app in development mode:

```sh
pnpm dev
```

The development flow prepares the Electron app, starts the renderer server on `127.0.0.1:3210`, and launches Electron with development settings.

You can also run the Vite renderer directly:

```sh
pnpm dev:vite
```

## Build

Create a production renderer build:

```sh
pnpm build
```

Run the Electron app against the production build:

```sh
pnpm start
```

## Quality Checks

Run Biome checks:

```sh
pnpm lint
```

Run TypeScript checks:

```sh
pnpm typecheck
```

Format the project:

```sh
pnpm format
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

## Database

Generate Drizzle artifacts:

```sh
pnpm db:generate
```

The Drizzle config lives in `drizzle.config.ts`, with Electron-side schema files under `electron/db`.

## Useful Scripts

Import Codex chat history:

```sh
pnpm import:codex-chats
```

Repair `node-pty` permissions and prepare the Electron development app:

```sh
pnpm postinstall
```

