# Open project flow

Simplifying how a folder is opened as a project, after comparing Dream with
T3 Code (pingdotgg/t3code at `f88b33a`, 2026-10-25). T3's server owns the
filesystem; adding a project is one flow: pick an environment, then type a
path that a single `filesystem.browse` RPC completes, with the native picker
only an extra for the desktop's own machine. Dream's host already owns the
filesystem the same way (the `dream-host` daemon and its catalog), so the
change is in the renderer, not the connection model.

## OPEN-01: One open-project dialog

Status: implemented; native inspection pending

Problem and trigger: opening a project had three folder pickers (the native
dialog, `OpenOnHostDialog` for SSH hosts, `OpenHomeFolderDialog` for browser
clients), two empty-page buttons, and SSH setup split between the open
dialog and Settings (Open on SSH Host jumped to Settings with no hosts).
The folder browser and the path input were not linked. `openProjectOnHost`
connected first but `addProject` did not, so chat search reopened a closed
SSH project without connecting. Mod+O did nothing in a browser client.
Settings listed SSH hosts and Remote access (Tailscale Serve) side by side,
which read as Tailscale being a third way to open a project.

Scope:

- `src/components/ide/open-project/open-project-dialog.tsx` is the only
  open flow: an "Open on" select (this computer and SSH hosts;
  shown once an SSH host exists), a path field, and on the desktop's own
  computer a Browse… button for the native picker. Picking an SSH host
  connects it; a failure waits for Connect rather than retrying. Open asks
  the host to resolve the path (`~`, relative to home) and refuses a
  non-folder before anything is added. The empty page has one Open Folder
  button; Mod+O opens the dialog on desktop and browser clients.
- `folder-path.ts` (pure, tested) splits the typed path at its last
  separator into the folder to list and a name prefix; `folder-path-field.tsx`
  lists that folder through the existing `POST /api/host-directories` and
  filters it client-side (case-insensitive start match; dot-folders only
  for a dot prefix). Click or Tab enters a folder, arrows pick, Enter opens.
  Filtering in the client keeps the host API unchanged, so older SSH hosts
  work without a protocol change.
- Store: `openProject(path, { hostId, activate })` replaces
  `openProjectOnHost`. It connects an SSH host (and loads its catalog)
  before `addProject`, and stays synchronous for the local host. The empty
  page's Recently closed list and chat search use it.
- `SshHostDialog` is exported and opened from the open dialog too. A new
  host is offered aliases from `~/.ssh/config` and its Includes
  (`electron/ssh/ssh-config-hosts.js`, desktop method `listSshConfigHosts`).
- Settings: one desktop-only "Connections" section shows SSH hosts above
  Remote access, replacing the two separate sections.

Excluded: T3's command-palette mode, cloning a Git URL or creating a new
project, and pairing a desktop with a remote host over Tailscale without
SSH (CONN-07). Worktree rows keep calling `addProject`: their parent
project's host is already connected.

Completion criteria:

- One dialog opens local, SSH and browser-client folders; the removed
  dialogs have no remaining references.
- Typing completes folders on the chosen host; a missing folder or a
  file is refused with the host's message, nothing added.
- Opening on an SSH host that is not connected connects it first, from the
  dialog, Recently closed and chat search alike.
- An SSH host can be added from the dialog and is selected after saving.
- Settings shows one Connections section on desktop; browser clients see
  neither section, as before.

Validation:

- `pnpm test`: 179 files, 1238 tests passed, including the new
  `folder-path.test.ts`, `ssh-config-hosts.test.js`, desktop handler and
  preload channel tests, and locale key parity across 11 locales.
- `tsc --noEmit` reports no errors outside
  `src/components/ide/settings/remote-access-section.tsx`. That file holds
  conflict markers committed in `c69b97e` (from merging `0a7673e`); this
  task did not change it. tsc skips semantic checks while any file has a
  syntax error, so the check was run against a temporary copy that took
  the HEAD side of each conflict, then the file was restored.
- `biome check` passes on every changed file.
- Not inspected: no development renderer was running for this checkout.

Remaining/deferred:

- Inspect the dialog in the desktop app and a browser client: keyboard
  completion, the connect states of an SSH host, Add SSH host from the footer
  (shown until an SSH host exists), Browse…, light and dark themes, and the
  Connections section.
- Resolve the conflict markers in `remote-access-section.tsx`
  (pre-existing, outside this task).

Recovery: docs/architecture/tasks/open-project-flow.md#open-01;
implemented, native inspection pending; latest validation above.
