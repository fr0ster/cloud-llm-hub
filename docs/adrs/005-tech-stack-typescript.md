# ADR 005: TypeScript-First CAP Implementation

## Status

Proposed

## Context

The Cloud LLM Hub will grow to orchestrate multiple MCP integrations, stream events, and enforce security policies. Keeping the codebase maintainable and refactor-friendly is essential. CAP 9 supports both JavaScript and TypeScript services.

## Decision

- Develop hub services in TypeScript.
- Enable CAP TypeScript tooling (`cds add typescript`) to generate declaration files from CDS models.
- Enforce type checking via `tsconfig.json` and integrate linting (ESLint) for consistent style.

## Consequences

- Developers benefit from static typing, IDE autocomplete, and safer refactoring.
- Build pipelines must compile TypeScript to JavaScript before deployment.
- Some CAP samples/plugins in plain JS may require type definitions or wrappers.
- Onboarding requires familiarity with TypeScript tooling, but the long-term maintainability outweighs the initial setup.
