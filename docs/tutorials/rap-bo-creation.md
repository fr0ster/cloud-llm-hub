# Tutorial: Creating a RAP Business Object with Cloud LLM Hub

This tutorial walks through creating a complete RAP (RESTful Application Programming) Business Object on a live SAP S/4HANA system using cloud-llm-hub's chat UI. The AI agent connects to the SAP system via MCP tools and executes all ABAP development tasks on your behalf.

**What you will build:** A Material Master RAP BO with root entity (MARA) and child entities (MARC, MAKT, MVKE), including tables, CDS views, behavior definition, service definition, and Fiori UI.

**System:** SAP S/4HANA (DEV)
**Time:** ~30-60 minutes
**Prerequisites:** Access to cloud-llm-hub chat UI with MCP connection to an SAP system

> **Use this tutorial as a fixed reference recipe.** It creates one Material Master BO from predefined prompts. If you want the phase-based learning flow with saved `business-requirements`, `tech-spec`, and `impl-plan` artifacts in RAG, use [Building a RAP BO with AI](rap-bo-book-catalog.md).

### Progress checklist

Tick each box as you finish the step. Long sessions are easier when you can see what is left.

- [ ] Step 1 — system connection verified
- [ ] Step 2 — package created
- [ ] Step 3 — 8 domains + 9 data elements created and active
- [ ] Step 4 — 4 persistent tables created and active
- [ ] Step 5 — 4 draft tables created and active
- [ ] Step 6 — 4 interface CDS views activated together
- [ ] Step 7 — 4 projection CDS views activated together
- [ ] Step 8 — metadata extension created and active
- [ ] Step 9 — interface BDEF created (do not activate yet)
- [ ] Step 10 — BIMP class created and activated together with the interface BDEF
- [ ] Step 11 — projection BDEF created and active
- [ ] Step 12 — service definition created and active
- [ ] Step 13 — service binding created and published
- [ ] Step 14 — Fiori preview shows the working app

---

## Naming Convention

ABAP object names have length limits (30 characters for most, 26 for service binding). To avoid conflicts and fit the limits, use a personal prefix `Z<II><NN>_`:

- `<II>` — your initials, 2 characters (`OK` for Oleksii Kyslytsia)
- `<NN>` — version number, 2 digits (`01`, `02`, ...). If your initials clash with another developer, use the next number.

**Naming table** — every object you create in this tutorial. `Z##_` is a placeholder; replace `##` with your prefix (e.g. `OK01`).

| Object | Max | Placeholder | Example (`ZDEMO01_`) |
|--------|-----|-------------|------------------|
| Package | 30 | `TEST_##_MAT` | `TEST_DEMO1_MAT` |
| Domain | 30 | `Z##_D_MATNR`, ... | `ZDEMO01_D_MATNR` |
| Data Element | 30 | `Z##_E_MATNR`, ... | `ZDEMO01_E_MATNR` |
| Persistent table (root) | 30 | `Z##_MARA` | `ZDEMO01_MARA` |
| Persistent table (child) | 30 | `Z##_MARC`, `Z##_MAKT`, `Z##_MVKE` | `ZDEMO01_MARC` |
| Draft table | 30 | `Z##_MARA_D`, `Z##_MARC_D`, ... | `ZDEMO01_MARA_D` |
| Interface CDS (root) | 30 | `Z##_R_MAT_ROOT` | `ZDEMO01_R_MAT_ROOT` |
| Interface CDS (child) | 30 | `Z##_R_MAT_PLANT`, ... | `ZDEMO01_R_MAT_PLANT` |
| Projection CDS (root) | 30 | `Z##_C_MAT_ROOT` | `ZDEMO01_C_MAT_ROOT` |
| Projection CDS (child) | 30 | `Z##_C_MAT_PLANT`, ... | `ZDEMO01_C_MAT_PLANT` |
| BIMP class | 30 | `ZBP_##_R_MAT_ROOT` | `ZBP_DEMO1_R_MAT_ROOT` |
| Service Definition | 30 | `ZUI_##_MAT_O4` | `ZUI_DEMO1_MAT_O4` |
| Service Binding | 26 | `ZUI_##_MAT_O4` | `ZUI_DEMO1_MAT_O4` |
| Metadata Extension | 30 | `Z##_C_MAT_ROOT` | `ZDEMO01_C_MAT_ROOT` |

> **Before you start:**
> 1. Decide your prefix (e.g., `ZDEMO01_`).
> 2. Ask the agent: *"Search for objects starting with ZDEMO01_"*.
> 3. If anything is found — increment to `ZDEMO02_`, `ZDEMO03_`, ...
> 4. When the search comes back empty — you are ready.

> **Can I use different names?** Yes, but RAP objects reference each other (CDS views → tables, BDEFs → CDS views and draft tables, projections → interfaces, services → projections). If you rename one object, you must update everything that points at it. For this tutorial, follow the convention exactly — rename later when you know the full dependency chain.

---

## Architecture Overview

You chat with Cloud LLM Hub, which runs a SmartAgent pipeline over an LLM (Claude/GPT) and calls MCP tools against SAP S/4HANA (ADT) to create and activate objects on your behalf.

## RAP BO Structure

The Business Object we are creating follows the standard RAP managed scenario with draft support:

Layers, top-down:

- **Service layer** — Service Definition + Service Binding (`ZUI_##_MAT_O4`), expose the BO as OData V4.
- **Projection layer (C-type)** — `Z##_C_MAT_ROOT` + 3 children + projection BDEF; what the consumer sees.
- **Interface layer (R-type)** — `Z##_R_MAT_ROOT` + 3 children + interface BDEF + BIMP class (`ZBP_##_R_MAT_ROOT`).
- **Database layer** — 4 persistent tables (`Z##_MARA/MARC/MAKT/MVKE`) plus the matching 4 draft tables (`_D` suffix).

