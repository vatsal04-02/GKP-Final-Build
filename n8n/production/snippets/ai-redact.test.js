const assert = require('assert');
const { fhqRedactText, fhqRedactRequest, fhqRestoreAnswer, FHQ_PATIENT } = require('./ai-redact');
const ids = { names: ['Priya Sharma'], phone: '+919876543210' };
const R = (s) => fhqRedactText(s, ids);

// direct identifiers go
assert.strictEqual(R('call me on +91 98765 43210 please'), 'call me on [NUMBER] please');
assert.strictEqual(R('098765-43210'), '[NUMBER]');
assert.strictEqual(R('+44 20 7946 0958'), '[NUMBER]');
assert.strictEqual(R('mail priya.s+x@example.co.in now'), 'mail [EMAIL] now');
assert.strictEqual(R('aadhaar 123456789012'), 'aadhaar [NUMBER]');
assert.strictEqual(R('I am Priya Sharma, priya here'), `I am ${FHQ_PATIENT} ${FHQ_PATIENT}, ${FHQ_PATIENT} here`);
assert.strictEqual(R('- name: Priya Sharma'), `- name: ${FHQ_PATIENT}`);
assert.strictEqual(R('- name: Somebody Else'), `- name: ${FHQ_PATIENT}`);
assert.strictEqual(R('9876543210'), '[NUMBER]');
// facts the model needs stay
assert.strictEqual(R('- 2026-10-20 = Tuesday 20 Oct'), '- 2026-10-20 = Tuesday 20 Oct');
assert.strictEqual(R('slots 09:00, 09:30, 17:30'), 'slots 09:00, 09:30, 17:30');
assert.strictEqual(R('2026-10-20 10:30 booked'), '2026-10-20 10:30 booked');
assert.strictEqual(R('fee is Rs 1500, 5 sessions'), 'fee is Rs 1500, 5 sessions');
assert.strictEqual(R('priyanka and Priyasha'), 'priyanka and Priyasha');   // whole words only
// the phone number written in another format than the CRM stores is still caught through the known digits
assert.strictEqual(fhqRedactText('my number is 98765.43210', ids), 'my number is [NUMBER]');
assert.strictEqual(fhqRedactText('', ids), '');
assert.strictEqual(fhqRedactText(null, ids), '');
assert.strictEqual(fhqRedactText('Priya', { names: ['A'] }), 'Priya');   // one-letter "names" are not masked

// request: only patient blocks are filtered, shape is checked
const req = {
  model: 'm', max_tokens: 10,
  system: [{ type: 'text', text: 'RULES price 1500 - 2000' }, { type: 'text', text: 'CLINIC fee 1500 - 2000', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'NOW: Tue 2026-10-20\nPATIENT\n- name: Priya Sharma\n- earlier summary: call +919876543210\nRECENT CONVERSATION\n- In: hi I am Priya' }],
  messages: [{ role: 'user', content: '<patient_message>\nmail priya@x.com\n</patient_message>' }],
};
const out = fhqRedactRequest(req, ids);
assert.strictEqual(out.system[0].text, 'RULES price 1500 - 2000');
assert.strictEqual(out.system[1].text, 'CLINIC fee 1500 - 2000');
assert(!/Priya|9876543210/.test(out.system[2].text), out.system[2].text);
assert(/2026-10-20/.test(out.system[2].text));
assert(!/priya@x.com/.test(out.messages[0].content));
assert.strictEqual(out.system.length, 4);
assert(/Privacy:/.test(out.system[3].text));
assert(/Priya/.test(JSON.stringify(req)), 'the input must not be mutated');
assert.throws(() => fhqRedactRequest({ system: [{ text: 'x' }], messages: [] }, ids), /patient-facts block/);
assert.throws(() => fhqRedactRequest({ system: [{ text: 'NOW: a' }, { text: 'NOW: b' }], messages: [] }, ids), /found 2/);
assert.throws(() => fhqRedactRequest(null, ids), /unexpected shape/);

// answer: the name comes back, JSON stays valid even for hostile names
const ans = { type: 'message', content: [{ type: 'text', text: JSON.stringify({ reply: `Hi ${FHQ_PATIENT}, we open at 9.` }) }] };
assert.strictEqual(JSON.parse(fhqRestoreAnswer(ans, 'Priya Sharma').content[0].text).reply, 'Hi Priya, we open at 9.');
assert.strictEqual(JSON.parse(fhqRestoreAnswer(ans, '"; DROP\\ x').content[0].text).reply, 'Hi there, we open at 9.');
assert.strictEqual(JSON.parse(fhqRestoreAnswer(ans, 'Ev"il\n Name').content[0].text).reply, 'Hi Evil, we open at 9.');
assert.strictEqual(JSON.parse(fhqRestoreAnswer(ans, '').content[0].text).reply, 'Hi there, we open at 9.');
assert.deepStrictEqual(fhqRestoreAnswer({ error: { message: 'x' } }, 'A'), { error: { message: 'x' } });
console.log('ai-redact: all assertions passed');
