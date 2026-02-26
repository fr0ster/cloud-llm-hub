# RAG Architecture & Implementation Decisions (PoC)

## 1) Use Case and Product Behavior

### Primary Goal

The RAG implementation is part of an agent-based architecture (`@mcp-abap-adt/llm-agent`) and supports:

- Support engineer assistance  
- Deep technical analysis (code, architecture, dependencies)  
- Experience accumulation and reuse  
- Multi-step agent workflows  

RAG is not a standalone QA module, but a capability within a multi-step orchestration pipeline.

---

### What Is Considered a “Good Answer”

A high-quality answer:

- May include concrete actionable instructions  
- May include references to retrieved sources  
- Supports normal and debug/audit modes  
- Avoids unnecessary verbosity in normal mode  

Source visibility is controlled by mode (normal vs debug).

---

### Behavior When Retrieval Returns No Results

If no relevant chunks are retrieved:

- No context is injected  
- The original query is passed directly to the LLM  
- No explicit warning in normal mode  

---

## 2) Data and Ingestion

### Multi-RAG Architecture

- Multiple independent RAG instances  
- Some RAGs reside in customer networks  
- Some RAGs reside in our environment  
- A single user request may query multiple RAGs  
- Aggregation is allowed if user roles permit access  

---

### Memory Architecture

Memory is implemented as a dedicated RAG:

- Session memory  
- Long-term user memory  
- Per-user isolation  
- Optional per-session isolation  
- Custom interface (in-memory or external backend)  

Memory can be injected:

- Via prompt  
- Via retrieval  
- Or in hybrid mode  

---

### Ingestion Strategy

- Defined per RAG  
- Chunking policy is adaptive  
- Strategy depends on data type (code, documentation, incidents, memory, etc.)  

---

### Chunking Policy

- No global default  
- Per-RAG configurable policy  
- Adaptive to data type  
- Fully configurable  

---

## 3) Embeddings and Retrieval

### LLM and Embeddings

- Default provider: SAP AI Core  
- Pluggable provider support per tenant / per RAG  
- Fully abstracted via interface  

---

### Retrieval Parameters

- `top_k` is configurable per RAG  
- Hard upper cap enforced  
- Confidence threshold is configurable  
- Chunks below threshold are excluded  

---

### Reranking

- Optional mode  
- Not automatically delegated to agent reasoning  
- Can be enabled for high-precision scenarios  

---

### Token Budget

- Controlled by the pipeline  
- Policy-driven  
- Adaptive to model and scenario  

---

## 4) Vector Store and Infrastructure

### Vector Store Design

- Fully pluggable via interface  
- Implementation depends on environment  

Possible deployments:

- Same BTP subaccount  
- Customer network deployment  
- Access via BTP Destination  
- Separate client ID / secret per customer  

---

### Security Model

- Standard BTP role-based authorization  
- Roles determine accessible MCP tools and RAG instances  
- Aggregation allowed only if roles permit  

---

### Isolation

- Physical isolation (separate infrastructure) possible  
- Logical isolation (namespace / metadata) possible  
- Depends on tenant requirements  

---

## 5) Prompting and Response Contract

### Context Injection

- Managed by pipeline  
- Not hardcoded inside RAG  
- Context block may be empty  

---

### Source Metadata (Debug Mode)

Logged in debug/audit mode:

- Chunk IDs  
- Similarity scores  
- RAG ID  
- Routing decision  

Normal mode suppresses technical noise.

---

## 6) Security and Compliance

- Full audit trail  
- Role-based access control  
- Customer RAG accessed via secure Destination  
- Pluggable embedding and LLM providers  

---

## 7) Reliability and Observability

### Fallback Strategy

Defined per RAG type:

- Memory RAG may fallback differently  
- Customer RAG may enforce strict failure  
- Technical RAG may fallback to LLM-only  

---

### Mandatory Logging

- Query ID  
- User ID  
- Used RAG instances  
- Retrieved chunk IDs  
- Similarity scores  
- Routing decision  
- LLM model ID  
- Token usage  
- Retrieval latency  
- Generation latency  

---

## 8) Index Lifecycle

- Index versioning supported  
- No parallel index versions  
- No ingestion rollback  

---

## Definition of Done (PoC)

PoC is considered complete when:

- End-to-end multi-RAG pipeline works  
- Retrieval quality metrics are available  
- Latency metrics are available  
- Smoke/integration tests exist  
- Deployment documentation exists  
- Demo scenario is prepared  

---

## Architectural Characteristics

- Agent-first RAG architecture  
- Multi-RAG orchestration  
- Pluggable vector store  
- Pluggable LLM provider  
- Policy-driven pipeline  
- Role-based access control  
- Enterprise-grade observability  
- Memory-aware design  