Root composes the three children (Plant, Text, Sales); each C-view projects the matching R-view, which reads from the matching persistent table.

## Entity Model

| Table        | Keys                                     | Business Fields                     | Notes                             |
|--------------|------------------------------------------|-------------------------------------|-----------------------------------|
| `Z##_MARA`   | client, uuid, matnr                      | mtart, matkl, lvorm, meins          | Root; no `root_uuid`              |
| `Z##_MARC`   | client, uuid, matnr, werks               | —                                   | Plant; `root_uuid` FK to MARA     |
| `Z##_MAKT`   | client, uuid, matnr, spras               | maktx                               | Text per language; `root_uuid` FK |
| `Z##_MVKE`   | client, uuid, matnr, vkorg, vtweg        | —                                   | Sales; `root_uuid` FK to MARA     |

MARA has a 1..* relationship to each of MARC / MAKT / MVKE via `root_uuid`.

## Creation Order

RAP objects must be created and activated in a specific order due to dependencies. The steps below follow that order: Package → Domains & Data Elements → Persistent + Draft Tables → Interface CDS → Projection CDS → Metadata Extensions → Interface BDEF → BIMP → Projection BDEF → Service Definition → Service Binding.

---

## Step 1: Verify System Connection

Before starting, verify that the agent can connect to your SAP system and that your prefix is available.

**You type in chat:**

> Check if you can connect to the SAP system. Search for objects starting with Z##_ to verify my prefix is available.

**What happens:** The agent uses `SearchObject` MCP tool to query the SAP system.

**Expected result:** The agent confirms connection. If objects with your prefix already exist — increment the version number (`Z##2_`, `Z##3_`).

---

## Step 2: Create Package

All objects need a development package. On most on-premise systems, local packages must start with `TEST_` or `$` to use the `LOCAL` software component.

**You type in chat:**

> Create package TEST_##_MAT as a local $TMP package with software component LOCAL and description 'Material Master RAP BO'.

**Expected result:** Package TEST_##_MAT created under $TMP with software component LOCAL.

> **Tip:** The agent may need two attempts — the first may fail if it omits the software component. If so, repeat the prompt and explicitly mention `software component LOCAL`.

> **Note:** If the agent cannot create the package via MCP, create it manually in ADT (Eclipse) via `File → New → ABAP Package` (select "Local Object" when prompted for transport). Then tell the agent: "Use package TEST_##_MAT for all objects."
>
> **Known LLM mistakes in package creation:**
>
> 1. **Package name must start with `TEST_` or `$` on on-premise.** Z-prefixed packages cannot use LOCAL software component. Error: "Package names starting with Z cannot be assigned to software component LOCAL". **Fix:** Use `TEST_` prefix for package name.
>
> 2. **Software component omitted.** The LLM may not pass `software_component: LOCAL` — the system rejects the package. **Fix:** Explicitly state "software component LOCAL" in the prompt.

---

## Step 3: Create Domains and Data Elements

Before creating tables, we define custom domains and data elements. This provides proper semantics, labels, and F4 help for Fiori UI fields.

### 3.1 Domains

**One domain per message.** After each one, wait for the agent to confirm the domain is active before sending the next.

**Message 1:**

> Create domain Z##_D_MATNR in package TEST_##_MAT with description 'Material Number', type abap.char(40). Activate it, then read it back and confirm it is active.

**Message 2:**

> Create domain Z##_D_MTART in package TEST_##_MAT with description 'Material Type', type abap.char(4). Activate it, then read it back and confirm it is active.

**Message 3:**

> Create domain Z##_D_MATKL in package TEST_##_MAT with description 'Material Group', type abap.char(9). Activate it, then read it back and confirm it is active.

**Message 4:**

> Create domain Z##_D_MEINS in package TEST_##_MAT with description 'Base Unit of Measure', type abap.unit(3). Activate it, then read it back and confirm it is active.

**Message 5:**

> Create domain Z##_D_WERKS in package TEST_##_MAT with description 'Plant', type abap.char(4). Activate it, then read it back and confirm it is active.

**Message 6:**

> Create domain Z##_D_MAKTX in package TEST_##_MAT with description 'Material Description', type abap.char(40). Activate it, then read it back and confirm it is active.

**Message 7:**

> Create domain Z##_D_VKORG in package TEST_##_MAT with description 'Sales Organization', type abap.char(4). Activate it, then read it back and confirm it is active.

**Message 8:**

> Create domain Z##_D_VTWEG in package TEST_##_MAT with description 'Distribution Channel', type abap.char(2). Activate it, then read it back and confirm it is active.

**Expected result:** 8 domains created and activated, one at a time.

> **If domains are not activated:** The agent may create domains without activating them (they will have status "new"). If this happens, type:
> "Activate all inactive domains starting with Z##_D_"
>
> **Never say "Activate all inactive objects"** — on a shared system other users may have their own inactive objects. Always activate only your own objects by prefix: "Activate all inactive objects starting with Z##_".

**Checkpoint:** Ask the agent: "Read domain Z##_D_MATNR" — verify it shows the correct type (CHAR, length 40) and is active.

### 3.2 Data Elements

> **Important:** All domains must be active before creating data elements. If data element creation fails with "domain not active", activate the domains first (see note above).

**One data element per message.** After each one, wait for the agent to confirm it is active before sending the next.

**Message 1:**

> Create data element Z##_E_MATNR in package TEST_##_MAT with label 'Material Number', referencing domain Z##_D_MATNR. Activate it, then read it back and confirm it is active.

**Message 2:**

> Create data element Z##_E_MTART in package TEST_##_MAT with label 'Material Type', referencing domain Z##_D_MTART. Activate it, then read it back and confirm it is active.

**Message 3:**

> Create data element Z##_E_MATKL in package TEST_##_MAT with label 'Material Group', referencing domain Z##_D_MATKL. Activate it, then read it back and confirm it is active.

**Message 4:**

