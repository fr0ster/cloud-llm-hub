import {
  extractClassName,
  extractFunctionGroup,
  isClassInclude,
  McpSourceClient,
  pickToolCall,
  unwrapToolText,
} from '../../srv/mcp-source-client';

describe('pickToolCall', () => {
  test('METHOD on public class (=CP) → GetClass with canonical class name', () => {
    expect(
      pickToolCall({
        eventType: 'METHOD',
        program: 'CL_REST_HTTP_HANDLER==========CP',
        include: 'CL_REST_HTTP_HANDLER==========CM001',
      }),
    ).toEqual({
      tool: 'GetClass',
      args: { class_name: 'CL_REST_HTTP_HANDLER' },
    });
  });

  test('METHOD on a method include (=CMxxx) → GetClass with canonical class name', () => {
    expect(
      pickToolCall({
        eventType: 'METHOD',
        program: 'CL_X==========CM00G',
        include: 'CL_X==========CM00G',
      }),
    ).toEqual({ tool: 'GetClass', args: { class_name: 'CL_X' } });
  });

  test('METHOD on exactly-30-char class name (no = padding) → GetClass with canonical name', () => {
    expect(
      pickToolCall({
        eventType: 'METHOD',
        program: 'CL_GRAC_SOD_ACCESS_RULE_ASSISTCP',
        include: 'CL_GRAC_SOD_ACCESS_RULE_ASSISTCM00G',
      }),
    ).toEqual({
      tool: 'GetClass',
      args: { class_name: 'CL_GRAC_SOD_ACCESS_RULE_ASSIST' },
    });
  });

  test('METHOD on local class (=CCIMP) → GetClass with canonical name', () => {
    expect(
      pickToolCall({
        eventType: 'METHOD',
        program: 'CL_X==========CCIMP',
        include: 'CL_X==========CCIMP',
      }),
    ).toEqual({ tool: 'GetClass', args: { class_name: 'CL_X' } });
  });

  test('namespace-prefixed METHOD → GetClass with namespaced canonical name', () => {
    expect(
      pickToolCall({
        eventType: 'METHOD',
        program: '/IWFND/CL_METERING_DB=========CP',
        include: '/IWFND/CL_METERING_DB=========CM00C',
      }),
    ).toEqual({
      tool: 'GetClass',
      args: { class_name: '/IWFND/CL_METERING_DB' },
    });
  });

  test('FUNCTION include → GetInclude (include preferred over program)', () => {
    expect(
      pickToolCall({
        eventType: 'FUNCTION',
        program: 'SAPLHTTP_RUNTIME',
        include: 'LHTTP_RUNTIMEU02',
      }),
    ).toEqual({
      tool: 'GetInclude',
      args: { include_name: 'LHTTP_RUNTIMEU02' },
    });
  });

  test('FORM with include → GetInclude (FG F-include)', () => {
    expect(
      pickToolCall({
        eventType: 'FORM',
        program: '/IWBEP/SAPLFGR_MGW_CLIENT_IF',
        include: '/IWBEP/LFGR_MGW_CLIENT_IFF01',
      }),
    ).toEqual({
      tool: 'GetInclude',
      args: { include_name: '/IWBEP/LFGR_MGW_CLIENT_IFF01' },
    });
  });

  test('FORM without include but SAPL program → GetProgFullCode FUGR with stripped name', () => {
    expect(
      pickToolCall({
        eventType: 'FORM',
        program: '/IWBEP/SAPLFGR_MGW_CLIENT_IF',
      }),
    ).toEqual({
      tool: 'GetProgFullCode',
      args: { name: '/IWBEP/FGR_MGW_CLIENT_IF', type: 'FUGR' },
    });
  });

  test('EVENT with include → GetInclude', () => {
    expect(
      pickToolCall({
        eventType: 'EVENT',
        program: 'ZREPORT_MAIN',
        include: 'ZREPORT_MAIN',
      }),
    ).toEqual({ tool: 'GetInclude', args: { include_name: 'ZREPORT_MAIN' } });
  });

  test('EVENT without include → GetProgFullCode PROG/P', () => {
    expect(
      pickToolCall({ eventType: 'EVENT', program: 'ZREPORT_MAIN' }),
    ).toEqual({
      tool: 'GetProgFullCode',
      args: { name: 'ZREPORT_MAIN', type: 'PROG/P' },
    });
  });

  test('unknown event type with include → GetInclude', () => {
    expect(
      pickToolCall({ eventType: 'WTF', program: 'P', include: 'I' }),
    ).toEqual({ tool: 'GetInclude', args: { include_name: 'I' } });
  });

  test('unknown event type without include → GetProgFullCode', () => {
    expect(pickToolCall({ eventType: 'WTF', program: 'P' })).toEqual({
      tool: 'GetProgFullCode',
      args: { name: 'P', type: 'PROG/P' },
    });
  });

  test('eventType with surrounding whitespace is normalised', () => {
    expect(
      pickToolCall({
        eventType: '  METHOD  ',
        program: 'CL_X==========CP',
        include: 'CL_X==========CM00G',
      }),
    ).toEqual({ tool: 'GetClass', args: { class_name: 'CL_X' } });
  });

  test('frame with neither include nor program throws', () => {
    expect(() => pickToolCall({ eventType: 'METHOD' })).toThrow(
      /Cannot resolve source for frame/,
    );
  });
});

