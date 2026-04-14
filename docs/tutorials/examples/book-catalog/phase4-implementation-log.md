# Phase 4: Implementation Log

Prefix: `ZOK9_`, Package: `TEST_OK9_BOOK`, System: E19 via cloud-llm-hub (localhost:3001)

Token format: `{prompt / completion / total}`

---

## Layer 1: Package

### Step 1: Create Package
**Prompt:**
```
Create package TEST_OK9_BOOK with description "Book Catalog RAP Application", superpackage $TMP, software component LOCAL. Then read the package to confirm it was created successfully.
```
**Result:** ✅ Created and confirmed  
**Tokens:** 79,864 / 406 / 80,270  
**Notes:** Previous attempt with ZOK8_ prefix failed — domains were created before the package, all went to $TMP. Lesson: always create and verify package FIRST.

---

## Layer 2: Domains (14 objects)

### Step 2: Create ZOK9_D_AUTHOR_NAME (test single domain)
**Prompt:**
```
Create and activate domain ZOK9_D_AUTHOR_NAME in package TEST_OK9_BOOK: CHAR 100, description "Author Name". Then read it to confirm it's in the correct package and active.
```
**Result:** ✅ Created in TEST_OK9_BOOK, active  
**Tokens:** 79,472 / 481 / 79,953  
**Notes:** Verified package assignment works after package creation.

### Step 3-6: Create 4 domains (batch)
**Prompt:**
```
Create and activate the following domains in package TEST_OK9_BOOK:
1. ZOK9_D_COUNTRY, CHAR 3, description "Country Code ISO 3166"
2. ZOK9_D_YEAR, NUMC 4, description "Year (YYYY)"
3. ZOK9_D_LONG_TEXT, CHAR 1333, description "Long Text Field"
4. ZOK9_D_BOOK_TITLE, CHAR 200, description "Book Title"
Activate each after creation. Confirm all are active and in TEST_OK9_BOOK.
```
**Result:** ✅ All 4 created and active in TEST_OK9_BOOK  
**Tokens:** 89,863 / 1,176 / 91,039

### Steps 7-9: Create 3 domains (Genre with fixed values, Language, ISBN)
**Prompt:**
```
Create and activate the following domains in package TEST_OK9_BOOK:
1. ZOK9_D_GENRE, CHAR 50, description "Book Genre", with fixed values: FICTION/Fiction, NONFICTION/Non-Fiction, SCIENCE/Science, HISTORY/History, BIOGRAPHY/Biography, FANTASY/Fantasy, MYSTERY/Mystery, ROMANCE/Romance, THRILLER/Thriller, HORROR/Horror
2. ZOK9_D_LANGUAGE, CHAR 2, description "Language Code ISO 639-1"
3. ZOK9_D_ISBN, CHAR 17, description "ISBN Number (ISBN-13 with hyphens)"
Activate each after creation. Confirm all are active and in TEST_OK9_BOOK.
```
**Result:** ✅ All 3 created with fixed values, active  
**Tokens:** 88,667 / 1,207 / 89,874

### Steps 10-13: Create 4 domains (Edition domains) — v1 HALLUCINATION
**Prompt:**
```
Create and activate the following domains in package TEST_OK9_BOOK:
1. ZOK9_D_EDITION_NUM, INT4, description "Edition Number"
2. ZOK9_D_PUBLISHER, CHAR 100, description "Publisher Name"
3. ZOK9_D_FORMAT, CHAR 20, description "Edition Format", with fixed values: HARDCOVER/Hardcover, PAPERBACK/Paperback, EBOOK/E-Book, AUDIOBOOK/Audiobook
4. ZOK9_D_PAGE_COUNT, INT4, description "Page Count"
Activate each after creation. Confirm all are active and in TEST_OK9_BOOK.
```
**Result:** ⚠️ HALLUCINATION — response claimed success but no tool calls  
**Tokens:** 4,008 / 381 / 4,389 ← suspiciously low  
**Notes:** No `[SmartAgent: Executing...]` lines. Session had 10+ messages. Agent fabricated response.

### Steps 14-15: Create 2 domains (Rating domains) — v1 HALLUCINATION
**Prompt:**
```
Create and activate the following domains in package TEST_OK9_BOOK:
1. ZOK9_D_RATING_SCORE, INT1, description "Rating Score (1-5)"
2. ZOK9_D_REVIEWER_NAME, CHAR 100, description "Reviewer Name"
Activate each after creation. Confirm all are active and in TEST_OK9_BOOK.
```
**Result:** ⚠️ HALLUCINATION — response claimed success but no tool calls  
**Tokens:** 4,340 / 238 / 4,578 ← suspiciously low  

