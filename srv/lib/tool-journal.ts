import { AsyncLocalStorage } from 'node:async_hooks';
import type { transportDocuments } from '@mcp-abap-adt/adt-clients';
import type { StepError } from '@mcp-abap-adt/lib/dist/lib/strategies/stepResponse';
import type {
  ILlm,
  McpToolResult,
  Message,
  ToolCallRecord,
} from '@mcp-abap-adt/llm-agent';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import {
  type CollectionAddress,
  collectionAddress,
} from './collection-address';
import { toolObjects } from './tool-objects';
import type { ToolResultRejection } from './tool-result-cap';
import { isWriteTool } from './write-guardrail';

const journalSystem = z.enum(['sap', 'rag', 'user-mcp']);
export type JournalSystem = z.infer<typeof journalSystem>;
export type JournalOutcome = 'succeeded' | 'failed' | 'unconfirmed';
export interface JournalEntry extends ToolCallRecord {
  answered: boolean;
  system?: JournalSystem;
  ragScope?: CollectionAddress['scope'];
  write: boolean;
  rejection?: ToolResultRejection;
}

export function isUnansweredWrite(entry: JournalEntry): boolean {
  return !entry.answered && (entry.write || isWriteTool(entry.call.name));
}

export function hasUnansweredSapWrite(
  entries: Iterable<JournalEntry>,
): boolean {
  for (const entry of entries) {
    if (entry.system === 'sap' && isUnansweredWrite(entry)) return true;
  }
  return false;
}

export type SapTarget = { type: string; name: string };
export type RagTarget = CollectionAddress & { record?: string };
export type JournalTarget = SapTarget | RagTarget;

type Json = z.infer<ReturnType<typeof z.json>>;

const jsonSchema = z.json();
const textPart = z.object({ type: z.literal('text'), text: z.string() });
const resultWrapper = z.object({
  content: jsonSchema.optional(),
  structuredContent: jsonSchema.optional(),
  isError: z.boolean().optional(),
});
const completedOperation = z.object({
  operation: z.literal('succeeded') satisfies z.ZodType<StepError['operation']>,
  cleanup: jsonSchema.optional(),
  message: z.string().optional(),
  error: jsonSchema.optional(),
});

export function journalPayload(
  content: McpToolResult['content'] | Json,
): Json | undefined {
  if (typeof content === 'string') {
    try {
      const value = jsonSchema.parse(JSON.parse(content));
      return typeof value === 'string' ? value : journalPayload(value);
    } catch {
      return content.trim() || undefined;
    }
  }
  if (Array.isArray(content)) {
    let text: string | undefined;
    for (const part of content) {
      const parsed = textPart.safeParse(part);
      if (parsed.success) {
        const value = journalPayload(parsed.data.text);
        if (value !== undefined && typeof value !== 'string') return value;
        text ??= value;
      }
    }
    return text ?? jsonSchema.safeParse(content).data;
  }
  const wrapper = resultWrapper.safeParse(content).data;
  const value = jsonSchema.safeParse(content).data;
  if (wrapper?.isError) {
    const inner = wrapper.structuredContent ?? wrapper.content;
    const payload = inner === undefined ? undefined : journalPayload(inner);
    if (payload && typeof payload === 'object' && !Array.isArray(payload))
      return { ...payload, isError: true };
    return value;
  }
  if (wrapper?.structuredContent !== undefined)
    return journalPayload(wrapper.structuredContent);
  if (
    value &&
    typeof value === 'object' &&
    ('success' in value ||
      'status' in value ||
      'error' in value ||
      'operation' in value)
  )
    return value;
  return wrapper?.content === undefined
    ? value
    : journalPayload(wrapper.content);
}

export const journalSnapshotSchema = z.object({
  requestId: z.string().optional(),
  entries: z.array(
    z.object({
      call: z.object({
        id: z.string(),
        name: z.string(),
        arguments: z.record(z.string(), jsonSchema),
      }),
      result: z.object({
        content: z.union([
          z.string(),
          z.record(z.string(), jsonSchema),
          z.array(
            z.looseObject({ type: z.string(), text: z.string().optional() }),
          ),
        ]),
        isError: z.boolean().optional(),
      }),
      answered: z.boolean(),
      write: z.boolean(),
      system: journalSystem.optional(),
      ragScope: collectionAddress.shape.scope.optional(),
    }),
  ),
});

export type JournalSnapshot = {
  requestId?: string;
  entries: JournalEntry[];
};

const resultFields = z.object({
  success: z.boolean().optional(),
  error: jsonSchema.optional(),
  isError: z.boolean().optional(),
  status: z.union([z.string(), z.number()]).optional(),
  cleanup: jsonSchema.optional(),
});

