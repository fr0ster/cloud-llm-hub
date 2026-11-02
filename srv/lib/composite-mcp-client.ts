import type { IMcpClient } from '@mcp-abap-adt/llm-agent';

/** First listed owner wins name collisions; one non-cacheable part disables caching. */
export function compositeMcpClient(parts: IMcpClient[]): IMcpClient {
  const owners = new Map<string, IMcpClient>();
  const client: IMcpClient = {
    cacheable: parts.every((part) => part.cacheable !== false),
    async listTools(options) {
      const tools: Awaited<ReturnType<IMcpClient['listTools']>> = {
        ok: true,
        value: [],
      };
      owners.clear();
      for (const part of parts) {
        const result = await part.listTools(options);
        if (!result.ok) return result;
        for (const tool of result.value) {
          if (owners.has(tool.name)) continue;
          owners.set(tool.name, part);
          tools.value.push(tool);
        }
      }
      return tools;
    },
    async callTool(name, args, options) {
      if (!owners.has(name)) {
        const result = await client.listTools(options);
        if (!result.ok) return result;
      }
      const owner = owners.get(name);
      return owner
        ? owner.callTool(name, args, options)
        : {
            ok: true,
            value: { isError: true, content: `Tool not found: ${name}` },
          };
    },
    ...(parts.some((part) => part.healthCheck)
      ? {
          async healthCheck(options) {
            for (const part of parts) {
              const result = part.healthCheck
                ? await part.healthCheck(options)
                : await part.listTools(options);
              if (!result.ok) return result;
              if (result.value === false) return { ok: true, value: false };
            }
            return { ok: true, value: true };
          },
        }
      : {}),
  };
  return client;
}
