# Context catalog — RAP development knowledge

Each file here is a **declarative** knowledge unit — rules and the development procedure,
as opposed to `../skills/` which hold imperative single-task "how to create object X"
instructions. Load these into the "RAP Context" RAG collection.

## How to use

- Upload these files into a RAG collection named "RAP Context" (id `rap-context-<init>` (or just `rap-context` if you are the only user of this instance)) via the MANAGE panel — one file at a time.
- They are reference content: read-only, the same across every RAP project.
- Keep the collection enabled while running the tutorial.

## Index

| File | Covers |
|------|--------|
| [`phase-procedure`](./phase-procedure.md) | The 1→4 phase flow + phase-guard (phases 1-3 = documents only) |
| [`odata-draft-vs-readonly`](./odata-draft-vs-readonly.md) | When an app is read-only vs needs draft handling for CRUD |
| [`composition-vs-association`](./composition-vs-association.md) | Owned children vs references; master/dependent |
| [`strict-mode-2`](./strict-mode-2.md) | What strict(2) requires of a BDEF |

## context vs skills

- `context/` = "what rules apply + what the process is" (declarative).
- `skills/` = "how to build artifact X" (imperative, single-task).
