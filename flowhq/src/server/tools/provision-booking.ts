// Adds the booking tables (grist/booking-schema.md) to ONE clinic's Grist doc and extends its Appointments table. Additive only. Dry run unless --apply.
//   npm run provision-booking -- <clinic-slug>                 show what would change
//   npm run provision-booking -- <clinic-slug> --apply          create the tables / columns
//   npm run provision-booking -- <clinic-slug> --apply --seed    ...and write the starting doctors, schedules and settings into EMPTY tables
// Reads GRIST_BASE_URL, GRIST_API_KEY and GRIST_REGISTRY_DOC_ID from the environment (e.g. node --env-file=.env). Prints no secrets.
// Run it against a COPY of the clinic doc first; it changes live data when pointed at the live doc.
import { GristClient } from '../grist';
import { provisionBooking } from '../booking/provision';
import { seedBooking } from '../booking/seed';

const [slug, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply'); const seed = flags.includes('--seed');
const { GRIST_BASE_URL: base, GRIST_API_KEY: key, GRIST_REGISTRY_DOC_ID: registry } = process.env;
if (!slug || !base || !key || !registry) { console.error('Usage: npm run provision-booking -- <clinic-slug> [--apply] [--seed]   (needs GRIST_BASE_URL, GRIST_API_KEY, GRIST_REGISTRY_DOC_ID)'); process.exit(2); }
if (seed && !apply) { console.error('--seed needs --apply'); process.exit(2); }

const grist = new GristClient(base, key);
const reg = (await grist.records(registry, 'Clinics')).find((r) => String(r.fields.Clinic_Slug).trim() === slug);
const doc = reg ? String(reg.fields.Grist_Doc_ID || '').trim() : '';
if (!doc) { console.error(`No clinic "${slug}" with a Grist_Doc_ID in the registry`); process.exit(1); }

const { changes, appointmentsFound } = await provisionBooking(grist, doc, apply, console.log);
if (!appointmentsFound) process.exit(1);
if (seed) await seedBooking(grist, doc, true, console.log);
console.log(changes ? (apply ? 'Done.' : 'Dry run only. Run again with --apply to make these changes.') : 'Nothing to do: the booking tables and Appointments columns already exist.');
