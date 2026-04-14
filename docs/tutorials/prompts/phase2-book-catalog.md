# Phase 2 Prompts: Book Catalog — Technical Specification

## Prompt 1: Generate draft specification

```
Do NOT create any SAP objects yet. We are in the technical design phase.

Based on the business requirements below, create a draft technical specification for SAP RAP implementation.

Business entities:
- Author: Name (mandatory), Country, BirthYear, Biography. One Author has many Books.
- Book: Title (mandatory), Genre, PublicationYear, Language, ISBN. One Book has many Editions and Ratings.
- Edition (child of Book, composition): EditionNumber, Publisher, PublicationDate, Format, PageCount
- Rating (child of Book, composition): Score (1-5, mandatory), ReviewText, ReviewerName (mandatory), ReviewDate

Technology constraints:
- SAP RAP managed BO with draft support, Fiori Elements UI, OData V4
- strict ( 2 ) mode
- Use prefix Z##_ for objects, package TEST_##_BOOK
- Custom domains and data elements for all business fields
- Author is a separate BO (association from Book, not composition)
- Book is root BO with Edition and Rating as children (composition)
- Explicit field mapping in BDEF (not corresponding)
- Draft table keys must match persistent table keys
- All 5 draft actions required (Edit, Resume, Activate, Discard, Prepare)
- authorization master ( instance ) on root, dependent on children
- BIMP class with local handler class for get_instance_authorizations
- UI: Author Name shown in Book list via text association, search on Title/Author/ISBN, filters on Genre/Year/Language, star rating for Score

For each object provide:
- Object name with prefix placeholder Z##_
- DDL source code or field definitions
- Activation notes (group activation, check before activate)

Include: domains, data elements, persistent tables, draft tables, interface CDS views, projection CDS views, metadata extensions, interface BDEF, BIMP, projection BDEF, service definition, service binding.
```

**Key elements:**
- "Do NOT create" guard repeated
- Explicit technology stack and constraints upfront
- Specific RAP requirements from skill (draft keys, explicit mapping, 5 draft actions, authorization)
- Asks for DDL source code, not just descriptions
- Lists all object types to include

## Results

- 1 iteration produced complete specification (22K tokens, 58KB file)
- 2342 lines covering: 16 domains, 16 data elements, 8 tables, 8 CDS views, 4 metadata extensions, 4 BDEFs, 2 BIMPs, service definition + binding
- Includes implementation sequence, critical config points, testing checklist, troubleshooting
- May need review iteration for draft table keys, BDEF mapping correctness