> Create data element Z##_E_MEINS in package TEST_##_MAT with label 'Base Unit of Measure', referencing domain Z##_D_MEINS. Activate it, then read it back and confirm it is active.

**Message 5:**

> Create data element Z##_E_WERKS in package TEST_##_MAT with label 'Plant', referencing domain Z##_D_WERKS. Activate it, then read it back and confirm it is active.

**Message 6:**

> Create data element Z##_E_MAKTX in package TEST_##_MAT with label 'Material Description', referencing domain Z##_D_MAKTX. Activate it, then read it back and confirm it is active.

**Message 7:**

> Create data element Z##_E_VKORG in package TEST_##_MAT with label 'Sales Organization', referencing domain Z##_D_VKORG. Activate it, then read it back and confirm it is active.

**Message 8:**

> Create data element Z##_E_VTWEG in package TEST_##_MAT with label 'Distribution Channel', referencing domain Z##_D_VTWEG. Activate it, then read it back and confirm it is active.

**Message 9:**

> Create data element Z##_E_LVORM in package TEST_##_MAT with label 'Marked for Deletion', type CHAR length 1, no domain. Activate it, then read it back and confirm it is active.

**Expected result:** 9 data elements created and activated.

> **Why domains and data elements?** Domains define value ranges and formatting. Data elements add labels and F4 help. Without them, Fiori UI shows raw field names instead of proper labels, and there's no input validation or search help.

> **If data elements are not activated:** Type: "Activate all inactive data elements starting with Z##_E_".
>
> **Known LLM mistakes in data element generation:**
>
> 1. **`abap_boolean` type not handled correctly.** The LLM may create Z##_E_LVORM with `type abap_boolean` but the MCP handler produces a data element without a data type definition. Error: "No domain or data type was defined". **Fix:** Use `type CHAR length 1` instead of `abap_boolean`.
>
> 2. **Data elements created but not activated.** Domains must be active before data elements can be created. If data element creation fails with "domain not active" — first activate domains: "Activate all inactive domains starting with Z##_D_".

**Checkpoint:** Ask the agent: "List all objects in package TEST_##_MAT" — you should see 8 domains + 9 data elements, all active.

---

## Step 4: Create Persistent Tables

The foundation of any RAP BO is the database tables. We need 4 persistent tables. Tables reference the data elements created in Step 3.

### 4.1 Root Table — Z##_MARA

**You type in chat:**

> Create table Z##_MARA in package TEST_##_MAT.
> Label: 'General Material Data'
> Fields:
> - key client : abap.clnt not null
> - key uuid : sysuuid_x16 not null
> - key matnr : z##_e_matnr not null
> - mtart : z##_e_mtart
> - matkl : z##_e_matkl
> - lvorm : z##_e_lvorm
> - meins : z##_e_meins
> - created_by : abp_creation_user
> - created_at : abp_creation_tstmpl
> - last_changed_by : abp_locinst_lastchange_user
> - last_changed_at : abp_locinst_lastchange_tstmpl
> - local_last_changed_at : abp_lastchange_tstmpl
>
> Activate after creation. Then read table Z##_MARA back and confirm it is active with exactly these fields.

> **Key concept:** Creating an ABAP object is always a two-step process:
> 1. `Create*` — creates an empty shell with metadata
> 2. `Update*` — sets the actual source code
>
> The agent handles both steps automatically.

**Expected result:** Table Z##_MARA created and activated with 12 fields.

### 4.2 Child Tables — Z##_MARC, Z##_MAKT, Z##_MVKE

**One child table per message.** After each one, wait for the agent to confirm it is active before sending the next.

**Message 1 — Z##_MARC (Plant Data for Material):**

> Create table Z##_MARC in package TEST_##_MAT with description 'Plant Data for Material'. Fields:
> - key client : abap.clnt not null
> - key uuid : sysuuid_x16 not null
> - key matnr : z##_e_matnr not null
> - key werks : z##_e_werks not null
> - root_uuid : sysuuid_x16
> - created_by : abp_creation_user
> - created_at : abp_creation_tstmpl
> - last_changed_by : abp_locinst_lastchange_user
> - last_changed_at : abp_locinst_lastchange_tstmpl
> - local_last_changed_at : abp_lastchange_tstmpl
>
> Activate after creation. Then read Z##_MARC back and confirm it is active with exactly these fields.

**Message 2 — Z##_MAKT (Material Descriptions):**

> Create table Z##_MAKT in package TEST_##_MAT with description 'Material Descriptions'. Fields:
> - key client : abap.clnt not null
> - key uuid : sysuuid_x16 not null
> - key matnr : z##_e_matnr not null
> - key spras : spras not null
> - root_uuid : sysuuid_x16
> - maktx : z##_e_maktx
> - created_by : abp_creation_user
> - created_at : abp_creation_tstmpl
> - last_changed_by : abp_locinst_lastchange_user
> - last_changed_at : abp_locinst_lastchange_tstmpl
> - local_last_changed_at : abp_lastchange_tstmpl
>
> Activate after creation. Then read Z##_MAKT back and confirm it is active with exactly these fields.

**Message 3 — Z##_MVKE (Sales Data for Material):**

> Create table Z##_MVKE in package TEST_##_MAT with description 'Sales Data for Material'. Fields:
> - key client : abap.clnt not null
> - key uuid : sysuuid_x16 not null
> - key matnr : z##_e_matnr not null
> - key vkorg : z##_e_vkorg not null
> - key vtweg : z##_e_vtweg not null
> - root_uuid : sysuuid_x16
> - created_by : abp_creation_user
> - created_at : abp_creation_tstmpl
> - last_changed_by : abp_locinst_lastchange_user
> - last_changed_at : abp_locinst_lastchange_tstmpl
> - local_last_changed_at : abp_lastchange_tstmpl
>
> Activate after creation. Then read Z##_MVKE back and confirm it is active with exactly these fields.

