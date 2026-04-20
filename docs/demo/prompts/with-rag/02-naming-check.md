# Validate Naming Against Internal Standard

## Prompt

> I want to name my new projection view `ZV_PROMO_HEADER`. Does that follow our conventions?

## Demo value

Agent should retrieve `rag-content/internal-docs/naming-conventions.md`, notice projection CDS convention is `ZC_<AREA>_<ENTITY>`, and propose `ZC_SALES_PROMO_HEADER` with reasoning tied to the standard.

## Expected RAG hit

`rag-content/internal-docs/naming-conventions.md`.
