# Review guidance

Use the checks configured in package.json and CI for syntax, formatting, types,
and scratch-file hygiene. This reference covers decisions those checks cannot make.

## UI consistency

Compare a changed screen with an existing screen serving the same purpose.
Settings creation and editing use dialogs over the list; inspect the MCP and
SSH sections in `src/components/ide/settings/` and `src/components/ide/ssh/`.
Keep navigation placement consistent with the scope of the action.

Use the shared components in `src/components/ui/` for standard actions, menus,
selection, and dialogs. Match the surrounding Button size, including actions
inside third-party toasts. Window controls, editor gutters, tabs, and custom
icon controls can need their own primitives; review their focus and keyboard
behavior rather than banning raw buttons.

Names and labels use normal UI typography. Commands, paths, URLs, and source
code can use monospace. Inspect text, outline badges, focus, disabled states,
and hover contrast in both light and dark themes. Shared component changes
need inspection at their other call sites as well as the motivating screen.

Keep labels and help text short, in sentence case. Describe the action or
setting directly; omit self-reference to Dream and implementation details.
Follow existing locale keys and keep equivalent messages aligned across locales.

For asynchronous content, inspect the transition as well as the finished view.
Diff placeholders should preserve rows, gutters, metadata, wrapping, and padding
when highlighting arrives. Use the fixtures described in docs/development-tools.md.

## Cross-provider and persistence changes

Review a shared turn contract across every provider adapter that consumes it.
Distinguish stopping a turn from disconnecting its observer: a disconnected
client leaves the host turn running; explicit Stop must reach the provider.
Route tests with a fake provider do not establish real adapter wiring.

Use GLOSSARY.md to identify the owner on each side of a seam. For caches,
review identity, invalidation after external writes, concurrent reads, and
hidden subscribers. For saves, review ordering, retry, and closing the window.
Record deliberately deferred behavior in the task document's completion scope.
