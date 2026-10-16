// STEP 06 - phone numbers are E.164, not +91-only. The same +91 function was pasted into 18 Code nodes; every copy is replaced by snippets/phone.js
// (international numbers are accepted, India stays the default for numbers written locally; FLOWHQ_DEFAULT_COUNTRY_CODE changes the default).
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'snippets', 'phone.js'), 'utf8');
const FN = SRC.slice(SRC.indexOf('// E.164'), SRC.length).trim();
const OLD = /^( *)function normalizeIndianPhone\(raw\) \{\n[\s\S]*?\n\1\}\n/m;

module.exports = {
  id: '06-phones',
  title: 'E.164 phone numbers (international)',
  FN,
  run(ctx) {
    let n = 0;
    for (const node of ctx.nodes) {
      if (node.type !== 'n8n-nodes-base.code' || !OLD.test(node.parameters.jsCode || '')) continue;
      node.parameters.jsCode = node.parameters.jsCode.replace(OLD, (m, indent) => `${FN.split('\n').map((l) => (l ? indent + l : l)).join('\n')}\n`);
      n++;
    }
    if (n !== 18) throw new Error(`expected the +91-only function in 18 Code nodes, found ${n}`);
    ctx.log('06', `${n} Code nodes: the +91-only phone function is replaced by an E.164 normaliser (international numbers accepted; default country FLOWHQ_DEFAULT_COUNTRY_CODE, India if unset)`);
    // Meta sends the sender as digits without "+": it is international by definition
    ctx.editCode('W2 – Normalize Phone', [
      { find: 'const { phone, valid } = normalizeIndianPhone($json.from);', replace: "const { phone, valid } = normalizeIndianPhone(String($json.from || '').trim().startsWith('+') ? $json.from : `+${String($json.from || '').trim()}`);   // Meta gives the number without + (always international)" },
      { find: "run_error: valid ? '' : 'sender number is not a valid Indian mobile (+91XXXXXXXXXX); nothing was stored',", replace: "run_error: valid ? '' : 'sender number is not a valid phone number (E.164, e.g. +919876543210); nothing was stored'," },
    ]);
    for (const name of ['W12 – Prepare request', 'W12 – Read reply']) ctx.editCode(name, [{ find: "return stop('invalid', 'decision.to is not a valid Indian mobile number');", replace: "return stop('invalid', 'decision.to is not a valid phone number (E.164, e.g. +919876543210)');" }]);
  },
};
