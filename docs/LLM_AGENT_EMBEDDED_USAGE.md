# LLM Agent Embedded Usage Guide

## Overview

The LLM agent can be used in two ways:
1. **Standalone service** - Run as a separate process/service
2. **Embedded module** - Import and use directly in the same process (like `mcp-abap-adt` in `cloud-llm-hub`)

This guide focuses on embedded usage within CAP services.

**Architecture:**
- The agent is imported as a module (similar to how `@fr0ster/mcp-abap-adt` is imported)
- **Important:** Agent doesn't know about SAP destinations or MCP specifics
- `cloud-llm-hub` (wrapper layer) determines MCP configuration from request headers
- Architecture: Request → Agent Manager → extracts SAP config from headers → creates MCP client with headers → passes to Agent
- Agent → works with MCP client (agnostic to SAP)
- MCP Client → connects to MCP Proxy (via HTTP) with headers
- MCP Proxy → processes headers and creates embedded MCP Server (`mcp-abap-adt`) with SAP config

## Importing the Agent

### Basic Import

```typescript
import { Agent, OpenAIProvider, MCPClientWrapper } from '@cloud-llm-hub/llm-agent';
```

### Type Imports

```typescript
import type { 
  AgentConfig, 
  MCPClientConfig, 
  AgentResponse,
  Message 
} from '@cloud-llm-hub/llm-agent';
```

## Usage in CAP Service

### Example 1: Using Agent Manager (Recommended)

The `agent-manager.ts` wrapper handles all MCP configuration. Agent doesn't know about SAP:

```typescript
// srv/agent-service.ts
import cds, { Service, Request } from '@sap/cds';
import { getAgent } from './agent-manager';

export default class AgentService extends cds.Service {
  async init() {
    // Handlers use getAgent() which handles all MCP configuration
  }

  async chat(req: Request) {
    // Agent manager extracts SAP config from request headers
    // and creates MCP client with proper configuration
    const agent = await getAgent(req);
    return await agent.process(req.data.message);
  }
}
```

**Note:** Agent doesn't receive destination or SAP config directly. The wrapper (`agent-manager.ts`) handles all that.

### Example 2: Per-Request Agent with Dynamic Configuration

Similar to how `mcp-manager.ts` creates MCP servers per request:

```typescript
// srv/agent-manager.ts
import cds from '@sap/cds';
import type { Request } from 'express';
import { Agent, OpenAIProvider, MCPClientWrapper } from '@cloud-llm-hub/llm-agent';

interface AgentInstance {
  agent: Agent;
  created: number;
  expiresAt?: number;
}

const agentCache = new Map<string, AgentInstance>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Get or create agent instance for a request
 */
export async function getAgent(req: Request): Promise<Agent> {
  const log = cds.log('agent-manager');
  
  // Extract configuration from request headers
  const destination = req.headers['x-sap-destination'] as string | undefined;
  const cacheKey = destination || 'default';
  
  // Check cache
  const cached = agentCache.get(cacheKey);
  if (cached) {
    const now = Date.now();
    if (!cached.expiresAt || now < cached.expiresAt) {
      log.debug('Using cached agent instance', { cacheKey });
      return cached.agent;
    }
    // Expired, remove from cache
    agentCache.delete(cacheKey);
  }

  // Create new agent instance
  log.info('Creating new agent instance', { cacheKey });
  
  const mcpConfig: MCPClientConfig = {
    url: 'http://localhost:4004/mcp/stream/http',
    headers: {
      'Authorization': req.headers.authorization as string || 'Basic YWxpY2U6',
      ...(destination && { 'X-SAP-Destination': destination }),
    },
  };

  const agent = new Agent({
    llmProvider: new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o-mini',
    }),
    mcpConfig,
  });

  await agent.connect();

  // Cache instance
  const expiresAt = Date.now() + CACHE_TTL;
  agentCache.set(cacheKey, {
    agent,
    created: Date.now(),
    expiresAt,
  });

  return agent;
}
```

### Example 3: CAP Service with Agent Integration

```typescript
// srv/agent-service.cds
service AgentService {
  function Chat(message: String) returns String;
  function GetHistory() returns array of ChatMessage;
}

type ChatMessage {
  role: String;
  content: String;
  timestamp: DateTime;
}
```

