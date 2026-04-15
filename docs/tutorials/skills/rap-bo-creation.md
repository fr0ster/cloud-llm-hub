---
name: RAP Business Object Creation
description: Rules and constraints for creating SAP RAP managed Business Objects with draft support on on-premise S/4HANA systems via MCP tools
version: 2.0.0
tags: [sap, rap, abap, cds, bdef, draft, fiori]
---

# RAP Business Object Creation — Skill Reference

## Scope

This skill covers creating a RAP managed BO with draft support on SAP S/4HANA on-premise systems. It documents constraints, common mistakes, and correct patterns discovered through testing.

## Hallucination Detection

The LLM may fabricate successful results without actually executing MCP tools. Indicators:

- **Low prompt token count** — a real tool call uses 40K–100K+ prompt tokens. A response with ~4K tokens likely had no tool execution.
- **Missing execution traces** — real tool calls produce `[SmartAgent: Executing ToolName...]` lines in the response. No trace = no execution.
- **Long conversation context** — after 10–12 messages in a session, the LLM tends to "pattern-match" earlier successful responses instead of calling tools.

**Triggers:**
- **Too many parallel tasks in one prompt** — asking to create 5+ objects at once increases hallucination risk. The LLM sees the pattern from the first 2–3 successful creations and fabricates the rest.
- **Long conversation context** — accumulated history from prior steps competes with tool execution. The LLM "remembers" the answer format and skips calling tools entirely.

**Rules:**
- Create objects in batches of 3–4 per prompt, not more.
- After batch creation, always verify by reading each object back (preferably in a fresh session).
- If prompt token count is suspiciously low, treat the response as fake and redo the step.
- Start a fresh conversation session after each layer or every ~10 messages.

## Object Creation Order

Objects must be created and activated in this exact dependency order:

1. Package
2. Domains → Data Elements
3. Persistent Tables
4. Draft Tables
5. Interface CDS Views (R-type) — create all, activate together
6. Projection CDS Views (C-type) — create all, activate together
7. Metadata Extensions
8. Interface Behavior Definition (BDEF) — do NOT activate without BIMP
9. Behavior Implementation Class (BIMP) — activate together with BDEF
10. Projection Behavior Definition
11. Service Definition
12. Service Binding — activate and publish

## Package

- On on-premise systems, local packages must start with `TEST_` or `$` to use the `LOCAL` software component.
- Always specify `software component LOCAL` explicitly — the LLM often omits it.
- If MCP cannot create the package, the user must create it manually in ADT/SE80.

## Domains

- Each domain defines a single ABAP type (CHAR, UNIT, etc.) with length.
- Domains may not activate automatically after creation. Always verify and activate if needed: "Activate all inactive domains starting with Z##_D_".

## Data Elements

- Each data element references a domain OR a predefined ABAP type.
- **Do NOT use `abap_boolean`** — the MCP handler produces a data element without a data type. Use `type CHAR length 1` instead.
- All domains must be **active** before creating data elements that reference them. If creation fails with "domain not active", activate domains first.

## Persistent Tables

- Root table: `key client : abap.clnt`, `key uuid : sysuuid_x16`, `key matnr : z##_e_matnr`, business fields, audit fields.
- Child tables: same keys + `root_uuid : sysuuid_x16` linking to parent.
- Audit fields: `created_by : abp_creation_user`, `created_at : abp_creation_tstmpl`, `last_changed_by : abp_locinst_lastchange_user`, `last_changed_at : abp_locinst_lastchange_tstmpl`, `local_last_changed_at : abp_lastchange_tstmpl`.

## Draft Tables

**Critical rules:**

1. **Key fields must match persistent table keys — but NO `draftuuid` key.** The draft UUID is managed by the `sych_bdl_draft_admin_inc` include. Adding `key draftuuid : sysuuid_x16` causes BDEF activation error: "cannot have a key field DRAFTUUID".
2. **All field names must use CDS view alias names** (lowercased PascalCase without underscores). Draft tables store CDS alias values, not persistent table field names. Example: `authorname` (not `author_name`), `publicationyear` (not `publication_year`), `createdby` (not `created_by`). Using snake_case causes BDEF activation error: "Missing fields (CamelCase expected)".
3. **Use `mandt` not `abap.clnt`** for the client key field.
4. **Use `include sych_bdl_draft_admin_inc;`** — not `"%_DIFFINCL" : sych_bdl_draft_admin_inc` (the `%` syntax fails in CDS table definitions). The include should ideally use group name `"%admin"` to avoid warnings.
5. **No `parentuuid` field** in child draft tables — the draft framework manages parent-child relationships via the include structure. Adding `parentuuid` produces warning: "does not expect the field PARENTUUID".
6. **Reserved ABAP keywords** cannot be field names — e.g., `format` → `editionformat`. Causes "Statements could not be generated" error.

