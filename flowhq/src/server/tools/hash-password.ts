// npm run hash-password -- 'the password'   -> prints a scrypt hash for config/users.json (the password itself is never stored)
import { hashPassword } from '../auth';
const pw = process.argv[2];
if (!pw || pw.length < 10) { console.error('usage: npm run hash-password -- "<password of at least 10 characters>"'); process.exit(1); }
console.log(hashPassword(pw));