```typescript
// srv/agent-service.ts
import cds, { Service, Request } from '@sap/cds';
import { Agent, OpenAIProvider } from '@cloud-llm-hub/llm-agent';
import { getAgent } from './agent-manager';

export default class AgentService extends cds.Service {
  async init() {
    // Register handlers
    this.on('Chat', this.handleChat);
    this.on('GetHistory', this.handleGetHistory);
  }

  async handleChat(req: Request) {
    const message = req.data.message as string;
    if (!message) {
      throw new Error('Message is required');
    }

    // Get agent instance for this request
    const agent = await getAgent(req as any);
    
    // Process message
    const response = await agent.process(message);
    
    if (response.error) {
      throw new Error(response.error);
    }

    return response.message;
  }

  async handleGetHistory(req: Request) {
    const agent = await getAgent(req as any);
    const history = agent.getHistory();
    
    return history.map(msg => ({
      role: msg.role,
      content: msg.content,
      timestamp: new Date(),
    }));
  }
}
```

## Integration with MCP Proxy

Since the agent connects to the MCP proxy (which embeds `mcp-abap-adt`), you can use the same proxy endpoints:

```typescript
// Agent connects to MCP proxy
const agent = new Agent({
  llmProvider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }),
  mcpConfig: {
    url: 'http://localhost:4004/mcp/stream/http', // Same proxy as MCP clients
    headers: {
      'Authorization': 'Basic YWxpY2U6',
      'X-SAP-Destination': 'SAP_DEV_DEST', // Same headers as MCP proxy
    },
  },
});
```

## Caching Strategy

Similar to `mcp-manager.ts`, you can cache agent instances:

```typescript
// Cache agents by configuration key
const agentCache = new Map<string, AgentInstance>();

function getCacheKey(config: MCPClientConfig): string {
  // Create unique key from configuration
  return `${config.url}:${config.headers?.['X-SAP-Destination'] || 'direct'}`;
}
```

## Error Handling

```typescript
try {
  const agent = await getAgent(req);
  const response = await agent.process(message);
  
  if (response.error) {
    log.error('Agent processing error', { error: response.error });
    throw new Error(response.error);
  }
  
  return response.message;
} catch (error: any) {
  log.error('Agent service error', { error: error.message });
  throw error;
}
```

## Best Practices

1. **Reuse agent instances** - Cache agents per configuration to avoid reconnecting
2. **Handle connection errors** - Implement retry logic for transient failures
3. **Clean up resources** - Disconnect agents when no longer needed
4. **Use request context** - Pass request headers to agent for proper authentication

## Comparison with Standalone Usage

| Aspect | Embedded | Standalone |
|--------|----------|------------|
| Process | Same as CAP service | Separate process |
| Configuration | From request headers | From config file/env |
| Caching | Shared with CAP service | Independent |
| Resource usage | Lower (shared process) | Higher (separate process) |
| Deployment | Single deployment | Separate deployment |

## Example: Complete Integration

```typescript
// srv/agent-service.ts
import cds, { Service, Request } from '@sap/cds';
import { Agent, OpenAIProvider, MCPClientWrapper } from '@cloud-llm-hub/llm-agent';
import type { MCPClientConfig } from '@cloud-llm-hub/llm-agent';

export default class AgentService extends cds.Service {
  private agentCache = new Map<string, Agent>();

  async init() {
    this.on('Chat', this.handleChat);
  }

  private async getOrCreateAgent(req: Request): Promise<Agent> {
    const destination = (req.headers['x-sap-destination'] as string) || 'default';
    
    // Check cache
    if (this.agentCache.has(destination)) {
      return this.agentCache.get(destination)!;
    }

    // Build MCP config from request
    const mcpConfig: MCPClientConfig = {
      url: `${req.protocol}://${req.get('host')}/mcp/stream/http`,
      headers: {
        'Authorization': req.headers.authorization as string || '',
        ...(destination !== 'default' && { 'X-SAP-Destination': destination }),
      },
    };

    // Create agent
    const agent = new Agent({
      llmProvider: new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY!,
      }),
      mcpConfig,
    });

    await agent.connect();
    this.agentCache.set(destination, agent);

    return agent;
  }

  async handleChat(req: Request) {
    const message = req.data.message as string;
    const agent = await this.getOrCreateAgent(req);
    const response = await agent.process(message);
    
    if (response.error) {
      throw new Error(response.error);
    }
    
    return response.message;
  }
}
```
