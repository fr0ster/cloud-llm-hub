# RFC: RAG Management API

## Status: Draft

## Problem

cloud-llm-hub has 4 RAG stores (tools, facts, feedback, state) but no HTTP API
to manage their content. All stores are in-memory and lose data on restart.
There is no way to:

- Add/edit/delete facts that the agent should know permanently
- Create custom document collections at runtime (e.g., product manuals, SAP notes)
- Upload documents to enrich the agent's knowledge without redeployment
- Inspect what the RAG stores contain

## Current Architecture

```
┌─────────────────────────────────────────────┐
│ SmartAgent Pipeline                         │
│                                             │
│  tools (per-dest)  — auto-vectorized MCP    │
│  facts (shared)    — long-term knowledge    │
│  feedback (shared) — user corrections       │
│  state (shared)    — Q&A pairs, TTL 1h      │
│                                             │
│  All: InMemoryRag / FallbackRag(Vector→Mem) │
│  Namespace: userId:destinationName          │
└─────────────────────────────────────────────┘
```

**What's internal (no API needed):**
- `tools` — auto-populated from MCP tool descriptions
- `state` — auto-populated from Q&A, short TTL
- `feedback` — auto-populated from classifier

**What needs management:**
- `facts` — long-term knowledge, editable by admins
- **Dynamic collections** — user-created document stores

## Proposal

### 1. Data Model

```
Collection
  ├── id: string (slug, e.g. "sap-notes", "product-manual")
  ├── displayName: string
  ├── description: string (used in RAG query expansion)
  ├── scope: "global" | "user"
  ├── createdAt: ISO timestamp
  ├── documentCount: number
  └── Documents[]
        ├── id: string (UUID or user-provided)
        ├── text: string (content to vectorize)
        ├── metadata: JSON (arbitrary key-value)
        ├── namespace: string (auto: userId or "global")
        └── createdAt: ISO timestamp
```

The built-in `facts` store becomes a pre-created collection with `id: "facts"`.

### 2. REST API

All endpoints under `/v1/rag/` with existing CAP auth middleware (XSUAA).

#### Collections CRUD

```
GET    /v1/rag/collections                    → list all collections
POST   /v1/rag/collections                    → create collection
GET    /v1/rag/collections/:id                → get collection info
PUT    /v1/rag/collections/:id                → update collection metadata
DELETE /v1/rag/collections/:id                → delete collection + all docs
```

#### Documents CRUD

```
GET    /v1/rag/collections/:id/documents      → list documents (paginated)
POST   /v1/rag/collections/:id/documents      → add document(s) — bulk supported
GET    /v1/rag/collections/:id/documents/:did  → get single document
PUT    /v1/rag/collections/:id/documents/:did  → update document text/metadata
DELETE /v1/rag/collections/:id/documents/:did  → delete document
```

#### Search / Query

```
POST   /v1/rag/collections/:id/query          → semantic search in collection
  body: { text: string, k?: number, namespace?: string }
  response: { results: [{ text, score, metadata }] }

POST   /v1/rag/query                          → search across all collections
  body: { text: string, k?: number, collections?: string[] }
```

#### Bulk Operations

```
POST   /v1/rag/collections/:id/documents/bulk  → bulk upsert (up to 100 docs)
DELETE /v1/rag/collections/:id/documents/bulk   → bulk delete by IDs
```

### 3. Integration with SmartAgent

When a chat request arrives at `/v1/chat/completions`:

1. **Auto-include `facts`** — always queried (existing behavior)
2. **Header-based collection selection:**
   ```
   X-Rag-Collections: sap-notes,product-manual
   ```
   or in request body:
   ```json
   { "rag_collections": ["sap-notes", "product-manual"] }
   ```
3. **Pipeline integration** — additional collections injected as extra RAG stores
   into `SmartAgentBuilder.withRag({ facts, ..., "sap-notes": sapNotesRag })`

### 4. Storage Backend

#### Phase 1: In-Memory + JSON Persistence

- RAG stores remain `VectorRag` / `InMemoryRag` (existing)
- Collection metadata + document texts persisted to JSON files on disk
- On server start: reload from JSON → re-vectorize into RAG stores
- Location: `~/.cloud-llm-hub/rag/` or configurable via `RAG_STORAGE_PATH`
- Simple, no external dependencies

```
~/.cloud-llm-hub/rag/
  collections.json          ← collection metadata
  facts/                    ← documents as JSONL
    doc-001.json
    doc-002.json
  sap-notes/
    doc-001.json
```

#### Phase 2: Qdrant (optional)

- When `LLM_AGENT_RAG_TYPE=qdrant` — use QdrantRag for persistent vector storage
- Collection maps 1:1 to Qdrant collection
- No re-vectorization on restart
- Requires Qdrant instance (self-hosted or cloud)

