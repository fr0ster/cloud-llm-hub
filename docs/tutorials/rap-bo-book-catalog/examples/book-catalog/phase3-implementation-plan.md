# Implementation Plan
## Book Catalog RAP Application - Step-by-Step Execution Guide

---

## Layer 1: Package Setup

### Step 1: Create Development Package
**Object:** `TEST_##_BOOK` (Package)  
**Prompt:**
```
Create package TEST_##_BOOK with description "Book Catalog RAP Application"
```
**Expected Result:** Package created and assigned to transport request  
**Verification:** Check in SE80 or ADT Package Explorer  
**Notes:** Use $TMP for local development or assign transport request for transportable package

---

## Layer 2: Domains (Sequential Creation)

### Step 2: Create Domain for Author Name
**Object:** `Z##_D_AUTHOR_NAME` (Domain)  
**Prompt:**
```
Create domain Z##_D_AUTHOR_NAME, CHAR 100, description "Author Name"
```
**Expected Result:** Domain created and activated  
**Verification:** SE11 → Domain → Display  
**Notes:** Activate immediately after creation

### Step 3: Create Domain for Country
**Object:** `Z##_D_COUNTRY` (Domain)  
**Prompt:**
```
Create domain Z##_D_COUNTRY, CHAR 3, description "Country Code ISO 3166"
```
**Expected Result:** Domain created and activated  
**Verification:** SE11 → Domain → Display  
**Notes:** Could use standard domain LAND1, but custom domain per requirements

### Step 4: Create Domain for Birth Year
**Object:** `Z##_D_YEAR` (Domain)  
**Prompt:**
```
Create domain Z##_D_YEAR, NUMC 4, description "Year (YYYY)"
```
**Expected Result:** Domain created and activated  
**Verification:** SE11 → Domain → Display  
**Notes:** Reusable for BirthYear and PublicationYear

### Step 5: Create Domain for Biography
**Object:** `Z##_D_LONG_TEXT` (Domain)  
**Prompt:**
```
Create domain Z##_D_LONG_TEXT, CHAR 1333, description "Long Text Field"
```
**Expected Result:** Domain created and activated  
**Verification:** SE11 → Domain → Display  
**Notes:** Reusable for Biography and ReviewText; 1333 is typical for string fields

### Step 6: Create Domain for Book Title
**Object:** `Z##_D_BOOK_TITLE` (Domain)  
**Prompt:**
```
Create domain Z##_D_BOOK_TITLE, CHAR 200, description "Book Title"
```
**Expected Result:** Domain created and activated  
**Verification:** SE11 → Domain → Display  
**Notes:** Activate immediately

### Step 7: Create Domain for Genre
**Object:** `Z##_D_GENRE` (Domain)  
**Prompt:**
```
Create domain Z##_D_GENRE, CHAR 50, description "Book Genre", with fixed values: FICTION/Fiction, NONFICTION/Non-Fiction, SCIENCE/Science, HISTORY/History, BIOGRAPHY/Biography, FANTASY/Fantasy, MYSTERY/Mystery, ROMANCE/Romance, THRILLER/Thriller, HORROR/Horror
```
**Expected Result:** Domain created with value list, activated  
**Verification:** SE11 → Domain → Value Range tab  
**Notes:** Fixed values enable dropdown in UI

### Step 8: Create Domain for Language
**Object:** `Z##_D_LANGUAGE` (Domain)  
**Prompt:**
```
Create domain Z##_D_LANGUAGE, CHAR 2, description "Language Code ISO 639-1"
```
**Expected Result:** Domain created and activated  
**Verification:** SE11 → Domain → Display  
**Notes:** Could use standard SPRAS, but custom per requirements

### Step 9: Create Domain for ISBN
**Object:** `Z##_D_ISBN` (Domain)  
**Prompt:**
```
Create domain Z##_D_ISBN, CHAR 17, description "ISBN Number (ISBN-13 with hyphens)"
```
**Expected Result:** Domain created and activated  
**Verification:** SE11 → Domain → Display  
**Notes:** Length 17 accommodates ISBN-13 format: 978-3-16-148410-0

### Step 10: Create Domain for Edition Number
**Object:** `Z##_D_EDITION_NUM` (Domain)  
**Prompt:**
```
Create domain Z##_D_EDITION_NUM, INT4, description "Edition Number"
```
**Expected Result:** Domain created and activated  
**Verification:** SE11 → Domain → Display  
**Notes:** Integer type for edition numbering

### Step 11: Create Domain for Publisher
**Object:** `Z##_D_PUBLISHER` (Domain)  
**Prompt:**
```
Create domain Z##_D_PUBLISHER, CHAR 100, description "Publisher Name"
```
**Expected Result:** Domain created and activated  
**Verification:** SE11 → Domain → Display  
**Notes:** Activate immediately

### Step 12: Create Domain for Format
**Object:** `Z##_D_FORMAT` (Domain)  
**Prompt:**
```
Create domain Z##_D_FORMAT, CHAR 20, description "Edition Format", with fixed values: HARDCOVER/Hardcover, PAPERBACK/Paperback, EBOOK/E-Book, AUDIOBOOK/Audiobook
```
**Expected Result:** Domain created with value list, activated  
**Verification:** SE11 → Domain → Value Range tab  
**Notes:** Fixed values for dropdown

### Step 13: Create Domain for Page Count
**Object:** `Z##_D_PAGE_COUNT` (Domain)  
**Prompt:**
```
Create domain Z##_D_PAGE_COUNT, INT4, description "Page Count"
```
**Expected Result:** Domain created and activated  
**Verification:** SE11 → Domain → Display  
**Notes:** Integer type

### Step 14: Create Domain for Rating Score
**Object:** `Z##_D_RATING_SCORE` (Domain)  
**Prompt:**
```
Create domain Z##_D_RATING_SCORE, INT1, description "Rating Score (1-5)"
```
**Expected Result:** Domain created and activated  
**Verification:** SE11 → Domain → Display  
**Notes:** INT1 (1 byte integer, range 0-255); validation in BDEF

### Step 15: Create Domain for Reviewer Name
**Object:** `Z##_D_REVIEWER_NAME` (Domain)  
**Prompt:**
```
Create domain Z##_D_REVIEWER_NAME, CHAR 100, description "Reviewer Name"
```
**Expected Result:** Domain created and activated  
**Verification:** SE11 → Domain → Display  
**Notes:** Activate immediately

---

