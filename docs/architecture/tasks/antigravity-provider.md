# Google Antigravity Provider

First-class AI coding-agent provider integration for Google Antigravity CLI (`agy`).

## AGY-01: Google Antigravity CLI as first-class agent provider

Status: implemented

Problem and trigger: Dream supports multiple agent CLIs (Claude Code, OpenAI Codex,
OpenCode, Cursor Agent, Grok Build). Google Antigravity CLI (`agy`) provides agentic
coding capabilities powered by Gemini models with streaming JSON output, tool execution,
reasoning effort controls, session persistence, and usage metrics. Users need to be
able to select Antigravity as their agent provider with native streaming, permission
handling, model switching, settings management, and background text generation.

Scope:

- Provider capabilities & registry:
  - Provider ID `"antigravity"` registered in `electron/shared/provider-capabilities.js`
    with `modelSwitchInSession: true`, `mcp: false`, `skills: { dispatch: "slash" }`,
    `selectedModelsSetting: "antigravitySelectedModels"`. Dream-managed MCP is deferred
    (matching Cursor).
  - Added to `PROVIDER_IDS` and validation schemas across chat, git, skills, and delegation.
  - Model options reasoning effort support (`["low", "medium", "high", "xhigh", "max"]`)
    in `electron/shared/model-options.js`.
  - Provider registration in `electron/api/providers/registry.js` with `checkAntigravityReady`,
    `streamAntigravityResponse`, `runAntigravityPrompt`, `fetchAntigravityModels`, and
    `fetchAntigravityUsageLimits`.
- CLI detection & readiness:
  - `electron/api/providers/antigravity-cli.js`: checks `agy` binary on PATH and standard
    installation paths under `%LOCALAPPDATA%\agy\bin\agy.exe`,
    `%LOCALAPPDATA%\Programs\agy\bin\agy.exe`, and
    `~/.gemini/antigravity-cli/bin/agy`.
  - Clear user guidance when CLI is unavailable: install Antigravity CLI and run `agy`
    in a terminal to authenticate.
- Dynamic model discovery:
  - `fetchAntigravityModels` and `parseAntigravityModelsOutput` in
    `electron/api/providers/provider-models.js`. Discovers available models via `agy models`,
    with context window mappings (1M tokens for Gemini models, 200k tokens for Claude models), and
    reasoning effort capabilities; unavailable discovery returns no models.
- Chat streaming adapter:
  - `electron/api/chat/antigravity-stream.js`: executes `agy` in streaming JSON mode
    (`--output-format stream-json`). When prompts exceed command-line limits or run via Windows shell,
    uses `--input-format stream-json` to pipe NDJSON user events over standard input.
  - Translates NDJSON events (`init`, `step_update`, `agent_response`, `tool`, `result`)
    into Dream's `turn` contract:
    - `turn.session` from `conversation_id`.
    - `turn.text` from streamed message chunks.
    - `turn.reasoning` from `thought_delta` / `reasoning_delta` fields.
    - `turn.toolStart`, `turn.toolOutput`, and `turn.toolError` from tool calls
      (`run_command`, `read_file`, `write_file`, `edit_file`). Raw tool names are preserved.
      Soft-denied commands in headless mode (`output: undefined`) are emitted as tool errors.
    - `turn.usage` reported once from final turn `result.usage` with `thinking_tokens` mapped
      to reasoning tokens and model-specific context window.
  - Maps Dream permission modes:
    - `full-access`: `--dangerously-skip-permissions`
    - `auto-accept-edits`: `--mode accept-edits`
    - `ask`: `--mode plan` (interactive mid-turn approval in headless print mode is deferred;
      `--mode plan` safely prevents unprompted workspace modifications or shell execution).
  - Session continuation via `--conversation <conversationId>`.
  - Reasoning effort via `--effort <effort>`.
  - Process cancellation via `stopChildProcess(child)`.
- Background text generation:
  - `runAntigravityPrompt` in `electron/api/providers/generate-text.js` using safe
    `--mode plan` with zero mutating tools for chat titles, git commit messages, and PR summaries,
    configured with process timeout handling (`--print-timeout` and Node-level kill timer).
- Usage limits & stats:
  - `fetchAntigravityUsageLimits` in `electron/api/providers/usage-limits.js` parsing
    `agy -p "/usage" --output-format json`.
- CLI updates:
  - Upgrade command `agy update` and GitHub release version tracking in
    `electron/api/providers/cli-updates.js`.
- UI & Settings:
  - Antigravity icon in `src/components/ai-elements/provider-icons.tsx`.
  - Provider labels, constants, model cache, and settings workspace integration
    with model enable/disable switches, version info, refresh, and update button.

Completion criteria:

- [x] Provider recognized uniformly across main, renderer, settings, and validation schemas.
- [x] CLI detection resolves executable and reports clean actionable error messages.
- [x] Dynamic model discovery parses `agy models`; unavailable discovery returns no models.
- [x] Streaming adapter maps assistant text, reasoning, tool execution, tool output/error,
      and token usage into Dream's turn contract.
- [x] Permission modes enforced safely; no dangerous elevation in `ask` mode.
- [x] Session resume persists native conversation ID.
- [x] Mid-session model switching supported.
- [x] Background generation runs in non-interactive plan mode without tool execution.
- [x] Usage limits reporting parses CLI usage outputs.
- [x] CLI upgrade and update check integrated.
- [x] Automated test suite covers CLI detection, model parsing, streaming, usage limits,
      and CLI updates.
- [x] `pnpm check:scratch`, `pnpm lint`, `pnpm typecheck`, `pnpm vite:build`, and tests pass.

Validation:

- `pnpm vitest run electron/api/providers/ electron/api/chat/ src/lib/models.test.ts`: 30 test files passed, 201 tests passed.
- `pnpm check:scratch`: clean.
- `pnpm lint` (`biome check .`): 757 files clean, 0 errors, 0 warnings.
- `pnpm typecheck` (`tsc --noEmit`): clean, 0 errors.
- `pnpm vite:build`: clean, 0 errors.
