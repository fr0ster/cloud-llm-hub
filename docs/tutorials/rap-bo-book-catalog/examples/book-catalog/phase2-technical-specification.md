# Technical Specification Document
## Book Catalog Application - SAP RAP Implementation

---

## 1. Technical Architecture Overview

**Technology Stack:**
- SAP RAP (ABAP RESTful Application Programming Model)
- Managed Business Objects with Draft Support
- Fiori Elements UI (List Report & Object Page)
- OData V4 Protocol
- strict ( 2 ) mode for all BDEFs

**Naming Convention:**
- Prefix: `Z##_` (where ## = your initials/number)
- Package: `TEST_##_BOOK`

**Business Object Structure:**
- **Author BO** (Independent root entity)
- **Book BO** (Root entity with children)
  - Edition (Child via composition)
  - Rating (Child via composition)

---

## 2. Development Objects Inventory

### 2.1 Foundation Layer

| Object Type | Object Name | Description |
|------------|-------------|-------------|
| Package | TEST_##_BOOK | Main development package |
| Domain | Z##_AUTHOR_NAME | Author name (60 chars) |
| Domain | Z##_COUNTRY | Country code (3 chars) |
| Domain | Z##_BIRTH_YEAR | Birth year (4 digits) |
| Domain | Z##_BIOGRAPHY | Biography text (1000 chars) |
| Domain | Z##_BOOK_TITLE | Book title (120 chars) |
| Domain | Z##_GENRE | Genre (30 chars) |
| Domain | Z##_PUB_YEAR | Publication year (4 digits) |
| Domain | Z##_LANGUAGE | Language code (2 chars) |
| Domain | Z##_ISBN | ISBN (20 chars) |
| Domain | Z##_EDITION_NUM | Edition number (3 digits) |
| Domain | Z##_PUBLISHER | Publisher name (80 chars) |
| Domain | Z##_FORMAT | Format type (20 chars) |
| Domain | Z##_PAGE_COUNT | Page count (5 digits) |
| Domain | Z##_RATING_SCORE | Rating score (1-5) |
| Domain | Z##_REVIEW_TEXT | Review text (2000 chars) |
| Domain | Z##_REVIEWER_NAME | Reviewer name (60 chars) |
| Data Element | Z##_AUTHOR_NAME | Author name |
| Data Element | Z##_COUNTRY | Country |
| Data Element | Z##_BIRTH_YEAR | Birth year |
| Data Element | Z##_BIOGRAPHY | Biography |
| Data Element | Z##_BOOK_TITLE | Book title |
| Data Element | Z##_GENRE | Genre |
| Data Element | Z##_PUB_YEAR | Publication year |
| Data Element | Z##_LANGUAGE | Language |
| Data Element | Z##_ISBN | ISBN |
| Data Element | Z##_EDITION_NUM | Edition number |
| Data Element | Z##_PUBLISHER | Publisher |
| Data Element | Z##_FORMAT | Format |
| Data Element | Z##_PAGE_COUNT | Page count |
| Data Element | Z##_RATING_SCORE | Rating score |
| Data Element | Z##_REVIEW_TEXT | Review text |
| Data Element | Z##_REVIEWER_NAME | Reviewer name |

### 2.2 Data Model Layer

| Object Type | Object Name | Description |
|------------|-------------|-------------|
| Table | Z##_AUTHOR | Author persistent table |
| Table | Z##_AUTHOR_D | Author draft table |
| Table | Z##_BOOK | Book persistent table |
| Table | Z##_BOOK_D | Book draft table |
| Table | Z##_EDITION | Edition persistent table |
| Table | Z##_EDITION_D | Edition draft table |
| Table | Z##_RATING | Rating persistent table |
| Table | Z##_RATING_D | Rating draft table |

### 2.3 CDS View Layer

| Object Type | Object Name | Description |
|------------|-------------|-------------|
| Interface View | Z##_I_Author | Author interface view |
| Interface View | Z##_I_Book | Book interface view (root) |
| Interface View | Z##_I_Edition | Edition interface view (child) |
| Interface View | Z##_I_Rating | Rating interface view (child) |
| Projection View | Z##_C_Author | Author projection view |
| Projection View | Z##_C_Book | Book projection view |
| Projection View | Z##_C_Edition | Edition projection view |
| Projection View | Z##_C_Rating | Rating projection view |

### 2.4 Behavior Definition Layer

| Object Type | Object Name | Description |
|------------|-------------|-------------|
| Interface BDEF | Z##_I_Author | Author behavior definition |
| Interface BDEF | Z##_I_Book | Book behavior definition |
| Behavior Implementation | Z##_BP_I_AUTHOR | Author behavior implementation |
| Behavior Implementation | Z##_BP_I_BOOK | Book behavior implementation |
| Projection BDEF | Z##_C_Author | Author projection behavior |
| Projection BDEF | Z##_C_Book | Book projection behavior |

### 2.5 Service Layer

| Object Type | Object Name | Description |
|------------|-------------|-------------|
| Service Definition | Z##_UI_BOOK_CATALOG | Service definition |
| Service Binding | Z##_UI_BOOK_CATALOG_O4 | OData V4 UI service binding |

### 2.6 UI Layer

| Object Type | Object Name | Description |
|------------|-------------|-------------|
| Metadata Extension | Z##_C_Author | Author UI annotations |
| Metadata Extension | Z##_C_Book | Book UI annotations |
| Metadata Extension | Z##_C_Edition | Edition UI annotations |
| Metadata Extension | Z##_C_Rating | Rating UI annotations |

---

## 3. Detailed Object Specifications

---

## 3.1 DOMAINS

### Domain: Z##_AUTHOR_NAME
```abap
Domain Name: Z##_AUTHOR_NAME
Description: Author Name
Data Type: CHAR
Length: 60
Lowercase: Yes
```

### Domain: Z##_COUNTRY
```abap
Domain Name: Z##_COUNTRY
Description: Country Code
Data Type: CHAR
Length: 3
Lowercase: No
```

### Domain: Z##_BIRTH_YEAR
```abap
Domain Name: Z##_BIRTH_YEAR
Description: Birth Year
Data Type: NUMC
Length: 4
```

### Domain: Z##_BIOGRAPHY
```abap
Domain Name: Z##_BIOGRAPHY
Description: Biography
Data Type: CHAR
Length: 1000
Lowercase: Yes
```

### Domain: Z##_BOOK_TITLE
```abap
Domain Name: Z##_BOOK_TITLE
Description: Book Title
Data Type: CHAR
Length: 120
Lowercase: Yes
```

### Domain: Z##_GENRE
```abap
Domain Name: Z##_GENRE
Description: Book Genre
Data Type: CHAR
Length: 30
Fixed Values:
- FICTION: Fiction
- NONFICTION: Non-Fiction
- SCIFI: Science Fiction
- FANTASY: Fantasy
- MYSTERY: Mystery
- THRILLER: Thriller
- ROMANCE: Romance
- BIOGRAPHY: Biography
- HISTORY: History
- SCIENCE: Science
- TECHNOLOGY: Technology
- BUSINESS: Business
- SELFHELP: Self-Help
- OTHER: Other
```

### Domain: Z##_PUB_YEAR
```abap
Domain Name: Z##_PUB_YEAR
Description: Publication Year
Data Type: NUMC
Length: 4
```

### Domain: Z##_LANGUAGE
```abap
Domain Name: Z##_LANGUAGE
Description: Language Code
Data Type: CHAR
Length: 2
Fixed Values:
- EN: English
- DE: German
- FR: French
- ES: Spanish
- IT: Italian
- PT: Portuguese
- NL: Dutch
- PL: Polish
- RU: Russian
- ZH: Chinese
- JA: Japanese
- KO: Korean
```

### Domain: Z##_ISBN
```abap
Domain Name: Z##_ISBN
Description: ISBN Number
Data Type: CHAR
Length: 20
Lowercase: No
```

### Domain: Z##_EDITION_NUM
```abap
Domain Name: Z##_EDITION_NUM
Description: Edition Number
Data Type: NUMC
Length: 3
```

### Domain: Z##_PUBLISHER
```abap
Domain Name: Z##_PUBLISHER
Description: Publisher Name
Data Type: CHAR
Length: 80
Lowercase: Yes
```

### Domain: Z##_FORMAT
```abap
Domain Name: Z##_FORMAT
Description: Edition Format
Data Type: CHAR
Length: 20
Fixed Values:
- HARDCOVER: Hardcover
- PAPERBACK: Paperback
- EBOOK: E-Book
- AUDIOBOOK: Audiobook
```

### Domain: Z##_PAGE_COUNT
```abap
Domain Name: Z##_PAGE_COUNT
Description: Page Count
Data Type: INT4
```

### Domain: Z##_RATING_SCORE
```abap
Domain Name: Z##_RATING_SCORE
Description: Rating Score (1-5)
Data Type: INT1
Fixed Values:
- 1: 1 Star
- 2: 2 Stars
- 3: 3 Stars
- 4: 4 Stars
- 5: 5 Stars
```

### Domain: Z##_REVIEW_TEXT
```abap
Domain Name: Z##_REVIEW_TEXT
Description: Review Text
Data Type: CHAR
Length: 2000
Lowercase: Yes
```

### Domain: Z##_REVIEWER_NAME
```abap
Domain Name: Z##_REVIEWER_NAME
Description: Reviewer Name
Data Type: CHAR
Length: 60
Lowercase: Yes
```

---

## 3.2 DATA ELEMENTS

### Data Element: Z##_AUTHOR_NAME
```abap
Data Element: Z##_AUTHOR_NAME
Description: Author Name
Domain: Z##_AUTHOR_NAME
Field Label:
  - Short: Author
  - Medium: Author Name
  - Long: Author Name
  - Heading: Author Name
```

### Data Element: Z##_COUNTRY
```abap
Data Element: Z##_COUNTRY
Description: Country
Domain: Z##_COUNTRY
Field Label:
  - Short: Country
  - Medium: Country
  - Long: Country
  - Heading: Country
```

### Data Element: Z##_BIRTH_YEAR
```abap
Data Element: Z##_BIRTH_YEAR
Description: Birth Year
Domain: Z##_BIRTH_YEAR
Field Label:
  - Short: Birth Yr
  - Medium: Birth Year
  - Long: Birth Year
  - Heading: Birth Year
```

### Data Element: Z##_BIOGRAPHY
```abap
Data Element: Z##_BIOGRAPHY
Description: Biography
Domain: Z##_BIOGRAPHY
Field Label:
  - Short: Biography
  - Medium: Biography
  - Long: Biography
  - Heading: Biography
```

### Data Element: Z##_BOOK_TITLE
```abap
Data Element: Z##_BOOK_TITLE
Description: Book Title
Domain: Z##_BOOK_TITLE
Field Label:
  - Short: Title
  - Medium: Book Title
  - Long: Book Title
  - Heading: Book Title
```

### Data Element: Z##_GENRE
```abap
Data Element: Z##_GENRE
Description: Genre
Domain: Z##_GENRE
Field Label:
  - Short: Genre
  - Medium: Genre
  - Long: Book Genre
  - Heading: Genre
```

### Data Element: Z##_PUB_YEAR
```abap
Data Element: Z##_PUB_YEAR
Description: Publication Year
Domain: Z##_PUB_YEAR
Field Label:
  - Short: Pub Year
  - Medium: Pub. Year
  - Long: Publication Year
  - Heading: Publication Year
```

### Data Element: Z##_LANGUAGE
```abap
Data Element: Z##_LANGUAGE
Description: Language
Domain: Z##_LANGUAGE
Field Label:
  - Short: Language
  - Medium: Language
  - Long: Language
  - Heading: Language
```

### Data Element: Z##_ISBN
```abap
Data Element: Z##_ISBN
Description: ISBN
Domain: Z##_ISBN
Field Label:
  - Short: ISBN
  - Medium: ISBN
  - Long: ISBN Number
  - Heading: ISBN
```

### Data Element: Z##_EDITION_NUM
```abap
Data Element: Z##_EDITION_NUM
Description: Edition Number
Domain: Z##_EDITION_NUM
Field Label:
  - Short: Edition
  - Medium: Edition No.
  - Long: Edition Number
  - Heading: Edition
```

### Data Element: Z##_PUBLISHER
```abap
Data Element: Z##_PUBLISHER
Description: Publisher
Domain: Z##_PUBLISHER
Field Label:
  - Short: Publisher
  - Medium: Publisher
  - Long: Publisher Name
  - Heading: Publisher
```

### Data Element: Z##_FORMAT
```abap
Data Element: Z##_FORMAT
Description: Format
Domain: Z##_FORMAT
Field Label:
  - Short: Format
  - Medium: Format
  - Long: Edition Format
  - Heading: Format
```

### Data Element: Z##_PAGE_COUNT
```abap
Data Element: Z##_PAGE_COUNT
Description: Page Count
Domain: Z##_PAGE_COUNT
Field Label:
  - Short: Pages
  - Medium: Page Count
  - Long: Page Count
  - Heading: Pages
```

### Data Element: Z##_RATING_SCORE
```abap
Data Element: Z##_RATING_SCORE
Description: Rating Score
Domain: Z##_RATING_SCORE
Field Label:
  - Short: Score
  - Medium: Rating
  - Long: Rating Score
  - Heading: Rating
```

### Data Element: Z##_REVIEW_TEXT
```abap
Data Element: Z##_REVIEW_TEXT
Description: Review Text
Domain: Z##_REVIEW_TEXT
Field Label:
  - Short: Review
  - Medium: Review Text
  - Long: Review Text
  - Heading: Review
```

### Data Element: Z##_REVIEWER_NAME
```abap
Data Element: Z##_REVIEWER_NAME
Description: Reviewer Name
Domain: Z##_REVIEWER_NAME
Field Label:
  - Short: Reviewer
  - Medium: Reviewer
  - Long: Reviewer Name
  - Heading: Reviewer
```

---

## 3.3 DATABASE TABLES

### Table: Z##_AUTHOR (Author Persistent Table)

```abap
@EndUserText.label : 'Author'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table z##_author {
  key client      : abap.clnt not null;
  key author_uuid : sysuuid_x16 not null;
  author_id       : abap.numc(10);
  name            : z##_author_name not null;
  country         : z##_country;
  birth_year      : z##_birth_year;
  biography       : z##_biography;
  created_by      : abp_creation_user;
  created_at      : abp_creation_tstmpl;
  last_changed_by : abp_locinst_lastchange_user;
  last_changed_at : abp_locinst_lastchange_tstmpl;
  local_last_changed_at : abp_lastchange_tstmpl;
}
```

**Technical Notes:**
- `author_uuid`: Primary key (UUID)
- `author_id`: Human-readable ID (auto-generated via early numbering)
- `name`: Mandatory field
- Includes standard RAP administrative fields

---

### Table: Z##_AUTHOR_D (Author Draft Table)

```abap
@EndUserText.label : 'Author Draft'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table z##_author_d {
  key client      : abap.clnt not null;
  key author_uuid : sysuuid_x16 not null;
  author_id       : abap.numc(10);
  name            : z##_author_name;
  country         : z##_country;
  birth_year      : z##_birth_year;
  biography       : z##_biography;
  created_by      : abp_creation_user;
  created_at      : abp_creation_tstmpl;
  last_changed_by : abp_locinst_lastchange_user;
  last_changed_at : abp_locinst_lastchange_tstmpl;
  local_last_changed_at : abp_lastchange_tstmpl;
  "%admin"        : include sych_bdl_draft_admin_inc;
}
```

**Technical Notes:**
- Keys must match persistent table exactly
- Includes `%admin` structure for draft administrative data
- `name` is NOT NULL in persistent table but nullable in draft

---

### Table: Z##_BOOK (Book Persistent Table)

```abap
@EndUserText.label : 'Book'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table z##_book {
  key client         : abap.clnt not null;
  key book_uuid      : sysuuid_x16 not null;
  book_id            : abap.numc(10);
  author_uuid        : sysuuid_x16 not null;
  title              : z##_book_title not null;
  genre              : z##_genre;
  publication_year   : z##_pub_year;
  language           : z##_language;
  isbn               : z##_isbn;
  created_by         : abp_creation_user;
  created_at         : abp_creation_tstmpl;
  last_changed_by    : abp_locinst_lastchange_user;
  last_changed_at    : abp_locinst_lastchange_tstmpl;
  local_last_changed_at : abp_lastchange_tstmpl;
}
```

**Technical Notes:**
- `book_uuid`: Primary key (UUID)
- `book_id`: Human-readable ID (auto-generated via early numbering)
- `author_uuid`: Foreign key to Author (association, not composition)
- `title`: Mandatory field

---

### Table: Z##_BOOK_D (Book Draft Table)

```abap
@EndUserText.label : 'Book Draft'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table z##_book_d {
  key client         : abap.clnt not null;
  key book_uuid      : sysuuid_x16 not null;
  book_id            : abap.numc(10);
  author_uuid        : sysuuid_x16;
  title              : z##_book_title;
  genre              : z##_genre;
  publication_year   : z##_pub_year;
  language           : z##_language;
  isbn               : z##_isbn;
  created_by         : abp_creation_user;
  created_at         : abp_creation_tstmpl;
  last_changed_by    : abp_locinst_lastchange_user;
  last_changed_at    : abp_locinst_lastchange_tstmpl;
  local_last_changed_at : abp_lastchange_tstmpl;
  "%admin"           : include sych_bdl_draft_admin_inc;
}
```

---

### Table: Z##_EDITION (Edition Persistent Table)

```abap
@EndUserText.label : 'Edition'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table z##_edition {
  key client           : abap.clnt not null;
  key edition_uuid     : sysuuid_x16 not null;
  book_uuid            : sysuuid_x16 not null;
  edition_number       : z##_edition_num;
  publisher            : z##_publisher;
  publication_date     : abap.dats;
  format               : z##_format;
  page_count           : z##_page_count;
  created_by           : abp_creation_user;
  created_at           : abp_creation_tstmpl;
  last_changed_by      : abp_locinst_lastchange_user;
  last_changed_at      : abp_locinst_lastchange_tstmpl;
  local_last_changed_at : abp_lastchange_tstmpl;
}
```

**Technical Notes:**
- `edition_uuid`: Primary key (UUID)
- `book_uuid`: Foreign key to Book (parent via composition)
- Child entity of Book

---

### Table: Z##_EDITION_D (Edition Draft Table)

```abap
@EndUserText.label : 'Edition Draft'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table z##_edition_d {
  key client           : abap.clnt not null;
  key edition_uuid     : sysuuid_x16 not null;
  book_uuid            : sysuuid_x16;
  edition_number       : z##_edition_num;
  publisher            : z##_publisher;
  publication_date     : abap.dats;
  format               : z##_format;
  page_count           : z##_page_count;
  created_by           : abp_creation_user;
  created_at           : abp_creation_tstmpl;
  last_changed_by      : abp_locinst_lastchange_user;
  last_changed_at      : abp_locinst_lastchange_tstmpl;
  local_last_changed_at : abp_lastchange_tstmpl;
  "%admin"             : include sych_bdl_draft_admin_inc;
}
```

---

### Table: Z##_RATING (Rating Persistent Table)

```abap
@EndUserText.label : 'Rating'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table z##_rating {
  key client           : abap.clnt not null;
  key rating_uuid      : sysuuid_x16 not null;
  book_uuid            : sysuuid_x16 not null;
  score                : z##_rating_score not null;
  review_text          : z##_review_text;
  reviewer_name        : z##_reviewer_name not null;
  review_date          : abap.dats;
  created_by           : abp_creation_user;
  created_at           : abp_creation_tstmpl;
  last_changed_by      : abp_locinst_lastchange_user;
  last_changed_at      : abp_locinst_lastchange_tstmpl;
  local_last_changed_at : abp_lastchange_tstmpl;
}
```

**Technical Notes:**
- `rating_uuid`: Primary key (UUID)
- `book_uuid`: Foreign key to Book (parent via composition)
- `score` and `reviewer_name`: Mandatory fields
- Child entity of Book

---

### Table: Z##_RATING_D (Rating Draft Table)

```abap
@EndUserText.label : 'Rating Draft'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
@AbapCatalog.tableCategory : #TRANSPARENT
@AbapCatalog.deliveryClass : #A
@AbapCatalog.dataMaintenance : #RESTRICTED
define table z##_rating_d {
  key client           : abap.clnt not null;
  key rating_uuid      : sysuuid_x16 not null;
  book_uuid            : sysuuid_x16;
  score                : z##_rating_score;
  review_text          : z##_review_text;
  reviewer_name        : z##_reviewer_name;
  review_date          : abap.dats;
  created_by           : abp_creation_user;
  created_at           : abp_creation_tstmpl;
  last_changed_by      : abp_locinst_lastchange_user;
  last_changed_at      : abp_locinst_lastchange_tstmpl;
  local_last_changed_at : abp_lastchange_tstmpl;
  "%admin"             : include sych_bdl_draft_admin_inc;
}
```

---

## 3.4 CDS INTERFACE VIEWS

### CDS View: Z##_I_Author

```abap
@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Author'
define root view entity Z##_I_Author
  as select from z##_author as Author
{
  key author_uuid           as AuthorUuid,
      author_id             as AuthorId,
      @Semantics.text: true
      name                  as Name,
      country               as Country,
      birth_year            as BirthYear,
      biography             as Biography,
      
      @Semantics.user.createdBy: true
      created_by            as CreatedBy,
      @Semantics.systemDateTime.createdAt: true
      created_at            as CreatedAt,
      @Semantics.user.lastChangedBy: true
      last_changed_by       as LastChangedBy,
      @Semantics.systemDateTime.lastChangedAt: true
      last_changed_at       as LastChangedAt,
      @Semantics.systemDateTime.localInstanceLastChangedAt: true
      local_last_changed_at as LocalLastChangedAt,
      
      // Associations
      _Book
}
```

**Technical Notes:**
- Root view for Author BO
- `@Semantics.text: true` on Name for text association
- Association `_Book` for navigation to books by this author

---

### CDS View: Z##_I_Book

```abap
@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Book'
define root view entity Z##_I_Book
  as select from z##_book as Book
  association [0..1] to Z##_I_Author as _Author 
    on $projection.AuthorUuid = _Author.AuthorUuid
  composition [0..*] of Z##_I_Edition as _Edition
  composition [0..*] of Z##_I_Rating as _Rating
{
  key book_uuid             as BookUuid,
      book_id               as BookId,
      author_uuid           as AuthorUuid,
      @Semantics.text: true
      title                 as Title,
      genre                 as Genre,
      publication_year      as PublicationYear,
      language              as Language,
      isbn                  as Isbn,
      
      @Semantics.user.createdBy: true
      created_by            as CreatedBy,
      @Semantics.systemDateTime.createdAt: true
      created_at            as CreatedAt,
      @Semantics.user.lastChangedBy: true
      last_changed_by       as LastChangedBy,
      @Semantics.systemDateTime.lastChangedAt: true
      last_changed_at       as LastChangedAt,
      @Semantics.systemDateTime.localInstanceLastChangedAt: true
      local_last_changed_at as LocalLastChangedAt,
      
      // Associations
      _Author,
      _Edition,
      _Rating
}
```

**Technical Notes:**
- Root view for Book BO
- Association to Author (not composition - separate BO)
- Compositions to Edition and Rating (child entities)
- Text association via `_Author.Name` for displaying author name in book list

---

### CDS View: Z##_I_Edition

```abap
@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Edition'
define view entity Z##_I_Edition
  as select from z##_edition as Edition
  association to parent Z##_I_Book as _Book
    on $projection.BookUuid = _Book.BookUuid
{
  key edition_uuid          as EditionUuid,
      book_uuid             as BookUuid,
      edition_number        as EditionNumber,
      publisher             as Publisher,
      publication_date      as PublicationDate,
      format                as Format,
      page_count            as PageCount,
      
      @Semantics.user.createdBy: true
      created_by            as CreatedBy,
      @Semantics.systemDateTime.createdAt: true
      created_at            as CreatedAt,
      @Semantics.user.lastChangedBy: true
      last_changed_by       as LastChangedBy,
      @Semantics.systemDateTime.lastChangedAt: true
      last_changed_at       as LastChangedAt,
      @Semantics.systemDateTime.localInstanceLastChangedAt: true
      local_last_changed_at as LocalLastChangedAt,
      
      // Association to parent
      _Book
}
```

**Technical Notes:**
- Child view (not root)
- Association to parent Book entity
- `book_uuid` is the foreign key to parent

---

### CDS View: Z##_I_Rating

```abap
@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Rating'
define view entity Z##_I_Rating
  as select from z##_rating as Rating
  association to parent Z##_I_Book as _Book
    on $projection.BookUuid = _Book.BookUuid
{
  key rating_uuid           as RatingUuid,
      book_uuid             as BookUuid,
      score                 as Score,
      review_text           as ReviewText,
      reviewer_name         as ReviewerName,
      review_date           as ReviewDate,
      
      @Semantics.user.createdBy: true
      created_by            as CreatedBy,
      @Semantics.systemDateTime.createdAt: true
      created_at            as CreatedAt,
      @Semantics.user.lastChangedBy: true
      last_changed_by       as LastChangedBy,
      @Semantics.systemDateTime.lastChangedAt: true
      last_changed_at       as LastChangedAt,
      @Semantics.systemDateTime.localInstanceLastChangedAt: true
      local_last_changed_at as LocalLastChangedAt,
      
      // Association to parent
      _Book
}
```

**Technical Notes:**
- Child view (not root)
- Association to parent Book entity
- `book_uuid` is the foreign key to parent

---

## 3.5 CDS PROJECTION VIEWS

### CDS View: Z##_C_Author

```abap
@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Author Projection'
@Metadata.allowExtensions: true
@Search.searchable: true
define root view entity Z##_C_Author
  provider contract transactional_query
  as projection on Z##_I_Author
{
  key AuthorUuid,
      @Search.defaultSearchElement: true
      @Search.fuzzinessThreshold: 0.8
      AuthorId,
      @Search.defaultSearchElement: true
      @Search.fuzzinessThreshold: 0.7
      Name,
      Country,
      BirthYear,
      Biography,
      CreatedBy,
      CreatedAt,
      LastChangedBy,
      LastChangedAt,
      LocalLastChangedAt,
      
      // Associations
      _Book : redirected to Z##_C_Book
}
```

**Technical Notes:**
- Projection view for consumption layer
- `@Metadata.allowExtensions: true` enables metadata extensions
- Search enabled on Name and AuthorId
- Association redirected to projection view

---

### CDS View: Z##_C_Book

```abap
@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Book Projection'
@Metadata.allowExtensions: true
@Search.searchable: true
define root view entity Z##_C_Book
  provider contract transactional_query
  as projection on Z##_I_Book
{
  key BookUuid,
      @Search.defaultSearchElement: true
      @Search.fuzzinessThreshold: 0.8
      BookId,
      AuthorUuid,
      @Search.defaultSearchElement: true
      @Search.fuzzinessThreshold: 0.7
      Title,
      Genre,
      PublicationYear,
      Language,
      @Search.defaultSearchElement: true
      Isbn,
      CreatedBy,
      CreatedAt,
      LastChangedBy,
      LastChangedAt,
      LocalLastChangedAt,
      
      // Virtual field for average rating (calculated in behavior implementation)
      @EndUserText.label: 'Average Rating'
      cast( 0.0 as abap.fltp ) as AverageRating,
      
      // Associations
      _Author : redirected to Z##_C_Author,
      _Edition : redirected to composition child Z##_C_Edition,
      _Rating : redirected to composition child Z##_C_Rating
}
```

**Technical Notes:**
- Projection view for consumption layer
- Search enabled on Title, BookId, and ISBN
- Virtual field `AverageRating` to be calculated via transient field
- Associations redirected to projection views

---

### CDS View: Z##_C_Edition

```abap
@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Edition Projection'
@Metadata.allowExtensions: true
define view entity Z##_C_Edition
  as projection on Z##_I_Edition
{
  key EditionUuid,
      BookUuid,
      EditionNumber,
      Publisher,
      PublicationDate,
      Format,
      PageCount,
      CreatedBy,
      CreatedAt,
      LastChangedBy,
      LastChangedAt,
      LocalLastChangedAt,
      
      // Association to parent
      _Book : redirected to parent Z##_C_Book
}
```

---

### CDS View: Z##_C_Rating

```abap
@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'Rating Projection'
@Metadata.allowExtensions: true
define view entity Z##_C_Rating
  as projection on Z##_I_Rating
{
  key RatingUuid,
      BookUuid,
      Score,
      ReviewText,
      ReviewerName,
      ReviewDate,
      CreatedBy,
      CreatedAt,
      LastChangedBy,
      LastChangedAt,
      LocalLastChangedAt,
      
      // Association to parent
      _Book : redirected to parent Z##_C_Book
}
```

---

## 3.6 BEHAVIOR DEFINITIONS

### Interface BDEF: Z##_I_Author

```abap
managed implementation in class z##_bp_i_author unique;
strict ( 2 );
with draft;

define behavior for Z##_I_Author alias Author
persistent table z##_author
draft table z##_author_d
etag master LocalLastChangedAt
lock master total etag LastChangedAt
authorization master ( instance )
{
  field ( readonly )
    AuthorUuid,
    CreatedBy,
    CreatedAt,
    LastChangedBy,
    LastChangedAt,
    LocalLastChangedAt;

  field ( numbering : managed, readonly ) AuthorId;

  field ( mandatory ) Name;

  create;
  update;
  delete;

  draft action Edit;
  draft action Activate optimized;
  draft action Discard;
  draft action Resume;
  draft determine action Prepare;

  mapping for z##_author
  {
    AuthorUuid = author_uuid;
    AuthorId = author_id;
    Name = name;
    Country = country;
    BirthYear = birth_year;
    Biography = biography;
    CreatedBy = created_by;
    CreatedAt = created_at;
    LastChangedBy = last_changed_by;
    LastChangedAt = last_changed_at;
    LocalLastChangedAt = local_last_changed_at;
  }
}
```

**Technical Notes:**
- Managed implementation with draft support
- `strict ( 2 )` mode enforced
- `authorization master ( instance )` - instance-based authorization
- Early numbering for `AuthorId` via `numbering : managed`
- All 5 draft actions explicitly defined
- Explicit field mapping (not `corresponding`)
- Draft table keys match persistent table keys

---

### Interface BDEF: Z##_I_Book

```abap
managed implementation in class z##_bp_i_book unique;
strict ( 2 );
with draft;

define behavior for Z##_I_Book alias Book
persistent table z##_book
draft table z##_book_d
etag master LocalLastChangedAt
lock master total etag LastChangedAt
authorization master ( instance )
{
  field ( readonly )
    BookUuid,
    CreatedBy,
    CreatedAt,
    LastChangedBy,
    LastChangedAt,
    LocalLastChangedAt;

  field ( numbering : managed, readonly ) BookId;

  field ( mandatory ) AuthorUuid, Title;

  create;
  update;
  delete;

  draft action Edit;
  draft action Activate optimized;
  draft action Discard;
  draft action Resume;
  draft determine action Prepare;

  association _Author { create; with draft; }
  association _Edition { create; with draft; }
  association _Rating { create; with draft; }

  mapping for z##_book
  {
    BookUuid = book_uuid;
    BookId = book_id;
    AuthorUuid = author_uuid;
    Title = title;
    Genre = genre;
    PublicationYear = publication_year;
    Language = language;
    Isbn = isbn;
    CreatedBy = created_by;
    CreatedAt = created_at;
    LastChangedBy = last_changed_by;
    LastChangedAt = last_changed_at;
    LocalLastChangedAt = local_last_changed_at;
  }
}

define behavior for Z##_I_Edition alias Edition
persistent table z##_edition
draft table z##_edition_d
etag master LocalLastChangedAt
lock dependent by _Book
authorization dependent by _Book
{
  field ( readonly )
    EditionUuid,
    BookUuid,
    CreatedBy,
    CreatedAt,
    LastChangedBy,
    LastChangedAt,
    LocalLastChangedAt;

  update;
  delete;

  association _Book { with draft; }

  mapping for z##_edition
  {
    EditionUuid = edition_uuid;
    BookUuid = book_uuid;
    EditionNumber = edition_number;
    Publisher = publisher;
    PublicationDate = publication_date;
    Format = format;
    PageCount = page_count;
    CreatedBy = created_by;
    CreatedAt = created_at;
    LastChangedBy = last_changed_by;
    LastChangedAt = last_changed_at;
    LocalLastChangedAt = local_last_changed_at;
  }
}

define behavior for Z##_I_Rating alias Rating
persistent table z##_rating
draft table z##_rating_d
etag master LocalLastChangedAt
lock dependent by _Book
authorization dependent by _Book
{
  field ( readonly )
    RatingUuid,
    BookUuid,
    CreatedBy,
    CreatedAt,
    LastChangedBy,
    LastChangedAt,
    LocalLastChangedAt;

  field ( mandatory ) Score, ReviewerName;

  update;
  delete;

  association _Book { with draft; }

  mapping for z##_rating
  {
    RatingUuid = rating_uuid;
    BookUuid = book_uuid;
    Score = score;
    ReviewText = review_text;
    ReviewerName = reviewer_name;
    ReviewDate = review_date;
    CreatedBy = created_by;
    CreatedAt = created_at;
    LastChangedBy = last_changed_by;
    LastChangedAt = last_changed_at;
    LocalLastChangedAt = local_last_changed_at;
  }
}
```

**Technical Notes:**
- Book is root entity with Edition and Rating as children
- `authorization master ( instance )` on root
- `authorization dependent by _Book` on children
- Children have `lock dependent by _Book`
- All 5 draft actions on root entity only
- Explicit field mapping for all entities
- Draft table keys match persistent table keys

---

### Projection BDEF: Z##_C_Author

```abap
projection;
strict ( 2 );
use draft;

define behavior for Z##_C_Author alias Author
{
  use create;
  use update;
  use delete;

  use action Edit;
  use action Activate;
  use action Discard;
  use action Resume;
  use action Prepare;

  use association _Book { create; with draft; }
}
```

---

### Projection BDEF: Z##_C_Book

```abap
projection;
strict ( 2 );
use draft;

define behavior for Z##_C_Book alias Book
{
  use create;
  use update;
  use delete;

  use action Edit;
  use action Activate;
  use action Discard;
  use action Resume;
  use action Prepare;

  use association _Author { create; with draft; }
  use association _Edition { create; with draft; }
  use association _Rating { create; with draft; }
}

define behavior for Z##_C_Edition alias Edition
{
  use update;
  use delete;

  use association _Book { with draft; }
}

define behavior for Z##_C_Rating alias Rating
{
  use update;
  use delete;

  use association _Book { with draft; }
}
```

**Technical Notes:**
- Projection BDEFs expose interface BDEF capabilities
- All 5 draft actions exposed on root entities
- Child entities expose update and delete only

---

## 3.7 BEHAVIOR IMPLEMENTATION CLASSES

### Class: Z##_BP_I_AUTHOR

```abap
CLASS z##_bp_i_author DEFINITION
  PUBLIC
  ABSTRACT
  FINAL FOR BEHAVIOR OF z##_i_author.
ENDCLASS.

CLASS z##_bp_i_author IMPLEMENTATION.
ENDCLASS.
```

**Local Handler Class:**

```abap
CLASS lhc_author DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.
    METHODS get_instance_authorizations FOR INSTANCE AUTHORIZATION
      IMPORTING keys REQUEST requested_authorizations FOR author RESULT result.
ENDCLASS.

CLASS lhc_author IMPLEMENTATION.

  METHOD get_instance_authorizations.
    " Authorization logic for Author instances
    " Example: Check if user can read/update/delete specific author records
    
    READ ENTITIES OF z##_i_author IN LOCAL MODE
      ENTITY author
      FIELDS ( AuthorUuid Name Country )
      WITH CORRESPONDING #( keys )
      RESULT DATA(authors)
      FAILED failed.

    CHECK authors IS NOT INITIAL.

    LOOP AT authors INTO DATA(author).
      APPEND VALUE #(
        %tky = author-%tky
        %update = if_abap_behv=>auth-allowed
        %delete = if_abap_behv=>auth-allowed
      ) TO result.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
```

**Technical Notes:**
- Global class with local handler class
- `get_instance_authorizations` method implements instance-based authorization
- In production, implement actual authorization checks (e.g., via authority-check)

---

### Class: Z##_BP_I_BOOK

```abap
CLASS z##_bp_i_book DEFINITION
  PUBLIC
  ABSTRACT
  FINAL FOR BEHAVIOR OF z##_i_book.
ENDCLASS.

CLASS z##_bp_i_book IMPLEMENTATION.
ENDCLASS.
```

**Local Handler Class:**

```abap
CLASS lhc_book DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.
    METHODS get_instance_authorizations FOR INSTANCE AUTHORIZATION
      IMPORTING keys REQUEST requested_authorizations FOR book RESULT result.
      
    METHODS calculateAverageRating FOR DETERMINE ON MODIFY
      IMPORTING keys FOR book~calculateAverageRating.
ENDCLASS.

CLASS lhc_book IMPLEMENTATION.

  METHOD get_instance_authorizations.
    " Authorization logic for Book instances
    
    READ ENTITIES OF z##_i_book IN LOCAL MODE
      ENTITY book
      FIELDS ( BookUuid Title AuthorUuid )
      WITH CORRESPONDING #( keys )
      RESULT DATA(books)
      FAILED failed.

    CHECK books IS NOT INITIAL.

    LOOP AT books INTO DATA(book).
      APPEND VALUE #(
        %tky = book-%tky
        %update = if_abap_behv=>auth-allowed
        %delete = if_abap_behv=>auth-allowed
        %action-Edit = if_abap_behv=>auth-allowed
        %action-Activate = if_abap_behv=>auth-allowed
        %action-Discard = if_abap_behv=>auth-allowed
        %action-Resume = if_abap_behv=>auth-allowed
        %action-Prepare = if_abap_behv=>auth-allowed
        %assoc-_Edition = if_abap_behv=>auth-allowed
        %assoc-_Rating = if_abap_behv=>auth-allowed
      ) TO result.
    ENDLOOP.
  ENDMETHOD.

  METHOD calculateAverageRating.
    " Calculate average rating for books
    " This would be implemented as a determination or via virtual field calculation
    
    READ ENTITIES OF z##_i_book IN LOCAL MODE
      ENTITY book BY \_Rating
      FIELDS ( Score )
      WITH CORRESPONDING #( keys )
      RESULT DATA(ratings).

    " Group ratings by book and calculate average
    DATA: avg_ratings TYPE TABLE FOR UPDATE z##_i_book.
    
    LOOP AT keys INTO DATA(key).
      DATA(book_ratings) = FILTER #( ratings WHERE BookUuid = key-BookUuid ).
      IF book_ratings IS NOT INITIAL.
        DATA(total_score) = REDUCE i( INIT sum = 0
                                       FOR rating IN book_ratings
                                       NEXT sum = sum + rating-Score ).
        DATA(count) = lines( book_ratings ).
        DATA(average) = CONV decfloat16( total_score / count ).
        
        " Store average rating (would be stored in a transient field or separate table)
        " For now, this is just a placeholder
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
```

**Technical Notes:**
- Global class with local handler class
- `get_instance_authorizations` implements instance-based authorization for root and children
- `calculateAverageRating` determination can be used to calculate average rating
- In production, implement actual authorization checks

---

## 3.8 SERVICE DEFINITION

### Service Definition: Z##_UI_BOOK_CATALOG

```abap
@EndUserText.label: 'Book Catalog Service'
define service Z##_UI_BOOK_CATALOG {
  expose Z##_C_Author as Author;
  expose Z##_C_Book as Book;
  expose Z##_C_Edition as Edition;
  expose Z##_C_Rating as Rating;
}
```

**Technical Notes:**
- Exposes all projection views
- Service name follows UI service naming convention

---

## 3.9 SERVICE BINDING

### Service Binding: Z##_UI_BOOK_CATALOG_O4

```
Service Binding Name: Z##_UI_BOOK_CATALOG_O4
Description: Book Catalog OData V4 UI Service
Binding Type: OData V4 - UI
Service Definition: Z##_UI_BOOK_CATALOG
```

**Technical Notes:**
- OData V4 protocol
- UI service binding type for Fiori Elements
- After activation, publish service and preview Fiori app

---

## 3.10 METADATA EXTENSIONS

### Metadata Extension: Z##_C_Author

```abap
@Metadata.layer: #CORE
@UI: {
  headerInfo: {
    typeName: 'Author',
    typeNamePlural: 'Authors',
    title: {
      type: #STANDARD,
      value: 'Name'
    }
  },
  presentationVariant: [{
    sortOrder: [{ by: 'Name', direction: #ASC }],
    visualizations: [{type: #AS_LINEITEM}]
  }]
}
annotate view Z##_C_Author with
{
  @UI.facet: [
    {
      id: 'AuthorDetails',
      purpose: #STANDARD,
      type: #IDENTIFICATION_REFERENCE,
      label: 'Author Details',
      position: 10
    },
    {
      id: 'Books',
      purpose: #STANDARD,
      type: #LINEITEM_REFERENCE,
      label: 'Books',
      position: 20,
      targetElement: '_Book'
    }
  ]

  @UI.hidden: true
  AuthorUuid;

  @UI: {
    lineItem: [{ position: 10, importance: #HIGH }],
    identification: [{ position: 10 }],
    selectionField: [{ position: 10 }]
  }
  AuthorId;

  @UI: {
    lineItem: [{ position: 20, importance: #HIGH }],
    identification: [{ position: 20 }],
    selectionField: [{ position: 20 }]
  }
  Name;

  @UI: {
    lineItem: [{ position: 30, importance: #MEDIUM }],
    identification: [{ position: 30 }],
    selectionField: [{ position: 30 }]
  }
  Country;

  @UI: {
    lineItem: [{ position: 40, importance: #MEDIUM }],
    identification: [{ position: 40 }]
  }
  BirthYear;

  @UI: {
    identification: [{ position: 50 }],
    multiLineText: true
  }
  Biography;

  @UI.hidden: true
  CreatedBy;

  @UI.hidden: true
  CreatedAt;

  @UI.hidden: true
  LastChangedBy;

  @UI.hidden: true
  LastChangedAt;

  @UI.hidden: true
  LocalLastChangedAt;
}
```

**Technical Notes:**
- Header displays Author Name
- List displays: AuthorId, Name, Country, BirthYear
- Object page has 2 facets: Author Details, Books (association)
- Biography shown as multi-line text

---

### Metadata Extension: Z##_C_Book

```abap
@Metadata.layer: #CORE
@UI: {
  headerInfo: {
    typeName: 'Book',
    typeNamePlural: 'Books',
    title: {
      type: #STANDARD,
      value: 'Title'
    },
    description: {
      value: '_Author.Name'
    }
  },
  presentationVariant: [{
    sortOrder: [{ by: 'Title', direction: #ASC }],
    visualizations: [{type: #AS_LINEITEM}]
  }]
}
annotate view Z##_C_Book with
{
  @UI.facet: [
    {
      id: 'BookDetails',
      purpose: #STANDARD,
      type: #IDENTIFICATION_REFERENCE,
      label: 'Book Details',
      position: 10
    },
    {
      id: 'Editions',
      purpose: #STANDARD,
      type: #LINEITEM_REFERENCE,
      label: 'Editions',
      position: 20,
      targetElement: '_Edition'
    },
    {
      id: 'Ratings',
      purpose: #STANDARD,
      type: #LINEITEM_REFERENCE,
      label: 'Ratings',
      position: 30,
      targetElement: '_Rating'
    }
  ]

  @UI.hidden: true
  BookUuid;

  @UI: {
    lineItem: [{ position: 10, importance: #HIGH }],
    identification: [{ position: 10 }],
    selectionField: [{ position: 10 }]
  }
  BookId;

  @UI.hidden: true
  AuthorUuid;

  @UI: {
    lineItem: [{ position: 20, importance: #HIGH, label: 'Title' }],
    identification: [{ position: 20 }],
    selectionField: [{ position: 20 }]
  }
  Title;

  @UI: {
    lineItem: [{ position: 25, importance: #HIGH, label: 'Author', value: '_Author.Name' }],
    identification: [{ position: 25, label: 'Author', value: '_Author.Name' }],
    selectionField: [{ position: 25 }],
    textArrangement: #TEXT_ONLY
  }
  @Consumption.valueHelpDefinition: [{
    entity: { name: 'Z##_C_Author', element: 'AuthorUuid' },
    additionalBinding: [{ element: 'Name', localElement: 'AuthorName', usage: #RESULT }]
  }]
  @ObjectModel.text.element: ['AuthorName']
  @Search.defaultSearchElement: true
  AuthorUuid;
  
  @UI.hidden: true
  @Semantics.text: true
  cast( '' as z##_author_name ) as AuthorName;

  @UI: {
    lineItem: [{ position: 30, importance: #MEDIUM }],
    identification: [{ position: 30 }],
    selectionField: [{ position: 30 }]
  }
  @Consumption.valueHelpDefinition: [{
    entity: { name: 'I_Genre', element: 'Genre' }
  }]
  Genre;

  @UI: {
    lineItem: [{ position: 40, importance: #MEDIUM }],
    identification: [{ position: 40 }],
    selectionField: [{ position: 40 }]
  }
  PublicationYear;

  @UI: {
    lineItem: [{ position: 50, importance: #MEDIUM }],
    identification: [{ position: 50 }],
    selectionField: [{ position: 50 }]
  }
  Language;

  @UI: {
    lineItem: [{ position: 60, importance: #LOW }],
    identification: [{ position: 60 }]
  }
  Isbn;

  @UI: {
    lineItem: [{ position: 70, importance: #MEDIUM, label: 'Avg Rating' }],
    identification: [{ position: 70, label: 'Average Rating' }],
    dataPoint: { 
      visualization: #RATING,
      targetValue: 5,
      title: 'Average Rating'
    }
  }
  AverageRating;

  @UI.hidden: true
  CreatedBy;

  @UI.hidden: true
  CreatedAt;

  @UI.hidden: true
  LastChangedBy;

  @UI.hidden: true
  LastChangedAt;

  @UI.hidden: true
  LocalLastChangedAt;
}
```

**Technical Notes:**
- Header displays Book Title with Author Name as description
- List displays: BookId, Title, Author Name (via text association), Genre, Year, Language, ISBN, Average Rating
- Author Name shown via `_Author.Name` association
- Search enabled on Title, BookId, ISBN, and Author (via AuthorUuid with text association)
- Filters on Genre, PublicationYear, Language
- Object page has 3 facets: Book Details, Editions, Ratings
- Average Rating displayed as star rating (visualization: #RATING)
- Value help on AuthorUuid to select author

---

### Metadata Extension: Z##_C_Edition

```abap
@Metadata.layer: #CORE
@UI: {
  headerInfo: {
    typeName: 'Edition',
    typeNamePlural: 'Editions',
    title: {
      type: #STANDARD,
      value: 'EditionNumber'
    }
  }
}
annotate view Z##_C_Edition with
{
  @UI.facet: [
    {
      id: 'EditionDetails',
      purpose: #STANDARD,
      type: #IDENTIFICATION_REFERENCE,
      label: 'Edition Details',
      position: 10
    }
  ]

  @UI.hidden: true
  EditionUuid;

  @UI.hidden: true
  BookUuid;

  @UI: {
    lineItem: [{ position: 10, importance: #HIGH }],
    identification: [{ position: 10 }]
  }
  EditionNumber;

  @UI: {
    lineItem: [{ position: 20, importance: #HIGH }],
    identification: [{ position: 20 }]
  }
  Publisher;

  @UI: {
    lineItem: [{ position: 30, importance: #MEDIUM }],
    identification: [{ position: 30 }]
  }
  PublicationDate;

  @UI: {
    lineItem: [{ position: 40, importance: #MEDIUM }],
    identification: [{ position: 40 }]
  }
  Format;

  @UI: {
    lineItem: [{ position: 50, importance: #MEDIUM }],
    identification: [{ position: 50 }]
  }
  PageCount;

  @UI.hidden: true
  CreatedBy;

  @UI.hidden: true
  CreatedAt;

  @UI.hidden: true
  LastChangedBy;

  @UI.hidden: true
  LastChangedAt;

  @UI.hidden: true
  LocalLastChangedAt;
}
```

**Technical Notes:**
- Displayed as line item in Book object page
- List displays: EditionNumber, Publisher, PublicationDate, Format, PageCount

---

### Metadata Extension: Z##_C_Rating

```abap
@Metadata.layer: #CORE
@UI: {
  headerInfo: {
    typeName: 'Rating',
    typeNamePlural: 'Ratings',
    title: {
      type: #STANDARD,
      value: 'ReviewerName'
    }
  }
}
annotate view Z##_C_Rating with
{
  @UI.facet: [
    {
      id: 'RatingDetails',
      purpose: #STANDARD,
      type: #IDENTIFICATION_REFERENCE,
      label: 'Rating Details',
      position: 10
    }
  ]

  @UI.hidden: true
  RatingUuid;

  @UI.hidden: true
  BookUuid;

  @UI: {
    lineItem: [{ 
      position: 10, 
      importance: #HIGH,
      label: 'Score'
    }],
    identification: [{ position: 10 }],
    dataPoint: { 
      visualization: #RATING,
      targetValue: 5,
      title: 'Score'
    }
  }
  Score;

  @UI: {
    lineItem: [{ position: 20, importance: #HIGH }],
    identification: [{ position: 20 }]
  }
  ReviewerName;

  @UI: {
    lineItem: [{ position: 30, importance: #MEDIUM }],
    identification: [{ position: 30 }]
  }
  ReviewDate;

  @UI: {
    lineItem: [{ position: 40, importance: #LOW }],
    identification: [{ position: 40 }],
    multiLineText: true
  }
  ReviewText;

  @UI.hidden: true
  CreatedBy;

  @UI.hidden: true
  CreatedAt;

  @UI.hidden: true
  LastChangedBy;

  @UI.hidden: true
  LastChangedAt;

  @UI.hidden: true
  LocalLastChangedAt;
}
```

**Technical Notes:**
- Displayed as line item in Book object page
- List displays: Score (star rating), ReviewerName, ReviewDate, ReviewText
- Score displayed as star rating (visualization: #RATING, 1-5 scale)

---

## 4. Implementation Sequence and Activation Strategy

### Phase 1: Foundation Layer
**Order:** Create in sequence, activate together

1. Create package `TEST_##_BOOK`
2. Create all domains (Z##_AUTHOR_NAME through Z##_REVIEWER_NAME)
3. Create all data elements (Z##_AUTHOR_NAME through Z##_REVIEWER_NAME)
4. **Activate:** Group activation of all domains and data elements

### Phase 2: Data Model Layer
**Order:** Create in sequence, activate together

5. Create persistent tables:
   - Z##_AUTHOR
   - Z##_BOOK
   - Z##_EDITION
   - Z##_RATING
6. Create draft tables:
   - Z##_AUTHOR_D
   - Z##_BOOK_D
   - Z##_EDITION_D
   - Z##_RATING_D
7. **Activate:** Group activation of all tables
8. **Verify:** Check tables exist in SE11

### Phase 3: CDS Interface Views
**Order:** Create in sequence, activate together

9. Create interface views:
   - Z##_I_Author (root, no dependencies)
   - Z##_I_Book (depends on Z##_I_Author association)
   - Z##_I_Edition (depends on Z##_I_Book parent)
   - Z##_I_Rating (depends on Z##_I_Book parent)
10. **Activate:** Group activation of all interface views
11. **Verify:** Check views in Data Preview (SE16N)

### Phase 4: Behavior Definitions (Interface)
**Order:** Create separately, activate separately

12. Create interface BDEF: Z##_I_Author
13. **Activate:** Z##_I_Author BDEF
14. Create behavior implementation class: Z##_BP_I_AUTHOR
15. Implement local handler class with `get_instance_authorizations`
16. **Activate:** Z##_BP_I_AUTHOR class
17. Create interface BDEF: Z##_I_Book (with children)
18. **Activate:** Z##_I_Book BDEF
19. Create behavior implementation class: Z##_BP_I_BOOK
20. Implement local handler class with `get_instance_authorizations`
21. **Activate:** Z##_BP_I_BOOK class
22. **Verify:** Test behavior via ADT (F9 on BDEF)

### Phase 5: CDS Projection Views
**Order:** Create in sequence, activate together

23. Create projection views:
    - Z##_C_Author
    - Z##_C_Book
    - Z##_C_Edition
    - Z##_C_Rating
24. **Activate:** Group activation of all projection views

### Phase 6: Behavior Definitions (Projection)
**Order:** Create separately, activate separately

25. Create projection BDEF: Z##_C_Author
26. **Activate:** Z##_C_Author BDEF
27. Create projection BDEF: Z##_C_Book (with children)
28. **Activate:** Z##_C_Book BDEF

### Phase 7: Service Layer
**Order:** Create in sequence, activate together

29. Create service definition: Z##_UI_BOOK_CATALOG
30. **Activate:** Service definition
31. Create service binding: Z##_UI_BOOK_CATALOG_O4 (OData V4 - UI)
32. **Activate:** Service binding
33. **Publish:** Publish service in service binding
34. **Verify:** Check service endpoint is active

### Phase 8: UI Layer
**Order:** Create in sequence, activate together

35. Create metadata extensions:
    - Z##_C_Author
    - Z##_C_Book
    - Z##_C_Edition
    - Z##_C_Rating
36. **Activate:** Group activation of all metadata extensions
37. **Verify:** Preview Fiori app via service binding

### Phase 9: Testing and Validation

38. **Test Author BO:**
    - Create new author
    - Edit author (draft)
    - Activate draft
    - Delete author
39. **Test Book BO:**
    - Create new book with author association
    - Add editions (child entities)
    - Add ratings (child entities)
    - Edit book (draft)
    - Verify author name displayed in book list
    - Test search on title/author/ISBN
    - Test filters on genre/year/language
40. **Test Authorization:**
    - Verify instance authorization checks work
    - Test with different users/roles
41. **Test UI:**
    - Verify star rating display for scores
    - Verify average rating calculation
    - Verify all facets display correctly
    - Test value helps and text associations

---

## 5. Critical Configuration Points

### 5.1 Draft Table Keys
**CRITICAL:** Draft table keys MUST match persistent table keys exactly.

**Example:**
```abap
// Persistent table Z##_BOOK
key client    : abap.clnt not null;
key book_uuid : sysuuid_x16 not null;

// Draft table Z##_BOOK_D - SAME KEYS
key client    : abap.clnt not null;
key book_uuid : sysuuid_x16 not null;
```

### 5.2 Explicit Field Mapping
**CRITICAL:** Do NOT use `corresponding` - use explicit field mapping.

**Example:**
```abap
mapping for z##_book
{
  BookUuid = book_uuid;
  BookId = book_id;
  AuthorUuid = author_uuid;
  Title = title;
  // ... all fields explicitly mapped
}
```

### 5.3 Authorization Master/Dependent
**CRITICAL:** Root entity has `authorization master ( instance )`, children have `authorization dependent by _Parent`.

**Example:**
```abap
// Root entity
define behavior for Z##_I_Book alias Book
authorization master ( instance )
{ ... }

// Child entity
define behavior for Z##_I_Edition alias Edition
authorization dependent by _Book
{ ... }
```

### 5.4 All 5 Draft Actions
**CRITICAL:** All 5 draft actions must be explicitly defined on root entities.

**Example:**
```abap
draft action Edit;
draft action Activate optimized;
draft action Discard;
draft action Resume;
draft determine action Prepare;
```

### 5.5 Text Association for Author Name
**CRITICAL:** Author name must be displayed in Book list via text association.

**Implementation:**
1. In Z##_I_Author: Add `@Semantics.text: true` to Name field
2. In Z##_C_Book: Add virtual field for AuthorName
3. In Z##_C_Book metadata extension: Use `value: '_Author.Name'` in lineItem
4. Add `@ObjectModel.text.element: ['AuthorName']` to AuthorUuid
5. Add value help on AuthorUuid with additional binding for Name

### 5.6 Star Rating Display
**CRITICAL:** Rating scores must display as star rating (1-5).

**Implementation:**
```abap
@UI: {
  dataPoint: { 
    visualization: #RATING,
    targetValue: 5,
    title: 'Score'
  }
}
Score;
```

### 5.7 Average Rating Calculation
**Implementation Options:**

**Option 1: Virtual Field with Determination**
- Add virtual field `AverageRating` to Z##_C_Book
- Implement determination in behavior implementation
- Calculate on read or modify

**Option 2: Transient Field**
- Define transient field in BDEF
- Calculate in behavior implementation
- Return in result

**Option 3: Separate Table**
- Create table Z##_BOOK_AVG_RATING
- Update via determination when ratings change
- Expose via association

---

## 6. Testing Checklist

### 6.1 Author BO Testing
- [ ] Create author (draft)
- [ ] Edit author (draft)
- [ ] Activate draft
- [ ] Resume draft
- [ ] Discard draft
- [ ] Delete author
- [ ] Search by author name
- [ ] View author details
- [ ] View books by author

### 6.2 Book BO Testing
- [ ] Create book with author selection
- [ ] Edit book (draft)
- [ ] Activate draft
- [ ] Resume draft
- [ ] Discard draft
- [ ] Delete book
- [ ] Search by title
- [ ] Search by author name
- [ ] Search by ISBN
- [ ] Filter by genre
- [ ] Filter by publication year
- [ ] Filter by language
- [ ] Verify author name displayed in book list

### 6.3 Edition Testing
- [ ] Create edition for book
- [ ] Edit edition
- [ ] Delete edition
- [ ] View editions in book object page
- [ ] Verify edition details display

### 6.4 Rating Testing
- [ ] Create rating for book
- [ ] Edit rating
- [ ] Delete rating
- [ ] View ratings in book object page
- [ ] Verify star rating display (1-5)
- [ ] Verify average rating calculation
- [ ] Verify average rating display in book list

### 6.5 Authorization Testing
- [ ] Test instance authorization for author
- [ ] Test instance authorization for book
- [ ] Test dependent authorization for edition
- [ ] Test dependent authorization for rating
- [ ] Test with different users/roles

### 6.6 UI Testing
- [ ] Verify author list displays correctly
- [ ] Verify book list displays correctly with author names
- [ ] Verify edition list in book object page
- [ ] Verify rating list in book object page
- [ ] Verify star rating visualization
- [ ] Verify average rating visualization
- [ ] Verify search functionality
- [ ] Verify filters functionality
- [ ] Verify value helps work
- [ ] Verify text associations work
- [ ] Verify all facets display
- [ ] Verify multi-line text fields

---

## 7. Known Issues and Troubleshooting

### Issue 1: Draft Table Key Mismatch
**Symptom:** Error "Draft table keys do not match persistent table keys"
**Solution:** Ensure draft table keys are EXACTLY the same as persistent table keys (including order)

### Issue 2: Authorization Check Fails
**Symptom:** "Authorization check failed" when accessing BO
**Solution:** Implement `get_instance_authorizations` in behavior implementation class, return `if_abap_behv=>auth-allowed` for all operations during testing

### Issue 3: Author Name Not Displayed in Book List
**Symptom:** Author name column is empty in book list
**Solution:** 
1. Check `@Semantics.text: true` on Author.Name
2. Check `@ObjectModel.text.element: ['AuthorName']` on Book.AuthorUuid
3. Verify association `_Author` is exposed and redirected
4. Check metadata extension uses `value: '_Author.Name'`

### Issue 4: Star Rating Not Displayed
**Symptom:** Rating shows as number instead of stars
**Solution:** Add `visualization: #RATING` and `targetValue: 5` in dataPoint annotation

### Issue 5: Average Rating Not Calculated
**Symptom:** Average rating shows as 0 or empty
**Solution:** Implement calculation logic in behavior implementation (determination or virtual field calculation)

### Issue 6: Search Not Working
**Symptom:** Search returns no results
**Solution:** 
1. Check `@Search.searchable: true` on projection view
2. Check `@Search.defaultSearchElement: true` on relevant fields
3. Verify search fields are exposed in projection

### Issue 7: Filters Not Available
**Symptom:** Filter fields not shown in selection bar
**Solution:** Check `@UI.selectionField` annotations in metadata extension

### Issue 8: Value Help Not Working
**Symptom:** Value help (F4) not available on author selection
**Solution:** Add `@Consumption.valueHelpDefinition` annotation on AuthorUuid field

---

## 8. Summary

This technical specification provides a complete blueprint for implementing a Book Catalog application using SAP RAP with the following key features:

**Architecture:**
- 2 independent Business Objects: Author and Book
- Book has 2 child entities: Edition and Rating
- Managed BO with draft support
- strict ( 2 ) mode
- Instance-based authorization

**Data Model:**
- Custom domains and data elements for all business fields
- Persistent and draft tables with matching keys
- Proper foreign key relationships

**Business Logic:**
- Full CRUD operations on all entities
- All 5 draft actions (Edit, Resume, Activate, Discard, Prepare)
- Instance authorization with BIMP class
- Average rating calculation capability

**User Interface:**
- Fiori Elements List Report and Object Page
- Author name displayed in book list via text association
- Search on Title, Author, ISBN
- Filters on Genre, Year, Language
- Star rating visualization for scores
- Average rating display

**Technology:**
- SAP RAP (ABAP RESTful Application Programming Model)
- OData V4
- Fiori Elements UI
- Explicit field mapping
- Text associations for foreign key display

The implementation follows SAP best practices and includes comprehensive activation notes and testing procedures to ensure successful deployment.