#### Phase 3: SAP HANA Cloud Vector Engine

- Native BTP integration
- HDI container for vector storage
- Enterprise-grade persistence

### 5. Authorization

| Operation | Required Role |
|-----------|--------------|
| Query collections | `MCP_Connector` (any authenticated user) |
| CRUD global collections | `MCP_Admin` |
| CRUD user-scoped collections | `MCP_Connector` (own collections only) |
| Bulk upload | `MCP_Admin` |

### 6. Implementation Plan

#### Step 1: Collection Registry (in-memory)

- `CollectionRegistry` class managing `Map<string, { meta, rag: IRag }>`
- Pre-register `facts` collection on startup
- Wire to shared embedder

#### Step 2: REST Endpoints

- New file: `srv/rag-handler.ts`
- Register routes in `server.ts` under `/v1/rag/`
- Reuse existing CAP auth middleware

#### Step 3: JSON Persistence

- Save/load collection metadata + documents to disk
- Re-vectorize on cold start (background, non-blocking)

#### Step 4: Chat Integration

- Parse `X-Rag-Collections` header / `rag_collections` body field
- Merge dynamic collections into SmartAgent's ragStores
- Custom RagQueryHandler queries selected collections

#### Step 5: UI Integration (future)

- Collection management panel in chat UI
- Document upload (text, PDF extraction)
- Search/preview documents

### 7. Example Workflows

#### Admin adds SAP Notes collection

```bash
# Create collection
curl -X POST /v1/rag/collections \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"id":"sap-notes","displayName":"SAP Notes","description":"Relevant SAP OSS notes for troubleshooting","scope":"global"}'

# Add documents
curl -X POST /v1/rag/collections/sap-notes/documents \
  -d '{"id":"note-3456789","text":"SAP Note 3456789: ABAP dump RAISE_SHORTDUMP occurs when...\n\nSolution: Apply correction instruction..."}'

# User query automatically includes SAP notes
curl -X POST /v1/chat/completions \
  -H "X-Rag-Collections: sap-notes" \
  -d '{"messages":[{"role":"user","content":"Why do I get RAISE_SHORTDUMP?"}]}'
```

#### User creates personal knowledge base

```bash
# User creates own collection (scope: user)
curl -X POST /v1/rag/collections \
  -d '{"id":"my-notes","displayName":"My Notes","scope":"user"}'

# Add personal notes
curl -X POST /v1/rag/collections/my-notes/documents \
  -d '{"text":"Our Z_CUSTOM_REPORT uses BAPI_MATERIAL_GETLIST for material search. Contact John for access."}'
```

### 8. Changes Required in llm-agent

Minimal — the existing `IRag` interface and `SmartAgentBuilder.withRag()` already
support arbitrary named stores:

```typescript
builder.withRag({
  facts: factsRag,
  feedback: feedbackRag,
  state: stateRag,
  'sap-notes': sapNotesRag,     // dynamic collection
  'my-notes': myNotesRag,       // dynamic collection
});
```

The only addition needed in llm-agent:
- **`RagQueryHandler`** should iterate all stores (or selected ones), not just hardcoded names
- Already partially supported: handler queries stores from `ctx.ragStores` map

### 9. Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Re-vectorization on restart is slow | Background init (existing pattern), progress endpoint |
| Large collections exhaust memory | Document count limits per collection, pagination |
| Embedder rate limits during bulk upload | Throttled upsert with retry (existing pattern from tool vectorization) |
| Stale collections after llm-agent update | Collections are cloud-llm-hub concern, not llm-agent |

### 10. Recency Boost

RAG results are re-ranked with a recency boost so newer documents score higher:

```
finalScore = baseScore * (1 + recencyBoost * recencyFactor)
recencyFactor = 2^(-ageMs / halfLifeMs)
```

- **recencyBoost**: 0.15 (up to 15% boost for just-created documents)
- **halfLifeMs**: 7 days (score boost halves every 7 days)
- Documents without timestamp metadata are unaffected
- Inner RAG fetches 2x results, re-ranks, then trims to requested k

### 11. File Upload

`POST /v1/rag/collections/:id/upload` accepts text file content and splits it
into chunks:

- Splits on paragraph boundaries (double newline)
- Oversized paragraphs split at sentence boundaries
- Configurable chunk size (default: 2000 chars)
- Each chunk becomes a document with `source` metadata

Chat UI provides a clip button next to the input field for quick file attach.
Files auto-create an "uploads" collection if needed.

### 12. Out of Scope (for now)

- PDF/Office document parsing (future: use SAP Document Information Extraction)
- Real-time document sync from external sources
- Multi-tenant collection isolation (current: namespace-based)
- Collection versioning / rollback
