# Documentation Reorganization Plan

## Overview

Reorganizing documentation into logical groups for better navigation and maintainability.

## New Structure

```
docs/
├── architecture/           # System architecture and design
│   ├── API_REFERENCE.md
│   ├── CAP_ENDPOINTS.md
│   ├── FEATURES.md
│   ├── IMPLEMENTATION_STATUS.md
│   ├── INTEGRATIONS.md
│   ├── MCP_HEADER_MATRIX.md
│   └── PERFORMANCE.md
│
├── development/           # Development guides
│   ├── DEBUGGING.md
│   ├── DEBUG_CLINE_REQUESTS.md
│   ├── TESTING_CHEAT_SHEET.md
│   └── JWT_TOKEN_REFRESH_GUIDE.md
│
├── deployment/            # Deployment and operations
│   ├── DEPLOYMENT_CHECKLIST.md
│   ├── MIGRATION_GUIDE.md
│   ├── MONITORING.md
│   └── OPERATIONS.md
│
├── usage/                 # User guides
│   ├── GETTING_STARTED.md
│   ├── QUICK_SETUP.md
│   ├── CONSUMER_GUIDE.md
│   ├── MCP_PROXY_USAGE.md
│   ├── MCP_CONFIG_UPDATE_HOWTO.md
│   ├── ASSISTANT_GUIDELINES.md
│   └── TROUBLESHOOTING.md
│
├── contributors/          # Existing - contributor guides
├── adrs/                  # Existing - architecture decision records
├── examples/              # Existing - examples
├── templates/             # Existing - templates
├── uk/                    # Existing - Ukrainian translations
└── README.md              # Main documentation index
```

## Migration Plan

### Phase 1: Architecture Documents
- [ ] Move `API_REFERENCE.md` → `architecture/`
- [ ] Move `CAP_ENDPOINTS.md` → `architecture/`
- [ ] Move `FEATURES.md` → `architecture/`
- [ ] Move `IMPLEMENTATION_STATUS.md` → `architecture/`
- [ ] Move `INTEGRATIONS.md` → `architecture/`
- [ ] Move `MCP_HEADER_MATRIX.md` → `architecture/`
- [ ] Move `PERFORMANCE.md` → `architecture/`

### Phase 2: Development Documents
- [ ] Move `DEBUGGING.md` → `development/`
- [ ] Move `DEBUG_CLINE_REQUESTS.md` → `development/`
- [ ] Move `TESTING_CHEAT_SHEET.md` → `development/`
- [ ] Move `JWT_TOKEN_REFRESH_GUIDE.md` → `development/`

### Phase 3: Deployment Documents
- [ ] Move `DEPLOYMENT_CHECKLIST.md` → `deployment/`
- [ ] Move `MIGRATION_GUIDE.md` → `deployment/`
- [ ] Move `MONITORING.md` → `deployment/`
- [ ] Move `OPERATIONS.md` → `deployment/`

### Phase 4: Usage Documents
- [ ] Move `GETTING_STARTED.md` → `usage/`
- [ ] Move `QUICK_SETUP.md` → `usage/`
- [ ] Move `CONSUMER_GUIDE.md` → `usage/`
- [ ] Move `MCP_PROXY_USAGE.md` → `usage/`
- [ ] Move `MCP_CONFIG_UPDATE_HOWTO.md` → `usage/`
- [ ] Move `ASSISTANT_GUIDELINES.md` → `usage/`
- [ ] Move `TROUBLESHOOTING.md` → `usage/`

### Phase 5: Update References
- [ ] Update `README.md` with new structure
- [ ] Create index files for each category
- [ ] Update cross-references in all documents
- [ ] Update `contributors/README.md` references

## Benefits

1. **Better Organization**: Logical grouping by purpose
2. **Easier Navigation**: Clear categories for different audiences
3. **Improved Maintainability**: Related docs in same location
4. **Clear Separation**: Architecture vs Development vs Usage vs Deployment

## Timeline

- Phase 1-4: Move files (immediate)
- Phase 5: Update references (after file moves)
