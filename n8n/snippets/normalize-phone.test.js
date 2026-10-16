// Run: node n8n/snippets/normalize-phone.test.js
const assert = require('assert');
const { normalizeIndianPhone } = require('./normalize-phone');

const cases = [
  ['9876543210', '+919876543210'],
  ['+91 98765 43210', '+919876543210'],
  ['919876543210', '+919876543210'],
  ['09876543210', '+919876543210'],
  ['0091-98765-43210', '+919876543210'],
  ['(+91) 98765-43210', '+919876543210'],
  ['5876543210', null],      // not a mobile prefix
  ['98765', null],           // too short
  ['', null],
  [null, null],
];

for (const [input, expected] of cases) {
  assert.strictEqual(normalizeIndianPhone(input).phone, expected, `input: ${input}`);
}
console.log(`All ${cases.length} phone cases pass`);
