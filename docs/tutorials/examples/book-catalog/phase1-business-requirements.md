# Business Requirements Document
## Book Catalog Application

---

## 1. Executive Summary

This document outlines the business requirements for a **Book Catalog Application** that enables users to manage books, authors, editions, and ratings. The application provides comprehensive CRUD operations, advanced search and filtering capabilities, and analytical features such as average ratings.

---

## 2. Business Objectives

- Provide a centralized system for managing book catalog information
- Enable efficient search and discovery of books by various criteria
- Track multiple editions of books with detailed publishing information
- Collect and display user ratings and reviews for books
- Maintain author information and their relationship to published works

---

## 3. Data Model

### 3.1 Entity: Author

**Description:** Represents book authors with biographical information.

| Field | Type | Mandatory | Description |
|-------|------|-----------|-------------|
| Author ID | Key | Yes | Unique identifier (auto-generated) |
| Name | String(100) | Yes | Full name of the author |
| Country | String(50) | No | Country of origin/residence |
| Birth Year | Integer(4) | No | Year of birth (YYYY format) |
| Biography | Text | No | Author biography and background |

**Business Rules:**
- Author Name is required and must be unique
- Birth Year must be between 1000 and current year if provided
- An author can exist without books (e.g., newly added authors)

---

### 3.2 Entity: Book

**Description:** Represents books in the catalog with core bibliographic information.

| Field | Type | Mandatory | Description |
|-------|------|-----------|-------------|
| Book ID | Key | Yes | Unique identifier (auto-generated) |
| Title | String(200) | Yes | Book title |
| Author ID | Foreign Key | Yes | Reference to Author entity |
| Genre | String(50) | No | Book genre/category |
| Publication Year | Integer(4) | No | Original publication year |
| Language | String(50) | No | Primary language of the book |
| ISBN | String(17) | No | International Standard Book Number |

**Business Rules:**
- Title is mandatory
- Each book must be associated with exactly one author
- ISBN should follow standard format (ISBN-10 or ISBN-13) if provided
- Publication Year must be ≤ current year if provided
- Genre should be selected from predefined list (Fiction, Non-Fiction, Mystery, Science Fiction, Biography, History, etc.)

**Relationships:**
- Many-to-One with Author (one author has many books)
- One-to-Many with Edition (one book has many editions)
- One-to-Many with Rating (one book has many ratings)

---

### 3.3 Entity: Edition (Child of Book)

**Description:** Represents different published editions of a book.

| Field | Type | Mandatory | Description |
|-------|------|-----------|-------------|
| Edition ID | Key | Yes | Unique identifier (auto-generated) |
| Book ID | Foreign Key | Yes | Reference to parent Book |
| Edition Number | String(20) | No | Edition identifier (1st, 2nd, Revised, etc.) |
| Publisher | String(100) | No | Publishing company name |
| Publication Date | Date | No | Date of this edition's publication |
| Format | String(30) | No | Format type (Hardcover, Paperback, eBook, Audiobook) |
| Page Count | Integer | No | Number of pages (for physical editions) |

**Business Rules:**
- Each edition must be linked to a parent book
- Publication Date should not precede the book's original publication year
- Page Count must be positive if provided
- Format should be selected from predefined list
- Multiple editions with same Edition Number for one book should be prevented

**Relationships:**
- Many-to-One with Book (composition/child relationship)

---

### 3.4 Entity: Rating (Child of Book)

**Description:** Represents user ratings and reviews for books.

| Field | Type | Mandatory | Description |
|-------|------|-----------|-------------|
| Rating ID | Key | Yes | Unique identifier (auto-generated) |
| Book ID | Foreign Key | Yes | Reference to parent Book |
| Score | Integer | Yes | Rating score (1-5 scale) |
| Review Text | Text | No | Written review content |
| Reviewer Name | String(100) | Yes | Name of the reviewer |
| Review Date | Date | No | Date of review submission |

**Business Rules:**
- Score is mandatory and must be between 1 and 5 (inclusive)
- Reviewer Name is mandatory
- Review Date defaults to current date if not provided
- Review Text has a recommended maximum length (e.g., 5000 characters)
- One reviewer can submit multiple reviews for different books

**Relationships:**
- Many-to-One with Book (composition/child relationship)

---

## 4. Functional Requirements

### 4.1 CRUD Operations

#### 4.1.1 Author Management
- **Create:** Add new authors with all fields
- **Read:** View author details including list of their books
- **Update:** Modify author information
- **Delete:** Remove authors (only if no books are associated)

#### 4.1.2 Book Management
- **Create:** Add new books with author assignment
- **Read:** View book details with author name, editions, and ratings
- **Update:** Modify book information including author reassignment
- **Delete:** Remove books (cascade delete editions and ratings)

#### 4.1.3 Edition Management
- **Create:** Add new editions to existing books
- **Read:** View edition details
- **Update:** Modify edition information
- **Delete:** Remove specific editions

#### 4.1.4 Rating Management
- **Create:** Submit new ratings and reviews
- **Read:** View individual ratings
- **Update:** Modify existing ratings (by reviewer)
- **Delete:** Remove ratings

---

### 4.2 Browse and Search

#### 4.2.1 Book List View
- Display all books in a paginated list
- Show: Title, Author Name, Genre, Publication Year, Average Rating
- Default sorting: Title (A-Z)
- Alternative sorting: Author Name, Publication Year, Average Rating

#### 4.2.2 Search Functionality
- **Search by Title:** Partial match, case-insensitive
- **Search by Author:** Partial match on author name, case-insensitive
- Combined search (Title OR Author)
- Display search results with highlighting

