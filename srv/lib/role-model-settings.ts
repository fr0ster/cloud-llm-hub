import type { Result } from '@mcp-abap-adt/llm-agent';
import { z } from 'zod';
import { sessionSlot } from './session-slot';

export type RoleName = 'coordinator' | 'planner' | 'executor' | 'checker';
export type ReasoningSetting =
  | { kind: 'budget'; tokens: number | 'off' }
  | { kind: 'effort'; effort: 'low' | 'medium' | 'high' }
  | { kind: 'disabled' };
export interface ModelParams {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number | 'off';
  reasoning?: ReasoningSetting;
}
export interface RoleSetting {
  model?: string;
  params?: ModelParams;
}
export type RoleModelSettings = Partial<Record<RoleName, RoleSetting>>;
export interface RoleSettingsError {
  field: string;
  reason: string;
}

const limitSchema = z.union([z.number().int().positive(), z.literal('off')]);
const paramsSchema = z.strictObject({
  temperature: z.number().optional(),
  topP: z.number().optional(),
  maxOutputTokens: limitSchema.optional(),
  reasoning: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('budget'), tokens: limitSchema }),
      z.strictObject({
        kind: z.literal('effort'),
        effort: z.enum(['low', 'medium', 'high']),
      }),
      z.strictObject({ kind: z.literal('disabled') }),
    ])
    .optional(),
});
const roleSchema = z.union([
  z.literal('auto'),
  z.strictObject({
    model: z.string().optional(),
    params: paramsSchema.optional(),
  }),
]);
export const roleModelSettingsSchema = z.strictObject({
  coordinator: roleSchema.optional(),
  planner: roleSchema.optional(),
  executor: roleSchema.optional(),
  checker: roleSchema.optional(),
});
export type RoleModelSettingsInput = z.input<typeof roleModelSettingsSchema>;

export function validateRoleModelSettings(
  input: RoleModelSettingsInput,
  ctx: {
    allow: ReadonlySet<string>;
    channel: 'chat' | 'mcp';
    paramsEnabled: boolean;
  },
): Result<RoleModelSettings, RoleSettingsError> {
  const parsed = roleModelSettingsSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: {
        field: [
          ...issue.path,
          ...(issue.code === 'unrecognized_keys' ? issue.keys.slice(0, 1) : []),
        ].join('.'),
        reason: issue.message,
      },
    };
  }
  const settings: RoleModelSettings = {};
  const roles: RoleName[] = ['coordinator', 'planner', 'executor', 'checker'];
  for (const role of roles) {
    const setting = parsed.data[role];
    if (setting === undefined) continue;
    if (role === 'coordinator' && ctx.channel === 'mcp')
      return {
        ok: false,
        error: {
          field: role,
          reason: 'the connecting agent is the coordinator on channel mcp',
        },
      };
    if (setting === 'auto') continue;
    if (setting.params !== undefined) {
      if (!ctx.paramsEnabled)
        return {
          ok: false,
          error: {
            field: `${role}.params`,
            reason:
              'parameters per role arrive with llm-agent per-role call options (stage 2)',
          },
        };
      if (!setting.model || setting.model === 'auto')
        return {
          ok: false,
          error: {
            field: `${role}.params`,
            reason: 'params require an explicit model',
          },
        };
    }
    if (!setting.model || setting.model === 'auto') continue;
    if (!ctx.allow.has(setting.model))
      return {
        ok: false,
        error: {
          field: `${role}.model`,
          reason: 'model is outside the allowlist',
        },
      };
    settings[role] = setting;
  }
  return { ok: true, value: settings };
}

const store = new Map<string, RoleModelSettings>();
export function getRoleModels(userId: string, key: string): RoleModelSettings {
  return structuredClone(store.get(sessionSlot(userId, key)) ?? {});
}
export function setRoleModels(
  userId: string,
  key: string,
  settings: RoleModelSettings,
): void {
  store.set(sessionSlot(userId, key), structuredClone(settings));
}
export function clearRoleModels(userId: string, key: string): void {
  store.delete(sessionSlot(userId, key));
}
