# Unit Tests

Unit tests for Cloud LLM Hub components.

## 📁 Structure

```
test/unit/
├── mcp-manager.test.ts          # MCP Manager tests
├── destination-resolver.test.ts  # Destination resolver tests
├── connection.test.ts            # Connection handler tests
└── __mocks__/                    # Mock implementations
    ├── @sap-cloud-sdk/
    └── @sap/cds/
```

## 🚀 Running Tests

```bash
# Run all unit tests
npm run test:unit

# Run in watch mode
npm run test:unit:watch

# Run with coverage
npm run test:unit:coverage

# Run specific test file
npm run test:unit -- mcp-manager.test.ts
```

## 📝 Writing Unit Tests

### Test File Naming

- Test files: `*.test.ts` or `*.spec.ts`
- Location: `test/unit/` or next to source files in `__tests__/`

### Example Test

```typescript
import { describe, it, expect, beforeEach } from '@jest/globals';
import { functionToTest } from '../../srv/module';

describe('Module Name', () => {
  beforeEach(() => {
    // Setup before each test
  });

  it('should do something', () => {
    const result = functionToTest(input);
    expect(result).toBe(expected);
  });
});
```

## 🎯 Coverage Goals

- **Critical components:** > 80%
- **Important components:** > 70%
- **Overall:** > 70%

## 📚 See Also

- [Testing Guide](../docs/contributors/TESTING.md) - Complete testing documentation
- [Code Style Guide](../docs/contributors/CODE_STYLE.md) - Coding standards
