# Code Style Guide

Coding standards and conventions for Cloud LLM Hub.

## 📋 General Principles

- **Readability** - Code should be easy to read and understand
- **Consistency** - Follow existing patterns in the codebase
- **Simplicity** - Prefer simple solutions over complex ones
- **Documentation** - Document complex logic and public APIs

## 🔤 Naming Conventions

### Variables and Functions

Use **camelCase**:

```typescript
// ✅ Good
const userName = 'alice';
const connectionTimeout = 5000;
function getDestination() {}

// ❌ Bad
const user_name = 'alice';
const ConnectionTimeout = 5000;
function GetDestination() {}
```

### Classes and Interfaces

Use **PascalCase**:

```typescript
// ✅ Good
class MCPManager {}
interface ConnectionConfig {}

// ❌ Bad
class mcpManager {}
interface connectionConfig {}
```

### Constants

Use **UPPER_SNAKE_CASE**:

```typescript
// ✅ Good
const DEFAULT_TIMEOUT = 30000;
const MAX_RETRIES = 3;

// ❌ Bad
const defaultTimeout = 30000;
const MAXRETRIES = 3;
```

### Files and Directories

- **Files:** `kebab-case.ts` (e.g., `mcp-proxy.ts`, `connection-handler.ts`)
- **Directories:** `kebab-case` (e.g., `connections/`, `test/smoke/`)

## 📝 TypeScript Style

### Type Annotations

**Prefer explicit types for function parameters and return values:**

```typescript
// ✅ Good
function connect(url: string, timeout: number): Promise<Connection> {
  // ...
}

// ⚠️ Acceptable (if type is obvious)
const user = 'alice'; // string inferred
```

### Interfaces vs Types

**Prefer `interface` for object shapes, `type` for unions/intersections:**

```typescript
// ✅ Good
interface ConnectionConfig {
  url: string;
  timeout: number;
}

type ConnectionMode = 'sse' | 'stream-http';

// ❌ Avoid
type ConnectionConfig = {
  url: string;
  timeout: number;
};
```

### Async/Await

**Prefer `async/await` over Promises:**

```typescript
// ✅ Good
async function fetchData(): Promise<Data> {
  const response = await fetch(url);
  return response.json();
}

// ⚠️ Acceptable (if needed for specific reasons)
function fetchData(): Promise<Data> {
  return fetch(url).then((res) => res.json());
}
```

### Error Handling

**Use try/catch with proper error types:**

```typescript
// ✅ Good
try {
  await connect();
} catch (error) {
  if (error instanceof ConnectionError) {
    log.error('Connection failed', { error });
  } else {
    throw error;
  }
}

// ❌ Bad
try {
  await connect();
} catch (error) {
  console.log(error); // Don't use console.log
}
```

## 🎨 Formatting

### Indentation

- **2 spaces** (no tabs)
- Consistent with existing code

### Line Length

- **Max 100 characters** (prefer 80)
- Break long lines appropriately

### Braces

**Opening brace on same line:**

```typescript
// ✅ Good
if (condition) {
  // ...
}

function example() {
  // ...
}

// ❌ Bad
if (condition) {
  // ...
}
```

### Semicolons

**Always use semicolons:**

```typescript
// ✅ Good
const x = 1;
function test() {
  return 'ok';
}

// ❌ Bad
const x = 1;
function test() {
  return 'ok';
}
```

### Quotes

**Use single quotes for strings:**

```typescript
// ✅ Good
const message = 'Hello, world';
const template = `Template with ${variable}`;

// ⚠️ Acceptable (for JSON keys)
const obj = { key: 'value' };
```

## 📦 Imports

### Import Organization

**Order:**

1. External packages (Node.js, npm)
2. SAP packages (`@sap/*`)
3. Internal modules

```typescript
// ✅ Good
import cds, { Request } from '@sap/cds';
import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { MCPManager } from './mcp-manager';
import { getDestination } from './connections';

// ❌ Bad (mixed order)
import { MCPManager } from './mcp-manager';
import cds from '@sap/cds';
import { getDestination } from './connections';
```

### Import Style

**Prefer named imports:**

```typescript
// ✅ Good
import { Request, Service } from '@sap/cds';

// ⚠️ Acceptable (for default exports)
import cds from '@sap/cds';
```

## 💬 Comments

### Code Comments

**Explain "why", not "what":**