## Layer 3: Data Elements (Sequential Creation)

### Step 16: Create Data Element for Author ID
**Object:** `Z##_E_AUTHOR_ID` (Data Element)  
**Prompt:**
```
Create data element Z##_E_AUTHOR_ID based on RAW(16), field label "Author ID" (short/medium/long/heading)
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** UUID type for key field

### Step 17: Create Data Element for Author Name
**Object:** `Z##_E_AUTHOR_NAME` (Data Element)  
**Prompt:**
```
Create data element Z##_E_AUTHOR_NAME based on domain Z##_D_AUTHOR_NAME, field labels "Author Name"/"Author Name"/"Author Name"/"Author Name"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** Links to domain created in Step 2

### Step 18: Create Data Element for Country
**Object:** `Z##_E_COUNTRY` (Data Element)  
**Prompt:**
```
Create data element Z##_E_COUNTRY based on domain Z##_D_COUNTRY, field labels "Country"/"Country"/"Country"/"Country"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** Links to domain created in Step 3

### Step 19: Create Data Element for Birth Year
**Object:** `Z##_E_BIRTH_YEAR` (Data Element)  
**Prompt:**
```
Create data element Z##_E_BIRTH_YEAR based on domain Z##_D_YEAR, field labels "Birth Year"/"Birth Year"/"Birth Year"/"Birth Year"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** Links to domain created in Step 4

### Step 20: Create Data Element for Biography
**Object:** `Z##_E_BIOGRAPHY` (Data Element)  
**Prompt:**
```
Create data element Z##_E_BIOGRAPHY based on domain Z##_D_LONG_TEXT, field labels "Biography"/"Biography"/"Biography"/"Biography"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** Links to domain created in Step 5

### Step 21: Create Data Element for Book ID
**Object:** `Z##_E_BOOK_ID` (Data Element)  
**Prompt:**
```
Create data element Z##_E_BOOK_ID based on RAW(16), field labels "Book ID"/"Book ID"/"Book ID"/"Book ID"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** UUID type for key field

### Step 22: Create Data Element for Book Title
**Object:** `Z##_E_BOOK_TITLE` (Data Element)  
**Prompt:**
```
Create data element Z##_E_BOOK_TITLE based on domain Z##_D_BOOK_TITLE, field labels "Title"/"Book Title"/"Book Title"/"Book Title"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** Links to domain created in Step 6

### Step 23: Create Data Element for Genre
**Object:** `Z##_E_GENRE` (Data Element)  
**Prompt:**
```
Create data element Z##_E_GENRE based on domain Z##_D_GENRE, field labels "Genre"/"Genre"/"Genre"/"Genre"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** Links to domain with fixed values (Step 7)

### Step 24: Create Data Element for Publication Year
**Object:** `Z##_E_PUB_YEAR` (Data Element)  
**Prompt:**
```
Create data element Z##_E_PUB_YEAR based on domain Z##_D_YEAR, field labels "Pub. Year"/"Publication Year"/"Publication Year"/"Publication Year"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** Reuses domain from Step 4

### Step 25: Create Data Element for Language
**Object:** `Z##_E_LANGUAGE` (Data Element)  
**Prompt:**
```
Create data element Z##_E_LANGUAGE based on domain Z##_D_LANGUAGE, field labels "Lang"/"Language"/"Language"/"Language"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** Links to domain created in Step 8

### Step 26: Create Data Element for ISBN
**Object:** `Z##_E_ISBN` (Data Element)  
**Prompt:**
```
Create data element Z##_E_ISBN based on domain Z##_D_ISBN, field labels "ISBN"/"ISBN"/"ISBN Number"/"ISBN Number"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** Links to domain created in Step 9

### Step 27: Create Data Element for Edition ID
**Object:** `Z##_E_EDITION_ID` (Data Element)  
**Prompt:**
```
Create data element Z##_E_EDITION_ID based on RAW(16), field labels "Edition ID"/"Edition ID"/"Edition ID"/"Edition ID"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** UUID type for key field

### Step 28: Create Data Element for Edition Number
**Object:** `Z##_E_EDITION_NUM` (Data Element)  
**Prompt:**
```
Create data element Z##_E_EDITION_NUM based on domain Z##_D_EDITION_NUM, field labels "Ed. No."/"Edition Number"/"Edition Number"/"Edition Number"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** Links to domain created in Step 10

### Step 29: Create Data Element for Publisher
**Object:** `Z##_E_PUBLISHER` (Data Element)  
**Prompt:**
```
Create data element Z##_E_PUBLISHER based on domain Z##_D_PUBLISHER, field labels "Publisher"/"Publisher"/"Publisher"/"Publisher"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** Links to domain created in Step 11

### Step 30: Create Data Element for Publication Date
**Object:** `Z##_E_PUB_DATE` (Data Element)  
**Prompt:**
```
Create data element Z##_E_PUB_DATE based on DATS, field labels "Pub. Date"/"Publication Date"/"Publication Date"/"Publication Date"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** Built-in DATS type (YYYYMMDD)

### Step 31: Create Data Element for Format
**Object:** `Z##_E_FORMAT` (Data Element)  
**Prompt:**
```
Create data element Z##_E_FORMAT based on domain Z##_D_FORMAT, field labels "Format"/"Format"/"Format"/"Format"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** Links to domain with fixed values (Step 12)

### Step 32: Create Data Element for Page Count
**Object:** `Z##_E_PAGE_COUNT` (Data Element)  
**Prompt:**
```
Create data element Z##_E_PAGE_COUNT based on domain Z##_D_PAGE_COUNT, field labels "Pages"/"Page Count"/"Page Count"/"Page Count"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** Links to domain created in Step 13

### Step 33: Create Data Element for Rating ID
**Object:** `Z##_E_RATING_ID` (Data Element)  
**Prompt:**
```
Create data element Z##_E_RATING_ID based on RAW(16), field labels "Rating ID"/"Rating ID"/"Rating ID"/"Rating ID"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** UUID type for key field

### Step 34: Create Data Element for Rating Score
**Object:** `Z##_E_RATING_SCORE` (Data Element)  
**Prompt:**
```
Create data element Z##_E_RATING_SCORE based on domain Z##_D_RATING_SCORE, field labels "Score"/"Rating Score"/"Rating Score (1-5)"/"Rating Score (1-5)"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** Links to domain created in Step 14

### Step 35: Create Data Element for Review Text
**Object:** `Z##_E_REVIEW_TEXT` (Data Element)  
**Prompt:**
```
Create data element Z##_E_REVIEW_TEXT based on domain Z##_D_LONG_TEXT, field labels "Review"/"Review Text"/"Review Text"/"Review Text"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** Reuses domain from Step 5

### Step 36: Create Data Element for Reviewer Name
**Object:** `Z##_E_REVIEWER_NAME` (Data Element)  
**Prompt:**
```
Create data element Z##_E_REVIEWER_NAME based on domain Z##_D_REVIEWER_NAME, field labels "Reviewer"/"Reviewer Name"/"Reviewer Name"/"Reviewer Name"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** Links to domain created in Step 15

### Step 37: Create Data Element for Review Date
**Object:** `Z##_E_REVIEW_DATE` (Data Element)  
**Prompt:**
```
Create data element Z##_E_REVIEW_DATE based on DATS, field labels "Rev. Date"/"Review Date"/"Review Date"/"Review Date"
```
**Expected Result:** Data element created and activated  
**Verification:** SE11 → Data Element → Display  
**Notes:** Built-in DATS type