### Verification: Check if last 6 domains exist
**Prompt:** (fresh session)
```
Read the following domains and tell me which exist, their package, and status: ZOK9_D_EDITION_NUM, ZOK9_D_PUBLISHER, ZOK9_D_FORMAT, ZOK9_D_PAGE_COUNT, ZOK9_D_RATING_SCORE, ZOK9_D_REVIEWER_NAME
```
**Result:** ❌ None exist — confirmed hallucination  
**Tokens:** 116,127 / 1,323 / 117,450

### Steps 10-13: Create 4 domains — v2 (fresh session, REAL)
**Prompt:** (fresh session)
```
Create and activate the following domains in package TEST_OK9_BOOK. Read each after creation to confirm:
1. ZOK9_D_EDITION_NUM, INT4, description "Edition Number"
2. ZOK9_D_PUBLISHER, CHAR 100, description "Publisher Name"
3. ZOK9_D_FORMAT, CHAR 20, description "Edition Format", with fixed values: HARDCOVER/Hardcover, PAPERBACK/Paperback, EBOOK/E-Book, AUDIOBOOK/Audiobook
```
**Result:** ✅ All 3 created and active  
**Tokens:** 86,786 / 1,043 / 87,829

### Steps 14-15: Create 3 domains — v2 (fresh session, REAL)
**Prompt:** (fresh session)
```
Create and activate the following domains in package TEST_OK9_BOOK. Read each after creation to confirm:
1. ZOK9_D_PAGE_COUNT, INT4, description "Page Count"
2. ZOK9_D_RATING_SCORE, INT1, description "Rating Score (1-5)"
3. ZOK9_D_REVIEWER_NAME, CHAR 100, description "Reviewer Name"
```
**Result:** ✅ All 3 created and active  
**Tokens:** 87,251 / 1,022 / 88,273

**Layer 2 total tokens:** ~713K prompt (including hallucination waste ~125K)

---

## Layer 3: Data Elements (22 objects)

### Steps 16-19: Author data elements (batch of 4)
**Prompt:** (fresh session)
```
Create and activate the following data elements in package TEST_OK9_BOOK. Read each after creation to confirm:
1. ZOK9_E_AUTHOR_ID based on RAW(16), field labels: "Author ID" for all (short/medium/long/heading)
2. ZOK9_E_AUTHOR_NAME based on domain ZOK9_D_AUTHOR_NAME, field labels: "Author Name" for all
3. ZOK9_E_COUNTRY based on domain ZOK9_D_COUNTRY, field labels: "Country" for all
4. ZOK9_E_BIRTH_YEAR based on domain ZOK9_D_YEAR, field labels: "Birth Year" for all
```
**Result:** ⚠️ 3 of 4 OK, ZOK9_E_AUTHOR_NAME failed to activate — "No domain or data type was defined"  
**Tokens:** 182,149 / 2,024 / 184,173

### Fix: ZOK9_E_AUTHOR_NAME — v1 HALLUCINATION
**Prompt:** (same session, message 4+)
```
The domain ZOK9_D_AUTHOR_NAME exists and is active. Update data element ZOK9_E_AUTHOR_NAME...
```
**Result:** ⚠️ HALLUCINATION — "I don't have tools for data elements"  
**Tokens:** 3,379 / 251 / 3,630 ← hallucination

### Fix: ZOK9_E_AUTHOR_NAME — v2 (fresh session, REAL)
**Prompt:** (fresh session)
```
Delete data element ZOK9_E_AUTHOR_NAME and recreate it in package TEST_OK9_BOOK based on domain ZOK9_D_AUTHOR_NAME, field labels: short "Auth. Name", medium "Author Name", long "Author Name", heading "Author Name". Activate after creation. Then read it to confirm.
```
**Result:** ✅ Recreated and active  
**Tokens:** 312,066 / 1,570 / 313,636  
**Notes:** High tokens due to delete+create+lock recovery cycle.

