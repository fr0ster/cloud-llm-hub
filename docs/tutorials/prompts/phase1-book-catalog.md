# Phase 1 Prompts: Book Catalog — Business Requirements

Reference prompts that produced the desired results during testing. Use as examples, adapt to your own application.

## Prompt 1: Initial business description

```
Do NOT create any SAP objects yet. We are in the requirements gathering phase.

I want to create an application for managing a book catalog. It should store information about book authors, their literary works, published editions of each book, and reader ratings. Users should be able to browse books, search by title or author, filter by genre and year, and see average ratings. When viewing a book, they should see all its editions and reviews.

Please formalize this into a structured business requirements document. List all entities, their attributes, relationships, and use cases. Do not include any technical details like ABAP types or table names — only business terms.
```

**Key elements:**
- Explicit "Do NOT create" — prevents AI from jumping to implementation
- "Requirements gathering phase" — sets context
- "No technical details" — keeps it business-level

## Prompt 2: Simplify for MVP

```
Good structure, but let's simplify for MVP. Remove these sections entirely: Security, Future Enhancements, Reporting Analytics, Responsive Design, Success Metrics, Assumptions. We'll add them later if needed.

Simplify the entities:
- Author: remove Photograph, Website URL, Date of Death. Keep: Name, Country, BirthYear, Biography (short text).
- Book: remove Cover Image, Status, Subgenre, Synopsis, Number of Pages from the work level. Keep: Title, Genre, PublicationYear, Language. Add ISBN here, not on edition.
- Edition: remove Cover Image, Availability Status, Price, Currency, ISBN (it's on Book now). Keep: EditionNumber, Publisher, PublicationDate, Format, PageCount.
- Rating: remove Review Title, Reviewer Email, Verification Status, Helpfulness Count, Status. Keep: Score (1-5), ReviewText, ReviewerName, ReviewDate.

Also: Rating should be on the Book level, not on Edition — readers rate the literary work, not a specific edition.

Please regenerate the simplified business requirements.
```

**Key elements:**
- Specific what to remove and what to keep
- Corrects relationship (Rating → Book, not Edition)
- Asks to regenerate, not patch

## Prompt 3: Final approval with additions

```
The business requirements look complete and well structured. Two small additions:

1. Add CRUD use cases — users should be able to create, edit, and delete Authors, Books, Editions, and Ratings (not just browse).
2. In the Book list display, the Author Name should be shown directly (not just a reference) — this is important for usability.

With these additions, the business requirements are finalized. Please regenerate the final version as a clean markdown document ready for the next phase.
```

**Key elements:**
- Positive feedback first ("well structured")
- Small, specific additions
- Explicit "finalized" signal
- Asks for clean regeneration

## Results

3 iterations to complete Phase 1:
- ~5K tokens per iteration
- ~15K total tokens
- Clean, structured business requirements with 4 entities, relationships, CRUD use cases, business rules
