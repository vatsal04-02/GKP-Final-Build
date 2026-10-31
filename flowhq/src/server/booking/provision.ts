// Creates the booking tables and extends the existing Appointments table in ONE clinic's Grist doc. ADDITIVE ONLY, like provision():
// it creates missing tables and missing columns, and nothing else (no rename, no retype, no delete, no clearing). With apply=false it only reports.
// The Appointments table is never created here: it must already exist (it is the table Cal.com / W4 write to). If it does not, we stop.
import { provision, type ProvisionClient } from '../records/provision';
import { APPOINTMENT_EXTRA, BOOKING_TABLES, BT, bookingColumnDefs } from './schema';

export async function provisionBooking(grist: ProvisionClient, doc: string, apply: boolean, log: (line: string) => void = () => {}): Promise<{ changes: number; appointmentsFound: boolean }> {
  const tables = new Set(await grist.tableIds(doc));
  if (!tables.has(BT.appointments)) { log(`STOP: the ${BT.appointments} table does not exist in this document. It comes from the Clinic CRM template; nothing was changed.`); return { changes: 0, appointmentsFound: false }; }
  let { changes } = await provision(grist, doc, apply, log, BOOKING_TABLES);
  const have = new Set(await grist.columnIds(doc, BT.appointments));
  const missing = bookingColumnDefs(APPOINTMENT_EXTRA).filter((c) => !have.has(c.id));
  if (missing.length) { log(`${apply ? 'adding' : 'would add'} to ${BT.appointments}: ${missing.map((m) => m.id).join(', ')}`); changes++; if (apply) await grist.addColumns(doc, BT.appointments, missing); }
  return { changes, appointmentsFound: true };
}
