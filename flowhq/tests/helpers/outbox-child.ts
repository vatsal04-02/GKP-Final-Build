// A child process for the forced-termination test: it opens a REAL outbox, writes some audit records, then is killed with no clean shutdown.
// argv: <dir>. Prints READY after the records are durable, then kills itself.
import { AuditOutbox, FileStore } from '../../src/server/booking/outbox';

const dir = process.argv[2]!;
const ob = new AuditOutbox(new FileStore({ dir, staleMs: 200, waitMs: 3000, heartbeatMs: 20 }));
await ob.open();
const done = await ob.intent({ actor: 'desk@test', source: 'Staff', action: 'create', record: 'GKA-000001', table: 'Appointments', detail: {} });
await ob.outcome(done, { outcome: 'ok', reason: 'created' });
await ob.intent({ actor: 'desk@test', source: 'Staff', action: 'cancel', record: 'GKA-000002', table: 'Appointments', detail: {} });   // never finished: the crash happens mid-operation
await ob.intent({ actor: 'desk@test', source: 'Staff', action: 'create', record: 'GKA-000003', table: 'Appointments', detail: {} });
console.log('READY');
process.kill(process.pid, 'SIGKILL');
setTimeout(() => process.exit(9), 5000);   // only reached if the kill did not work