## CDS Views — Interface (R-type)

- Root: `define root view entity` with `composition [0..*]` to children.
- Children: `define view entity` with `association to parent` on `$projection.RootUuid = _Root.Uuid`.
- All fields mapped to PascalCase aliases: `uuid as Uuid`, `matnr as Matnr`, `mtart as MaterialType`.
- **Circular dependency:** root references children, children reference root. Create all views first (syntax errors are expected), then activate all together in one call.
- **Syntax check before activation will show errors — this is normal.** Errors like "data source X does not exist or is not active" are expected because the views reference each other. These errors disappear after group activation. Only non-circular errors (wrong field names, missing tables) need fixing before activation.
- **Always provide exact DDL source code** in the prompt — without it, the agent may create empty view shells that fail activation with "DDIC source code does not contain a valid definition".
- After activation, run syntax check: "Check CDS view Z##_R_MAT_ROOT for syntax errors".

## CDS Views — Projection (C-type)

- Root projection: `provider contract transactional_query`, `@Search.searchable: true`, `@Metadata.allowExtensions: true`.
- Redirect compositions: `_Plant : redirected to composition child Z##_C_MAT_PLANT`.
- Children: redirect `_Root : redirected to parent Z##_C_MAT_ROOT`.
- Same circular dependency pattern — create all, activate together.

## Metadata Extensions

- Require `@Metadata.allowExtensions: true` on projection views.
- Use `@Metadata.layer: #CUSTOMER`.
- Define `@UI.facet` for object page layout, `@UI.lineItem` for list columns, `@UI.identification` for detail fields, `@UI.selectionField` for filter bar.
- Hide technical fields: `@UI.hidden: true` on Uuid, RootUuid.

## Behavior Definition (BDEF)

**Critical rules for `strict ( 2 )` with `with draft`:**

1. **`authorization master ( instance )`** on root entity — required by strict mode. Without it: "every entity must be flagged as authorization master or dependent".
2. **`authorization dependent by _Root`** on all child entities.
3. **`lock master total etag LocalLastChangedAt`** on root entity.
4. **`lock dependent by _Root`** on all child entities.
5. **`draft table`** on ALL entities (root and children) — not just root. Without it: "There is no draft persistency specified".
6. **Draft actions on root entity** — all five are required:
   ```
   draft action Edit;
   draft action Resume;
   draft action Activate optimized;
   draft action Discard;
   draft determine action Prepare;
   ```
   Missing `Discard` causes: "there must be an explicit definition of the draft action Discard".
7. **Explicit field mapping** — do NOT use `mapping for z##_mara corresponding`. CDS aliases (PascalCase) don't match table field names (lowercase), causing 41+ mapping warnings and broken field persistence. Always use explicit mapping:
   ```
   mapping for z##_mara
   {
     Uuid = uuid;
     Matnr = matnr;
     MaterialType = mtart;
     MaterialGroup = matkl;
     ...
   }
   ```
8. **No mapping for draft tables** — `mapping for` is only for persistent tables. Draft table is declared in the entity header only.
9. **UUID key fields should use `numbering:managed`** — without it, the system warns: "should be flagged as numbering:managed to give it a UUID automatically". Add `field ( numbering : managed, readonly ) AuthorId;` instead of just `field ( readonly ) AuthorId;`.
10. **Cross-BO associations** use `with cross associations;` in the header — without it, warning: "uses an obsolete implementation". For example, Book referencing Author (separate BO) requires this syntax.
11. **Child entities (lock/authorization dependent)** do NOT need their own handler classes — they inherit authorization from the master entity.

## Behavior Implementation (BIMP)

- Global class: `PUBLIC ABSTRACT FINAL FOR BEHAVIOR OF Z##_R_MAT_ROOT` — contains only the standard generated definition and empty implementation.
- The actual handler logic goes into **local types** (CCIMP include), not the global class.
- For managed scenario with `authorization master ( instance )`, the local types must contain:
  ```
  CLASS lhc_<RootAlias> DEFINITION INHERITING FROM cl_abap_behavior_handler.
    PRIVATE SECTION.
      METHODS get_instance_authorizations FOR INSTANCE AUTHORIZATION
        IMPORTING keys REQUEST requested_authorizations FOR <RootAlias> RESULT result.
  ENDCLASS.

  CLASS lhc_<RootAlias> IMPLEMENTATION.
    METHOD get_instance_authorizations.
    ENDMETHOD.
  ENDCLASS.
  ```
