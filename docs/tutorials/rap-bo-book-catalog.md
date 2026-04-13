# Smart Tutorial: Book Catalog RAP Application

This tutorial creates a complete SAP Fiori application for managing a book catalog using cloud-llm-hub chat UI. Unlike the step-by-step tutorial, here you describe **what** you want — the AI agent figures out the technical implementation using its RAP BO creation skills.

**What you will build:** A Book Catalog application with authors, books, editions, and reader ratings — with full CRUD, search, filters, and a polished Fiori UI.

**System:** SAP S/4HANA (on-premise)
**Skill required:** `rap-bo-creation` (load into RAG before starting)
**Time:** ~45-90 minutes
**Prerequisites:** Access to cloud-llm-hub chat UI with MCP connection to an SAP system

---

## Application Description

### Entities

| Entity | Description | Key Fields | Business Fields |
|--------|-------------|------------|-----------------|
| **Author** | Book authors | UUID | Name, Country, BirthYear, Biography (short text) |
| **Book** | Literary works | UUID | Title, ISBN, Genre, PublicationYear, Language, PageCount; reference to Author |
| **Edition** | Published editions of a book | UUID | EditionNumber, Publisher, PublicationDate, Format (hardcover/paperback/ebook), Price, Currency |
| **Rating** | Reader ratings and reviews | UUID | Score (1-5), ReviewText, ReviewerName, ReviewDate |

### Relationships

```
Author 1──* Book (one author has many books)
Book 1──* Edition (one book has many editions)
Book 1──* Rating (one book has many ratings)
```

- **Book → Author**: association (reference, not composition — author exists independently)
- **Book → Edition**: composition (book owns its editions)
- **Book → Rating**: composition (book owns its ratings)

### UI Requirements

1. **Book list page**: show Title, Author Name (not UUID!), Genre, Publication Year, average Rating
2. **Book detail page**: General info facet, Editions table, Ratings table
3. **Author list page**: show Name, Country, number of books
4. **Search**: fuzzy search on Book Title, Author Name, ISBN
5. **Filters**: Genre, Publication Year range, Language, Author Country
6. **Value help**: Author field on Book shows author names (not UUIDs)
7. **Ratings**: display as star rating (1-5) in UI
8. **Text association**: Book list shows Author Name instead of AuthorUuid

---

## How to Use This Tutorial

### Step 1: Load the skill

Upload the RAP BO Creation skill file to a RAG collection in cloud-llm-hub:
1. Open MANAGE panel in cloud-llm-hub chat UI
2. Create collection "RAP Skills"
3. Upload the skill file (`rap-bo-creation.md`) — get it from the shared documentation (SharePoint) or from `docs/tutorials/skills/rap-bo-creation.md` in the repo
4. Enable the collection (checkbox ON)

The agent will use this skill automatically when answering RAP-related prompts.

### Step 2: Choose your prefix

Pick a unique prefix (e.g., `ZDEMO1_`) and verify it's available:

> Search for objects starting with ZDEMO1_ to verify the prefix is available.

### Step 3: Create the package

> Create package TEST_##_BOOKS as a local $TMP package with software component LOCAL and description 'Book Catalog RAP Application'.

### Step 4: Describe the application

Give the agent the full application description. The agent will use the RAP skill to determine the correct creation order, DDL structures, and UI annotations.

> I want to create a Book Catalog RAP application with these entities:
>
> **Author** (root BO): Name (char 100, mandatory), Country (char 50), BirthYear (numc 4), Biography (char 255). Business key: Name.
>
> **Book** (root BO): Title (char 200, mandatory), ISBN (char 13), Genre (char 50), PublicationYear (numc 4), Language (char 2), PageCount (int4). Association to Author via AuthorUuid. Business key: Title + ISBN.
>
> **Edition** (child of Book, composition): EditionNumber (numc 3), Publisher (char 100), PublicationDate (dats), Format (char 20 — values: HARDCOVER, PAPERBACK, EBOOK), Price (dec 11.2), Currency (cuky 5).
>
> **Rating** (child of Book, composition): Score (int1, 1-5), ReviewText (char 500), ReviewerName (char 100), ReviewDate (dats).
>
> Requirements:
> - Use package TEST_##_BOOKS for all objects
> - Prefix all objects with Z##_
> - Create domains and data elements for all business fields
> - Create persistent tables, draft tables, interface CDS, projection CDS, metadata extensions, BDEFs, service definitions, service bindings
> - UI: show Author Name instead of UUID in Book list (text association), fuzzy search on Title/Author/ISBN, filters on Genre/Year/Language, star rating display for Score
> - Follow strict(2) mode with draft support
> - Use explicit field mapping in BDEF (not corresponding)
> - Check each object for syntax errors before group activation
>
> Start with domains and data elements, then proceed step by step. Create one object type at a time and verify before moving to the next.

### Step 5: Iterate

The agent will work through the creation order. At each checkpoint:

1. **Verify** — "List all objects starting with Z##_ and check for inactive ones"
2. **Check** — "Check CDS view Z##_R_BOOK for syntax errors"
3. **Fix** — If errors found, ask the agent to fix and retry
4. **Activate** — "Activate all inactive objects starting with Z##_"

### Step 6: Test the UI

Once the service binding is published:

> Open the service binding preview for Z##_BOOK in ADT and test:
> 1. Create a new Author
> 2. Create a new Book referencing that Author
> 3. Add an Edition to the Book
> 4. Add a Rating to the Book
> 5. Verify Author Name shows in Book list (not UUID)
> 6. Test search and filters

---

## Expected Result

A fully functional Fiori Elements application with:
- ~50 ABAP objects (domains, data elements, tables, CDS views, BDEFs, service)
- Two RAP BOs: Author (standalone) and Book (with Edition + Rating children)
- Draft-enabled CRUD operations
- Professional UI with search, filters, value help, and star ratings
- Proper field labels from data elements

---

## Tips

- **Be patient** — complex RAP BOs require many tool calls. 20+ iterations per entity layer is normal.
- **One layer at a time** — don't ask the agent to create everything at once. Go layer by layer: domains → data elements → tables → CDS → BDEF → service.
- **Provide DDL when needed** — for CDS views and BDEF, the agent may need exact DDL source code to avoid circular dependency issues.
- **Check before activate** — always run syntax check before group activation.
- **Prefix discipline** — use your prefix consistently. On shared systems, never activate objects without prefix filter.
