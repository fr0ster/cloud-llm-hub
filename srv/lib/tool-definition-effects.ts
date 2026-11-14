import type { ToolEffectAnnotations } from './tool-authorization';

/**
 * Core 23.1 exposes its explicit read-only declaration as a description tag,
 * without MCP annotations. Normalize that legacy declaration at the MCP boundary
 * and use the same annotations for corpus construction. Native annotations win;
 * an unannotated definition without this upstream declaration remains a writer.
 */
export function toolDefinitionAnnotations(definition: {
  description?: string;
  annotations?: ToolEffectAnnotations;
}): ToolEffectAnnotations | undefined {
  return (
    definition.annotations ??
    (definition.description?.startsWith('[read-only]')
      ? { readOnlyHint: true }
      : undefined)
  );
}
