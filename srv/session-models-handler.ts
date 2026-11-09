import cds from '@sap/cds';
import type { Request, Response } from 'express';
import {
  effectiveExecutionLimits,
  executionLimitsSchema,
  getExecutionLimits,
  setExecutionLimits,
  validateExecutionLimits,
} from './lib/execution-limits';
import { capabilitiesFor } from './lib/model-capabilities';
import { parseModelAllowlist } from './lib/model-policy';
import {
  getRoleModels,
  roleModelSettingsSchema,
  setRoleModels,
  validateRoleModelSettings,
} from './lib/role-model-settings';
import { effectiveRoleModels } from './lib/role-models-scope';
import type { LongSessionRequest } from './lib/session-connection';
import { resolveSessionKey } from './session-id';

const updateSchema = roleModelSettingsSchema.extend({
  limits: executionLimitsSchema.optional(),
});

function sessionOf(
  req: Request,
  res: Response,
): { userId: string; key: string } | undefined {
  const { key } = resolveSessionKey(req);
  if (!key) {
    res.status(400).json({
      error: { field: 'x-clh-session', reason: 'x-clh-session is required' },
    });
    return;
  }
  const userId = cds.context?.user?.id ?? 'anonymous';
  const session = (req as LongSessionRequest).longSession;
  if (!session || session.userId !== userId || session.key !== key) {
    res
      .status(404)
      .json({ error: { field: 'x-clh-session', reason: 'session not found' } });
    return;
  }
  return { userId, key };
}

function snapshot(userId: string, key: string) {
  return {
    settings: getRoleModels(userId, key),
    effective: effectiveRoleModels(userId, key),
    capabilities: capabilitiesFor(parseModelAllowlist()),
    limits: getExecutionLimits(userId, key),
    effectiveLimits: effectiveExecutionLimits(userId, key),
    canEdit: cds.context?.user?.is('MCP_Admin') === true,
  };
}

export function handleGetSessionModels(req: Request, res: Response): void {
  const session = sessionOf(req, res);
  if (session) res.status(200).json(snapshot(session.userId, session.key));
}

/** Mounted behind requireAdminRole; validate the whole replacement before writing. */
export function handlePutSessionModels(req: Request, res: Response): void {
  const session = sessionOf(req, res);
  if (!session) return;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({
      error: {
        field: [
          ...issue.path,
          ...(issue.code === 'unrecognized_keys' ? issue.keys.slice(0, 1) : []),
        ].join('.'),
        reason: issue.message,
      },
    });
    return;
  }
  const { limits, ...models } = parsed.data;
  const validatedModels = validateRoleModelSettings(models, {
    allow: parseModelAllowlist(),
    channel: 'chat',
    paramsEnabled: false,
  });
  const validatedLimits = validateExecutionLimits(limits ?? {}, {
    libraryLimitsEnabled: false,
  });
  if (!validatedModels.ok) {
    res.status(400).json({ error: validatedModels.error });
    return;
  }
  if (!validatedLimits.ok) {
    res.status(400).json({ error: validatedLimits.error });
    return;
  }
  setRoleModels(session.userId, session.key, validatedModels.value);
  setExecutionLimits(session.userId, session.key, validatedLimits.value);
  res.status(200).json(snapshot(session.userId, session.key));
}
