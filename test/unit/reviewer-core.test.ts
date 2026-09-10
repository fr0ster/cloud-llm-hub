import type { ToolCallRecord } from '@mcp-abap-adt/llm-agent';
import {
  evaluateDeterministic,
  parseToolOutcome,
} from '../../srv/lib/reviewer-core';

function record(
  name: string,
  content: string | Record<string, unknown>,
  isError?: boolean,
): ToolCallRecord {
  return {
    call: { id: '', name, arguments: {} },
    result: { content, isError },
  };
}

describe('parseToolOutcome', () => {
  it('parses a JSON string envelope with status', () => {
    const outcome = parseToolOutcome(
      record('CreateDomain', '{"success":true,"status":"active"}'),
    );
    expect(outcome).toEqual({
      name: 'CreateDomain',
      ok: true,
      status: 'active',
    });
  });

  it('accepts a Record content directly (no string parse)', () => {
    const outcome = parseToolOutcome(
      record('CreateDomain', { success: true, status: 'inactive' }),
    );
    expect(outcome).toEqual({
      name: 'CreateDomain',
      ok: true,
      status: 'inactive',
    });
  });

  it('is not-ok when the MCP layer reports isError', () => {
    const outcome = parseToolOutcome(
      record('CreateDomain', 'backend unreachable', true),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('backend unreachable');
  });

  it('is not-ok when the envelope explicitly says success:false, using error/message', () => {
    const outcome = parseToolOutcome(
      record('CreateDomain', '{"success":false,"error":"name already exists"}'),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('name already exists');
  });

  it('falls back to message when error is absent', () => {
    const outcome = parseToolOutcome(
      record('CreateDomain', '{"success":false,"message":"lock timeout"}'),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('lock timeout');
  });

  it('treats unparseable content as an empty envelope (success, no throw)', () => {
    const outcome = parseToolOutcome(record('ReadDomain', 'not json at all'));
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBeUndefined();
  });

  it('a missing success field defaults to ok (many read tools carry no envelope)', () => {
    const outcome = parseToolOutcome(record('ReadDomain', '{"data":"x"}'));
    expect(outcome.ok).toBe(true);
  });
});

describe('evaluateDeterministic (result-based)', () => {
  it('is clean when CreateDomain(activate:true default) returns status:active — the ex-false-positive is gone', () => {
    const content =
      'Domain ZDEMO_D_MATNR was created and has been successfully activated.';
    const verdict = evaluateDeterministic(content, [
      record('CreateDomain', '{"success":true,"status":"active"}'),
    ]);
    expect(verdict).toEqual({ ok: true });
  });

  it('flags the activate:false lie — CreateDomain(activate:false) returns status:inactive but content claims activated (ZDEMO_D_MATNR-class bug)', () => {
    const content =
      'Domain ZDEMO_D_MATNR was created and has been successfully activated.';
    const verdict = evaluateDeterministic(content, [
      record('CreateDomain', '{"success":true,"status":"inactive"}'),
    ]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.issues).toEqual([
      expect.objectContaining({
        kind: 'unverified-write',
        claimedOp: 'activated',
      }),
    ]);
    expect((verdict.issues[0] as { reason: string }).reason).toMatch(
      /no tool result shows status:'active'/,
    );
  });

  it('flags created when only a read tool ran (no successful Create*)', () => {
    const content = 'The domain was created successfully.';
    const verdict = evaluateDeterministic(content, [
      record('ReadDomain', '{"success":true}'),
    ]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.issues).toEqual([
      expect.objectContaining({
        kind: 'unverified-write',
        claimedOp: 'created',
      }),
    ]);
  });

  it('flags a failed write tool claimed as success', () => {
    const content = 'The domain was created successfully.';
    const verdict = evaluateDeterministic(content, [
      record('CreateDomain', '{"success":false,"error":"name conflict"}', true),
    ]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(
      verdict.issues.some((i) =>
        (i as { reason: string }).reason.includes(
          'CreateDomain returned error',
        ),
      ),
    ).toBe(true);
  });

  it('is clean on an honest refusal (no completed-write claim)', () => {
    const verdict = evaluateDeterministic('I could not create it.', []);
    expect(verdict).toEqual({ ok: true });
  });

  it('is clean when create+activate both succeed via separate tool results', () => {
    const content = 'Domain ZDEMO was created and activated successfully.';
    const verdict = evaluateDeterministic(content, [
      record('CreateDomain', '{"success":true,"status":"inactive"}'),
      record('ActivateDomain', '{"success":true,"status":"active"}'),
    ]);
    expect(verdict).toEqual({ ok: true });
  });

  it('is clean with the REAL ActivateDomain envelope — success but NO status field (the e2e false-positive)', () => {
    // ActivateDomain returns {success:true, activation:{activated:true}} with NO
    // `status` — a status-only check false-flagged this active object. A
    // successful Activate* tool must satisfy "activated" on its own.
    const content = 'Domain ZDEMO was created and activated successfully.';
    const verdict = evaluateDeterministic(content, [
      record('CreateDomain', '{"success":true,"status":"inactive"}'),
      record(
        'ActivateDomain',
        '{"success":true,"activation":{"activated":true},"message":"activated successfully"}',
      ),
    ]);
    expect(verdict).toEqual({ ok: true });
  });

  it('extracts status from the MCP parts-array content the adapter actually produces', () => {
    // The adapter sets McpToolResult.content = result.result, which is the MCP
    // parts array [{type:'text', text:'…json…'}] — a naive "use the object as-is"
    // misses `status`, which was the deployed e2e false positive.
    const content = 'Domain ZDEMO was created and activated successfully.';
    const wrapped = [
      { type: 'text', text: '{"success":true,"status":"active"}' },
    ] as unknown as Record<string, unknown>;
    const verdict = evaluateDeterministic(content, [
      {
        call: { id: '', name: 'CreateDomain', arguments: {} },
        result: { content: wrapped },
      },
    ]);
    expect(verdict).toEqual({ ok: true });
  });

  it('parseToolOutcome unwraps an MCP {content:[{text}]} envelope', () => {
    const outcome = parseToolOutcome({
      call: { id: '', name: 'CreateDomain', arguments: {} },
      result: {
        content: {
          content: [
            { type: 'text', text: '{"success":true,"status":"active"}' },
          ],
        } as unknown as Record<string, unknown>,
      },
    });
    expect(outcome).toMatchObject({ ok: true, status: 'active' });
  });

  it('still flags activated when only a READ tool ran (a successful Activate* is required, not a read)', () => {
    const content = 'Domain ZDEMO was created and activated successfully.';
    const verdict = evaluateDeterministic(content, [
      record('CreateDomain', '{"success":true,"status":"inactive"}'),
      record('ReadDomain', '{"success":true,"status":"inactive"}'),
    ]);
    expect(verdict.ok).toBe(false);
  });

  it('flags an unverified delete when no delete tool ran', () => {
    const content = 'The table entry was deleted successfully.';
    const verdict = evaluateDeterministic(content, [
      record('ReadTable', '{"success":true}'),
    ]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.issues).toEqual([
      expect.objectContaining({
        kind: 'unverified-write',
        claimedOp: 'deleted',
      }),
    ]);
  });

  it('satisfies "updated" via status:active (an update that also activates)', () => {
    const content = 'The class was updated successfully.';
    const verdict = evaluateDeterministic(content, [
      record('UpdateClass', '{"success":true,"status":"active"}'),
    ]);
    expect(verdict).toEqual({ ok: true });
  });

  it('does NOT let a READ tool echoing status:active satisfy an activation claim', () => {
    const content = 'Domain ZDEMO_D_MATNR has been successfully activated.';
    const verdict = evaluateDeterministic(content, [
      record('ReadDomain', '{"success":true,"status":"active"}'),
    ]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.issues).toEqual([
      expect.objectContaining({
        kind: 'unverified-write',
        claimedOp: 'activated',
      }),
    ]);
  });

  it('still flags a failed CreateDomain claimed as created (per-op rule, no catch-all needed)', () => {
    const content = 'The domain was created successfully.';
    const verdict = evaluateDeterministic(content, [
      record('CreateDomain', '{"success":false,"error":"name conflict"}', true),
    ]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(
      verdict.issues.some((i) =>
        (i as { reason: string }).reason.includes(
          'CreateDomain returned error',
        ),
      ),
    ).toBe(true);
  });

  it('is clean for an honest create+activate alongside an UNRELATED failed DeleteTable', () => {
    const content = 'Domain ZDEMO was created and activated successfully.';
    const verdict = evaluateDeterministic(content, [
      record('CreateDomain', '{"success":true,"status":"active"}'),
      record('DeleteTable', '{"success":false,"error":"lock held"}', true),
    ]);
    expect(verdict).toEqual({ ok: true });
  });
});

// The tool-count signal, kept as a check of its own rather than as a gate on
// whether to ask an LLM. Nothing was called, and the response says it read the
// system: it cannot have read what it never asked for. Conditioned on ZERO
// calls on purpose — "I read the table" is ordinary prose everywhere else.
describe('a read claimed with nothing called', () => {
  const nothing: never[] = [];
  const oneRead = [
    {
      call: { id: '', name: 'ReadDomain', arguments: {} },
      result: { content: '{"success":true}' },
    },
  ] as never;

  it('flags a fabricated read, in either language', () => {
    for (const text of [
      'I read the domain ZDEMO_TEST; its type is CHAR 10.',
      'Прочитав домен ZDEMO_TEST, тип CHAR 10.',
    ]) {
      const v = evaluateDeterministic(text, nothing);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.issues[0].kind).toBe('unverified-read');
    }
  });

  it('leaves alone everything that is not a fabricated read', () => {
    for (const text of [
      'Hello! How can I help you today?',
      'I cannot read that domain without a destination.',
      'I will read the domain next.',
    ]) {
      expect(evaluateDeterministic(text, nothing).ok).toBe(true);
    }
  });

  it('says nothing once a tool has actually run', () => {
    expect(
      evaluateDeterministic('I read the domain ZDEMO_TEST.', oneRead).ok,
    ).toBe(true);
  });
});
