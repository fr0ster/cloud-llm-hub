import type { IMcpClient } from '@mcp-abap-adt/llm-agent';

/**
 * First listed owner wins name collisions; one non-cacheable part disables
 * caching. The last part is the primary client and receives unlisted names.
 */
export function compositeMcpClient(parts: IMcpClient[]): IMcpClient {
  let owners = new Map<string, IMcpClient>();
  const client: IMcpClient = {
    cacheable: parts.every((part) => part.cacheable !== false),
    async listTools(options) {
      const tools: Awaited<ReturnType<IMcpClient['listTools']>> = {
        ok: true,
        value: [],
      };
      const local = new Map<string, IMcpClient>();
      for (const part of parts) {
        const result = await part.listTools(options);
        if (!result.ok) return result;
        for (const tool of result.value) {
          if (local.has(tool.name)) continue;
          local.set(tool.name, part);
          tools.value.push(tool);
        }
      }
      owners = local;
      return tools;
    },
    async callTool(name, args, options) {
      if (!owners.has(name)) {
        const result = await client.listTools(options);
        if (!result.ok) return result;
      }
      // An unlisted name goes to the primary (last) part: its own guards
      // (forbidden names, unknown-tool errors) decide, not this router.
      const owner = owners.get(name) ?? parts.at(-1);
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
