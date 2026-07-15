import { getSystemContext } from '@mcp-abap-adt/core/utils';
import { setRequestResponsible } from '../../srv/lib/responsible';

describe('setRequestResponsible', () => {
  it('sets responsible from x-sap-login', () => {
    setRequestResponsible({ 'x-sap-login': 'ALICE' });
    expect(getSystemContext().responsible).toBe('ALICE');
  });

  it('prefers x-sap-responsible over x-sap-login', () => {
    setRequestResponsible({
      'x-sap-responsible': 'BOB',
      'x-sap-login': 'ALICE',
    });
    expect(getSystemContext().responsible).toBe('BOB');
  });

  it('CLEARS a stale responsible when a later request has no headers', () => {
    setRequestResponsible({ 'x-sap-login': 'ALICE' });
    expect(getSystemContext().responsible).toBe('ALICE');
    // Next request via destination-auth (no login header) must NOT inherit ALICE.
    setRequestResponsible({});
    expect(getSystemContext().responsible).toBeUndefined();
  });

  it('trims and ignores empty header values', () => {
    setRequestResponsible({ 'x-sap-login': '  CAROL  ' });
    expect(getSystemContext().responsible).toBe('CAROL');
    setRequestResponsible({ 'x-sap-login': '   ' });
    expect(getSystemContext().responsible).toBeUndefined();
  });
});
