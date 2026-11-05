import {
  BaseHandlerGroup,
  CompositeHandlersRegistry,
  type HandlerContext,
  HandlerExporter,
  type HandlerExporterOptions,
} from '@mcp-abap-adt/lib/handlers';

export function boundHandlerExporter(
  context: HandlerContext,
  options: HandlerExporterOptions,
): HandlerExporter {
  const exporter = new HandlerExporter(options);
  const registry = exporter.createRegistry();
  if (!(registry instanceof CompositeHandlersRegistry))
    throw new Error('HandlerExporter returned an unsupported registry');
  for (const group of registry.getHandlerGroups()) {
    if (!(group instanceof BaseHandlerGroup))
      throw new Error('HandlerExporter returned an unsupported handler group');
    Object.assign(group.currentContext(), context);
  }
  return exporter;
}
