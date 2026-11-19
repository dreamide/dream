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
Task: docs/architecture/tasks/example-task.md#EX-03
Status: implementing
Remaining: measure new/deleted/EOF fixtures in both themes and modes
Validation: typecheck passed; browser geometry verification pending
```

For an HTML view of a document, run `pnpm architecture:report <document>`.
The generated HTML goes to a temporary directory; Markdown remains authoritative.

## When a task is done

Task documents are temporary. Once every candidate in a document is
implemented, move anything it deferred, excluded as future work, or left
unverified into `backlog.md`, then delete the document. Git keeps the original:
`git log --diff-filter=D -- docs/architecture/tasks/`. Code comments do not
cite task IDs (see CODING_STANDARDS.md), so nothing else needs updating.

Module names and current ownership live in ../../GLOSSARY.md.