#### 4.2.3 Filter Functionality
- **Filter by Genre:** Single or multiple genre selection
- **Filter by Publication Year:** 
  - Year range (from-to)
  - Specific year
  - Decade selection
- **Filter by Language:** Dropdown selection
- **Filter by Average Rating:** Minimum rating threshold (e.g., 4+ stars)
- Combine multiple filters simultaneously

---

### 4.3 Book Detail View

#### 4.3.1 Core Information Display
- Book title, author name (clickable link to author details)
- Genre, publication year, language, ISBN
- Average rating with star visualization
- Total number of ratings

#### 4.3.2 Editions Section
- List all editions for the book
- Display: Edition Number, Publisher, Publication Date, Format, Page Count
- Sort by Publication Date (newest first)
- Ability to add new edition from this view

#### 4.3.3 Ratings Section
- List all ratings and reviews for the book
- Display: Score (stars), Reviewer Name, Review Date, Review Text
- Sort options: Most Recent, Highest Score, Lowest Score
- Show average rating calculation
- Ability to add new rating from this view

---

### 4.4 Author Detail View
- Author name, country, birth year, biography
- List of all books by this author
- Show book count
- Link to each book's detail page

---

### 4.5 Analytical Features

#### 4.5.1 Average Rating Calculation
- Calculate average rating per book (sum of scores / count of ratings)
- Display with one decimal precision
- Update automatically when ratings are added/modified/deleted
- Show "No ratings yet" if no ratings exist

#### 4.5.2 Statistics (Optional Enhancement)
- Total books in catalog
- Total authors
- Most reviewed books
- Highest rated books
- Books by genre distribution

---

## 5. Non-Functional Requirements

### 5.1 Performance
- Search results should return within 2 seconds
- Page load time < 3 seconds
- Support for at least 10,000 books and 50,000 ratings

### 5.2 Usability
- Intuitive navigation with breadcrumbs
- Responsive design for mobile and desktop
- Clear error messages and validation feedback
- Accessibility compliance (WCAG 2.1 Level AA)

### 5.3 Data Integrity
- Referential integrity maintained for all relationships
- Cascade delete rules properly implemented
- Mandatory field validation on client and server side
- Data type and range validation

### 5.4 Security
- Input validation to prevent injection attacks
- Authorization for CRUD operations (if user management added)
- Audit trail for data modifications (optional)

---

## 6. User Interface Requirements

### 6.1 Main Navigation
- Home / Book List
- Authors
- Add New Book
- Add New Author
- Search (always accessible)

### 6.2 Book List Page
- Search bar at top
- Filter panel (left sidebar or collapsible)
- Results grid/table with pagination
- Items per page: 20 (configurable)

### 6.3 Book Detail Page
- Header: Book information with author link
- Tab 1: Overview (description, details)
- Tab 2: Editions (list of editions)
- Tab 3: Ratings & Reviews (ratings list with average)
- Action buttons: Edit, Delete, Add Edition, Add Rating

### 6.4 Forms
- Clear field labels with mandatory indicators (*)
- Dropdown/select for predefined values (Genre, Format, etc.)
- Date pickers for date fields
- Text area for long text (Biography, Review Text)
- Validation messages inline
- Save, Cancel buttons

---

## 7. Business Rules Summary

1. **Author Name** is mandatory and should be unique
2. **Book Title** is mandatory
3. Every **Book** must have an **Author**
4. **Edition** cannot exist without a parent **Book**
5. **Rating Score** must be between 1-5
6. **Reviewer Name** is mandatory for ratings
7. **ISBN** format validation (if provided)
8. **Publication Year** cannot be in the future
9. **Edition Publication Date** cannot precede book's original publication year
10. **Delete Author** only allowed if no books are associated
11. **Delete Book** cascades to editions and ratings
12. **Average Rating** recalculated on any rating change

---

## 8. Future Enhancements (Out of Scope)

- Multi-author books support
- Book series/collections
- User accounts and personalized reading lists
- Book availability and inventory tracking
- Integration with external book databases (Google Books, Open Library)
- Social features (share, recommend)
- Advanced analytics and reporting
- Book cover image upload and display
- Full-text search in reviews

---

## 9. Acceptance Criteria

### 9.1 Author Management
- ✓ Can create author with mandatory name field
- ✓ Can view list of all authors
- ✓ Can edit author information
- ✓ Cannot delete author with associated books
- ✓ Can delete author without books

### 9.2 Book Management
- ✓ Can create book with title and author
- ✓ Author name displayed in book list
- ✓ Can edit book information
- ✓ Can delete book (editions and ratings also deleted)
- ✓ Can view book details with all related data

### 9.3 Search and Filter
- ✓ Search by title returns matching books
- ✓ Search by author name returns matching books
- ✓ Filter by genre shows only books in selected genre(s)
- ✓ Filter by year range shows books within range
- ✓ Combined filters work correctly

### 9.4 Editions
- ✓ Can add edition to a book
- ✓ Editions displayed on book detail page
- ✓ Can edit and delete editions

### 9.5 Ratings
- ✓ Can add rating with score 1-5 and reviewer name
- ✓ Ratings displayed on book detail page
- ✓ Average rating calculated and displayed correctly
- ✓ Average updates when ratings change

---

## 10. Glossary

- **CRUD:** Create, Read, Update, Delete operations
- **ISBN:** International Standard Book Number
- **Edition:** A particular version or printing of a book
- **Genre:** Category or type of book (fiction, mystery, etc.)
- **Average Rating:** Mean of all rating scores for a book
- **Cascade Delete:** Automatic deletion of related child records

---

**Document Version:** 1.0  
**Date:** 2024  
**Status:** Ready for Implementation