**Expected result:** All 3 child tables created and activated. Each has `root_uuid` field linking back to the root.

> **Important:** Child tables always have `root_uuid : sysuuid_x16` to link to the parent via UUID. The root table does NOT have `root_uuid`.

---

## Step 5: Create Draft Tables

Draft tables enable the "Edit" mode in Fiori UI — changes are saved as drafts before the user presses "Save".

**One draft table per message.** After each one, wait for the agent to confirm it is active before sending the next.

Common rules for every draft table below:

- `key mandt : mandt not null` (not `abap.clnt`)
- `key uuid : sysuuid_x16 not null`
- All key fields from the persistent table must also be keys in the draft table, using lowercased CDS aliases without underscores
- Non-key fields use lowercased CDS aliases (`materialtype` instead of `mtart`)
- Audit fields spelled out individually: `createdby`, `createdat`, `lastchangedby`, `lastchangedat`, `locallastchangedat`
- End with `include sych_bdl_draft_admin_inc;` (with group name `"%admin"` if the tool supports it)
- Do not add `draftuuid` or `parentuuid`; the draft framework manages those through the admin include

**Message 1 — Z##_MARA_D (root draft):**

> Create draft table Z##_MARA_D in package TEST_##_MAT, paired with persistent table Z##_MARA. Fields: key mandt, key uuid, key matnr, materialtype, materialgroup, markedfordeletion, baseunitofmeasure, createdby, createdat, lastchangedby, lastchangedat, locallastchangedat, plus `include sych_bdl_draft_admin_inc;`. Activate it, then read it back and confirm it is active and has no `draftuuid` or `parentuuid` field.

**Message 2 — Z##_MARC_D (plant draft):**

> Create draft table Z##_MARC_D in package TEST_##_MAT, paired with Z##_MARC. Fields: key mandt, key uuid, key matnr, key plant, rootuuid, createdby, createdat, lastchangedby, lastchangedat, locallastchangedat, plus `include sych_bdl_draft_admin_inc;`. Activate it, then read it back and confirm it is active and has no `draftuuid` or `parentuuid` field.

**Message 3 — Z##_MAKT_D (text draft):**

> Create draft table Z##_MAKT_D in package TEST_##_MAT, paired with Z##_MAKT. Fields: key mandt, key uuid, key matnr, key language, materialdescription, rootuuid, createdby, createdat, lastchangedby, lastchangedat, locallastchangedat, plus `include sych_bdl_draft_admin_inc;`. Activate it, then read it back and confirm it is active and has no `draftuuid` or `parentuuid` field.

**Message 4 — Z##_MVKE_D (sales draft):**

> Create draft table Z##_MVKE_D in package TEST_##_MAT, paired with Z##_MVKE. Fields: key mandt, key uuid, key matnr, key salesorganization, key distributionchannel, rootuuid, createdby, createdat, lastchangedby, lastchangedat, locallastchangedat, plus `include sych_bdl_draft_admin_inc;`. Activate it, then read it back and confirm it is active and has no `draftuuid` or `parentuuid` field.

**What happens:** The agent creates 4 draft tables. The naming convention difference between persistent and draft tables is critical:

| Persistent (`Z##_MARA`) | Draft (`Z##_MARA_D`) | Rule                             |
|-------------------------|-----------------------|----------------------------------|
| `mtart`                 | `materialtype`        | CDS alias (lowercased PascalCase) |
| `matkl`                 | `materialgroup`       | CDS alias                        |
| `created_by`            | `createdby`           | Audit fields spelled out, lowercase |

In addition, the draft table must include `sych_bdl_draft_admin_inc` — this carries the draft-administration fields required by the RAP draft framework.

**Expected result:** All 4 draft tables created and activated. Key fields match persistent tables (mandt + uuid + business keys), fields use lowercased CDS aliases without underscores, and the draft administration include is present.

> **Critical rule:** Draft table key fields must match persistent table key fields. If persistent table has `key matnr`, draft table must also have `key matnr`. Draft table field names must use the CDS aliases lowercased without underscores, for example `materialtype`, `rootuuid`, `createdby`.
>
> **Known LLM mistake:** The LLM often generates draft tables with only `mandt` + `uuid` as keys, omitting business keys like `matnr`, `werks`, `spras`. This causes BDEF activation error: "Field MATNR is required but not a key". **Fix:** Ensure all key fields from the persistent table are also key fields in the draft table.
>
> **Common mistake:** Using persistent table field names (mtart) instead of CDS aliases (materialtype) for non-key fields in draft tables. This causes BDEF mapping errors.

---

## Step 6: Create Interface CDS Views (R-type)

Interface CDS views define the BO's data model. The root view has compositions to children.

> **Important — activation strategy:** Root and child CDS views reference each other (root composes children, children associate to parent). This is a loop: each side needs the other to exist. The fix is two phases:
> 1. Create all 4 views first (they will have syntax errors — that is expected, ignore for now).
> 2. Activate all 4 together in one activation call.
>
> If the agent gets stuck, say: "Create all views without activating, then activate all 4 together."

### 6.1 Root CDS — Z##_R_MAT_ROOT

**You type in chat:**

> Create interface CDS view entity Z##_R_MAT_ROOT in package TEST_##_MAT.
> Source table: z##_mara
> This is the root view with compositions to children:
> - composition [0..*] of Z##_R_MAT_PLANT as _Plant
> - composition [0..*] of Z##_R_MAT_TEXT as _Text
> - composition [0..*] of Z##_R_MAT_SALES as _Sales
>
> Map fields to PascalCase aliases:
> - uuid as Uuid, matnr as Matnr, mtart as MaterialType, matkl as MaterialGroup
> - lvorm as MarkedForDeletion, meins as BaseUnitOfMeasure
> - created_by as CreatedBy, created_at as CreatedAt
> - last_changed_by as LastChangedBy, last_changed_at as LastChangedAt
> - local_last_changed_at as LocalLastChangedAt
>
> Expose compositions _Plant, _Text, _Sales in the field list.
> Do NOT activate yet — we need to create child views first.