const published = z.object({
  result: z.literal('SUCCESS'),
  completion: z.literal('done'),
});
const activated = z.object({
  activated: z.boolean(),
  nothing_to_activate: z.boolean().optional(),
});
const deleted = z.object({ deleted: z.boolean() });
const wireBoolean = z.enum(['true', 'false']);
const activationDocument = z.object({
  'chkl:messages': z.object({
    'chkl:properties': z.object({
      '@': z.object({ activationExecuted: wireBoolean }),
    }),
  }),
});
const deletionItem = z.object({
  '@': z.object({ 'del:isDeleted': wireBoolean }),
});
const deletionDocument = z.object({
  'del:deletionResult': z.object({
    'del:object': z.union([deletionItem, z.array(deletionItem).min(1)]),
  }),
});
const wrappedResult = z.object({ result: jsonSchema });
const xml = new XMLParser({
  ignoreAttributes: false,
  attributesGroupName: '@',
  attributeNamePrefix: '',
  processEntities: false,
});

function resultDocument(data: Json | undefined): Json | undefined {
  const body = wrappedResult.safeParse(data).data?.result ?? data;
  if (typeof body !== 'string' || !body.startsWith('<')) return body;
  if (XMLValidator.validate(body) !== true) return undefined;
  return parseSapDocument(body);
}

function parseSapDocument(
  body: ReturnType<typeof transportDocuments.createdTask>,
): Json | undefined {
  try {
    return jsonSchema.safeParse(xml.parse(body)).data;
  } catch {
    return undefined;
  }
}

function booleanOutcome(value: boolean | undefined): JournalOutcome {
  return value === undefined ? 'unconfirmed' : value ? 'succeeded' : 'failed';
}

// These handlers publish their own boolean success projection. Most CRUD
// handlers instead use the ADT library's terseWrite or terseDeletion output.
const sapBooleanSuccessTools = new Set([
  'UpdateDomainLow',
  'UpdateDataElementLow',
  'UpdatePackageLow',
  'CreateMessageClassMessage',
  'UpdateMessageClassMessage',
  'DeleteMessageClassMessage',
  'RuntimeCreateProfilerTraceParameters',
]);

function sapOutcome(tool: string, data: Json | undefined): JournalOutcome {
  switch (tool) {
    case 'CreateTransport':
    case 'CreateTransportTask':
      return generatedTransportNumber(tool, data) ? 'succeeded' : 'unconfirmed';
    case 'AddTransportObject':
    case 'RemoveTransportObject':
    case 'MoveTransportObjects':
    case 'SortAndCompressTransportTask':
      // The CTS responses acknowledge the request without confirming a change.
      return 'unconfirmed';
    case 'UpdateServiceBinding':
      return published.safeParse(data).success ? 'succeeded' : 'unconfirmed';
  }
  if (sapBooleanSuccessTools.has(tool))
    return booleanOutcome(resultFields.safeParse(data).data?.success);
  if (!Object.hasOwn(toolObjects, tool)) return 'unconfirmed';
  if (tool.startsWith('Activate')) {
    const result = activated.safeParse(data).data;
    if (result)
      return booleanOutcome(
        result.nothing_to_activate ? undefined : result.activated,
      );
    const properties = activationDocument.safeParse(resultDocument(data))
      .data?.['chkl:messages']['chkl:properties']['@'];
    return booleanOutcome(
      properties && properties.activationExecuted === 'true',
    );
  }
  const body = wrappedResult.safeParse(data).data?.result ?? data;
  if (body === 'SUCCESS' && /^(?:Create|Update|Delete)/.test(tool))
    return 'succeeded';
  if (tool.startsWith('Delete')) {
    const result = deleted.safeParse(data).data;
    if (result) return booleanOutcome(result.deleted);
    const objects = deletionDocument.safeParse(resultDocument(data)).data?.[
      'del:deletionResult'
    ]['del:object'];
    if (objects)
      return booleanOutcome(
        [objects]
          .flat()
          .every((object) => object['@']['del:isDeleted'] === 'true'),
      );
  }
  return 'unconfirmed';
}

const ragWriteConfirmations: Readonly<Record<string, z.ZodType>> = {
  collection_create: z.object({ created: z.literal(true) }),
  collection_delete: deleted.extend({ deleted: z.literal(true) }),
  collection_set_enabled: z.object({ id: z.string(), enabled: z.boolean() }),
  collection_set_trust: z.object({ updated: z.literal(true) }),
  record_add: z.object({ record: z.string(), created: z.literal(true) }),
  record_delete: z.object({ record: z.string(), deleted: z.literal(true) }),
  record_set_enabled: z
    .object({ collection: z.string(), enabled: z.boolean() })
    .and(
      z.union([
        z.object({ id: z.string() }),
        z.object({ updated: z.number().positive() }),
      ]),
    ),
  record_set_trust: z.object({ updated: z.literal(true) }),
  record_update: z.object({ record: z.string(), updated: z.literal(true) }),
  rag_persist: z.object({
    collection: z.string(),
    records: z.array(z.string()).min(1),
  }),
};

