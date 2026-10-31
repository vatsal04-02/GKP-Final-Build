// The approved starting values for Geeta Krishna Physiotherapy Centre. Written ONLY into an EMPTY table, never over existing rows.
// Everything here is editable in the CRM afterwards (Slice 3/4); nothing is hard-coded in the engine.
import type { GristClient, GristValue } from '../grist';
import { BT } from './schema';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];   // Sunday: no rows = closed
export const SEED_DOCTORS: Array<Record<string, GristValue>> = [
  { Doctor_ID: 'DR-001', Name: 'Dr. Mahesh Tiwari', Qualification: 'MPT (PT)', Default_Shift: 'Morning', Active: true, Notes: '' },
  { Doctor_ID: 'DR-002', Name: 'Dr. Sandeep Tiwari', Qualification: 'MPT (PT)', Default_Shift: 'Evening', Active: true, Notes: '' },
];
export const SEED_SCHEDULES: Array<Record<string, GristValue>> = DAYS.flatMap((d, i) => [
  { Schedule_ID: `SCH-${String(i * 2 + 1).padStart(3, '0')}`, Doctor_ID: 'DR-001', Weekday: d, Shift: 'Morning', Start_Time: '09:00', End_Time: '13:00', Active: true, Is_Override: false },
  { Schedule_ID: `SCH-${String(i * 2 + 2).padStart(3, '0')}`, Doctor_ID: 'DR-002', Weekday: d, Shift: 'Evening', Start_Time: '16:00', End_Time: '20:00', Active: true, Is_Override: false },
]);
// booking_enabled is seeded OFF: nothing is offered to patients until an admin switches WhatsApp AI booking on.
export const SEED_CONFIG: Array<Record<string, GristValue>> = [
  { Key: 'booking_enabled', Value: 'off' }, { Key: 'timezone', Value: 'Asia/Kolkata' },
  { Key: 'slot_minutes', Value: '30' }, { Key: 'buffer_minutes', Value: '0' }, { Key: 'capacity', Value: '1' },
  { Key: 'min_notice_minutes', Value: '120' }, { Key: 'cancel_min_notice_minutes', Value: '0' }, { Key: 'max_advance_days', Value: '' },
  { Key: 'operating_days', Value: 'Mon-Sat' }, { Key: 'open_windows', Value: '09:00-13:00, 16:00-20:00' },
  { Key: 'shift_morning_enabled', Value: 'on' }, { Key: 'shift_evening_enabled', Value: 'on' },
];

export type SeedClient = Pick<GristClient, 'records' | 'add'>;
/** Dry run unless apply. Skips any table that already has rows, so a re-run (or a clinic that already configured things) is never overwritten. */
export async function seedBooking(grist: SeedClient, doc: string, apply: boolean, log: (line: string) => void = () => {}): Promise<{ inserted: number }> {
  let inserted = 0;
  for (const [table, rows] of [[BT.doctors, SEED_DOCTORS], [BT.schedules, SEED_SCHEDULES], [BT.config, SEED_CONFIG]] as const) {
    const have = await grist.records(doc, table);
    if (have.length) { log(`${table}: already has ${have.length} row(s); left as it is`); continue; }
    log(`${apply ? 'seeding' : 'would seed'} ${table} with ${rows.length} row(s)`);
    if (apply) { await grist.add(doc, table, rows.map((r) => ({ ...r }))); inserted += rows.length; }
  }
  return { inserted };
}
