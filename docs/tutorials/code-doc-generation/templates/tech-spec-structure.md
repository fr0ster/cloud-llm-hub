# Technical Specification — Template

> Format for documenting an existing ABAP development (report, function group, class, RAP BO).
> Every value must come from the actual code or metadata. Do not fabricate. If a fact is
> unknown after analysis, write `[UNKNOWN — not found in available sources]` rather than guessing.

## 1. General information

| Parameter           | Description |
|---------------------|-------------|
| Object name         |             |
| Object description  |             |
| Object type         |             |
| Application area    |             |
| Created by          |             |
| Created on          |             |
| Last modified by    |             |
| Last modified on    |             |
| Package             |             |

**How to fill in:**

- *Object name / type / package*: from object metadata (e.g. `ReadProgram` / `GetTable` / `GetClass`).
- *Description / application area*: from the metadata header or the program description.
- *Audit fields*: from the object's source-code header or repository metadata.

## 2. Purpose and Functionality

Short description of the business task this object serves, who uses it, what process it
automates, what workflow it follows. One to three paragraphs. Evidence-backed only — quote
or reference the code/comments that prove each statement.

## 3. Program includes

> Only for PROG-type objects with multiple include files. Skip for CLAS / FUGR.

List the include files that are part of this program. Identified via program-structure
analysis (`GetIncludesList`).

| Include name | Include description |
|--------------|--------------------|

## 4. Selection screens

> Only if the object defines a selection screen. Skip otherwise.

| Field | Type (PARAMETERS / SELECT-OPTIONS) | Data type | Purpose |
|-------|-------------------------------------|-----------|---------|

## 5. Database tables

List ABAP DDIC tables referenced for data storage or lookup. Include only **standard**
tables (no customer namespace — those go in section 7). Identified via code analysis +
`GetTable`.

| Table name | Purpose | Primary / secondary keys |
|------------|---------|--------------------------|

## 6. CDS views

List CDS views referenced by this object. Group by purpose (lookup view, transactional
view, projection).

| CDS name | Purpose | Key fields |
|----------|---------|------------|

## 7. Custom program objects

Objects that belong to the **same customer namespace** as this development and are used
(referenced) in its code. Exclude standard SAP objects. Exclude includes (those are in
section 3).

Group rows by object type. Insert a bolded row with the group name before listing each
group's objects.

Example:

| Object name          | Description                                | Package |
|----------------------|--------------------------------------------|---------|
| **Authorization objects** |                                       |         |
| Z_MY_AUTH            | Custom auth object for program access      | …       |
| **Data elements**    |                                            |         |
| Z_PERSON_NAME        | Person name data element                   | …       |
| **Function modules** |                                            |         |
| Z_DOC_UPLOAD         | Wrapper for SXPG_COMMAND_EXECUTE           | …       |

Identified via code analysis + a description pass (`DescribeByList` / `DescribeObject`).

## 8. Logic overview

> Free-form, but structured. Aim for ~½ to 1 page.

- **Entry points** — which event blocks fire (`INITIALIZATION`, `START-OF-SELECTION`,
  `END-OF-SELECTION`, PBO/PAI events for screen flow).
- **Main flow** — step-by-step what the code does in the happy path. Use bullet points.
- **Key algorithms / decisions** — anything non-obvious. Quote the relevant lines.
- **External effects** — DB updates, file I/O, RFC calls, OS commands, emails, IDoc
  postings. Be explicit.
- **Error handling** — how exceptions, `sy-subrc` checks, and message classes are used.

Every claim in this section must be backed by a line reference or a quoted code fragment.

## 9. Open questions

Things the analysis could not answer from the available sources. List them so the
maintainer or business owner can fill them in. Examples:

- "Why are two reports sharing SM69 command X?"
- "What is the expected file naming convention for output Y?"
- "Which authorization role grants S_RZL_ADM in production?"

If section 8 references behaviour that lives outside the codebase (SM69 entries, OS
scripts, customizing tables), call it out here.
