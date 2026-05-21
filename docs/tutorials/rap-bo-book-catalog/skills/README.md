# Skill catalog — RAP BO creation

Each file in this folder is a **single-task skill**. One concern per file, no
references to tutorial stages, no orchestration of multi-step flows. Load only the
skills relevant to the task at hand.

## How to use

- The tutorial's RAG collection should hold the skills the agent needs for the work in
  progress. Upload skill files individually via the MANAGE panel.
- Each skill has the same shape: front-matter (`name`, `description`, `tags`), a short
  body, one or two tables of common errors with fixes.
- If a skill describes more than one task, that's a bug — split it.

## Index — what each skill covers

### Object-creation skills

| Skill                                                          | Covers                                                       |
|----------------------------------------------------------------|--------------------------------------------------------------|
| [`creating-domain`](./creating-domain.md)                      | One ABAP domain · type + length                              |
| [`creating-data-element`](./creating-data-element.md)          | Data element referencing a domain                            |
| [`creating-persistent-table`](./creating-persistent-table.md)  | RAP root/child persistent table · UUID + audit fields        |
| [`creating-draft-table`](./creating-draft-table.md)            | Draft table · CamelCase fields · no `draftuuid` key          |
| [`creating-interface-cds-view`](./creating-interface-cds-view.md) | R-type CDS · composition graph · group activation          |
| [`creating-projection-cds-view`](./creating-projection-cds-view.md) | C-type CDS · projection · redirected compositions       |
| [`creating-metadata-extension`](./creating-metadata-extension.md) | UI annotations · facets · line-items · selection fields    |
| [`creating-bdef`](./creating-bdef.md)                          | Interface BDEF · strict 2 · draft actions · explicit mapping |
| [`creating-bimp`](./creating-bimp.md)                          | BIMP global class + local-types handler                      |
| [`creating-projection-bdef`](./creating-projection-bdef.md)    | Projection BDEF · `use draft` · CRUD on root and children    |
| [`creating-service-definition`](./creating-service-definition.md) | Service definition · `expose … as …`                      |
| [`creating-service-binding`](./creating-service-binding.md)    | Service binding · `binding_variant` · publish                |

### Operational skills

| Skill                                                          | Covers                                                       |
|----------------------------------------------------------------|--------------------------------------------------------------|
| [`enforcing-target-package`](./enforcing-target-package.md)    | Never `$TMP`; verify after batch; report failures            |
| [`avoiding-hallucinations`](./avoiding-hallucinations.md)      | Batch limits · read-back · token-count signals               |
| [`managing-rag-artifacts`](./managing-rag-artifacts.md)        | `rag_add` / `rag_correct` / `rag_deprecate` · stable ids     |
| [`activating-objects`](./activating-objects.md)                | Group activation · prefix filter · BDEF tool                 |

## What's missing

- UI-annotation patterns (text-association, value-help, search) — currently inside
  `creating-metadata-extension` and `creating-projection-cds-view`. Split out if they
  grow.
- Cross-BO references (associations to another BO) — covered briefly inside
  `creating-bdef`. Split if patterns multiply.
