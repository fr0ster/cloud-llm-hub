# LLM Proxy Configuration Proposal

## Problem

The LLM agent needs to know how to connect to the MCP server, which is implemented in a separate repository (submodules/mcp-abap-adt) and accessible through the MCP proxy in the main project.

## Current Architecture

The MCP proxy receives configuration through HTTP headers:
- **Destination mode**: `X-SAP-Destination` header
- **Direct mode**: `X-SAP-URL`, `X-SAP-Auth-Type`, `X-SAP-JWT-Token`, etc.

## Solution: Parameter-Based Configuration

### Approach: Parameters at Agent Creation

**Advantages:**
- ✅ Simple to use
- ✅ No database dependency
- ✅ Suitable for simple cases
- ✅ Easy to test and debug
- ✅ Configuration is explicit and visible

**Disadvantages:**
- ⚠️ Configuration is hardcoded in code
- ⚠️ Cannot change configuration dynamically without code changes

**Example:**
```typescript
const agent = new Agent({
  llmProvider: new OpenAIProvider({ apiKey: '...' }),
  mcpConfig: {
    url: 'http://localhost:4004/mcp/stream/http',
    headers: {
      'Authorization': 'Basic YWxpY2U6',
      'X-SAP-Destination': 'SAP_DEV_DEST',
    },
  },
});
```

## Implementation

### AgentConfig Interface

```typescript
export interface AgentConfig {
  llmProvider: LLMProvider;
  /**
   * MCP client instance (if provided, will be used directly)
   * If not provided, will be created from mcpConfig
   */
  mcpClient?: MCPClientWrapper;
  /**
   * Direct MCP configuration (used if mcpClient is not provided)
   * If both mcpClient and mcpConfig are provided, mcpClient takes precedence
   */
  mcpConfig?: MCPClientConfig;
  maxIterations?: number;
}
```

### MCPClientConfig Interface

```typescript
export interface MCPClientConfig {
  /**
   * Transport type: 'stdio' | 'sse' | 'stream-http' | 'auto'
   * Default: 'auto' (detected from URL)
   */
  transport?: TransportType;
  
  /**
   * For stdio: command and args to execute
   */
  command?: string;
  args?: string[];
  
  /**
   * For HTTP transports: URL endpoint
   */
  url?: string;
  
  /**
   * Session ID for HTTP transports (optional)
   */
  sessionId?: string;
  
  /**
   * HTTP headers for authentication and configuration
   */
  headers?: Record<string, string>;
  
  /**
   * Timeout in milliseconds (default: 30000)
   */
  timeout?: number;
}
```

## Usage Examples

### Example 1: Destination Mode

```typescript
const agent = new Agent({
  llmProvider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }),
  mcpConfig: {
    url: 'http://localhost:4004/mcp/stream/http',
    headers: {
      'Authorization': 'Basic YWxpY2U6',
      'X-SAP-Destination': 'SAP_DEV_DEST',
    },
  },
});
```

### Example 2: Direct Mode

```typescript
const agent = new Agent({
  llmProvider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }),
  mcpConfig: {
    url: 'http://localhost:4004/mcp/stream/http',
    headers: {
      'Authorization': 'Basic YWxpY2U6',
      'X-SAP-URL': 'https://my-sap-system.example.com',
      'X-SAP-Auth-Type': 'jwt',
      'X-SAP-JWT-Token': process.env.SAP_JWT_TOKEN!,
      'X-SAP-Client': '100',
    },
  },
});
```

### Example 3: Pre-configured Client

```typescript
const mcpClient = new MCPClientWrapper({
  url: 'http://localhost:4004/mcp/stream/http',
  headers: {
    'Authorization': 'Basic YWxpY2U6',
    'X-SAP-Destination': 'SAP_DEV_DEST',
  },
});

const agent = new Agent({
  llmProvider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }),
  mcpClient: mcpClient,
});
```

## Implementation Status

1. ✅ Extended `AgentConfig` to support `mcpClient` and `mcpConfig`
2. ✅ Implemented MCP client wrapper with transport auto-detection
3. ✅ Added `connect()` method for async initialization
4. ✅ Updated documentation

## Future Enhancements (Optional)

If needed in the future, we can add:
- Configuration storage in database (OData service)
- Dynamic configuration management
- UI for configuration management
- Configuration versioning

But for now, parameter-based configuration is sufficient and keeps the solution simple.
