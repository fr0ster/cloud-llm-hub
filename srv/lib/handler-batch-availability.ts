import type { HandlerContext } from '@mcp-abap-adt/lib/handlers';

// lib 23.1.0 batch views carry no system kind; remove when the lib states it.
export const handlerBatchAvailability: NonNullable<
  HandlerContext['batchAvailability']
> = {
  available: () => false,
  noteOuterStatus: () => {},
};
