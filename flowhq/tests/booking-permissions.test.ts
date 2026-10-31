// The permission matrix, as pure logic (the booking service enforces exactly this on every staff write).
import { describe, expect, it } from 'vitest';
import { can, limitedToOwnDoctor, type Right } from '../src/server/booking/permissions';

const RIGHTS: Right[] = ['view', 'appointments:write', 'blocks:write', 'settings:write', 'ai_switch', 'audit:read'];
const matrix = (who: Parameters<typeof can>[0]) => Object.fromEntries(RIGHTS.map((r) => [r, can(who, r)]));

describe('who may do what', () => {
  it('an admin may do everything, including the AI switch, settings and the audit log', () => {
    expect(matrix({ role: 'admin' })).toEqual({ view: true, 'appointments:write': true, 'blocks:write': true, 'settings:write': true, ai_switch: true, 'audit:read': true });
    expect(limitedToOwnDoctor({ role: 'admin', clinician: 'Dr. X' })).toBe(false);
  });
  it('front-desk staff manage appointments and leave, but never the AI switch, settings, doctors or the audit log', () => {
    expect(matrix({ role: 'staff' })).toEqual({ view: true, 'appointments:write': true, 'blocks:write': true, 'settings:write': false, ai_switch: false, 'audit:read': false });
    expect(limitedToOwnDoctor({ role: 'staff' })).toBe(false);
  });
  it("a doctor's own login manages only their own appointments and cannot block time", () => {
    expect(matrix({ role: 'staff', clinician: 'Dr. Mahesh Tiwari' })).toEqual({ view: true, 'appointments:write': true, 'blocks:write': false, 'settings:write': false, ai_switch: false, 'audit:read': false });
    expect(limitedToOwnDoctor({ role: 'staff', clinician: 'Dr. Mahesh Tiwari' })).toBe(true);
  });
  it('a missing or odd role is treated as plain staff, never as admin', () => {
    for (const who of [{}, { role: undefined }, { role: 'owner' as never }, { role: 'ADMIN' as never }]) { expect(can(who, 'ai_switch')).toBe(false); expect(can(who, 'settings:write')).toBe(false); expect(can(who, 'audit:read')).toBe(false); }
  });
});
