import type { McpToolResult, ToolCallRecord } from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import type { WriteClaim } from './checker-verdict-schema';
import { collectionAddress, isRagWriteTool } from './rag-tool-catalogue';
import type { ReviewIssue, ReviewVerdict } from './reviewer-core';
import { toolObjects } from './tool-objects';

type SapClaim = Extract<WriteClaim, { system: 'sap' }>;
type RagClaim = Extract<WriteClaim, { system: 'rag' }>;
type Json = z.infer<ReturnType<typeof z.json>>;

const jsonSchema = z.json();
const textPart = z.object({ type: z.literal('text'), text: z.string() });
const resultWrapper = z.object({
  content: jsonSchema.optional(),
  structuredContent: jsonSchema.optional(),
  isError: z.boolean().optional(),
});

function payload(content: McpToolResult['content'] | Json): Json | undefined {
  if (typeof content === 'string') {
    try {
      const value = jsonSchema.parse(JSON.parse(content));
      return typeof value === 'string' ? value : payload(value);
    } catch {
      return content.trim() || undefined;
    }
  }
  if (Array.isArray(content)) {
    let text: string | undefined;
    for (const part of content) {
      const parsed = textPart.safeParse(part);
      if (parsed.success) {
        const value = payload(parsed.data.text);
        if (value !== undefined && typeof value !== 'string') return value;
        text ??= value;
      }
    }
    return text;
  }
  const wrapper = resultWrapper.safeParse(content).data;
  if (wrapper?.isError) return undefined;
  const nested = wrapper?.structuredContent ?? wrapper?.content;
  return nested === undefined
    ? jsonSchema.safeParse(content).data
    : payload(nested);
}

const failure = z.object({
  success: z.boolean().optional(),
  error: jsonSchema.optional(),
  isError: z.boolean().optional(),
  status: z.union([z.string(), z.number()]).optional(),
});

const sapOperations = {
  created: 'Create',
  updated: 'Update',
  deleted: 'Delete',
  activated: 'Activate',
} satisfies Record<SapClaim['operation'], string>;

// SAP handler input keys, indexed by the object types in tool-objects.json.
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
  transport: ['transport_number'],
  unitTest: [
    'class_name',
    'cds_view_name',
    'function_group_name',
    'program_name',
  ],
};
const sapActivation = z.object({
  status: z.string().optional(),
  activated: z.boolean().optional(),
  activation: z.object({ activated: z.boolean() }).optional(),
});
const batchActivation = z.object({
  objects: z.array(z.object({ type: z.string(), name: z.string() })),
});
const sapResultTarget = z.object({ name: z.string(), type: z.string() });

function verifiesSap(
  claim: SapClaim,
  call: ToolCallRecord['call'],
  result: Json,
) {
  const tool = call.name;
  const operationMatches = tool.startsWith(sapOperations[claim.operation]);
  if (claim.operation === 'activated') {
    const activation = sapActivation.safeParse(result).data;
    const activated =
      activation?.activated ?? activation?.activation?.activated;
    if (activated === false || activation?.status === 'inactive') return false;
    if (!operationMatches) {
      if (!tool.startsWith('Create') && !tool.startsWith('Update'))
        return false;
      if (activated !== true && activation?.status !== 'active') return false;
    }
  } else if (!operationMatches) return false;

  const { target } = claim;
  const sameName = (name: string) =>
    name.toUpperCase() === target.name.toUpperCase();
  if (tool === 'ActivateObjects') {
    return batchActivation
      .safeParse(call.arguments)
      .data?.objects.some(
        (object) =>
          object.type.toUpperCase() === target.type.toUpperCase() &&
          sameName(object.name),
      );
  }
  const type = toolObjects[tool];
  if (!type || type !== target.type) return false;

  for (const field of sapTargetFields[type] ?? []) {
    const name = z.string().safeParse(call.arguments[field]).data;
    if (name !== undefined) return sameName(name);
  }
  const returned = sapResultTarget.safeParse(result).data;
  return (
    returned?.type.toLowerCase() === type.toLowerCase() &&
    sameName(returned.name)
  );
}

