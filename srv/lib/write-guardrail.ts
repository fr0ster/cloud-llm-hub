/** Legacy SAP write classification for transport error reporting. */
const WRITE_TOOL =
  /^(?:Create|Update|Delete|Activate|SortAndCompressTransportTask$|MoveTransportObjects$|DiscardBackgroundRun$)/i;

export function isWriteTool(name: string): boolean {
  return WRITE_TOOL.test(name);
}
