# Find RAP Business Objects

**Goal:** Demonstrate locating RAP BOs by behavior definition and tracing the stack down to the service binding.
**Destination:** `S4HANA_DEV`.
**Expected tools invoked:** `SearchObjects`, `GetBehaviorDefinition`, `GetServiceBinding`.

## Prompt

> Find all RAP managed business objects in package `Z_DEMO_SALES`. For each, report: root entity, behavior definition name, implementation class (BIMP), projection behavior, service definition, service binding URL. Highlight BOs that lack draft support.

## Expected Outcome

- Table: Root Entity | BDEF | BIMP | Projection | Service Def | Binding URL | Draft?
- Missing components marked as `—` (not invented).

## Troubleshooting

- **"No RAP BOs found"** — confirm that behavior definitions exist (`SearchObjects(type=BDEF)`).
- **Binding URL missing** — service binding may be inactive or not published.