- Replace `<RootAlias>` with the BDEF root entity alias (e.g. `MaterialRoot`).
- The method body can be empty for initial setup — framework handles CRUD automatically.
- BDEF and BIMP have circular dependency. Create both, then activate together.

## Projection BDEF

- `projection; strict ( 2 ); use draft;`
- Root: `use create; use update; use delete;` + `use association _Plant { create; with draft; }`.
- Children: `use update; use delete;` + `use association _Root { with draft; }`.

## Service Definition

- `define service` with `expose` for each projection view.
- Entity aliases: `expose Z##_C_MAT_ROOT as Material`.

## Service Binding

- OData V4 UI binding.
- Must be activated AND published separately.
- Publishing may require a separate "Publish service binding" prompt.
- Since `core@5.2.0` + `adt-clients@5.0.0`, use `binding_variant` parameter: `ODATA_V4_UI` (Fiori Elements), `ODATA_V4_WEB_API`, `ODATA_V2_UI`, `ODATA_V2_WEB_API`. Default is `ODATA_V4_UI`. Earlier versions always created Web API (category 1).

## Activation Rules

- **Before group activation — check each object for syntax errors and fix all issues first.** Group activation is expensive (locks objects, may fail midway leaving inconsistent state). Run "Check CDS view Z##_R_MAT_ROOT for syntax errors" on each created object. Fix errors iteratively until clean. Only then activate.
- **Never say "Activate all inactive objects"** on shared systems — this activates other users' objects. Always filter by prefix: "Activate all inactive objects starting with Z##_".
- CDS views with circular references must be activated together in one call.
- BDEF + BIMP must be activated together.
- After activation, run syntax check again to catch warnings (missing access control, key mismatches).

## UI Annotations and Fiori UX

### Text Associations (show text instead of key)

When a field stores a key (e.g. AuthorUuid), show a human-readable text (e.g. author name) in the UI:

1. In the **interface CDS view**, add an association to the text source and annotate the key field:
   ```
   association [0..1] to Z##_R_AUTHOR as _Author on $projection.AuthorUuid = _Author.Uuid
   ```
2. In the **projection CDS view**, expose the association and annotate:
   ```
   @ObjectModel.text.association: '_Author'
   AuthorUuid,
   _Author
   ```
3. The text entity must have a field annotated with `@Semantics.text: true` (e.g. the name field).

### Value Help (F4 search help)

Add `@Consumption.valueHelpDefinition` on projection fields that reference other entities:
```
@Consumption.valueHelpDefinition: [{ entity: { name: 'Z##_C_AUTHOR', element: 'Uuid' } }]
AuthorUuid,
```

### Search

- `@Search.searchable: true` on the root projection view.
- `@Search.defaultSearchElement: true` on fields that should be searchable (name, title, etc.).
- `@Search.fuzzinessThreshold: 0.7` for fuzzy search support.

### Selection Fields (filter bar)

`@UI.selectionField: [{ position: 10 }]` on fields to show in the filter bar above the list.

### Header Info

Annotate the projection view for list/detail page titles:
```
@UI.headerInfo: {
  typeName: 'Book',
  typeNamePlural: 'Books',
  title: { type: #STANDARD, value: 'Title' },
  description: { type: #STANDARD, value: 'AuthorName' }
}
```

### Facets (object page sections)

Define in metadata extension using `@UI.facet`:
- `#IDENTIFICATION_REFERENCE` — general info section
- `#LINEITEM_REFERENCE` with `targetElement` — child entity table (e.g. editions, ratings)

### Field Labels

Data elements provide automatic field labels in Fiori UI. Without custom data elements, annotate directly:
```
@EndUserText.label: 'Book Title'
Title,
```

### Rating / Numeric Fields

For rating fields (1-5 stars), use `@UI.dataPoint` with `visualization: #RATING`:
```
@UI.dataPoint: { visualization: #RATING, targetValue: 5 }
Rating,
```

## Data Modeling Patterns

### Multi-entity BO with ratings

For a BO with independent root entities that reference each other (e.g. Author, Book, Edition, Rating):
- Each root entity is a separate RAP BO with its own BDEF, projections, and service
- OR: use one root entity (e.g. Book) with compositions to children (Edition, Rating) and an association (not composition) to Author
- Composition = lifecycle ownership (parent creates/deletes children)
- Association = reference (no lifecycle dependency)