**What happens:** The agent creates a `define root view entity` with compositions. Syntax errors are expected at this point because child views don't exist yet.

- `Z##_R_MAT_ROOT` is a `define root view entity` with `composition [0..*]` to each child (`_Plant`, `_Text`, `_Sales`).
- Each child declares `association to parent Z##_R_MAT_ROOT as _Root`.
- The on-condition on every child joins both keys: `$projection.Matnr = _Root.Matnr and $projection.RootUuid = _Root.Uuid`.
- `RootUuid` on the child is the technical link; `Matnr` is the business key — both are required.

> **Key concept:** Composition on-conditions must include ALL keys: both the business key (Matnr) and the technical key (RootUuid = parent Uuid).

### 6.2 Child CDS Views + Activate All

**One child view per message. Do NOT activate yet — all 4 interface views (root + 3 children) must be activated together at the end because of the circular composition/association references.**

**Message 1 — Z##_R_MAT_PLANT:**

> Create interface CDS view entity Z##_R_MAT_PLANT in package TEST_##_MAT.
> Source table: z##_marc
> association to parent Z##_R_MAT_ROOT as _Root on $projection.Matnr = _Root.Matnr and $projection.RootUuid = _Root.Uuid
> Fields: uuid as Uuid, matnr as Matnr, werks as Plant, root_uuid as RootUuid, created_by as CreatedBy, created_at as CreatedAt, last_changed_by as LastChangedBy, last_changed_at as LastChangedAt, local_last_changed_at as LocalLastChangedAt
> Expose _Root.
> Do NOT activate yet.

**Message 2 — Z##_R_MAT_TEXT:**

> Create interface CDS view entity Z##_R_MAT_TEXT in package TEST_##_MAT.
> Source table: z##_makt
> association to parent Z##_R_MAT_ROOT as _Root on $projection.Matnr = _Root.Matnr and $projection.RootUuid = _Root.Uuid
> Fields: uuid as Uuid, matnr as Matnr, spras as Language, maktx as MaterialDescription, root_uuid as RootUuid, created_by as CreatedBy, created_at as CreatedAt, last_changed_by as LastChangedBy, last_changed_at as LastChangedAt, local_last_changed_at as LocalLastChangedAt
> Expose _Root.
> Do NOT activate yet.

**Message 3 — Z##_R_MAT_SALES:**

> Create interface CDS view entity Z##_R_MAT_SALES in package TEST_##_MAT.
> Source table: z##_mvke
> association to parent Z##_R_MAT_ROOT as _Root on $projection.Matnr = _Root.Matnr and $projection.RootUuid = _Root.Uuid
> Fields: uuid as Uuid, matnr as Matnr, vkorg as SalesOrganization, vtweg as DistributionChannel, root_uuid as RootUuid, created_by as CreatedBy, created_at as CreatedAt, last_changed_by as LastChangedBy, last_changed_at as LastChangedAt, local_last_changed_at as LocalLastChangedAt
> Expose _Root.
> Do NOT activate yet.

**Message 4 — Activate the group:**

> Activate ALL 4 interface CDS views together: Z##_R_MAT_ROOT, Z##_R_MAT_PLANT, Z##_R_MAT_TEXT, Z##_R_MAT_SALES.

**Expected result:** All 4 CDS views created and activated. The agent confirms all views are active.

**Checkpoint:** Ask the agent to verify: "List all objects starting with Z##_ and confirm all interface CDS views are active."

> **Tip:** If activation fails with "association target not found", it means not all views were activated together. Ask the agent: "Activate Z##_R_MAT_ROOT, Z##_R_MAT_PLANT, Z##_R_MAT_TEXT, Z##_R_MAT_SALES together in one activation call."
>
> **Known LLM mistakes in CDS view generation:**
>
> 1. **DDL source not uploaded.** The LLM may create the view object shell but fail to upload the DDL source (circular dependency blocks syntax check). Error on activation: "DDIC source code does not contain a valid definition". **Fix:** Provide the exact DDL source code in the prompt. Ask the agent to update each view with the DDL, then activate all together.
>
> 2. **Views created then deleted during retries.** The LLM may delete and recreate views many times while trying to break the loop dependency, and may delete views that already worked. **Fix:** After this step, always verify with a checkpoint that all 4 views exist and are active before moving on.
>
> **Important — run a syntax check after activation:** CDS views are created without a syntax check and activated as a group. After activation, verify each view has no errors:
> "Check CDS view Z##_R_MAT_ROOT for syntax errors" (repeat for each view).
> The check may show warnings about key definitions or missing access control — those are warnings only for this tutorial but should be fixed in production.

---

## Step 7: Create Projection CDS Views (C-type)

Projections define what the service consumer sees. They reference the interface CDS views.

Same loop-dependency pattern as Step 6: root redirects to children, children redirect to root. Create all 4 without activating, then activate together.

**One projection per message. Do NOT activate yet.**

**Message 1 — Z##_C_MAT_ROOT:**

> Create projection CDS view Z##_C_MAT_ROOT in package TEST_##_MAT as projection on Z##_R_MAT_ROOT.
> - provider contract transactional_query
> - All fields from the interface view
> - Redirect compositions: _Plant : redirected to composition child Z##_C_MAT_PLANT, _Text : redirected to composition child Z##_C_MAT_TEXT, _Sales : redirected to composition child Z##_C_MAT_SALES
> - @Search.searchable: true on view, @Search.defaultSearchElement on Matnr
> - @Metadata.allowExtensions: true
> Do NOT activate yet.

**Message 2 — Z##_C_MAT_PLANT:**

> Create projection CDS view Z##_C_MAT_PLANT in package TEST_##_MAT as projection on Z##_R_MAT_PLANT.
> - All fields from the interface view
> - Redirect _Root : redirected to parent Z##_C_MAT_ROOT
> - @Metadata.allowExtensions: true
> Do NOT activate yet.

