/** REST and MCP share the visibility/write guard after resolving a collection. */
export function collectionAccessError(
  meta: { scope?: string; owner?: string },
  userId: string,
  admin: boolean,
  mode: 'read' | 'write',
): { status: number; message: string } | undefined {
  if (meta.scope === 'global') {
    return mode === 'write' && !admin
      ? {
          status: 403,
          message: 'MCP_Admin role required for global collections',
        }
      : undefined;
  }
  if ((userId && userId !== 'anonymous' && meta.owner === userId) || admin)
    return undefined;
  return { status: 404, message: 'Collection not found' };
}