const ragResult = z.object({
  scope: collectionAddress.shape.scope.optional(),
  collection: z.string().optional(),
  name: z.string().optional(),
  record: z.string().optional(),
  records: z.array(z.string()).optional(),
  recordIds: z.array(z.string()).optional(),
  id: z.string().optional(),
  created: z.boolean().optional(),
  updated: z.union([z.boolean(), z.number()]).optional(),
  deleted: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
const ragArguments = z.object({
  record: z.string().optional(),
  collection: z.union([collectionAddress, z.string()]).optional(),
  to: collectionAddress.optional(),
});

function address(value: string | undefined) {
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

function verifiesRag(
  claim: RagClaim,
  call: ToolCallRecord['call'],
  result: Json,
) {
  const data = ragResult.safeParse(result).data;
  const args = ragArguments.safeParse(call.arguments).data;
  if (!data || !args) return false;

  const returned =
    call.name === 'collection_set_enabled' ? data.id : data.collection;
  const requested =
    call.name === 'rag_persist'
      ? args.to
      : typeof args.collection === 'string'
        ? address(args.collection)
        : args.collection;
  const identity =
    address(returned) ||
    (data.scope && { scope: data.scope, collection: data.name ?? returned }) ||
    (requested?.collection === returned ? requested : undefined) ||
    (returned && { scope: 'global', collection: returned });
  const { scope, collection, record } = claim.target;
  if (
    !identity ||
    identity.scope !== scope ||
    identity.collection !== collection ||
    (data.scope !== undefined && data.scope !== scope) ||
    (data.name !== undefined && data.name !== collection) ||
    (requested &&
      (requested.scope !== scope || requested.collection !== collection))
  )
    return false;

  const { operation } = claim;
  switch (call.name) {
    case 'rag_persist':
      return (
        (operation === 'persisted' ||
          operation === 'created' ||
          operation === 'updated') &&
        (record === undefined
          ? operation === 'persisted' && Boolean(data.records?.length)
          : data.records?.includes(record))
      );
    case 'collection_create':
      return (
        record === undefined && operation === 'created' && data.created === true
      );
    case 'collection_delete':
      return (
        record === undefined && operation === 'deleted' && data.deleted === true
      );
    case 'collection_set_enabled':
      return (
        record === undefined &&
        operation === (data.enabled === true ? 'enabled' : 'disabled') &&
        data.enabled !== undefined
      );
    case 'collection_set_trust':
      return (
        record === undefined && operation === 'updated' && data.updated === true
      );
    case 'record_add':
      return (
        record !== undefined &&
        record === data.record &&
        operation === 'created' &&
        data.created === true
      );
    case 'record_update':
      return (
        record !== undefined &&
        record === data.record &&
        operation === 'updated' &&
        data.updated === true
      );
    case 'record_delete':
      return (
        record !== undefined &&
        record === data.record &&
        operation === 'deleted' &&
        data.deleted === true
      );
    case 'record_set_trust':
      return (
        record !== undefined &&
        record === args.record &&
        operation === 'updated' &&
        data.updated === true
      );
    case 'record_set_enabled':
      return (
        record !== undefined &&
        (record === data.id || data.recordIds?.includes(record)) &&
        operation === (data.enabled === true ? 'enabled' : 'disabled') &&
        data.enabled !== undefined
      );
  }
  return false;
}

function describeClaim(claim: WriteClaim): string {
  const target =
    claim.system === 'sap'
      ? `${claim.target.type} ${claim.target.name}`
      : [claim.target.scope, claim.target.collection, claim.target.record]
          .filter((part) => part !== undefined)
          .join('/');
  return `${claim.system.toUpperCase()} ${claim.operation} ${target}`;
}

export function evaluateWriteClaims(
  claims: WriteClaim[],
  journal: ToolCallRecord[],
  isSapWriteTool: (name: string) => boolean,
): ReviewVerdict {
  const byId = new Map(journal.map((entry) => [entry.call.id, entry]));
  const issues: ReviewIssue[] = [];
  for (const claim of claims) {
    const entry = claim.callId ? byId.get(claim.callId) : undefined;
    let reason: string;
    if (!claim.callId) reason = 'no write call cited';
    else if (!entry) reason = `call ${claim.callId} is absent from the journal`;
    else {
      const { call, result } = entry;
      const data = payload(result.content);
      const failed = failure.safeParse(data).data;
      if (
        result.isError ||
        data == null ||
        failed?.success === false ||
        failed?.error ||
        failed?.isError ||
        failed?.status === 'failed' ||
        failed?.status === 'error' ||
        (typeof failed?.status === 'number' && failed.status >= 400)
      )
        reason = `cited call ${call.name} did not succeed`;
      else if (
        !(claim.system === 'sap'
          ? isSapWriteTool(call.name)
          : isRagWriteTool(call.name))
      )
        reason = `cited call ${call.name} is not a ${claim.system.toUpperCase()} write`;
      else if (
        claim.system === 'sap'
          ? verifiesSap(claim, call, data)
          : verifiesRag(claim, call, data)
      )
        continue;
      else
        reason = `cited call ${call.name} does not prove the operation and target`;
    }
    issues.push({
      kind: 'unverified-write',
      claimedOp: claim.operation,
      reason: `${describeClaim(claim)}: ${reason}`,
    });
  }
  return issues.length ? { ok: false, issues } : { ok: true };
}