describe('extractClassName', () => {
  test('strips =*CP suffix', () => {
    expect(extractClassName('CL_REST_HTTP_HANDLER==========CP')).toBe(
      'CL_REST_HTTP_HANDLER',
    );
  });
  test('strips method include suffix CMxxx', () => {
    expect(extractClassName('CL_X==========CM00G')).toBe('CL_X');
  });
  test('strips local-class suffix CCIMP', () => {
    expect(extractClassName('CL_X==========CCIMP')).toBe('CL_X');
  });
  test('handles 30-char class without = padding', () => {
    expect(extractClassName('CL_GRAC_SOD_ACCESS_RULE_ASSISTCP')).toBe(
      'CL_GRAC_SOD_ACCESS_RULE_ASSIST',
    );
  });
  test('handles non-class name unchanged', () => {
    expect(extractClassName('SAPMHTTP')).toBe('SAPMHTTP');
  });
  test('namespace-prefixed class', () => {
    expect(extractClassName('/IWFND/CL_METERING_DB=========CP')).toBe(
      '/IWFND/CL_METERING_DB',
    );
  });
});

describe('isClassInclude', () => {
  test('public class (=CP) is true', () => {
    expect(isClassInclude('CL_X==========CP')).toBe(true);
  });
  test('method include (CMxxx) is true', () => {
    expect(isClassInclude('CL_X==========CM00G')).toBe(true);
  });
  test('local class (CCIMP) is true', () => {
    expect(isClassInclude('CL_X==========CCIMP')).toBe(true);
  });
  test('non-class program (SAPMHTTP) is false', () => {
    expect(isClassInclude('SAPMHTTP')).toBe(false);
  });
});

describe('extractFunctionGroup', () => {
  test('strips SAPL prefix', () => {
    expect(extractFunctionGroup('SAPLHTTP_RUNTIME')).toBe('HTTP_RUNTIME');
  });
  test('keeps namespace, strips SAPL', () => {
    expect(extractFunctionGroup('/IWBEP/SAPLFGR_MGW_CLIENT_IF')).toBe(
      '/IWBEP/FGR_MGW_CLIENT_IF',
    );
  });
  test('non-FG program returns undefined', () => {
    expect(extractFunctionGroup('ZREPORT_MAIN')).toBeUndefined();
  });
  test('class program returns undefined', () => {
    expect(extractFunctionGroup('CL_X==========CP')).toBeUndefined();
  });
});

describe('unwrapToolText', () => {
  test('returns plain text unchanged', () => {
    expect(unwrapToolText("REPORT zfoo. WRITE / 'hi'.")).toBe(
      "REPORT zfoo. WRITE / 'hi'.",
    );
  });
  test('extracts source_code from GetClass envelope', () => {
    const env = JSON.stringify({
      success: true,
      class_name: 'CL_X',
      source_code: 'CLASS cl_x DEFINITION.',
    });
    expect(unwrapToolText(env)).toBe('CLASS cl_x DEFINITION.');
  });
  test('joins code_objects from GetProgFullCode envelope with headers', () => {
    const env = JSON.stringify({
      name: 'ZFOO',
      type: 'PROG/P',
      total_code_objects: 2,
      code_objects: [
        { OBJECT_TYPE: 'PROG/P', OBJECT_NAME: 'ZFOO', code: 'REPORT zfoo.' },
        {
          OBJECT_TYPE: 'PROG/I',
          OBJECT_NAME: 'ZFOO_F01',
          code: 'FORM x. ENDFORM.',
        },
      ],
    });
    const out = unwrapToolText(env);
    expect(out).toContain('* ===== PROG/P ZFOO =====');
    expect(out).toContain('REPORT zfoo.');
    expect(out).toContain('* ===== PROG/I ZFOO_F01 =====');
    expect(out).toContain('FORM x. ENDFORM.');
  });
});