**Message 3 — Z##_C_MAT_TEXT:**

> Create projection CDS view Z##_C_MAT_TEXT in package TEST_##_MAT as projection on Z##_R_MAT_TEXT.
> - All fields from the interface view
> - Redirect _Root : redirected to parent Z##_C_MAT_ROOT
> - @Metadata.allowExtensions: true
> Do NOT activate yet.

**Message 4 — Z##_C_MAT_SALES:**

> Create projection CDS view Z##_C_MAT_SALES in package TEST_##_MAT as projection on Z##_R_MAT_SALES.
> - All fields from the interface view
> - Redirect _Root : redirected to parent Z##_C_MAT_ROOT
> - @Metadata.allowExtensions: true
> Do NOT activate yet.

**Message 5 — Activate the group:**

> Activate ALL 4 projection CDS views together: Z##_C_MAT_ROOT, Z##_C_MAT_PLANT, Z##_C_MAT_TEXT, Z##_C_MAT_SALES.

**Expected result:** All 4 projection CDS views created and activated. Only the root projection carries `provider contract transactional_query` — required for a managed RAP BO with draft.

**Checkpoint:** Ask the agent: "List all CDS views starting with Z##_ and confirm they are all active."

---

## Step 8: Create Metadata Extensions

Metadata extensions add UI annotations for the Fiori Elements app. They depend on projection views (`@Metadata.allowExtensions: true` from Step 7).

**You type in chat:**

> Create metadata extension for Z##_C_MAT_ROOT in package TEST_##_MAT with this source:
>
> ```
> @Metadata.layer: #CUSTOMER
> annotate entity Z##_C_MAT_ROOT with
> {
>   @UI.facet: [
>     { id: 'General', purpose: #STANDARD, type: #IDENTIFICATION_REFERENCE, label: 'General Data', position: 10 },
>     { id: 'Plant', purpose: #STANDARD, type: #LINEITEM_REFERENCE, label: 'Plant Data', position: 20, targetElement: '_Plant' },
>     { id: 'Text', purpose: #STANDARD, type: #LINEITEM_REFERENCE, label: 'Texts', position: 30, targetElement: '_Text' },
>     { id: 'Sales', purpose: #STANDARD, type: #LINEITEM_REFERENCE, label: 'Sales Data', position: 40, targetElement: '_Sales' }
>   ]
>   @UI.hidden: true
>   Uuid;
>   @UI: { lineItem: [{ position: 10 }], identification: [{ position: 10 }], selectionField: [{ position: 10 }] }
>   Matnr;
>   @UI: { lineItem: [{ position: 20 }], identification: [{ position: 20 }], selectionField: [{ position: 20 }] }
>   MaterialType;
>   @UI: { lineItem: [{ position: 30 }], identification: [{ position: 30 }], selectionField: [{ position: 30 }] }
>   MaterialGroup;
>   @UI: { lineItem: [{ position: 40 }], identification: [{ position: 40 }] }
>   BaseUnitOfMeasure;
> }
> ```
>
> Activate.

**Expected result:** Metadata extension created and activated. The Fiori preview will show proper list/detail pages with field labels and facets.

---

## Step 9: Create Interface Behavior Definition (BDEF)

The BDEF defines the transactional behavior — CRUD operations, draft support, field control, and mappings.

The BDEF source below is one big block. Scan it top-down — every section is marked by its `define behavior for ...` line:

1. **Header** — `managed implementation in class ...` + `strict ( 2 )` + `with draft`
2. **`define behavior for Z##_R_MAT_ROOT`** — root entity: lock master, etag, all 5 draft actions, field control, mapping, compositions to children
3. **`define behavior for Z##_R_MAT_PLANT`** — plant child: lock dependent, mapping, association back to root
4. **`define behavior for Z##_R_MAT_TEXT`** — text child: same shape as plant
5. **`define behavior for Z##_R_MAT_SALES`** — sales child: same shape as plant

**You type in chat:**