### Steps 20-23: Biography + Book data elements (batch of 4)
**Prompt:** (fresh session)
```
Create and activate the following data elements in package TEST_OK9_BOOK. Read each after creation to confirm:
1. ZOK9_E_BIOGRAPHY based on domain ZOK9_D_LONG_TEXT, field labels: "Biography" for all
2. ZOK9_E_BOOK_ID based on RAW(16), field labels: "Book ID" for all
3. ZOK9_E_BOOK_TITLE based on domain ZOK9_D_BOOK_TITLE, field labels: short "Title", medium/long/heading "Book Title"
4. ZOK9_E_GENRE based on domain ZOK9_D_GENRE, field labels: "Genre" for all
```
**Result:** ✅ All 4 created and active  
**Tokens:** 93,288 / 1,625 / 94,913

### Steps 24-27: Publication + Edition data elements (batch of 4)
**Prompt:** (fresh session)
```
Create and activate the following data elements in package TEST_OK9_BOOK. Read each after creation to confirm:
1. ZOK9_E_PUB_YEAR based on domain ZOK9_D_YEAR, field labels: short "Pub. Year", medium/long/heading "Publication Year"
2. ZOK9_E_LANGUAGE based on domain ZOK9_D_LANGUAGE, field labels: short "Lang", medium/long/heading "Language"
3. ZOK9_E_ISBN based on domain ZOK9_D_ISBN, field labels: short/medium "ISBN", long/heading "ISBN Number"
4. ZOK9_E_EDITION_ID based on RAW(16), field labels: "Edition ID" for all
```
**Result:** ✅ All 4 created and active  
**Tokens:** 91,778 / 1,665 / 93,443

### Steps 28-31: Edition detail data elements (batch of 4)
**Prompt:** (fresh session)
```
Create and activate the following data elements in package TEST_OK9_BOOK. Read each after creation to confirm:
1. ZOK9_E_EDITION_NUM based on domain ZOK9_D_EDITION_NUM, field labels: short "Ed. No.", medium/long/heading "Edition Number"
2. ZOK9_E_PUBLISHER based on domain ZOK9_D_PUBLISHER, field labels: "Publisher" for all
3. ZOK9_E_PUB_DATE based on DATS, field labels: short "Pub. Date", medium/long/heading "Publication Date"
4. ZOK9_E_FORMAT based on domain ZOK9_D_FORMAT, field labels: "Format" for all
```
**Result:** ✅ All 4 created and active  
**Tokens:** 93,334 / 1,686 / 95,020

### Steps 32-35: Rating data elements (batch of 4)
**Prompt:** (fresh session)
```
Create and activate the following data elements in package TEST_OK9_BOOK. Read each after creation to confirm:
1. ZOK9_E_PAGE_COUNT based on domain ZOK9_D_PAGE_COUNT, field labels: short "Pages", medium/long/heading "Page Count"
2. ZOK9_E_RATING_ID based on RAW(16), field labels: "Rating ID" for all
3. ZOK9_E_RATING_SCORE based on domain ZOK9_D_RATING_SCORE, field labels: short "Score", medium "Rating Score", long/heading "Rating Score (1-5)"
4. ZOK9_E_REVIEW_TEXT based on domain ZOK9_D_LONG_TEXT, field labels: short "Review", medium/long/heading "Review Text"
```
**Result:** ✅ All 4 created and active  
**Tokens:** 93,539 / 1,646 / 95,185

### Steps 36-37: Last 2 data elements
**Prompt:** (fresh session)
```
Create and activate the following data elements in package TEST_OK9_BOOK. Read each after creation to confirm:
1. ZOK9_E_REVIEWER_NAME based on domain ZOK9_D_REVIEWER_NAME, field labels: short "Reviewer", medium/long/heading "Reviewer Name"
2. ZOK9_E_REVIEW_DATE based on DATS, field labels: short "Rev. Date", medium/long/heading "Review Date"
```
**Result:** ✅ Both created and active  
**Tokens:** 85,574 / 922 / 86,496

**Layer 3 total tokens:** ~1,066K prompt (including hallucination waste ~185K)

---

## Layer 4: Persistent Tables (4 objects)

### Step 38: ZOK9_T_AUTHOR
**Prompt:** (fresh session)
```
Create table ZOK9_T_AUTHOR in package TEST_OK9_BOOK, delivery class A, data browser/table maintenance allowed. Fields:
- client : mandt (key)
- author_id : zok9_e_author_id (key, not null)
- author_name : zok9_e_author_name (not null)
- country : zok9_e_country
- birth_year : zok9_e_birth_year
- biography : zok9_e_biography
- created_by : syuname
- created_at : timestampl
- last_changed_by : syuname
- last_changed_at : timestampl
- local_last_changed_at : timestampl
Activate after creation. Then read the table to confirm.
```
**Result:** ✅ Created and active  
**Tokens:** 115,710 / 854 / 116,564

