/**
 * Unit tests for srv/lib/log-mask.ts — masking the raw SAP login before it
 * reaches a structured log payload.
 *
 * Under test:
 * - a real login masks to the literal 'user-basic', never the raw value
 * - undefined/empty/null login (destination service user) masks to
 *   '(destination-auth)'
 */

import { maskLoginForLog } from '../../srv/lib/log-mask';

describe('maskLoginForLog', () => {
  it('masks a real login to the literal user-basic', () => {
    expect(maskLoginForLog('DEVELOPER01')).toBe('user-basic');
  });

  it('never returns the raw login', () => {
    const rawLogin = 'SUPER_SECRET_LOGIN';
    expect(maskLoginForLog(rawLogin)).not.toBe(rawLogin);
    expect(maskLoginForLog(rawLogin)).not.toContain(rawLogin);
  });

  it('masks undefined to (destination-auth)', () => {
    expect(maskLoginForLog(undefined)).toBe('(destination-auth)');
  });

  it('masks an empty string to (destination-auth)', () => {
    expect(maskLoginForLog('')).toBe('(destination-auth)');
  });

  it('masks null to (destination-auth)', () => {
    expect(maskLoginForLog(null)).toBe('(destination-auth)');
  });
});