> Create interface behavior definition for Z##_R_MAT_ROOT in package TEST_##_MAT. Use this exact BDEF source:
>
> ```
> managed implementation in class ZBP_##_R_MAT_ROOT unique;
> strict ( 2 );
> with draft;
>
> define behavior for Z##_R_MAT_ROOT alias MaterialRoot
> persistent table z##_mara
> draft table z##_mara_d
> lock master total etag LocalLastChangedAt
> authorization master ( instance )
> {
>   create;
>   update;
>   delete;
>
>   draft action Edit;
>   draft action Resume;
>   draft action Activate optimized;
>   draft action Discard;
>   draft determine action Prepare;
>
>   field ( numbering : managed, readonly ) Uuid;
>   field ( readonly ) CreatedAt, CreatedBy, LastChangedAt, LastChangedBy, LocalLastChangedAt;
>   field ( mandatory ) Matnr, MaterialType;
>
>   mapping for z##_mara
>   {
>     Uuid = uuid;
>     Matnr = matnr;
>     MaterialType = mtart;
>     MaterialGroup = matkl;
>     MarkedForDeletion = lvorm;
>     BaseUnitOfMeasure = meins;
>     CreatedBy = created_by;
>     CreatedAt = created_at;
>     LastChangedBy = last_changed_by;
>     LastChangedAt = last_changed_at;
>     LocalLastChangedAt = local_last_changed_at;
>   }
>
>   association _Plant { create; with draft; }
>   association _Text { create; with draft; }
>   association _Sales { create; with draft; }
> }
>
> define behavior for Z##_R_MAT_PLANT alias MaterialPlant
> persistent table z##_marc
> draft table z##_marc_d
> lock dependent by _Root
> authorization dependent by _Root
> {
>   update;
>   delete;
>
>   field ( numbering : managed, readonly ) Uuid;
>   field ( readonly ) Matnr, RootUuid, CreatedAt, CreatedBy, LastChangedAt, LastChangedBy, LocalLastChangedAt;
>
>   mapping for z##_marc
>   {
>     Uuid = uuid;
>     Matnr = matnr;
>     Plant = werks;
>     RootUuid = root_uuid;
>     CreatedBy = created_by;
>     CreatedAt = created_at;
>     LastChangedBy = last_changed_by;
>     LastChangedAt = last_changed_at;
>     LocalLastChangedAt = local_last_changed_at;
>   }
>
>   association _Root { with draft; }
> }
>
> define behavior for Z##_R_MAT_TEXT alias MaterialText
> persistent table z##_makt
> draft table z##_makt_d
> lock dependent by _Root
> authorization dependent by _Root
> {
>   update;
>   delete;
>
>   field ( numbering : managed, readonly ) Uuid;
>   field ( readonly ) Matnr, RootUuid, CreatedAt, CreatedBy, LastChangedAt, LastChangedBy, LocalLastChangedAt;
>
>   mapping for z##_makt
>   {
>     Uuid = uuid;
>     Matnr = matnr;
>     Language = spras;
>     MaterialDescription = maktx;
>     RootUuid = root_uuid;
>     CreatedBy = created_by;
>     CreatedAt = created_at;
>     LastChangedBy = last_changed_by;
>     LastChangedAt = last_changed_at;
>     LocalLastChangedAt = local_last_changed_at;
>   }
>
>   association _Root { with draft; }
> }
>
> define behavior for Z##_R_MAT_SALES alias MaterialSales
> persistent table z##_mvke
> draft table z##_mvke_d
> lock dependent by _Root
> authorization dependent by _Root
> {
>   update;
>   delete;
>
>   field ( numbering : managed, readonly ) Uuid;
>   field ( readonly ) Matnr, RootUuid, CreatedAt, CreatedBy, LastChangedAt, LastChangedBy, LocalLastChangedAt;
>
>   mapping for z##_mvke
>   {
>     Uuid = uuid;
>     Matnr = matnr;
>     SalesOrganization = vkorg;
>     DistributionChannel = vtweg;
>     RootUuid = root_uuid;
>     CreatedBy = created_by;
>     CreatedAt = created_at;
>     LastChangedBy = last_changed_by;
>     LastChangedAt = last_changed_at;
>     LocalLastChangedAt = local_last_changed_at;
>   }
>
>   association _Root { with draft; }
> }
> ```
>
> Do NOT activate yet — BIMP class must be created first.

**What happens:**

Interface BDEF header: `managed` + `strict ( 2 )` + `with draft`. Entities:

| Entity         | Lock             | Actions              |
|----------------|------------------|----------------------|
| `MaterialRoot` | lock master      | create, update, delete |
| `MaterialPlant`| lock dependent by `_Root` | update, delete |
| `MaterialText` | lock dependent by `_Root` | update, delete |
| `MaterialSales`| lock dependent by `_Root` | update, delete |

- Root entity also declares `authorization master ( instance )` and the five draft actions (`Edit`, `Resume`, `Activate optimized`, `Discard`, `Prepare`).
- Root's compositions to children are declared as `association _Plant/_Text/_Sales { create; with draft; }`.

**Expected result:** BDEF created (inactive until BIMP class exists). Do NOT activate yet — proceed to Step 10.

> **Run check before activation:** After creating the BDEF, verify it has no errors:
> "Check behavior definition Z##_R_MAT_ROOT for syntax errors"
> This catches mapping errors, missing draft actions, and authorization issues before attempting activation — saving time on expensive retry loops.

> **Known LLM mistakes in BDEF generation:**
>
> 1. **Draft table mapping added incorrectly.** The LLM may generate `mapping for z##_mara_d corresponding;` for draft tables. This is wrong — `mapping for` is only for persistent tables. Draft table is specified in the entity header (`draft table z##_mara_d`) and does NOT need a mapping line. If you see this error: remove the draft mapping lines.
>
> 2. **Missing `authorization master ( instance )` on root entity.** `strict ( 2 )` requires every entity to declare authorization. Root must have `authorization master ( instance )`. If you see error "every entity must be flagged as authorization master or dependent" — add this line to root entity.
>
> 3. **Missing `draft table` on child entities.** The LLM may only add `draft table` to the root but not children. All entities need `draft table` when `with draft` is enabled. Error: "There is no draft persistency specified for Z##_R_MAT_PLANT".
>
> 4. **Missing `lock dependent by _Root` on child entities.** `strict ( 2 )` requires every entity to have lock master or dependent. Error: "every entity must be flagged either as lock master or lock dependent".
>
> 5. **Missing draft actions.** When `with draft` is enabled, the root entity must explicitly declare draft actions: `draft action Edit;`, `draft action Resume;`, `draft action Activate optimized;`, `draft action Discard;`, `draft determine action Prepare;`. Without them, the Fiori UI draft flow (Edit → change → Save) will not work.
>
> 6. **Using `mapping for ... corresponding` instead of explicit mapping.** `corresponding` matches by field name, but CDS aliases (PascalCase like `MaterialType`) don't match table field names (lowercase like `mtart`). This causes 41+ mapping warnings at activation and broken field persistence. **Fix:** Always use explicit mapping with `CdsAlias = table_field;` syntax as shown above.
>
> **How to fix:** Ask the agent to update the BDEF with the corrected source code from above, then activate.

---

## Step 10: Create Behavior Implementation (BIMP)

**You type in chat:**