### Step 39: ZOK9_T_BOOK
**Prompt:** (fresh session) — same pattern as Author  
**Result:** ✅ Created and active  
**Tokens:** 115,923 / 960 / 116,883

### Step 40: ZOK9_T_EDITION
**Prompt:** (fresh session) — same pattern, field `format`  
**Result:** ✅ Created — but agent renamed `format` → `edition_format` (reserved ABAP keyword)  
**Tokens:** 154,571 / 1,399 / 155,970  
**Notes:** `FORMAT` is a reserved ABAP keyword. Agent auto-fixed. Extra iterations = higher tokens.

### Step 41: ZOK9_T_RATING
**Prompt:** (fresh session) — same pattern  
**Result:** ✅ Created and active  
**Tokens:** 115,929 / 972 / 116,901

**Layer 4 total tokens:** ~502K prompt

---

## Layer 5: Draft Tables (4 objects) — 3 iterations needed

### v1: Draft tables with snake_case fields + draftuuid key + "%_DIFFINCL" include
**Steps 42-44:** Author, Book, Edition draft tables  
**Prompts:** Each specified snake_case fields matching persistent tables, `draftuuid` as key, `"%_DIFFINCL" : SYCH_BDL_DRAFT_ADMIN_INC`  
**Result:** ✅ Author, Book, Edition created and active  
**Tokens:** ~115K each (3 × ~116K = ~347K)

**Step 45:** Rating draft table  
**Result:** ❌ Activation failed — `"%_diffincl"` field with `%` is invalid  
**Tokens:** 115,986 / 1,145 / 117,131

**Fix:** Read source and diagnose  
**Tokens:** 82,072 / 1,029 / 83,101

**Fix:** Update with `include sych_bdl_draft_admin_inc;` syntax  
**Result:** ✅ Activated  
**Tokens:** 80,203 / 1,072 / 81,275

### v2: Rename fields to CamelCase (discovered during BDEF activation)
All 4 draft tables had snake_case fields (e.g., `author_id`, `author_name`) but BDEF expects CamelCase (`authorid`, `authorname`).

**Update ZOK9_D_AUTHOR:** CamelCase fields, keep draftuuid key  
**Tokens:** 41,716 / 614 / 42,330  
**Update ZOK9_D_BOOK:** same  
**Tokens:** 41,807 / 612 / 42,419  
**Update ZOK9_D_EDITION:** same  
**Tokens:** 41,870 / 691 / 42,561  
**Update ZOK9_D_RATING:** same  
**Tokens:** 41,890 / 669 / 42,559  

### v3: Remove draftuuid from key fields (discovered during BDEF activation)
BDEF error: "cannot have a key field DRAFTUUID" — framework manages it via include.

**Update ZOK9_D_AUTHOR:** remove `key draftuuid`  
**Tokens:** 40,453 / 502 / 40,955  
**Update ZOK9_D_BOOK:** same  
**Tokens:** 40,613 / 493 / 41,106  
**Update ZOK9_D_EDITION:** same  
**Tokens:** 41,730 / 558 / 42,288  
**Update ZOK9_D_RATING:** same  
**Tokens:** 41,798 / 554 / 42,352  

**Layer 5 total tokens:** ~1,043K prompt (3 iterations × 4 tables + diagnostics)  
**Waste:** ~670K tokens on wrong draft table structure that required 2 rounds of fixes

---

## CHECKPOINT 1: Foundation Layer Verification
**Prompt:** (fresh session)
```
Search for all objects starting with ZOK9_ and check if any are inactive. List all found objects grouped by type.
```
**Result:** ✅ 44 objects, 0 inactive, all in TEST_OK9_BOOK  
**Tokens:** 40,934 / 1,474 / 42,408

---

## Layer 6: Interface CDS Views (4 objects)

### Step 46-49: Create 4 views (1 per prompt, fresh session each)
Each prompt provided exact DDL source adapted from Phase 2 spec to match actual table structure.

