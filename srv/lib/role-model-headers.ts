import type { IncomingHttpHeaders } from 'node:http';
import type { Result } from '@mcp-abap-adt/llm-agent';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  executionLimitsSchema,
  getExecutionLimits,
  setExecutionLimits,
  validateExecutionLimits,
} from './execution-limits';
import {
  ignoredModelHeader,
  parseModelAllowlist,
  resolveRequestModel,
} from './model-policy';
import {
  getRoleModels,
  type RoleModelSettingsInput,
  type RoleSettingsError,
  roleModelSettingsSchema,
  setRoleModels,
  validateRoleModelSettings,
} from './role-model-settings';
import { effectiveRoleModels } from './role-models-scope';
import type { LongSessionRequest } from './session-connection';

const roles = ['coordinator', 'planner', 'executor', 'checker'] as const;
export const roleModelHeaderNames = [
  ...roles.flatMap((role) => [`x-clh-model-${role}`, `x-clh-params-${role}`]),
  'x-clh-limits',
];

export function readRoleModelHeaders(
  headers: IncomingHttpHeaders,
): Result<RoleModelSettingsInput | undefined, RoleSettingsError> {
  const input: RoleModelSettingsInput = {};
  let present = false;
  for (const role of roles) {
    const modelHeader = `x-clh-model-${role}`;
    const paramsHeader = `x-clh-params-${role}`;
    const model = headers[modelHeader];
    const params = headers[paramsHeader];
    if (model === undefined && params === undefined) continue;
    present = true;
    if (Array.isArray(model) || Array.isArray(params))
      return {
        ok: false,
        error: {
          field: Array.isArray(model) ? modelHeader : paramsHeader,
          reason: 'expected a single header value',
        },
      };
    let setting: NonNullable<RoleModelSettingsInput[typeof role]> = {};
    if (model !== undefined) setting = { model: model.trim() };
    if (params !== undefined) {
      try {
        const parsed = roleModelSettingsSchema.safeParse({
          [role]: { ...setting, params: JSON.parse(params) },
        });
        if (!parsed.success)
          return {
            ok: false,
            error: {
              field: paramsHeader,
              reason: parsed.error.issues[0].message,
            },
          };
        setting = parsed.data[role] ?? {};
      } catch (error) {
        return {
          ok: false,
          error: {
            field: paramsHeader,
            reason: error instanceof Error ? error.message : 'invalid JSON',
          },
        };
      }
    }
    input[role] = setting;
  }
  return { ok: true, value: present ? input : undefined };
}

export function chatRequestModel(
  requested: string | undefined,
  admin: boolean,
) {
  return admin
    ? resolveRequestModel(requested, parseModelAllowlist())
    : { ignored: requested, model: undefined };
}

/** Validate the complete update before writing either store. */
export function applyRoleModelHeaders(
  req: Request,
  res: Response,
  userId: string,
  admin: boolean,
): boolean {
  const session = (req as LongSessionRequest).longSession;
  const key = session?.userId === userId ? session.key : undefined;
  const body = z.record(z.string(), z.json()).safeParse(req.body);
  const requested =
    body.success && typeof body.data.model === 'string'
      ? body.data.model
      : undefined;
  const requestModel = chatRequestModel(requested, admin);
  const report = () => {
    const effective = effectiveRoleModels(userId, key ?? '');
    if (!getRoleModels(userId, key ?? '').coordinator && requestModel.model)
      effective.coordinator.model = requestModel.model;
    const models = {
      coordinator: effective.coordinator.model,
      planner: effective.planner.model,
      executor: effective.executor.model,
      checker: effective.checker.model,
    };
    res.setHeader(
      'x-clh-models-effective',
      ignoredModelHeader(JSON.stringify(models), Infinity),
    );
  };
  report();
  if (requestModel.ignored !== undefined)
    res.setHeader(
      'x-clh-model-ignored',
      ignoredModelHeader(requestModel.ignored),
    );
  if (body.success) {
    const ignored = [
      'temperature',
      'top_p',
      'max_tokens',
      'max_completion_tokens',
      'reasoning_effort',
      'thinking',
    ].filter((name) => Object.hasOwn(body.data, name));
    if (ignored.length)
      res.setHeader('x-clh-params-ignored', ignored.join(','));
  }
  const header = roleModelHeaderNames.find(
    (name) => req.headers[name] !== undefined,
  );
  if (!header) return true;
  const refuse = (status: number, field: string, reason: string) => {
    res.status(status).json({
      error: {
        field,
        reason,
        message: `${field}: ${reason}`,
        type: 'invalid_request_error',
      },
    });
    return false;
  };
  if (!admin) return refuse(403, header, 'MCP_Admin is required');
  if (!key) return refuse(400, 'x-clh-session', 'an open session is required');
  const read = readRoleModelHeaders(req.headers);
  if (!read.ok) return refuse(400, read.error.field, read.error.reason);
  const merged: RoleModelSettingsInput = getRoleModels(userId, key);
  for (const role of roles) {
    const update = read.value?.[role];
    if (update === undefined) continue;
    merged[role] =
      update === 'auto'
        ? update
        : { ...(merged[role] === 'auto' ? {} : merged[role]), ...update };
  }
  const models = validateRoleModelSettings(merged, {
    allow: parseModelAllowlist(),
    channel: 'chat',
    paramsEnabled: false,
  });
  if (!models.ok) {
    const [role, field] = models.error.field.split('.');
    return refuse(
      400,
      `x-clh-${field === 'params' ? 'params' : 'model'}-${role}`,
      models.error.reason,
    );
  }
  let limits = getExecutionLimits(userId, key);
  const rawLimits = req.headers['x-clh-limits'];
  if (rawLimits !== undefined) {
    if (Array.isArray(rawLimits))
      return refuse(400, 'x-clh-limits', 'expected a single header value');
    try {
      const parsed = executionLimitsSchema.safeParse(JSON.parse(rawLimits));
      if (!parsed.success)
        return refuse(400, 'x-clh-limits', parsed.error.issues[0].message);
      const update = parsed.data;
      limits = { ...limits, ...update };
      for (const role of ['coordinator', 'executor', 'checker'] as const) {
        if (update[role])
          limits[role] = {
            ...getExecutionLimits(userId, key)[role],
            ...update[role],
          };
      }
    } catch (error) {
      return refuse(
        400,
        'x-clh-limits',
        error instanceof Error ? error.message : 'invalid JSON',
      );
    }
  }
  const validated = validateExecutionLimits(limits, {
    libraryLimitsEnabled: false,
  });
  if (!validated.ok) return refuse(400, 'x-clh-limits', validated.error.reason);
  setRoleModels(userId, key, models.value);
  setExecutionLimits(userId, key, validated.value);
  report();
  return true;
}

export function sessionCoordinator(
  req: Request,
  userId: string,
): string | undefined {
  const session = (req as LongSessionRequest).longSession;
  return session?.userId === userId
    ? getRoleModels(userId, session.key).coordinator?.model
    : undefined;
}
