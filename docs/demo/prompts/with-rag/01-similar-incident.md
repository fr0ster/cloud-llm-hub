# Find a Similar Past Incident

## Prompt

> My report returns all sales orders instead of the filtered subset. Have we seen this before?

## Expected RAG hit

`rag-content/support-cases/MOCK-SC-001-select-for-all-entries-empty.md` — describes the same symptom (FOR ALL ENTRIES with empty driver table).

## Demo value

Shows RAG surfacing prior-incident knowledge without the user knowing the ticket ID. Agent answers with the diagnosis and the documented fix, grounded in the retrieved doc.