### UUID vs Business Key

- `uuid : sysuuid_x16` — technical key, managed numbering, hidden from UI
- Business keys (ISBN, author name) — visible, searchable, may be mandatory but not the primary key
- Always use UUID as the primary key for managed RAP

## Common Error Messages and Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| "Field MATNR is required but not a key" | Draft table missing business key | Add `key matnr` to draft table |
| "every entity must be flagged as authorization master or dependent" | Missing `authorization` on entity | Add `authorization master ( instance )` on root, `authorization dependent by _Root` on children |
| "every entity must be flagged either as lock master or lock dependent" | Missing `lock` on child entity | Add `lock dependent by _Root` on children |
| "There is no draft persistency specified" | Missing `draft table` on child entity | Add `draft table z##_xxx_d` to each child entity header |
| "there must be an explicit definition of the draft action Discard" | Missing draft action | Add `draft action Discard;` to root entity |
| "DDIC source code does not contain a valid definition" | CDS view created without DDL source | Provide exact DDL in prompt, update view, then activate |
| "No domain or data type was defined" | Data element with `abap_boolean` | Use `type CHAR length 1` instead |
| "domain not active" | Data element references inactive domain | Activate domains first |
| "association target not found" | CDS views not activated together | Activate all R-type or C-type views in one call |
| Mapping warnings (41+) | Using `corresponding` with PascalCase aliases | Use explicit `mapping for table { CdsAlias = table_field; }` |
| "cannot have a key field DRAFTUUID" | Draft table has `key draftuuid` | Remove `draftuuid` from keys — framework manages it via include |
| "Missing fields (CamelCase expected)" | Draft table uses snake_case fields | Rename all fields to CDS alias names (lowercased PascalCase) |
| "Statements could not be generated" | Reserved ABAP keyword as field name | Rename field (e.g. `format` → `editionformat`) |
| "does not expect the field PARENTUUID" | Extra field in child draft table | Remove `parentuuid` — framework handles parent-child relationships |
| Field `%_DIFFINCL` invalid | Wrong include syntax in CDS table | Use `include sych_bdl_draft_admin_inc;` (no quotes, no field name) |

## Token Waste Analysis

Based on Phase 4 testing of Book Catalog (72 objects, ~6.1M tokens, ~$19):

### Waste categories (18% = ~1.1M tokens = ~$3.47)

| Category | Waste | Root Cause | Prevention |
|----------|-------|------------|------------|
| Draft table iterations | ~670K (11%) | Wrong field names + wrong key structure | Follow Draft Tables rules in this skill exactly |
| Hallucinations | ~310K (5%) | Long sessions + large batches | Fresh session every layer; max 3-4 objects per prompt |
| BDEF activation retries | ~98K (2%) | ActivateObjects tool can't find BDEFs | Use ActivateBehaviorDefinition, not ActivateObjects |

### Cost-saving rules

1. **Draft tables are the #1 waste source.** Get them right on the first attempt using the rules in this skill. Wrong draft tables cascade into BDEF activation failures → re-fix draft tables → re-activate BDEFs = 3× cost.
2. **Fresh session per layer.** Never accumulate 10+ messages. Session history competes with tool execution context.
3. **Max 3-4 objects per prompt.** More than 4 triggers hallucination — LLM pattern-matches earlier successes instead of calling tools.
4. **Always verify after batch creation.** Read each object in a fresh session. If prompt tokens < 10K, the response was fabricated.
5. **Provide exact DDL source** for CDS views, BDEFs, MDEs. Without it, agent creates empty shells that fail activation = wasted creation + fix + re-activation.
6. **Activate BDEFs individually** via ActivateBehaviorDefinition, not via ActivateObjects group.

### Optimal token budget per object type (single object, no errors)

| Object Type | ~Prompt Tokens | Notes |
|-------------|---------------|-------|
| Domain | 80-90K | Create + Read confirmation |
| Data Element | 80-95K | Create + Read confirmation |
| Table | 115-155K | Create + Update DDL + Read (higher for complex tables) |
| CDS View | 77K | Create + Update DDL (no activation) |
| CDS Group Activate | 39K | ActivateObjects for 4 views |
| Metadata Extension | 77-78K | Create + Update DDL + auto-activate |
| BDEF | 77-80K | Create + Update source |
| BIMP Class | 77-240K | Simple: 77K; Complex (multi-entity): up to 240K |
| Service Definition | 85-152K | Varies; may need retry if object exists |
| Service Binding | 86K | Create + Publish |
