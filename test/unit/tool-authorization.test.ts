import { resolveExposition } from '../../srv/lib/exposition';
import {
  assertToolAllowed,
  ToolAuthorizationError,
} from '../../srv/lib/tool-authorization';

// RAG exposition filtering only decides what is OFFERED to the model. This is
// the control that decides what may RUN — the case the filter cannot cover is
// a user naming a tool in the prompt and the model asking for it by name.
describe('assertToolAllowed', () => {
  const reader = resolveExposition(['MCP_Reader']);
  const developer = resolveExposition(['MCP_Developer']);
  const full = resolveExposition(['MCP_Full']);

  it('lets a reader run a read-only tool', () => {
    expect(() =>
      assertToolAllowed('GetTable', 'readonly', reader),
    ).not.toThrow();
  });

  it('lets every role run search and system tools', () => {
    for (const roles of [reader, developer, full]) {
      expect(() =>
        assertToolAllowed('SearchObject', 'search', roles),
      ).not.toThrow();
    }
    // system is Analyst and above — a bare reader must not get it
    expect(() =>
      assertToolAllowed('GetSqlQuery', 'system', developer),
    ).not.toThrow();
    expect(() => assertToolAllowed('GetSqlQuery', 'system', reader)).toThrow(
      ToolAuthorizationError,
    );
  });

  it('refuses a create tool for a reader, however it was asked for', () => {
    expect(() => assertToolAllowed('CreateDomain', 'high', reader)).toThrow(
      ToolAuthorizationError,
    );
  });

  it('says why, and that naming the tool does not help', () => {
    expect(() => assertToolAllowed('CreateDomain', 'high', reader)).toThrow(
      /Asking for it by name does not grant it/,
    );
  });

  it('lets a developer run a create tool', () => {
    expect(() =>
      assertToolAllowed('CreateDomain', 'high', developer),
    ).not.toThrow();
  });

  it('keeps low-level handlers to MCP_Full', () => {
    expect(() => assertToolAllowed('AdtRequest', 'low', developer)).toThrow(
      ToolAuthorizationError,
    );
    expect(() => assertToolAllowed('AdtRequest', 'low', full)).not.toThrow();
  });

  // Fail-closed. Both unknowns mean "no".
  it('refuses when the caller has no resolved roles', () => {
    expect(() => assertToolAllowed('GetTable', 'readonly', [])).toThrow(
      ToolAuthorizationError,
    );
    expect(() => assertToolAllowed('GetTable', 'readonly', undefined)).toThrow(
      ToolAuthorizationError,
    );
  });

  it('refuses a tool that carries no exposition group', () => {
    // An unclassified tool must not inherit access by being unclassified.
    expect(() => assertToolAllowed('MysteryTool', undefined, full)).toThrow(
      ToolAuthorizationError,
    );
  });

  it('refuses a caller with no MCP role at all', () => {
    expect(() =>
      assertToolAllowed(
        'GetTable',
        'readonly',
        resolveExposition(['SomeOtherRole']),
      ),
    ).toThrow(ToolAuthorizationError);
  });

  it('carries a 403 and a stable code', () => {
    try {
      assertToolAllowed('CreateDomain', 'high', reader);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolAuthorizationError);
      expect((err as ToolAuthorizationError).statusCode).toBe(403);
      expect((err as ToolAuthorizationError).code).toBe('TOOL_FORBIDDEN');
    }
  });
});
