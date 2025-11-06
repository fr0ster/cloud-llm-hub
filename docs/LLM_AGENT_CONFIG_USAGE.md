# LLM Agent Configuration Usage Guide

## Overview

The LLM agent is configured through parameters when creating an instance. All necessary settings for connecting to the MCP server are passed via `mcpConfig` or `mcpClient`.

## Configuration via Parameters

### Example 1: Destination Mode

When using SAP Destination Service, specify the destination name in headers:

```typescript
import { Agent, OpenAIProvider, MCPClientWrapper } from '@cloud-llm-hub/llm-agent';

const agent = new Agent({
  llmProvider: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o-mini',
  }),
  mcpConfig: {
    url: 'http://localhost:4004/mcp/stream/http',
    headers: {
      'Authorization': 'Basic YWxpY2U6',
      'X-SAP-Destination': 'SAP_DEV_DEST',
    },
  },
});

await agent.connect();
const response = await agent.process('What tools are available?');
console.log(response.message);
```

### Example 2: Direct Mode (without Destination)

If not using Destination Service, you can pass SAP parameters directly:

```typescript
const agent = new Agent({
  llmProvider: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
  }),
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

await agent.connect();
const response = await agent.process('What tools are available?');
```

### Example 3: Using Pre-configured MCP Client

You can also create the MCP client separately and pass it to the agent:

```typescript
import { Agent, OpenAIProvider, MCPClientWrapper } from '@cloud-llm-hub/llm-agent';

const mcpClient = new MCPClientWrapper({
  url: 'http://localhost:4004/mcp/stream/http',
  headers: {
    'Authorization': 'Basic YWxpY2U6',
    'X-SAP-Destination': 'SAP_DEV_DEST',
  },
});

const agent = new Agent({
  llmProvider: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
  }),
  mcpClient: mcpClient,
});

await agent.connect();
```

### Example 4: Auto-Detection of Transport

The agent can automatically detect the transport type from the URL:

```typescript
// Auto-detects 'stream-http' from URL
const agent = new Agent({
  llmProvider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }),
  mcpConfig: {
    url: 'http://localhost:4004/mcp/stream/http', // Auto-detects 'stream-http'
    headers: {
      'Authorization': 'Basic YWxpY2U6',
      'X-SAP-Destination': 'SAP_DEV_DEST',
    },
  },
});

// Or explicitly specify transport
const agent2 = new Agent({
  llmProvider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }),
  mcpConfig: {
    transport: 'sse', // Explicitly set to SSE
    url: 'http://localhost:4004/mcp/stream/sse',
    headers: {
      'Authorization': 'Basic YWxpY2U6',
      'X-SAP-Destination': 'SAP_DEV_DEST',
    },
  },
});
```

## Available Headers

### Authentication Headers

- `Authorization`: Basic or Bearer token for MCP proxy authentication
  - Basic: `Basic YWxpY2U6` (base64 encoded username:password)
  - Bearer: `Bearer <JWT_TOKEN>`

### SAP Configuration Headers (Destination Mode)

- `X-SAP-Destination`: Name of the destination in SAP BTP Destination Service

### SAP Configuration Headers (Direct Mode)

- `X-SAP-URL`: Direct SAP system URL
- `X-SAP-Auth-Type`: Authentication type (`jwt` or `basic`)
- `X-SAP-JWT-Token`: SAP JWT token (for JWT auth)
- `X-SAP-Username`: SAP username (for Basic auth)
- `X-SAP-Password`: SAP password (for Basic auth)
- `X-SAP-Client`: SAP client number

## Transport Types

### stdio

For local processes and CLI tools:

```typescript
mcpConfig: {
  transport: 'stdio',
  command: 'node',
  args: ['path/to/mcp-server.js'],
}
```

### sse (Server-Sent Events)

For one-way streaming from server to client:

```typescript
mcpConfig: {
  transport: 'sse',
  url: 'http://localhost:4004/mcp/stream/sse',
  headers: { /* ... */ },
}
```

### stream-http (Streamable HTTP)

For bidirectional NDJSON streaming (recommended for production):

```typescript
mcpConfig: {
  transport: 'stream-http',
  url: 'http://localhost:4004/mcp/stream/http',
  headers: { /* ... */ },
}
```

### auto

Automatically detect transport from URL (default):

```typescript
mcpConfig: {
  transport: 'auto', // or omit this field
  url: 'http://localhost:4004/mcp/stream/http', // Will detect 'stream-http'
  headers: { /* ... */ },
}
```

## Complete Example

```typescript
import { Agent, OpenAIProvider } from '@cloud-llm-hub/llm-agent';

async function main() {
  // Create agent with configuration
  const agent = new Agent({
    llmProvider: new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o-mini',
      temperature: 0.7,
    }),
    mcpConfig: {
      url: 'http://localhost:4004/mcp/stream/http',
      headers: {
        'Authorization': 'Basic YWxpY2U6',
        'X-SAP-Destination': 'SAP_DEV_DEST',
      },
      timeout: 30000,
    },
    maxIterations: 5,
  });

  // Connect to MCP server
  await agent.connect();

  // Process user message
  const response = await agent.process('List all available ABAP classes');
  
  if (response.error) {
    console.error('Error:', response.error);
  } else {
    console.log('Response:', response.message);
  }

  // Get conversation history
  const history = agent.getHistory();
  console.log('History:', history);
}
```

## Error Handling

```typescript
try {
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

  await agent.connect();
  const response = await agent.process('What tools are available?');
  
  if (response.error) {
    console.error('Agent error:', response.error);
  } else {
    console.log('Success:', response.message);
  }
} catch (error: any) {
  console.error('Failed to create or connect agent:', error.message);
}
```

## Best Practices

1. **Store sensitive data in environment variables:**
   ```typescript
   headers: {
     'Authorization': `Basic ${Buffer.from(`${process.env.MCP_USER}:${process.env.MCP_PASS}`).toString('base64')}`,
     'X-SAP-Destination': process.env.SAP_DESTINATION!,
   }
   ```

2. **Use appropriate transport for your use case:**
   - Development: `stdio` or `sse`
   - Production: `stream-http`

3. **Handle connection errors:**
   ```typescript
   try {
     await agent.connect();
   } catch (error) {
     console.error('Connection failed:', error);
     // Retry or fallback logic
   }
   ```

4. **Reuse agent instance:**
   - Create agent once and reuse for multiple requests
   - Connection is maintained between requests
