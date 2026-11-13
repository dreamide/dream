# Architecture tasks

Keep the specification for an architecture change in a Markdown document here.
Start from `tasks/template.md`. Each candidate has a stable ID, the behavior it
changes, boundaries, and observable completion criteria. Select by ID and path,
so “implement #3” resolves to one recorded task even after context recovery.

Before implementation, read the selected candidate and record the agreed scope.
If its text is missing from recovered context, recover it from this document
before inferring work from code. Keep status, validation, and deferred behavior
beside that candidate as the work progresses. A narrowed scope needs an explicit
record; a passing check alone does not finish the original specification.

Recovery notes contain the document path, candidate ID, status, remaining
criteria, and latest validation. Example:

```
Task: docs/architecture/tasks/retro-v026-environment.md#retro-03
Status: implementing
Remaining: measure new/deleted/EOF fixtures in both themes and modes
Validation: typecheck passed; browser geometry verification pending
```

For an HTML view of a document, run `pnpm architecture:report <document>`.
The generated HTML goes to a temporary directory; Markdown remains authoritative.

- `v0.26.0-performance.md` preserves the seven candidates from the October 5
  performance review and distinguishes shipped behavior from deferred proposals.
- `tasks/retro-v026-environment.md` tracks implementation of the five environment
  improvements selected after the release retrospective.
- `tasks/transcript-cache-ownership.md` tracks PDRY-01 from the October 11
  performance and DRY review: one owner for transcript loads and host refreshes.
- `tasks/project-file-traversal.md` tracks PDRY-02 from the same review:
  shared recursive traversal for file lists and text search.
- `tasks/project-search-budget.md` tracks PDRY-03: bounded matching and
  cancellable reads for Project text search.
- `tasks/sqlite-read-pool-write-sink.md` tracks SQL-01 to SQL-03: a derived
  search text table, catalog reads on reader threads, and write-sink changes.
- `tasks/desktop-bridge.md` tracks DSK-01 from the October 16 review: a
  shared channel table, desktop handlers with injected Electron parts, and
  the SSH prompt broker, unload guard and theme rules out of `main.js`.
- `tasks/model-selection-settle.md` tracks MSS-01 from the October 16
  review: models settled by a pure function in settings actions, driven by
  the provider capability rows.
- `tasks/persisted-fields-once.md` tracks PFO-01 from the October 16
  review: plain persisted fields declared once in a codec table, and one
  project UI normalizer for loading and saving.
- `tasks/project-git-writes.md` tracks PGW-01 from the October 16 review:
  git writes, their in-flight state and their refresh in one store module.
- `tasks/one-workspace-save-path.md` tracks WSP-01 from the October 16
  review: the workspace is written only as change sets, with one row rule.
- `tasks/github-pull-requests.md` tracks GHPR-01 from the October 16
  review: one host module (and one rule) for pull requests, behind `gh` and
  git ports.
- `tasks/commit-draft-and-generated-git-text.md` tracks CDG-01 from the
  October 16 review: one commit draft for both composers, one fingerprint
  and cache for generated git text.
- `tasks/changes-diffs-as-resources.md` tracks CDR-01 from the October 16
  review: per-file diffs as project resources, the Changes tab's view as
  one reducer.
- `tasks/project-file-tree.md` tracks PFT-01 from the October 16 review:
  the file tree's loader, path index and model glue in one tested module.
- `tasks/right-panel-navigation.md` tracks RPN-01 from the October 16
  review: right-panel views change only through store operations, and
  chat columns settle through the workspace document.
- `tasks/file-editor-session.md` tracks FES-01 from the October 16 review:
  the Files panel's tabs and drafts in a session outside React, and one
  way to open a project file.
- `tasks/workspace-document-removals.md` tracks WSDOC-01 from the October 16
  architecture review: every project removal and host-catalog merge goes
  through the workspace document and drops runtime state in one place.

- `tasks/host-orchestration.md` tracks ORCH-01 through ORCH-05 from the
  T3 Code V2 comparison: durable host scheduling, provider continuity,
  transcript pagination, protocol replay tests and delegation.

- `tasks/remote-connections.md` tracks CONN-01 to CONN-05 (host identity,
  pairing and device sessions, the shared connection runtime, the browser
  client, Tailscale and direct access setup; implemented, with the phone layout
  later removed by DH-17 and pairing links by DH-18), CONN-06 unattended hosting
  (implemented, with its service management later removed by DH-10), CONN-07
  multiple routes (implemented: ordered route management and direct desktop
  pairing, with remote-only mode later removed by DH-20; live SSH/network and
  cross-platform walkthroughs remain), and CONN-08 Cloudflare Tunnel integration
  (implemented, then revised on 2026-10-28 so the user runs the connector; the
  real-tunnel walkthrough is pending).
  CONN-09/10 are reserved for a separate, unscheduled mobile project and its
  push notifications; CONN-11 is an independent future host-browser project.

Module names and current ownership live in ../../GLOSSARY.md.

- `tasks/review-20261111-performance.md` tracks PERF11-01 to PERF11-07 from
  the November 11 performance review: one turn message for every provider,
  catalog rows applied and saved by identity, a live-transcript
  subscription that knows visibility, project resources read only for shown
  projects, a chat run that prepares its transcript once, checkpoint
  capture with a stated cost, and the startup sequence.

- `tasks/provider-session-decision.md` tracks PSD-01 from the November 12
  architecture review: one Provider session module decides what each Agent
  turn starts from, records what the adapter reported, and keeps the session.

- `tasks/review-20261109.md` tracks SSH-PROMPT, SAVED-ROUTES and
  ATTACHMENT-LIFETIME: SSH prompt ownership, saved-connection edit lifetime,
  and attachment preparation and release.

- `tasks/review-20261018.md` tracks PRR-01, HCL-01, BTN-01 and GLP-01:
  pull-request resources, host catalog readiness, browser tab operations and
  Git history pagination.
- `tasks/review-20261025.md` tracks ARC-01, ARC-02 and ARC-03:
  Agent turn completion, Connection recovery and Remote access state.
- `tasks/open-project-flow.md` tracks OPEN-01 from the T3 Code comparison:
  one open-project dialog with path completion on any host, connecting SSH
  hosts before opening, and one Connections section in Settings.
- `tasks/review-20261026.md` tracks D26-01 through D26-03: Host-bound
  Generated git text, Terminal session command observation, and Project-opening
  attempt lifetime.
- `tasks/antigravity-provider.md` tracks AGY-01: Google Antigravity CLI as a
  first-class AI coding-agent provider in Dream.
- `tasks/detached-host.md` tracks DH-01 to DH-06 from the 2026-10-29 T3 Code
  `t3 serve` comparison: an OS-held state lock, the desktop's host in a child
  process, one-line installs, turn resume from a byte offset, and headless
  pairing. DH-07 to DH-21 (2026-10-30) then narrowed that: one option table for
  starting `dream-host`, the desktop managing only its own host, service
  management removed, no phone client, pairing by code only, and no remote-only
  desktop. Host mode in Settings and WSL hosts were removed along the way, and
  some of these tasks were later reversed; each section's status says which.
  Their Hosts and Sharing & access pages are now one Connections page.
