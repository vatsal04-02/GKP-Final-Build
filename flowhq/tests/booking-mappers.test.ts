// REAL Grist returns 0 (not null) for a blank Int cell. Found by the real-Grist suite (tests/real-grist): every seeded schedule row came back with Slot_Minutes / Buffer_Minutes /
// Capacity = 0, which the engine took for an invalid override, so no doctor had any slot. The in-memory Grist used by the other tests returns null and hid it.
import { describe, expect, it } from 'vitest';
import { toSchedule } from '../src/server/booking/mappers';
import { validateScheduleRow } from '../src/server/booking/engine';

const row = (over: Record<string, unknown> = {}) => ({ id: 1, fields: { Schedule_ID: 'SCH-001', Doctor_ID: 'DR-001', Weekday: 'Mon', Shift: 'Morning', Start_Time: '09:00', End_Time: '13:00', Slot_Minutes: 0, Buffer_Minutes: 0, Capacity: 0, Effective_From: null, Effective_To: null, Active: true, Is_Override: false, Override_Reason: '', ...over } });

describe('blank Int cells as real Grist sends them', () => {
  it('0 in Slot_Minutes / Buffer_Minutes / Capacity means "use the Booking_Config value"', () => {
    expect(toSchedule(row())).toMatchObject({ slotMinutes: null, bufferMinutes: null, capacity: null });
    expect(toSchedule(row({ Slot_Minutes: null, Buffer_Minutes: null, Capacity: null }))).toMatchObject({ slotMinutes: null, bufferMinutes: null, capacity: null });
    expect(toSchedule(row({ Slot_Minutes: undefined }))).toMatchObject({ slotMinutes: null });
  });
  it('a real override is kept, and a row with blank (0) overrides is a VALID schedule row', () => {
    expect(toSchedule(row({ Slot_Minutes: 45, Buffer_Minutes: 5, Capacity: 2 }))).toMatchObject({ slotMinutes: 45, bufferMinutes: 5, capacity: 2 });
    const r = toSchedule(row())!;
    const doctor = { id: 'DR-001', name: 'Dr. Mahesh Tiwari', qualification: '', defaultShift: 'morning' as const, active: true };
    expect(validateScheduleRow(r, doctor, [])).toEqual([]);
  });
  it('a nonsense value is still invalid (it is not turned into a blank): 3 minutes, a negative buffer, capacity 99', () => {
    const doctor = { id: 'DR-001', name: 'D', qualification: '', defaultShift: 'morning' as const, active: true };
    for (const [over, code] of [[{ Slot_Minutes: 3 }, 'bad_duration'], [{ Buffer_Minutes: -5 }, 'bad_buffer'], [{ Capacity: 99 }, 'bad_capacity']] as const) {
      expect(validateScheduleRow(toSchedule(row(over))!, doctor, []).map((p) => p.code), code).toContain(code);
    }
  });
});