export function journalOutcome(entry: JournalEntry): JournalOutcome {
  if (!entry.answered) return 'unconfirmed';
  const data = journalPayload(entry.result.content);
  const result = resultFields.safeParse(data).data;
  if (entry.system === 'sap' && completedOperation.safeParse(data).success)
    return 'succeeded';
  if (entry.system === 'user-mcp')
    return entry.result.isError || result?.isError ? 'failed' : 'unconfirmed';
  const status = result?.status;
  if (
    entry.result.isError ||
    result?.isError ||
    result?.success === false ||
    result?.error ||
    status === 'error' ||
    status === 'failed' ||
    (typeof status === 'number' && status >= 400)
  )
    return 'failed';
  if (entry.system === 'sap') return sapOutcome(entry.call.name, data);
  if (
    entry.system === 'rag' &&
    Object.hasOwn(ragWriteConfirmations, entry.call.name) &&
    ragWriteConfirmations[entry.call.name].safeParse(data).success
  )
    return 'succeeded';
  return 'unconfirmed';
}

function journalNote(
  entry: JournalEntry,
  outcome: JournalOutcome,
): Json | undefined {
  if (entry.system !== 'sap' || outcome !== 'succeeded') return undefined;
  const data = journalPayload(entry.result.content);
  const result = resultFields.safeParse(data).data;
  const completion = completedOperation.safeParse(data).data;
  return (
    result?.cleanup ??
    completion?.cleanup ??
    completion?.message ??
    completion?.error
  );
}

// For handlers that act on a named object and can return a terse SUCCESS,
// these input keys identify the object addressed by the write.
const sapTargetFields: Record<string, readonly string[]> = {
  behaviorDefinition: ['name'],
  behaviorImplementation: ['class_name'],
  class: ['class_name'],
  dataElement: ['data_element_name'],
  ddl: ['ddl_name'],
  domain: ['domain_name'],
  functionGroup: ['function_group_name'],
  functionInclude: ['include_name'],
  functionModule: ['function_module_name'],
  include: ['include_name'],
  interface: ['interface_name'],
  messageClass: ['message_class_name'],
  metadataExtension: ['name'],
  package: ['package_name'],
  program: ['program_name'],
  service: ['service_binding_name', 'service_name'],
  serviceDefinition: ['service_definition_name'],
  structure: ['structure_name'],
  table: ['table_name'],
  tableType: ['table_type_name'],
  transport: ['task_number', 'transport_number'],
  unitTest: [
    'class_name',
    'cds_view_name',
    'function_group_name',
    'program_name',
  ],
};
const name = z.string().min(1);
const namedObject = z.object({
  type: name,
  name,
});
const batchActivation = z.object({ objects: z.array(namedObject) });
function stringField(data: Json | undefined, key: string) {
  if (data && typeof data === 'object' && !Array.isArray(data))
    return name.safeParse(data[key]).data;
}

const transportAttributes = z.object({ '@': z.object({ 'tm:number': name }) });
const taskDocument = z.object({ 'tm:root': transportAttributes });
const requestDocument = z.object({
  'tm:root': z.object({ 'tm:request': transportAttributes }),
});

function generatedTransportNumber(
  tool: string,
  data: Json | undefined,
): string | undefined {
  const task = tool === 'CreateTransportTask';
  const terse = stringField(data, task ? 'task_number' : 'transport_number');
  if (terse) return terse;
  const document = resultDocument(data);
  const attributes = task
    ? (taskDocument.safeParse(document).data?.['tm:root'] ??
      transportAttributes.safeParse(document).data)
    : requestDocument.safeParse(document).data?.['tm:root']['tm:request'];
  return attributes?.['@']['tm:number'];
}

function sapTargets(entry: JournalEntry, data: Json | undefined): SapTarget[] {
  const { name: tool, arguments: args } = entry.call;
  if (tool === 'ActivateObjects') {
    return (
      batchActivation.safeParse(data).data?.objects ??
      batchActivation.safeParse(args).data?.objects ??
      []
    );
  }
  const type = toolObjects[tool];
  if (!type) return [];
  if (tool === 'CreateTransportTask' || tool === 'CreateTransport') {
    const generated = generatedTransportNumber(tool, data);
    return generated ? [{ type, name: generated }] : [];
  }
  const fields = sapTargetFields[type] ?? [];
  const returned =
    fields.map((key) => stringField(data, key)).find(Boolean) ??
    stringField(data, 'name');
  const requested =
    fields.map((key) => name.safeParse(args[key]).data).find(Boolean) ??
    name.safeParse(args.transport_number).data;
  const identity = returned ?? requested;
  return identity ? [{ type, name: identity }] : [];
}