> Create the behavior implementation class ZBP_##_R_MAT_ROOT in package TEST_##_MAT for behavior of Z##_R_MAT_ROOT.
> The class should be PUBLIC ABSTRACT FINAL FOR BEHAVIOR OF Z##_R_MAT_ROOT.
> The global class contains the standard generated definition and empty implementation — the actual handler logic goes into local types.
> The local types (CCIMP) must contain a handler class for authorization:
>
> ```
> CLASS lhc_MaterialRoot DEFINITION INHERITING FROM cl_abap_behavior_handler.
>   PRIVATE SECTION.
>     METHODS get_instance_authorizations FOR INSTANCE AUTHORIZATION
>       IMPORTING keys REQUEST requested_authorizations FOR MaterialRoot RESULT result.
> ENDCLASS.
>
> CLASS lhc_MaterialRoot IMPLEMENTATION.
>   METHOD get_instance_authorizations.
>   ENDMETHOD.
> ENDCLASS.
> ```
>
> After the class exists, activate Z##_R_MAT_ROOT behavior definition and ZBP_##_R_MAT_ROOT together. If generic object activation cannot find the behavior definition, use direct behavior definition activation for Z##_R_MAT_ROOT, then activate the class.

**Expected result:** A BIMP class with empty global class and a local handler class `lhc_MaterialRoot` implementing `get_instance_authorizations`. After BIMP exists, the BDEF from Step 9 can be activated.

> **Note:** Steps 9 and 10 have a circular dependency: BDEF references the BIMP class, but the class is "for behavior of" the BDEF. The agent may need to create both and then activate them together.
> If generic object activation cannot find the BDEF, ask the agent to activate the behavior definition directly (for example, `ActivateBehaviorDefinition`) and then activate the BIMP class.
>
> **Known LLM mistake:** The agent may create the BIMP as a plain empty class without local types. The correct BIMP has: empty global class + local handler class inheriting from `cl_abap_behavior_handler` with authorization method. If the BDEF has `authorization master ( instance )`, the handler class **must** implement `get_instance_authorizations`. Without it, activation fails.

---

## Step 11: Create Projection Behavior Definition

**You type in chat:**

> Create projection behavior definition for Z##_C_MAT_ROOT in package TEST_##_MAT.
> Settings: projection, strict ( 2 ), use draft
>
> Root entity Z##_C_MAT_ROOT (alias Material):
> - use etag
> - use create, update, delete
> - use action Edit, Activate, Discard, Resume, Prepare
> - use association _Plant { create; with draft; }
> - use association _Text { create; with draft; }
> - use association _Sales { create; with draft; }
>
> Child entities Z##_C_MAT_PLANT, Z##_C_MAT_TEXT, Z##_C_MAT_SALES:
> - use etag
> - use update, delete
> - use association _Root { with draft; }
>
> Activate the projection behavior definition after creation.

**Expected result:** Projection BDEF created and activated.

---

## Step 12: Create Service Definition

**You type in chat:**

> Create service definition ZUI_##_MAT_O4 in package TEST_##_MAT.
> Label: 'Service for Material'
> Expose:
> - Z##_C_MAT_ROOT as Material
> - Z##_C_MAT_PLANT as MaterialPlant
> - Z##_C_MAT_TEXT as MaterialText
> - Z##_C_MAT_SALES as MaterialSales
>
> Activate.

**Expected result:** Service definition created and activated.

---

## Step 13: Create Service Binding and Publish

**You type in chat:**

> Create OData V4 UI service binding ZUI_##_MAT_O4 in package TEST_##_MAT for service definition ZUI_##_MAT_O4.
> Use binding variant ODATA_V4_UI.
> After creation, publish it.

**Expected result:** Service binding created, activated, and published. You get a service URL for testing.

> **Note:** Service Binding publishing may not be available via MCP tools. If so, the agent will tell you — publish manually in ADT (Eclipse) or Fiori Launchpad.

---

## Step 14: Verification

After all steps, verify the BO works:

**You type in chat:**

> Check the current state of all objects in package TEST_##_MAT. List any inactive objects and activate them.

**Expected result:** The agent lists all tutorial objects and confirms they are all active. If any are inactive, it activates them.

> **Final test:** Open the service binding in ADT and use "Preview" to launch the Fiori Elements app. You should be able to create, edit, and delete materials with plant data, texts, and sales data.

---

## Troubleshooting

### "Association/composition target not found"
The child CDS is not yet created or activated. Create and activate all interface CDS views together.

### "Field not found in draft table"
Draft tables use CDS alias names (MaterialType), not table field names (mtart). Check your draft table DDL.

### "Persistent table not found"
Activate tables before creating CDS views. Objects must be activated in dependency order.

### "Draft table missing admin fields"
Add `include sych_bdl_draft_admin_inc;` to the draft table, ideally with group name `"%admin"` if the tool supports it.

### Agent creates but doesn't activate
After each creation step, you can ask: "Activate all inactive objects starting with Z##_" or "Activate Z##_R_MAT_ROOT".

> **Important:** Never ask the agent to "activate all inactive objects" without a prefix filter. On shared systems, other users may have inactive objects that will conflict with yours. Always specify your prefix.

---

## Summary

**Total objects created:** ~38 (1 package + 8 domains + 9 data elements + 4 persistent tables + 4 draft tables + 4 interface CDS + 4 projection CDS + metadata extensions + 2 BDEFs + 1 BIMP + 1 Service Definition + 1 Service Binding)

**Key takeaways:**
1. Always create objects in dependency order (package → domains → data elements → tables → CDS → BDEF → service)
2. On on-premise, local packages must start with `TEST_` or `$` (software component LOCAL)
3. Draft table keys must match persistent table keys — business keys included
4. Draft table fields use lowercased CDS aliases without underscores
5. CDS views with loop dependencies (root ↔ children) must be activated together
6. **Before group activation — run a syntax check on each object and fix errors until clean.** This avoids many failed activations and retry loops.
7. BDEF strict(2) requires: authorization master/dependent, lock master/dependent, all 5 draft actions (Edit, Resume, Activate, Discard, Prepare), explicit field mapping (not `corresponding`)
8. Never use "Activate all inactive objects" on shared systems — always filter by your prefix
9. The agent handles Create + Update two-step process automatically but may not check syntax — always verify
