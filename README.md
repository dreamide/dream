# Dream

Dream is a desktop IDE for working with AI coding agents.

## Features

- Multi-project workspace with project tabs
- View multiple chats at once
- Git status, branch, commit, push, and PR workflows
- File explorer, diff rendering, and editor launch integration
- Integrated terminal
- Built-in browser preview panel

## Requirements
- At least one supported agent CLI: Codex, Claude Code, OpenCode, or Cursor Agent

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

### macOS signing and notarization

`pnpm package:mac` uses Electron Builder's standard macOS signing and
notarization environment variables. For a Developer ID build, make sure the
Developer ID Application certificate and private key are installed in your
login keychain, then run:

```sh
CSC_NAME="BBKK LLC (RXKCUSCKL7)" \
APPLE_ID="you@example.com" \
APPLE_TEAM_ID="RXKCUSCKL7" \
APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx" \
pnpm package:mac
```

If there is only one Developer ID Application identity in the keychain,
`CSC_NAME` can be omitted. To use a notarytool keychain profile instead of
Apple ID password variables, set `APPLE_KEYCHAIN_PROFILE`.

## License

MIT
