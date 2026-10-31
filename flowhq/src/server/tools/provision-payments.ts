// Adds the payment tables (Booking_Payments, Payment_Events, Payment_Files) to ONE clinic's Grist doc. Additive only. Dry run unless --apply.
//   npm run provision-payments -- <clinic-slug>            show what would change
//   npm run provision-payments -- <clinic-slug> --apply     create the tables / columns
// Reads GRIST_BASE_URL, GRIST_API_KEY and GRIST_REGISTRY_DOC_ID from the environment. Prints no secrets. Run it against a COPY first when in doubt.
import { GristClient } from '../grist';
import { provisionPayments } from '../payments/provision';

const [slug, ...flags] = process.argv.slice(2); const apply = flags.includes('--apply');
const { GRIST_BASE_URL: base, GRIST_API_KEY: key, GRIST_REGISTRY_DOC_ID: registry } = process.env;
if (!slug || !base || !key || !registry) { console.error('Usage: npm run provision-payments -- <clinic-slug> [--apply]   (needs GRIST_BASE_URL, GRIST_API_KEY, GRIST_REGISTRY_DOC_ID)'); process.exit(2); }
const grist = new GristClient(base, key);
const reg = (await grist.records(registry, 'Clinics')).find((r) => String(r.fields.Clinic_Slug).trim() === slug);
const doc = reg ? String(reg.fields.Grist_Doc_ID || '').trim() : '';
if (!doc) { console.error(`No clinic "${slug}" with a Grist_Doc_ID in the registry`); process.exit(1); }
const { changes, ready } = await provisionPayments(grist, doc, apply, console.log);
if (!ready) process.exit(1);
console.log(changes ? (apply ? 'Done.' : 'Dry run only. Run again with --apply to make these changes.') : 'Nothing to do: the payment tables already exist.');
