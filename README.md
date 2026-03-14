# Dream IDE

Multi-project AI desktop IDE built with Electron + Next.js.

## What it includes

- Multi-project workspace with tabbed projects (Chrome-style tab strip)
- Resizable 4-panel layout:
  - Left: project list + settings
  - Middle: AI chat (AI SDK + AI Elements)
  - Right: live app preview (Electron `WebContentsView`)
  - Bottom: run output + interactive terminal (`xterm.js`)
- Per-project run command and preview URL
- AI providers (currently): OpenAI, Anthropic
- File-editing chat tools via AI SDK route (`listFiles`, `readFile`, `writeFile`, `searchInFiles`)
- Electron packaging via `electron-builder` with macOS signing/notarization placeholders

## Tech stack

- Electron (latest)
- Next.js 16 (App Router, TypeScript, Tailwind v4, `src/`, `@/*` alias)
- Biome
- AI SDK (`ai`, `@ai-sdk/react`, `@ai-sdk/openai`, `@ai-sdk/anthropic`)
- AI Elements
- shadcn/ui
- react-resizable-panels
- xterm.js (`@xterm/xterm`)
- lucide-react

## Install

```bash
pnpm install
```

If Electron fails to launch due blocked install scripts in pnpm, run:

```bash
node node_modules/electron/install.js
```

## Development

```bash
pnpm dev
```

This starts:
- Electron main process
- Next.js dev server on `http://127.0.0.1:3210` (started automatically by Electron)

## Quality checks

```bash
pnpm lint
pnpm typecheck
pnpm build
```

## Packaging

```bash
pnpm dist
```

For a packaging smoke test without installer output:

```bash
pnpm exec electron-builder --dir
```

## Code signing notes

`electron-builder` is configured for macOS hardened runtime with entitlements at:

- `build/entitlements.mac.plist`

To enable real signing/notarization, provide the usual `electron-builder` signing env vars (for example `CSC_LINK`, `CSC_KEY_PASSWORD`, and notarization credentials).

## AI provider setup

Set your API keys in-app:

- Open left panel → `Settings`
- Enter OpenAI and/or Anthropic API keys

The chat route uses the active project's provider/model plus its selected folder as the editable project root.

## Codex thread import

Codex thread import is available as a standalone script instead of an in-app action:

```bash
pnpm import:codex-threads
```

Optional flags:

- `--dry-run`
- `--codex-dir /path/to/.codex`
- `--user-data-dir /path/to/app/user-data`
