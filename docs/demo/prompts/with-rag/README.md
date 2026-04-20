# Prompts with RAG Content

Prompts that rely on documents pre-indexed from [../../rag-content/](../../rag-content/). Each file states what RAG retrieval is expected to surface.

Format:

```markdown
## Prompt
<paste in UI>

## Expected RAG hit
<which mock doc(s) should be retrieved>

## Demo value
<what the audience should take away>
```

Pre-index `docs/demo/rag-content/` into the demo tenant's vector store before running these.
