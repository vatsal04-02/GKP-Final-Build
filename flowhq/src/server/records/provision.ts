// Creates the Clinic Records tables in one clinic doc. ADDITIVE ONLY: it creates missing tables and missing columns, and nothing else
// (no rename, no retype, no delete, no clearing). With apply=false it only reports.
import type { GristClient } from '../grist';
import { RECORD_COLUMNS, gristField } from './schema';

export type ProvisionClient = Pick<GristClient, 'tableIds' | 'columnIds' | 'createTable' | 'addColumns'>;
export async function provision(grist: ProvisionClient, doc: string, apply: boolean, log: (line: string) => void = () => {}): Promise<{ changes: number }> {
  const have = new Set(await grist.tableIds(doc));
  let changes = 0;
  for (const [table, cols] of Object.entries(RECORD_COLUMNS)) {
    const defs = cols.map(([id, t]) => ({ id, fields: gristField(id, t) }));
    if (!have.has(table)) {
      log(`${apply ? 'creating' : 'would create'} table ${table} (${cols.length} columns)`); changes++;
      if (apply) await grist.createTable(doc, table, defs);
      continue;
    }
    const existing = new Set(await grist.columnIds(doc, table));
    const missing = defs.filter((d) => !existing.has(d.id));
    if (missing.length) { log(`${apply ? 'adding' : 'would add'} to ${table}: ${missing.map((m) => m.id).join(', ')}`); changes++; if (apply) await grist.addColumns(doc, table, missing); }
  }
  return { changes };
}