const ragResult = z.object({
  scope: collectionAddress.shape.scope.optional(),
  collection: name.optional(),
  name: name.optional(),
  record: name.optional(),
  records: z.array(name).optional(),
  recordIds: z.array(name).optional(),
  id: name.optional(),
});
const ragArguments = z.object({
  record: name.optional(),
  id: name.optional(),
  name: name.optional(),
  scope: collectionAddress.shape.scope.optional(),
  collection: z.union([collectionAddress, name]).optional(),
  to: collectionAddress.optional(),
  records: z.array(name).optional(),
});

function address(value: string | undefined): CollectionAddress | undefined {
  if (!value) return undefined;
  const [scope, collection] = value.split('/');
  if (value === `${scope}/${collection}`) {
    const parsed = collectionAddress.safeParse({ scope, collection });
    if (parsed.success) return parsed.data;
  }
  const physical = /^(.*)__(u|s)_[a-f0-9]{16}$/.exec(value);
  if (physical)
    return {
      scope: physical[2] === 'u' ? 'user' : 'session',
      collection: physical[1],
    };
  return undefined;
}

function ragTargets(entry: JournalEntry, data: Json | undefined): RagTarget[] {
  const { name: tool, arguments: args } = entry.call;
  const result = ragResult.safeParse(data).data;
  const input = ragArguments.safeParse(args).data;
  const returned =
    tool === 'collection_set_enabled' ? result?.id : result?.collection;
  const requested =
    tool === 'rag_persist'
      ? input?.to
      : typeof input?.collection === 'string'
        ? address(input.collection)
        : input?.collection;
  const identity =
    address(returned) ??
    collectionAddress.safeParse({
      scope: result?.scope ?? input?.scope ?? entry.ragScope,
      collection:
        result?.name ??
        returned ??
        input?.name ??
        (typeof input?.collection === 'string' ? input.collection : undefined),
    }).data ??
    (returned && requested?.collection !== returned
      ? collectionAddress.safeParse({ scope: 'global', collection: returned })
          .data
      : requested);
  if (!identity) return [];
  const record =
    result?.record ??
    (tool === 'record_set_enabled' || tool === 'rag_read'
      ? result?.id
      : undefined) ??
    input?.record ??
    input?.id;
  const records =
    result?.records ??
    result?.recordIds ??
    (tool === 'rag_persist' ? input?.records : undefined) ??
    (record ? [record] : []);
  return records.length
    ? records.map((id) => ({ ...identity, record: id }))
    : [identity];
}

export function journalTargets(entry: JournalEntry): JournalTarget[] {
  const data = journalPayload(entry.result.content);
  if (entry.system === 'sap') return sapTargets(entry, data);
  if (entry.system === 'rag') return ragTargets(entry, data);
  return [];
}

export function writeActions(
  journal: Iterable<JournalEntry>,
): string | undefined {
  const lines: string[] = [];
  for (const entry of journal) {
    if (!entry.write || !entry.system) continue;
    const outcome = journalOutcome(entry);
    lines.push(
      JSON.stringify({
        callId: entry.call.id,
        system: entry.system,
        operation: entry.call.name,
        targets: journalTargets(entry),
        outcome,
        note: journalNote(entry, outcome),
      }),
    );
  }
  return lines.length
    ? `[actions] Tool writes
${lines.join('\n')}`
    : undefined;
}

const actionContext = new AsyncLocalStorage<() => Iterable<JournalEntry>>();

export function withWriteActions<T>(
  entries: () => Iterable<JournalEntry>,
  run: () => T,
): T {
  return actionContext.run(entries, run);
}

export function writeActionMessages(messages: Message[]): Message[] {
  const entries = actionContext.getStore()?.();
  const actions = entries && writeActions(entries);
  return actions ? [...messages, { role: 'user', content: actions }] : messages;
}

export function withWriteActionsLlm(llm: ILlm): ILlm {
  return {
    get model() {
      return llm.model;
    },
    chat: (messages, tools, options) =>
      llm.chat(writeActionMessages(messages), tools, options),
    streamChat: (messages, tools, options) =>
      llm.streamChat(writeActionMessages(messages), tools, options),
    healthCheck: llm.healthCheck?.bind(llm),
    getModels: llm.getModels?.bind(llm),
  };
}