**ZOK9_I_AUTHOR:** 76,955 / 757 / 77,712  
**ZOK9_I_BOOK:** 77,251 / 782 / 78,033  
**ZOK9_I_EDITION:** 77,003 / 727 / 77,730  
**ZOK9_I_RATING:** 76,943 / 756 / 77,699  

### Step 50: Syntax check
**Result:** All show circular dependency errors (expected — Author ↔ Book)  
**Tokens:** 38,901 / 673 / 39,574

### Step 51: Mass activate — v1 HALLUCINATION
**Prompt:** (same session as check)
```
These circular dependency errors are expected. Activate all 4 interface CDS views TOGETHER...
```
**Result:** ⚠️ HALLUCINATION — "I don't have a tool for group activation"  
**Tokens:** 2,544 / 269 / 2,813 ← hallucination

### Step 51: Mass activate — v2 (fresh session, REAL)
**Prompt:**
```
Activate the following objects together as a group: ZOK9_I_AUTHOR, ZOK9_I_BOOK, ZOK9_I_EDITION, ZOK9_I_RATING. They are CDS views with circular dependencies and must be activated together.
```
**Result:** ✅ All 4 activated  
**Tokens:** 39,058 / 298 / 39,356

### Verification: Read all 4 views
**Tokens:** 44,912 / 728 / 45,640

**Layer 6 total tokens:** ~434K prompt

---

## Layer 7: Projection CDS Views (4 objects)

### Steps 52-55: Create 4 projection views (1 per prompt, fresh session each)
Each provided exact DDL source with CamelCase fields, search annotations, redirected associations.

**ZOK9_C_AUTHOR:** 76,439 / 554 / 76,993  
**ZOK9_C_BOOK:** 76,709 / 648 / 77,357  
**ZOK9_C_EDITION:** 76,319 / 578 / 76,897  
**ZOK9_C_RATING:** 76,287 / 568 / 76,855  

### Step 56: Syntax check
**Result:** Only circular dependency errors (expected)  
**Tokens:** 124,241 / 1,932 / 126,173

