// Creates the three payment tables (docs/payments.md) in ONE clinic's Grist doc. ADDITIVE ONLY (like provision-booking): missing tables / columns are created, nothing is renamed,
// retyped, deleted or cleared. Dry run unless --apply. Needs the booking tables to exist already (Appointments, Booking_Config).
import { provision, type ProvisionClient } from '../records/provision';
import { PAYMENT_TABLES } from './schema';

export async function provisionPayments(grist: ProvisionClient, doc: string, apply: boolean, log: (line: string) => void = () => {}): Promise<{ changes: number; ready: boolean }> {
  const tables = new Set(await grist.tableIds(doc));
  for (const need of ['Appointments', 'Booking_Config']) if (!tables.has(need)) { log(`STOP: the ${need} table does not exist in this document (run provision-booking first). Nothing was changed.`); return { changes: 0, ready: false }; }
  const { changes } = await provision(grist, doc, apply, log, PAYMENT_TABLES);
  return { changes, ready: true };
}
