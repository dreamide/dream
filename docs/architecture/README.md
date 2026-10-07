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

Module names and current ownership live in ../../GLOSSARY.md.