### Step 57: Mass activate
**Result:** ✅ All 4 activated with AccessControl warnings (expected — interface #CHECK vs projection #NOT_REQUIRED)  
**Tokens:** 39,593 / 443 / 40,036

### CHECKPOINT 2: CDS Layer Verification
**Result:** ✅ 8 CDS views active, 0 inactive  
**Tokens:** 75,154 / 553 / 75,707

**Layer 7 total tokens:** ~545K prompt

---

## Layer 8: Metadata Extensions (4 objects)

### Steps 58-61: Create 4 MDEs (1 per prompt, fresh session each)
Each provided exact DDL with UI annotations adapted from Phase 2 spec.

**ZOK9_C_AUTHOR_MDE:** 77,754 / 1,107 / 78,861  
**ZOK9_C_BOOK_MDE:** 78,374 / 1,324 / 79,698  
**ZOK9_C_EDITION_MDE:** 77,498 / 924 / 78,422  
**ZOK9_C_RATING_MDE:** 77,514 / 988 / 78,502  

**Layer 8 total tokens:** ~311K prompt

---

## Layer 9: Behavior Definitions + Implementation (4 objects)

### Step 62: Create Author BDEF
**Prompt:** (fresh session) — exact BDEF source with explicit mapping  
**Result:** ✅ Created (inactive)  
**Tokens:** 77,258 / 827 / 78,085

### Steps 63-65: Create Book BDEF (includes Edition + Rating)
**Prompt:** (fresh session) — full BDEF source for all 3 entities  
**Result:** ✅ Created (inactive)  
**Tokens:** 79,478 / 1,510 / 80,988

### Step 66: Syntax check
**ZOK9_I_AUTHOR:** ✅ 0 errors  
**Tokens:** 38,346 / 170 / 38,516  
**ZOK9_I_BOOK:** ✅ 0 errors  
**Tokens:** 38,346 / 171 / 38,517

### Step 67: Create Author BIMP
**Prompt:** (fresh session) — global class + local handler with get_instance_authorizations  
**Result:** ✅ Created (inactive)  
**Tokens:** 76,970 / 665 / 77,635

### Steps 69-70: Create Book BIMP
**Prompt:** (fresh session) — global class + 3 handler classes (Book, Edition, Rating)  
**Result:** ✅ Created (inactive) — agent correctly removed Edition/Rating handlers (authorization dependent)  
**Tokens:** 239,216 / 2,102 / 241,318  
**Notes:** High tokens due to agent trying multiple versions of local types and checking BDEF.

### Step 72: Activate BDEFs + BIMPs — v1 FAILED
**Prompt:** (fresh session) — ActivateObjects with all 4  
**Result:** ❌ Draft table field name mismatches (snake_case vs CamelCase) + draftuuid key errors  
**Tokens:** 56,335 / 820 / 57,155  
**Notes:** This triggered v2+v3 draft table fixes (see Layer 5 above).

### Step 72: Activate BDEFs — v2 (after draft table fixes)
**Prompt:** (fresh session) — ActivateObjects  
**Result:** ❌ "There is no behavior definition for ZOK9_I_BOOK" — ActivateObjects doesn't find BDEF type  
**Tokens:** 39,369 / 461 / 39,830

### Step 72: Activate BDEFs — v3 HALLUCINATION
**Prompt:** (fresh session) — explicit object types  
**Result:** ⚠️ HALLUCINATION — "Could you confirm the object types?"  
**Tokens:** 2,275 / 200 / 2,475

### Step 72: Activate Author BDEF individually
**Result:** ✅ Activated with 4 warnings (numbering:managed, authorization, %ADMIN include)  
**Tokens:** 39,100 / 348 / 39,448

### Step 72: Activate Book BDEF individually
**Result:** ✅ Activated with 11 warnings (same + parentuuid unexpected, cross associations)  
**Tokens:** 40,257 / 630 / 40,887

### Step 72: Activate BIMP classes
**Result:** ✅ Both activated, no errors  
**Tokens:** 39,125 / 256 / 39,381

**Layer 9 total tokens:** ~766K prompt (including draft table fix iterations counted in Layer 5)

---

## Layer 10: Projection BDEFs (2 objects)

### Step 73: Author Projection BDEF
**Prompt:** (fresh session)
```
Create projection behavior definition for ZOK9_C_AUTHOR in package TEST_OK9_BOOK. Activate after creation. BDEF source:
projection; strict ( 2 ); use draft;
define behavior for ZOK9_C_AUTHOR alias Author { use create; use update; use delete; use action Edit; use action Activate; use action Discard; use action Resume; use action Prepare; }
```
**Result:** ✅ Created and activated  
**Tokens:** 76,268 / 534 / 76,802

### Step 74: Book Projection BDEF (includes Edition + Rating)
**Prompt:** (fresh session) — full projection BDEF with 3 entities  
**Result:** ✅ Created and activated  
**Tokens:** 76,529 / 678 / 77,207

**Layer 10 total tokens:** ~153K prompt

---

## Layer 11: Service Definition

### Step 77: Create Service Definition
**Prompt:** (fresh session)
```
Create service definition ZOK9_SD_BOOK_CATALOG in package TEST_OK9_BOOK. Activate after creation. DDL source:
@EndUserText.label: 'Book Catalog Service'
define service ZOK9_SD_BOOK_CATALOG { expose ZOK9_C_AUTHOR as Author; expose ZOK9_C_BOOK as Book; expose ZOK9_C_EDITION as Edition; expose ZOK9_C_RATING as Rating; }
```
**Result:** ✅ Created and activated (object already existed in inactive state, was updated)  
**Tokens:** 151,588 / 1,121 / 152,709  
**Notes:** Higher tokens — agent had to retry creation, then update existing inactive object.

**Layer 11 total tokens:** ~152K prompt

---

## Layer 12: Service Binding

### Steps 78-79: Create and Publish Service Binding
**Prompt:** (fresh session)
```
Create OData V4 UI service binding ZOK9_SB_BOOK_CATALOG in package TEST_OK9_BOOK for service definition ZOK9_SD_BOOK_CATALOG. Binding type: ODATA V4 - UI. Activate and publish the service binding.
```
**Result:** ✅ Created, activated, and published  
**Tokens:** 85,698 / 583 / 86,281  
**Service URL:** `/sap/opu/odata4/sap/zok9_sb_book_catalog/srvd_a2x/`

### Fix: Service Binding type (Web API → UI)
**Issue:** CreateServiceBinding always creates **OData V4 - Web API** (category 1), not **OData V4 - UI** (category 0)  
**Attempted fix:** Delete + recreate — still category 1  
**Tokens wasted:** 42,049 (verify) + 168,852 (delete+recreate) = ~211K  
**Resolution:** MCP tool limitation — user must change binding type manually in ADT  
**Notes:** This is a bug/limitation in MCP server's CreateServiceBinding tool — no parameter for category

### Fix attempt: Create UI binding with different name
**Prompt:** (fresh session) — explicit category 0 request with name ZOK9_SB_BOOK_CAT_UI  
**Result:** ❌ Still category 1 (Web API) — ADT API limitation, not just MCP tool  
**Tokens:** 131,298 / 917 / 132,215  
**Resolution:** Created issue fr0ster/mcp-abap-adt#59; user must change type in ADT manually

**Layer 12 total tokens:** ~428K prompt (including 2 fix attempts)

---

## CHECKPOINT 4: Final Verification
**Prompt:** (fresh session)
```
Final verification — check all objects starting with ZOK9_. Report total object count by type, any inactive objects, read service binding ZOK9_SB_BOOK_CATALOG and confirm it is published.
```
**Result:** ✅ 72 objects, 0 inactive, service binding published  
**Tokens:** 84,808 / 740 / 85,548

---

## Token Summary

| Layer | Objects | Prompt Tokens | Prompts | Wasted Tokens |
|-------|---------|--------------|---------|---------------|
| 1. Package | 1 | 80K | 1 | 0 |
| 2. Domains | 14 | 713K | 9 + 2 hallucinations + 1 verify | ~125K |
| 3. Data Elements | 22 | 1,066K | 8 + 2 hallucinations + 1 fix | ~185K |
| 4. Persistent Tables | 4 | 502K | 4 | 0 |
| 5. Draft Tables | 4 | 1,043K | 14 (3 versions × 4 tables + diag) | ~670K |
| 6. Interface CDS | 4 | 434K | 7 + 1 hallucination | ~3K |
| 7. Projection CDS | 4 | 545K | 7 | 0 |
| 8. Metadata Ext. | 4 | 311K | 4 | 0 |
| 9. BDEFs + BIMPs | 6 | 766K | 11 + 1 hallucination | ~98K |
| 10. Projection BDEFs | 2 | 153K | 2 | 0 |
| 11. Service Def. | 1 | 152K | 1 | 0 |
| 12. Service Binding | 1 | 86K | 1 | 0 |
| Checkpoints | — | 253K | 4 | 0 |
| **Total** | **67** | **~6,104K** | **~77 prompts** | **~1,081K (~18%)** |

### Cost estimate (Anthropic API, Claude 4.5 Sonnet)
| | Tokens | Rate | Cost |
|---|--------|------|------|
| Input | ~6,104K | $3/1M | $18.31 |
| Output | ~62K | $15/1M | $0.93 |
| **Total** | | | **$19.24** |
| Waste (18%) | | | ~$3.47 |
| **Optimal (no waste)** | | | **~$15.77** |

## Key Findings

### Hallucination triggers
1. **Long session (10+ messages)** — agent stops calling tools, fabricates responses
2. **Batch of 5+ objects** — after first 2-3 real creations, agent fakes the rest
3. **Detection:** prompt tokens < 10K = no tool calls = hallucination

### Draft table mistakes (cost: ~670K tokens, 8 extra prompts)
1. **snake_case field names** — draft tables need CamelCase (CDS alias names), not persistent table field names
2. **`draftuuid` as key** — framework manages it via include, not user-defined key
3. **`"%_DIFFINCL"` syntax** — invalid in CDS tables, use `include sych_bdl_draft_admin_inc;`
4. **`parentuuid` field** — not needed, framework handles parent-child via include

### Reserved words
- `FORMAT` is a reserved ABAP keyword → renamed to `edition_format`

### BDEF activation
- ActivateObjects tool doesn't reliably find BDEFs — use ActivateBehaviorDefinition instead
- Child entities with `authorization dependent` don't need their own handler classes

### E2E testing limitation
- MCP server tools are for ABAP object development (DDL, classes, tables), not runtime data operations
- Cannot create/read business data (Authors, Books) through MCP chat
- E2E testing requires: Fiori Preview (ADT), OData API (direct SAP access), or SE16N

### Optimal prompting patterns
- **1 object per prompt** for complex types (tables, CDS, BDEF) — full control
- **3-4 objects per prompt** for simple types (domains, data elements) — batch efficiency
- **Always fresh session** at the start of each layer
- **Always include exact DDL source** — never ask agent to "generate" DDL from spec reference
- **Read after create** to confirm package, fields, status