---

## Layer 4: Persistent Tables (Sequential Creation)

### Step 38: Create Author Table
**Object:** `Z##_T_AUTHOR` (Table)  
**Prompt:**
```
Create table Z##_T_AUTHOR with fields from technical specification Section 3.1.1, delivery class A, data browser/table maintenance allowed
```
**Expected Result:** Table created and activated  
**Verification:** SE11 → Database Table → Display  
**Notes:** Use field definitions from spec; key field: author_id (client-independent UUID)

**Field List Reference:** Technical Specification Section 3.1.1
- client (MANDT, key)
- author_id (Z##_E_AUTHOR_ID, key, not null)
- author_name (Z##_E_AUTHOR_NAME, not null)
- country (Z##_E_COUNTRY)
- birth_year (Z##_E_BIRTH_YEAR)
- biography (Z##_E_BIOGRAPHY)
- created_by, created_at, last_changed_by, last_changed_at, local_last_changed_at (standard admin fields)

### Step 39: Create Book Table
**Object:** `Z##_T_BOOK` (Table)  
**Prompt:**
```
Create table Z##_T_BOOK with fields from technical specification Section 3.1.2, delivery class A, data browser/table maintenance allowed
```
**Expected Result:** Table created and activated  
**Verification:** SE11 → Database Table → Display  
**Notes:** Use field definitions from spec; key field: book_id; foreign key to author_id

**Field List Reference:** Technical Specification Section 3.1.2
- client (MANDT, key)
- book_id (Z##_E_BOOK_ID, key, not null)
- title (Z##_E_BOOK_TITLE, not null)
- author_id (Z##_E_AUTHOR_ID, not null) - foreign key
- genre (Z##_E_GENRE)
- publication_year (Z##_E_PUB_YEAR)
- language (Z##_E_LANGUAGE)
- isbn (Z##_E_ISBN)
- created_by, created_at, last_changed_by, last_changed_at, local_last_changed_at

### Step 40: Create Edition Table
**Object:** `Z##_T_EDITION` (Table)  
**Prompt:**
```
Create table Z##_T_EDITION with fields from technical specification Section 3.1.3, delivery class A, data browser/table maintenance allowed
```
**Expected Result:** Table created and activated  
**Verification:** SE11 → Database Table → Display  
**Notes:** Composite key: book_id + edition_id; foreign key to book_id

**Field List Reference:** Technical Specification Section 3.1.3
- client (MANDT, key)
- book_id (Z##_E_BOOK_ID, key, not null) - foreign key
- edition_id (Z##_E_EDITION_ID, key, not null)
- edition_number (Z##_E_EDITION_NUM)
- publisher (Z##_E_PUBLISHER)
- publication_date (Z##_E_PUB_DATE)
- format (Z##_E_FORMAT)
- page_count (Z##_E_PAGE_COUNT)
- created_by, created_at, last_changed_by, last_changed_at, local_last_changed_at

**Corrected Field List (discovered during testing):**

Draft version (fails activation):
```
- format (Z##_E_FORMAT)
```
Final version (works):
```
- edition_format (Z##_E_FORMAT)
```
`FORMAT` is a reserved ABAP keyword — field names starting with reserved words cause "Statements could not be generated" activation error. Rename to `edition_format`.

### Step 41: Create Rating Table
**Object:** `Z##_T_RATING` (Table)  
**Prompt:**
```
Create table Z##_T_RATING with fields from technical specification Section 3.1.4, delivery class A, data browser/table maintenance allowed
```
**Expected Result:** Table created and activated  
**Verification:** SE11 → Database Table → Display  
**Notes:** Composite key: book_id + rating_id; foreign key to book_id

**Field List Reference:** Technical Specification Section 3.1.4
- client (MANDT, key)
- book_id (Z##_E_BOOK_ID, key, not null) - foreign key
- rating_id (Z##_E_RATING_ID, key, not null)
- score (Z##_E_RATING_SCORE, not null)
- review_text (Z##_E_REVIEW_TEXT)
- reviewer_name (Z##_E_REVIEWER_NAME, not null)
- review_date (Z##_E_REVIEW_DATE)
- created_by, created_at, last_changed_by, last_changed_at, local_last_changed_at

---

## Layer 5: Draft Tables (Sequential Creation)

### Step 42: Create Author Draft Table
**Object:** `Z##_D_AUTHOR` (Table)  
**Prompt:**
```
Create draft table Z##_D_AUTHOR with same key fields as Z##_T_AUTHOR plus draft administrative fields (DraftUUID, DraftEntityCreationDateTime, DraftEntityLastChangeDateTime, DraftAdministrativeData, DraftIsCreatedByMe, DraftIsProcessedByMe, DraftIsKeptByUser)
```
**Expected Result:** Draft table created and activated  
**Verification:** SE11 → Database Table → Display  
**Notes:** Key structure MUST match persistent table; add draft fields from SYCH_BDL_DRAFT_ADMIN_INC

**Field List:**
- All key fields from Z##_T_AUTHOR (client, author_id)
- DraftUUID (SYSUUID_X16, key)
- All non-key fields from Z##_T_AUTHOR
- Draft admin fields: DraftEntityCreationDateTime, DraftEntityLastChangeDateTime, DraftAdministrativeData (include structure), DraftIsCreatedByMe, DraftIsProcessedByMe, DraftIsKeptByUser

**Corrected Field List (discovered during testing):**

Draft version (fails activation):
```
- Draft admin fields: DraftEntityCreationDateTime, DraftEntityLastChangeDateTime, DraftAdministrativeData (include structure), ...
- or: "%_DIFFINCL" : sych_bdl_draft_admin_inc
```
Final version (works):
```
- include sych_bdl_draft_admin_inc;
```
The `"%_DIFFINCL" : sych_bdl_draft_admin_inc` syntax fails — field name with `%` is invalid in CDS table definition. Listing individual draft admin fields also fails. The correct CDS table syntax is simply `include sych_bdl_draft_admin_inc;` which expands to all required draft admin fields.

### Step 43: Create Book Draft Table
**Object:** `Z##_D_BOOK` (Table)  
**Prompt:**
```
Create draft table Z##_D_BOOK with same key fields as Z##_T_BOOK plus draft administrative fields
```
**Expected Result:** Draft table created and activated  
**Verification:** SE11 → Database Table → Display  
**Notes:** Key: client, book_id, DraftUUID

**Field List:**
- All key fields from Z##_T_BOOK (client, book_id)
- DraftUUID (SYSUUID_X16, key)
- All non-key fields from Z##_T_BOOK
- Draft admin fields (same as Step 42)

### Step 44: Create Edition Draft Table
**Object:** `Z##_D_EDITION` (Table)  
**Prompt:**
```
Create draft table Z##_D_EDITION with same key fields as Z##_T_EDITION plus ParentUUID and draft administrative fields
```
**Expected Result:** Draft table created and activated  
**Verification:** SE11 → Database Table → Display  
**Notes:** Key: client, book_id, edition_id, DraftUUID; add ParentUUID for draft hierarchy

**Field List:**
- All key fields from Z##_T_EDITION (client, book_id, edition_id)
- DraftUUID (SYSUUID_X16, key)
- ParentUUID (SYSUUID_X16) - links to parent draft
- All non-key fields from Z##_T_EDITION
- Draft admin fields (same as Step 42)

**Corrected Field List (discovered during testing):**

Draft version (fails activation):
```
- format (Z##_E_FORMAT)
- "%_DIFFINCL" : sych_bdl_draft_admin_inc
```
Final version (works):
```
- edition_format (Z##_E_FORMAT)
- include sych_bdl_draft_admin_inc;
```
Same corrections as Step 40 (reserved keyword) and Step 42 (include syntax).

### Step 45: Create Rating Draft Table
**Object:** `Z##_D_RATING` (Table)  
**Prompt:**
```
Create draft table Z##_D_RATING with same key fields as Z##_T_RATING plus ParentUUID and draft administrative fields
```
**Expected Result:** Draft table created and activated  
**Verification:** SE11 → Database Table → Display  
**Notes:** Key: client, book_id, rating_id, DraftUUID; add ParentUUID

**Field List:**
- All key fields from Z##_T_RATING (client, book_id, rating_id)
- DraftUUID (SYSUUID_X16, key)
- ParentUUID (SYSUUID_X16)
- All non-key fields from Z##_T_RATING
- Draft admin fields (same as Step 42)

**Corrected Field List (discovered during testing):**

Draft version (fails activation):
```
- "%_DIFFINCL" : sych_bdl_draft_admin_inc
```
Final version (works):
```
- include sych_bdl_draft_admin_inc;
```
Same correction as Step 42 (include syntax).

---

## CHECKPOINT 1: Verify Foundation Layer
**Command:**
```
Check all domains, data elements, and tables are active. Run GetInactiveObjects to verify no inactive objects with prefix Z##_
```
**Expected:** All objects active, no errors  
**Action if issues found:** Activate missing objects individually or use mass activation

---

## Layer 6: Interface CDS Views (Create-Check-Activate Pattern)

### Step 46: Create Author Interface View
**Object:** `Z##_I_AUTHOR` (CDS View)  
**Prompt:**
```
Create interface CDS view Z##_I_AUTHOR for Author entity using DDL from technical specification Section 4.1.1
```
**Expected Result:** View created (may be inactive due to missing associations)  
**Verification:** Check syntax in ADT  
**Notes:** Do NOT activate yet; wait until all interface views created

**DDL Reference:** Technical Specification Section 4.1.1
- Define root view, provider contract analytical_query or transactional_query
- Expose all fields from Z##_T_AUTHOR
- Add associations to Book (via _Book, cardinality [0..*])
- Use strict (2) mode if part of BDEF

### Step 47: Create Book Interface View
**Object:** `Z##_I_BOOK` (CDS View)  
**Prompt:**
```
Create interface CDS view Z##_I_BOOK for Book entity using DDL from technical specification Section 4.1.2
```
**Expected Result:** View created (may be inactive)  
**Verification:** Check syntax in ADT  
**Notes:** Do NOT activate yet; contains associations to Author, Edition, Rating

**DDL Reference:** Technical Specification Section 4.1.2
- Define root view
- Expose all fields from Z##_T_BOOK
- Add association to Author (via _Author, cardinality [1..1])
- Add composition to Edition (via _Edition, cardinality [0..*])
- Add composition to Rating (via _Rating, cardinality [0..*])
- Calculated field: AverageRating (virtual, computed in behavior)

### Step 48: Create Edition Interface View
**Object:** `Z##_I_EDITION` (CDS View)  
**Prompt:**
```
Create interface CDS view Z##_I_EDITION for Edition entity using DDL from technical specification Section 4.1.3
```
**Expected Result:** View created (may be inactive)  
**Verification:** Check syntax in ADT  
**Notes:** Do NOT activate yet; child entity

**DDL Reference:** Technical Specification Section 4.1.3
- Define view with parent association
- Expose all fields from Z##_T_EDITION
- Add association to parent Book (via _Book, cardinality [1..1])

### Step 49: Create Rating Interface View
**Object:** `Z##_I_RATING` (CDS View)  
**Prompt:**
```
Create interface CDS view Z##_I_RATING for Rating entity using DDL from technical specification Section 4.1.4
```
**Expected Result:** View created (may be inactive)  
**Verification:** Check syntax in ADT  
**Notes:** Do NOT activate yet; child entity

**DDL Reference:** Technical Specification Section 4.1.4
- Define view with parent association
- Expose all fields from Z##_T_RATING
- Add association to parent Book (via _Book, cardinality [1..1])

### Step 50: Check All Interface Views for Syntax Errors
**Prompt:**
```
Check syntax for all interface views Z##_I_AUTHOR, Z##_I_BOOK, Z##_I_EDITION, Z##_I_RATING. Report any errors.
```
**Expected Result:** All views syntactically correct (may have warnings about inactive associations)  
**Verification:** ADT Problems view or mass check in SE80  
**Notes:** Fix any syntax errors before proceeding

### Step 51: Mass Activate All Interface Views
**Prompt:**
```
Activate all interface CDS views together: Z##_I_AUTHOR, Z##_I_BOOK, Z##_I_EDITION, Z##_I_RATING
```
**Expected Result:** All 4 views activated successfully  
**Verification:** Check activation log; verify in SE11 or ADT  
**Notes:** Group activation resolves circular dependencies (Author ↔ Book)

---

## Layer 7: Projection CDS Views (Create-Check-Activate Pattern)

### Step 52: Create Author Projection View
**Object:** `Z##_C_AUTHOR` (CDS View)  
**Prompt:**
```
Create projection CDS view Z##_C_AUTHOR for Author entity using DDL from technical specification Section 4.2.1
```
**Expected Result:** View created (inactive)  
**Verification:** Check syntax in ADT  
**Notes:** Do NOT activate yet; wait for all projections

**DDL Reference:** Technical Specification Section 4.2.1
- Define projection on Z##_I_AUTHOR
- Expose selected fields for UI
- Redirect associations to projection views (_Book → Z##_C_BOOK)
- Add UI annotations (if not in separate metadata extension)

### Step 53: Create Book Projection View
**Object:** `Z##_C_BOOK` (CDS View)  
**Prompt:**
```
Create projection CDS view Z##_C_BOOK for Book entity using DDL from technical specification Section 4.2.2
```
**Expected Result:** View created (inactive)  
**Verification:** Check syntax in ADT  
**Notes:** Do NOT activate yet; contains associations to projections

**DDL Reference:** Technical Specification Section 4.2.2
- Define projection on Z##_I_BOOK
- Expose fields for UI
- Redirect associations (_Author → Z##_C_AUTHOR, _Edition → Z##_C_EDITION, _Rating → Z##_C_RATING)
- Include AverageRating field

### Step 54: Create Edition Projection View
**Object:** `Z##_C_EDITION` (CDS View)  
**Prompt:**
```
Create projection CDS view Z##_C_EDITION for Edition entity using DDL from technical specification Section 4.2.3
```
**Expected Result:** View created (inactive)  
**Verification:** Check syntax in ADT  
**Notes:** Do NOT activate yet

**DDL Reference:** Technical Specification Section 4.2.3
- Define projection on Z##_I_EDITION
- Expose fields for UI
- Redirect parent association (_Book → Z##_C_BOOK)

### Step 55: Create Rating Projection View
**Object:** `Z##_C_RATING` (CDS View)  
**Prompt:**
```
Create projection CDS view Z##_C_RATING for Rating entity using DDL from technical specification Section 4.2.4
```
**Expected Result:** View created (inactive)  
**Verification:** Check syntax in ADT  
**Notes:** Do NOT activate yet

**DDL Reference:** Technical Specification Section 4.2.4
- Define projection on Z##_I_RATING
- Expose fields for UI
- Redirect parent association (_Book → Z##_C_BOOK)
- UI annotation for star rating display on Score field

### Step 56: Check All Projection Views for Syntax Errors
**Prompt:**
```
Check syntax for all projection views Z##_C_AUTHOR, Z##_C_BOOK, Z##_C_EDITION, Z##_C_RATING. Report any errors.
```
**Expected Result:** All views syntactically correct  
**Verification:** ADT Problems view  
**Notes:** Fix any errors before activation

### Step 57: Mass Activate All Projection Views
**Prompt:**
```
Activate all projection CDS views together: Z##_C_AUTHOR, Z##_C_BOOK, Z##_C_EDITION, Z##_C_RATING
```
**Expected Result:** All 4 views activated successfully  
**Verification:** Check activation log  
**Notes:** Group activation resolves dependencies

---

## CHECKPOINT 2: Verify CDS Layer
**Command:**
```
Check all interface and projection CDS views are active. Run GetInactiveObjects with prefix Z##_
```
**Expected:** All 8 CDS views active  
**Action if issues:** Re-activate failed views

---

## Layer 8: Metadata Extensions (Sequential Creation)

### Step 58: Create Author Metadata Extension
**Object:** `Z##_C_AUTHOR_MDE` (Metadata Extension)  
**Prompt:**
```
Create metadata extension Z##_C_AUTHOR_MDE for Z##_C_AUTHOR with UI annotations from technical specification Section 5.1
```
**Expected Result:** Metadata extension created and activated  
**Verification:** Preview in Fiori Elements preview or check in ADT  
**Notes:** Activate immediately after creation

**Annotation Reference:** Technical Specification Section 5.1
- @UI.headerInfo with typeName, typeNamePlural
- @UI.lineItem for list display
- @UI.fieldGroup for object page sections
- @UI.identification for header fields

### Step 59: Create Book Metadata Extension
**Object:** `Z##_C_BOOK_MDE` (Metadata Extension)  
**Prompt:**
```
Create metadata extension Z##_C_BOOK_MDE for Z##_C_BOOK with UI annotations from technical specification Section 5.2
```
**Expected Result:** Metadata extension created and activated  
**Verification:** Check in ADT  
**Notes:** Includes facets for Edition and Rating child entities

**Annotation Reference:** Technical Specification Section 5.2
- @UI.headerInfo with title (Book Title), description (Author Name via association)
- @UI.lineItem with columns: Title, Author Name (via _Author.AuthorName), Genre, PublicationYear, AverageRating
- @UI.selectionField for search/filter: Title, Genre, PublicationYear, Language
- @UI.facet for object page: General Info section, Editions facet (collection), Ratings facet (collection)
- @UI.dataPoint for AverageRating with visualization as rating stars

### Step 60: Create Edition Metadata Extension
**Object:** `Z##_C_EDITION_MDE` (Metadata Extension)  
**Prompt:**
```
Create metadata extension Z##_C_EDITION_MDE for Z##_C_EDITION with UI annotations from technical specification Section 5.3
```
**Expected Result:** Metadata extension created and activated  
**Verification:** Check in ADT  
**Notes:** Child entity UI

**Annotation Reference:** Technical Specification Section 5.3
- @UI.lineItem for display in parent object page
- @UI.fieldGroup for edition details

### Step 61: Create Rating Metadata Extension
**Object:** `Z##_C_RATING_MDE` (Metadata Extension)  
**Prompt:**
```
Create metadata extension Z##_C_RATING_MDE for Z##_C_RATING with UI annotations from technical specification Section 5.4
```
**Expected Result:** Metadata extension created and activated  
**Verification:** Check in ADT  
**Notes:** Star rating visualization for Score field

**Annotation Reference:** Technical Specification Section 5.4
- @UI.lineItem for display in parent object page
- @UI.dataPoint for Score with rating visualization
- @UI.fieldGroup for rating details

---

## Layer 9: Behavior Definitions (Create-Check-Fix-Activate)

### Step 62: Create Author Interface BDEF
**Object:** `Z##_I_AUTHOR` (Behavior Definition)  
**Prompt:**
```
Create interface behavior definition for Z##_I_AUTHOR (managed, draft enabled, strict(2)) using BDEF from technical specification Section 6.1.1
```
**Expected Result:** BDEF created (inactive)  
**Verification:** Check syntax in ADT  
**Notes:** Do NOT activate yet; may have errors until BIMP class created

**BDEF Reference:** Technical Specification Section 6.1.1
- managed implementation in class Z##_BP_I_AUTHOR unique
- strict ( 2 )
- with draft, draft table Z##_D_AUTHOR
- persistent table Z##_T_AUTHOR
- lock master, authorization master ( instance )
- etag master LocalLastChangedAt
- mapping explicit: author_id = author_id, author_name = author_name, etc.
- field ( readonly ) author_id, CreatedBy, CreatedAt, LastChangedBy, LastChangedAt, LocalLastChangedAt
- field ( mandatory ) AuthorName
- association _Book { create; }
- draft actions: Edit, Resume, Activate, Discard, Prepare
- determination setInitialValues on modify { create; }

**Corrected (discovered during testing):**
- `ActivateObjects` tool doesn't reliably find BDEFs — use `ActivateBehaviorDefinition` instead
- UUID key fields should use `field ( numbering : managed, readonly ) AuthorId;` — without it, warning about missing UUID auto-generation
- `association _Book { create; }` removed from Author BDEF — Author is a standalone BO, Book references Author (not the other way)

### Step 63: Create Book Interface BDEF
**Object:** `Z##_I_BOOK` (Behavior Definition)  
**Prompt:**
```
Create interface behavior definition for Z##_I_BOOK (managed, draft enabled, strict(2)) using BDEF from technical specification Section 6.1.2
```
**Expected Result:** BDEF created (inactive)  
**Verification:** Check syntax in ADT  
**Notes:** Do NOT activate yet; root BO with compositions

**BDEF Reference:** Technical Specification Section 6.1.2
- managed implementation in class Z##_BP_I_BOOK unique
- strict ( 2 )
- with draft, draft table Z##_D_BOOK
- persistent table Z##_T_BOOK
- lock master, authorization master ( instance )
- etag master LocalLastChangedAt
- mapping explicit: book_id = book_id, title = title, author_id = author_id, etc.
- field ( readonly ) book_id, AverageRating, CreatedBy, CreatedAt, LastChangedBy, LastChangedAt, LocalLastChangedAt
- field ( mandatory ) Title
- association _Author
- composition [0..*] _Edition
- composition [0..*] _Rating
- draft actions: Edit, Resume, Activate, Discard, Prepare
- determination setInitialValues on modify { create; }
- determination calculateAverageRating on save { create; update; }

### Step 64: Create Edition Interface BDEF
**Object:** `Z##_I_EDITION` (Behavior Definition)  
**Prompt:**
```
Create interface behavior definition for Z##_I_EDITION (managed, draft enabled, strict(2)) using BDEF from technical specification Section 6.1.3
```
**Expected Result:** BDEF created (inactive)  
**Verification:** Check syntax in ADT  
**Notes:** Do NOT activate yet; child entity with authorization dependent

**BDEF Reference:** Technical Specification Section 6.1.3
- managed implementation in class Z##_BP_I_BOOK unique (shared with parent)
- strict ( 2 )
- with draft, draft table Z##_D_EDITION
- persistent table Z##_T_EDITION
- lock dependent by _Book, authorization dependent by _Book
- etag master LocalLastChangedAt
- mapping explicit: book_id = book_id, edition_id = edition_id, edition_number = edition_number, etc.
- field ( readonly ) book_id, edition_id, CreatedBy, CreatedAt, LastChangedBy, LastChangedAt, LocalLastChangedAt
- association _Book { with draft; }
- determination setInitialValues on modify { create; }

### Step 65: Create Rating Interface BDEF
**Object:** `Z##_I_RATING` (Behavior Definition)  
**Prompt:**
```
Create interface behavior definition for Z##_I_RATING (managed, draft enabled, strict(2)) using BDEF from technical specification Section 6.1.4
```
**Expected Result:** BDEF created (inactive)  
**Verification:** Check syntax in ADT  
**Notes:** Do NOT activate yet; child entity with validation

**BDEF Reference:** Technical Specification Section 6.1.4
- managed implementation in class Z##_BP_I_BOOK unique (shared with parent)
- strict ( 2 )
- with draft, draft table Z##_D_RATING
- persistent table Z##_T_RATING
- lock dependent by _Book, authorization dependent by _Book
- etag master LocalLastChangedAt
- mapping explicit: book_id = book_id, rating_id = rating_id, score = score, etc.
- field ( readonly ) book_id, rating_id, CreatedBy, CreatedAt, LastChangedBy, LastChangedAt, LocalLastChangedAt
- field ( mandatory ) Score, ReviewerName
- association _Book { with draft; }
- validation validateScore on save { create; update; field Score; }
- determination setInitialValues on modify { create; }

### Step 66: Check All Interface BDEFs for Syntax Errors
**Prompt:**
```
Check syntax for all interface behavior definitions: Z##_I_AUTHOR, Z##_I_BOOK, Z##_I_EDITION, Z##_I_RATING. Report any errors.
```
**Expected Result:** Syntax correct (activation errors expected due to missing BIMP classes)  
**Verification:** ADT Problems view  
**Notes:** BIMP class errors are expected at this stage

### Step 67: Create Author Behavior Implementation Class
**Object:** `Z##_BP_I_AUTHOR` (Class)  
**Prompt:**
```
Create behavior implementation class Z##_BP_I_AUTHOR for Author BO with local handler class for get_instance_authorizations, setInitialValues methods using code from technical specification Section 6.2.1
```
**Expected Result:** Class created with skeleton (inactive)  
**Verification:** Check in ADT Class Builder  
**Notes:** Do NOT activate yet; implement methods first

**Code Reference:** Technical Specification Section 6.2.1
- Global class Z##_BP_I_AUTHOR, interfaces IF_ABAP_BEHAVIOR_HANDLER
- Local handler class lcl_handler definition for Z##_I_AUTHOR
- Method get_instance_authorizations for authorization checks
- Method setInitialValues for UUID generation and defaults

### Step 68: Implement Author BIMP Methods
**Prompt:**
```
Implement methods in Z##_BP_I_AUTHOR: get_instance_authorizations (return full access), setInitialValues (generate author_id UUID). Use implementation from technical specification Section 6.2.1.
```
**Expected Result:** Methods implemented  
**Verification:** Check code in ADT  
**Notes:** Save but do NOT activate yet

### Step 69: Create Book Behavior Implementation Class
**Object:** `Z##_BP_I_BOOK` (Class)  
**Prompt:**
```
Create behavior implementation class Z##_BP_I_BOOK for Book/Edition/Rating BOs with local handler classes for all three entities using code from technical specification Section 6.2.2
```
**Expected Result:** Class created with skeleton (inactive)  
**Verification:** Check in ADT  
**Notes:** Single BIMP class handles Book + Edition + Rating

**Code Reference:** Technical Specification Section 6.2.2
- Global class Z##_BP_I_BOOK
- Local handler class lcl_book for Z##_I_BOOK entity
  - Methods: get_instance_authorizations, setInitialValues, calculateAverageRating
- Local handler class lcl_edition for Z##_I_EDITION entity
  - Methods: get_instance_authorizations, setInitialValues
- Local handler class lcl_rating for Z##_I_RATING entity
  - Methods: get_instance_authorizations, setInitialValues, validateScore

**Corrected (discovered during testing):**
- Child entities with `authorization dependent by _Book` do NOT need their own handler classes — they inherit authorization from the master entity
- Only `lhc_book` handler is needed in ZDEMO9_BP_I_BOOK; `lhc_edition` and `lhc_rating` are unnecessary
- Agent auto-corrected this when given all 3 handler classes — it removed Edition/Rating handlers

### Step 70: Implement Book BIMP Methods
**Prompt:**
```
Implement all methods in Z##_BP_I_BOOK for Book/Edition/Rating: get_instance_authorizations (all), setInitialValues (UUID generation), calculateAverageRating (compute average from ratings), validateScore (check 1-5 range). Use implementation from technical specification Section 6.2.2.
```
**Expected Result:** All methods implemented  
**Verification:** Check code in ADT  
**Notes:** Save but do NOT activate yet

### Step 71: Check All BDEFs and BIMP Classes for Errors
**Prompt:**
```
Check syntax and consistency for BDEFs and BIMP classes: Z##_I_AUTHOR, Z##_BP_I_AUTHOR, Z##_I_BOOK, Z##_BP_I_BOOK. Report any errors.
```
**Expected Result:** All syntactically correct, ready for activation  
**Verification:** ADT Problems view  
**Notes:** Fix any errors before proceeding

### Step 72: Activate All Interface BDEFs and BIMP Classes Together
**Prompt:**
```
Activate all interface behavior definitions and implementation classes together: Z##_I_AUTHOR, Z##_BP_I_AUTHOR, Z##_I_BOOK, Z##_BP_I_BOOK (including child entity BDEFs Z##_I_EDITION, Z##_I_RATING)
```
**Expected Result:** All BDEFs and classes activated successfully  
**Verification:** Check activation log; verify in ADT  
**Notes:** Mass activation required due to dependencies

**Corrected (discovered during testing):**
- `ActivateObjects` tool fails to find BDEF type — activate BDEFs individually via `ActivateBehaviorDefinition`
- Activate BDEFs first, then BIMP classes separately
- Expected warnings after activation:
  - `numbering:managed` should be added to UUID key fields
  - `with cross associations;` needed for cross-BO associations (Book → Author)
  - `"%ADMIN"` group name for draft include
  - `PARENTUUID` field in child draft tables is unexpected — remove it

---

## CHECKPOINT 3: Verify Behavior Layer
**Command:**
```
Check all interface BDEFs and BIMP classes are active. Run GetInactiveObjects with prefix Z##_
```
**Expected:** All behavior objects active  
**Action if issues:** Check error log, fix implementation issues, re-activate

---

## Layer 10: Projection Behavior Definitions

### Step 73: Create Author Projection BDEF
**Object:** `Z##_C_AUTHOR` (Behavior Definition)  
**Prompt:**
```
Create projection behavior definition for Z##_C_AUTHOR using BDEF from technical specification Section 6.3.1
```
**Expected Result:** Projection BDEF created and activated  
**Verification:** Check in ADT  
**Notes:** Activate immediately after creation

**BDEF Reference:** Technical Specification Section 6.3.1
- projection, use draft
- alias for Z##_I_AUTHOR
- use create, update, delete
- use association _Book { create; }
- use action Edit, Resume, Activate, Discard, Prepare

### Step 74: Create Book Projection BDEF
**Object:** `Z##_C_BOOK` (Behavior Definition)  
**Prompt:**
```
Create projection behavior definition for Z##_C_BOOK using BDEF from technical specification Section 6.3.2
```
**Expected Result:** Projection BDEF created and activated  
**Verification:** Check in ADT  
**Notes:** Includes child entities Edition and Rating

**BDEF Reference:** Technical Specification Section 6.3.2
- projection, use draft
- alias for Z##_I_BOOK
- use create, update, delete
- use association _Author
- use composition _Edition, _Rating
- use action Edit, Resume, Activate, Discard, Prepare

### Step 75: Create Edition Projection BDEF
**Object:** `Z##_C_EDITION` (Behavior Definition)  
**Prompt:**
```
Create projection behavior definition for Z##_C_EDITION using BDEF from technical specification Section 6.3.3
```
**Expected Result:** Projection BDEF created and activated  
**Verification:** Check in ADT  
**Notes:** Child entity projection

**BDEF Reference:** Technical Specification Section 6.3.3
- projection, use draft
- alias for Z##_I_EDITION
- use create, update, delete
- use association _Book { with draft; }

### Step 76: Create Rating Projection BDEF
**Object:** `Z##_C_RATING` (Behavior Definition)  
**Prompt:**
```
Create projection behavior definition for Z##_C_RATING using BDEF from technical specification Section 6.3.4
```
**Expected Result:** Projection BDEF created and activated  
**Verification:** Check in ADT  
**Notes:** Child entity projection

**BDEF Reference:** Technical Specification Section 6.3.4
- projection, use draft
- alias for Z##_I_RATING
- use create, update, delete
- use association _Book { with draft; }

---

## Layer 11: Service Definition

### Step 77: Create Service Definition
**Object:** `Z##_SD_BOOK_CATALOG` (Service Definition)  
**Prompt:**
```
Create service definition Z##_SD_BOOK_CATALOG exposing Author and Book entities using code from technical specification Section 7.1
```
**Expected Result:** Service definition created and activated  
**Verification:** Check in ADT, verify exposed entities  
**Notes:** Activate immediately

**Code Reference:** Technical Specification Section 7.1
```
@EndUserText.label: 'Book Catalog Service'
define service Z##_SD_BOOK_CATALOG {
  expose Z##_C_AUTHOR as Author;
  expose Z##_C_BOOK as Book;
  expose Z##_C_EDITION as Edition;
  expose Z##_C_RATING as Rating;
}
```

---

## Layer 12: Service Binding and Publication

### Step 78: Create Service Binding
**Object:** `Z##_SB_BOOK_CATALOG` (Service Binding)  
**Prompt:**
```
Create OData V4 UI service binding Z##_SB_BOOK_CATALOG for service definition Z##_SD_BOOK_CATALOG, binding type ODATA V4 - UI
```
**Expected Result:** Service binding created (unpublished)  
**Verification:** Check in ADT Service Binding editor  
**Notes:** Do NOT publish yet

### Step 79: Activate and Publish Service Binding
**Prompt:**
```
Activate and publish service binding Z##_SB_BOOK_CATALOG. Generate OData service endpoint.
```
**Expected Result:** Service binding published, OData endpoint available  
**Verification:** Check service URL in binding editor, test in browser or Fiori preview  
**Notes:** Service is now consumable

**Corrected (discovered during testing):**

Draft version (wrong binding type):
```
CreateServiceBinding always creates OData V4 - Web API (category 1)
```
Final version (manual fix required):
```
User must change binding type from "Web API" to "UI" in ADT after creation
```
ADT REST API does not expose the `category` parameter. `ListServiceBindingTypes` returns both OData V4 variants (category 0 = UI, category 1 = Web API), but `CreateServiceBinding` always creates category 1. See fr0ster/mcp-abap-adt#59.

---

## CHECKPOINT 4: Final Verification
**Command:**
```
Run GetInactiveObjects with prefix Z##_ to verify all objects are active. Test service binding preview for Author and Book entities.
```
**Expected:** 
- Zero inactive objects
- Service binding shows 2 entity sets: Author, Book
- Fiori preview launches successfully
- CRUD operations work in draft mode

**Final Object Count:**
- 15 Domains
- 22 Data Elements
- 4 Persistent Tables
- 4 Draft Tables
- 4 Interface CDS Views
- 4 Projection CDS Views
- 4 Metadata Extensions
- 4 Interface BDEFs
- 2 BIMP Classes
- 4 Projection BDEFs
- 1 Service Definition
- 1 Service Binding
- **Total: 69 objects**

---

## Step 80: Test End-to-End Functionality
**Prompt:**
```
Test the Book Catalog application: Create an Author, create a Book linked to that Author, add an Edition and Rating to the Book. Verify draft functionality (Edit, Save Draft, Activate). Check that Author Name appears in Book list and Average Rating is calculated.
```
**Expected Result:** 
- Full CRUD works for all entities
- Draft mode functions correctly (Edit → modify → Save Draft → Activate)
- Author Name displayed in Book list via association
- Average Rating calculated and displayed
- Star rating visualization for Score field
- Search and filters work (Title, Genre, Year, Language)

**Verification:** Use Fiori Elements preview or SAP Fiori launchpad  
**Notes:** This validates the complete RAP implementation

---

## Troubleshooting Guide

**Common Issues:**

1. **Inactive CDS Views after creation:**
   - Cause: Circular dependencies (Author ↔ Book)
   - Solution: Mass activate all interface views together (Step 51)

2. **BDEF activation errors:**
   - Cause: BIMP class not created or methods not implemented
   - Solution: Create BIMP class first, implement all methods, then activate together (Steps 67-72)

3. **Draft table key mismatch:**
   - Cause: Draft table keys don't match persistent table keys
   - Solution: Verify key structure in Steps 42-45; regenerate draft table if needed

4. **Authorization errors in preview:**
   - Cause: get_instance_authorizations not implemented or returns no access
   - Solution: Check BIMP implementation returns full access for testing (Step 68, 70)

5. **Average rating not calculated:**
   - Cause: calculateAverageRating determination not triggered or incorrect implementation
   - Solution: Verify determination in BDEF (Step 63) and implementation (Step 70)

6. **Service binding preview fails:**
   - Cause: Missing annotations or inactive objects
   - Solution: Run CHECKPOINT 4, verify all objects active, check metadata extensions (Steps 58-61)

---

## Post-Implementation Tasks

1. **Add sample data:** Use Fiori app or write ABAP program to populate test data
2. **Configure authorization:** Replace full-access stub in get_instance_authorizations with real authorization checks
3. **Enhance validations:** Add business validations (e.g., ISBN format check, future date validation)
4. **Add value helps:** Create additional CDS views for dropdowns (e.g., Author value help in Book creation)
5. **Optimize performance:** Add indexes on frequently queried fields (Genre, PublicationYear)
6. **Add search help:** Implement fuzzy search for Title and Author Name
7. **Configure transport:** Assign all objects to transport request for deployment

---

## Summary

This implementation plan provides a **sequential, step-by-step approach** to building the Book Catalog RAP application. Each step is designed as a **single user prompt** to an AI agent, with clear verification and notes. The plan follows **strict layering** to avoid dependency issues and includes **checkpoints** between layers to ensure stability.

**Key Principles:**
- One object at a time (no parallel work)
- Create-check-activate pattern for complex objects
- Mass activation for objects with circular dependencies
- Verification after each step and checkpoint after each layer
- Self-contained prompts referencing the technical specification

**Total Steps:** 80 (including checkpoints and testing)  
**Estimated Time:** 4-6 hours (depending on familiarity with RAP and tooling)
