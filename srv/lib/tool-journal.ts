import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ILlm,
  McpToolResult,
  Message,
  ToolCallRecord,
} from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import {
  type CollectionAddress,
  collectionAddress,
} from './collection-address';
import { toolObjects } from './tool-objects';
import type { ToolResultRejection } from './tool-result-cap';

export type JournalSystem = 'sap' | 'rag';
export type JournalOutcome = 'succeeded' | 'failed' | 'unconfirmed';
export interface JournalEntry extends ToolCallRecord {
  answered: boolean;
  system?: JournalSystem;
  ragScope?: CollectionAddress['scope'];
  write: boolean;
  rejection?: ToolResultRejection;
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
  if (wrapper?.isError) return value;
  if (wrapper?.structuredContent !== undefined)
    return journalPayload(wrapper.structuredContent);
  if (
    value &&
    typeof value === 'object' &&
    ('success' in value || 'status' in value || 'error' in value)
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
      system: z.enum(['sap', 'rag']).optional(),
      ragScope: collectionAddress.shape.scope.optional(),
    }),
  ),
});

export type JournalSnapshot = {
  requestId?: string;
  entries: JournalEntry[];
};

const failure = z.object({
  success: z.boolean().optional(),
  error: jsonSchema.optional(),
  isError: z.boolean().optional(),
  status: z.union([z.string(), z.number()]).optional(),
});

export function journalOutcome(entry: JournalEntry): JournalOutcome {
  if (!entry.answered) return 'unconfirmed';
  const result = failure.safeParse(journalPayload(entry.result.content)).data;
  const status = result?.status;
  return entry.result.isError ||
    result?.isError ||
    result?.success === false ||
    result?.error ||
    status === 'error' ||
    status === 'failed' ||
    (typeof status === 'number' && status >= 400)
    ? 'failed'
    : 'succeeded';
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
const names = z.record(z.string(), z.json());
const stringField = (data: Json | undefined, key: string) =>
  name.safeParse(names.safeParse(data).data?.[key]).data;

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
  const generatedKey =
    tool === 'CreateTransportTask'
      ? 'task_number'
      : tool === 'CreateTransport'
        ? 'transport_number'
        : undefined;
  if (generatedKey) {
    const generated = stringField(data, generatedKey);
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
    lines.push(
      JSON.stringify({
        callId: entry.call.id,
        system: entry.system,
        operation: entry.call.name,
        targets: journalTargets(entry),
        outcome: journalOutcome(entry),
      }),
    );
  }
  return lines.length
    ? `[actions] SAP and RAG writes
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