describe('McpSourceClient.fetchFrameSource', () => {
  test('METHOD on public class calls GetClass and returns unwrapped source_code', async () => {
    const calls: Array<{ name: string; arguments: any }> = [];
    const env = JSON.stringify({
      success: true,
      class_name: 'CL_X',
      source_code: 'CLASS cl_x DEFINITION. ENDCLASS.',
    });
    const fakeClient = {
      connect: async () => {},
      callTool: async (req: any) => {
        calls.push(req);
        return { content: [{ type: 'text', text: env }] };
      },
      close: async () => {},
    };
    const c = new McpSourceClient(
      'CLOUD_LLM_HUB',
      'S4HANA_E19',
      () => fakeClient as any,
    );
    const out = await c.fetchFrameSource({
      eventType: 'METHOD',
      program: 'CL_X==========CP',
      include: 'CL_X==========CM00G',
    });
    expect(out).toBe('CLASS cl_x DEFINITION. ENDCLASS.');
    expect(calls).toEqual([
      { name: 'GetClass', arguments: { class_name: 'CL_X' } },
    ]);
  });

  test('GetInclude 404 falls back to GetProgFullCode (REPORT case)', async () => {
    const calls: Array<{ name: string; arguments: any }> = [];
    const fakeClient = {
      connect: async () => {},
      callTool: async (req: any) => {
        calls.push(req);
        if (req.name === 'GetInclude') {
          return {
            isError: true,
            content: [
              { type: 'text', text: 'Request failed with status code 404' },
            ],
          };
        }
        return { content: [{ type: 'text', text: 'REPORT zfoo.' }] };
      },
      close: async () => {},
    };
    const c = new McpSourceClient(
      'CLOUD_LLM_HUB',
      'S4HANA_E19',
      () => fakeClient as any,
    );
    const out = await c.fetchFrameSource({
      eventType: 'EVENT',
      program: 'ZFOO',
      include: 'ZFOO',
    });
    expect(out).toBe('REPORT zfoo.');
    expect(calls.map((c) => c.name)).toEqual(['GetInclude', 'GetProgFullCode']);
  });

  test('Tool result with isError=true throws with the error message', async () => {
    const fakeClient = {
      connect: async () => {},
      callTool: async () => ({
        isError: true,
        content: [{ type: 'text', text: 'CLASS not found' }],
      }),
      close: async () => {},
    };
    const c = new McpSourceClient(
      'CLOUD_LLM_HUB',
      'S4HANA_E19',
      () => fakeClient as any,
    );
    await expect(
      c.fetchFrameSource({
        eventType: 'METHOD',
        program: 'CL_X==========CP',
        include: 'CL_X==========CM00G',
      }),
    ).rejects.toThrow(/MCP GetClass failed: CLASS not found/);
  });

  test('Empty content array throws', async () => {
    const fakeClient = {
      connect: async () => {},
      callTool: async () => ({ content: [] }),
      close: async () => {},
    };
    const c = new McpSourceClient(
      'CLOUD_LLM_HUB',
      'S4HANA_E19',
      () => fakeClient as any,
    );
    await expect(
      c.fetchFrameSource({
        eventType: 'METHOD',
        program: 'CL_X==========CP',
        include: 'CL_X==========CM00G',
      }),
    ).rejects.toThrow(/MCP GetClass returned no content/);
  });

  test('close() is called even when callTool throws', async () => {
    let closed = false;
    const fakeClient = {
      connect: async () => {},
      callTool: async () => {
        throw new Error('boom');
      },
      close: async () => {
        closed = true;
      },
    };
    const c = new McpSourceClient(
      'CLOUD_LLM_HUB',
      'S4HANA_E19',
      () => fakeClient as any,
    );
    await expect(
      c.fetchFrameSource({
        eventType: 'METHOD',
        program: 'CL_X==========CP',
        include: 'CL_X==========CM00G',
      }),
    ).rejects.toThrow(/boom/);
    expect(closed).toBe(true);
  });
});