```typescript
// ✅ Good
// Cache MCP servers per SAP URL to avoid re-initialization
// Each server maintains its own session state
const serverCache = new Map<string, MCPServer>();

// ❌ Bad
// Create a map for caching
const serverCache = new Map<string, MCPServer>();
```

### JSDoc Comments

**Use JSDoc for public APIs:**

```typescript
/**
 * Creates an MCP server instance for the given SAP system.
 *
 * @param sapUrl - SAP system URL
 * @param config - Connection configuration
 * @returns Promise resolving to MCP server instance
 * @throws {ConnectionError} If connection fails
 */
async function createMCPServer(sapUrl: string, config: ConnectionConfig): Promise<MCPServer> {
  // ...
}
```

## 🧪 Testing

### Test Structure

**Follow AAA pattern (Arrange, Act, Assert):**

```typescript
// ✅ Good
describe('MCPManager', () => {
  it('should create server for new URL', async () => {
    // Arrange
    const manager = new MCPManager();
    const url = 'https://sap.example.com';

    // Act
    const server = await manager.getServer(url);

    // Assert
    expect(server).toBeDefined();
    expect(server.url).toBe(url);
  });
});
```

### Test Naming

**Use descriptive test names:**

```typescript
// ✅ Good
it('should return cached server for same URL', async () => {});
it('should throw error when connection fails', async () => {});

// ❌ Bad
it('test1', async () => {});
it('works', async () => {});
```

## 🔒 Security

### Secrets and Credentials

**Never commit secrets:**

```typescript
// ✅ Good
const token = process.env.SAP_JWT_TOKEN;
const config = readConfigFromFile('config.json');

// ❌ Bad
const token = 'hardcoded-secret-token';
const password = 'admin123';
```

### Input Validation

**Always validate inputs:**

```typescript
// ✅ Good
function connect(url: string): void {
  if (!url || typeof url !== 'string') {
    throw new Error('URL must be a non-empty string');
  }
  if (!url.startsWith('https://')) {
    throw new Error('URL must use HTTPS');
  }
  // ...
}

// ❌ Bad
function connect(url: string): void {
  // No validation
  fetch(url);
}
```

## 📚 Logging

### Use CAP Logger

**Prefer CAP's logger over console:**

```typescript
// ✅ Good
const log = cds.log('mcp-proxy');
log.info('Connection established', { url, timeout });
log.error('Connection failed', { error, url });

// ❌ Bad
console.log('Connection established');
console.error('Connection failed', error);
```

### Log Levels

- **`log.debug()`** - Detailed debugging info
- **`log.info()`** - General information
- **`log.warn()`** - Warnings
- **`log.error()`** - Errors

## 🚫 Common Mistakes to Avoid

### ❌ Don't Use `any`

```typescript
// ❌ Bad
function process(data: any): any {
  return data.value;
}

// ✅ Good
function process(data: { value: string }): string {
  return data.value;
}
```

### ❌ Don't Ignore Errors

```typescript
// ❌ Bad
try {
  await riskyOperation();
} catch (error) {
  // Ignored
}

// ✅ Good
try {
  await riskyOperation();
} catch (error) {
  log.error('Operation failed', { error });
  throw error;
}
```

### ❌ Don't Use `var`

```typescript
// ❌ Bad
var x = 1;
var y = 2;

// ✅ Good
const x = 1;
let y = 2;
```

### ❌ Don't Mutate Function Parameters

```typescript
// ❌ Bad
function process(config: Config): void {
  config.timeout = 5000; // Mutates input
}

// ✅ Good
function process(config: Config): Config {
  return { ...config, timeout: 5000 };
}
```

## 🔍 Code Review Checklist

Before submitting PR:

- [ ] Code follows naming conventions
- [ ] Types are properly defined (no `any`)
- [ ] Error handling is implemented
- [ ] Logging is appropriate
- [ ] Comments explain "why"
- [ ] Imports are organized
- [ ] Formatting is consistent
- [ ] Tests are added/updated
- [ ] No secrets in code
- [ ] Documentation is updated

## 📚 Additional Resources

- [TypeScript Style Guide](https://github.com/basarat/typescript-book/blob/master/docs/styleguide/styleguide.md)
- [SAP CAP Documentation](https://cap.cloud.sap/docs/)
- [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)

---

**Questions?** Check existing code for examples or ask in a PR comment!
