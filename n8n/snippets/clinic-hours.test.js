// Run: node n8n/snippets/clinic-hours.test.js
const assert = require('assert');
const { parseClock, parseDays, isOpenNow } = require('./clinic-hours');

let n = 0;
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); n++; };

// ---- parseClock
for (const [input, mins] of [
  ['09:00', 540], ['9:00', 540], ['9', 540], ['19:30', 1170], ['00:00', 0], ['24:00', 1440], ['9.30', 570], [' 09:00 ', 540],
  ['9 AM', 540], ['9:00 am', 540], ['7:30 pm', 1170], ['12 PM', 720], ['12 AM', 0], ['12:15 a.m.', 15], ['1 p.m.', 780],
  ['25:00', null], ['24:30', null], ['9:60', null], ['13 pm', null], ['0 am', null], ['', null], ['soon', null], [null, null], [undefined, null], ['9:00-17:00', null],
]) eq(parseClock(input), mins, `parseClock(${JSON.stringify(input)})`);

// ---- parseDays (0 = Sunday)
const MON_SAT = [1, 2, 3, 4, 5, 6];
for (const [input, days] of [
  ['Mon-Sat', MON_SAT], ['mon - sat', MON_SAT], ['Monday to Saturday', MON_SAT], ['Mon–Sat', MON_SAT], ['MON-SAT', MON_SAT],
  ['Mon,Tue,Thu', [1, 2, 4]], ['Mon, Tue and Thu', [1, 2, 4]], ['Mon & Wed', [1, 3]], ['monday, wednesday, friday', [1, 3, 5]],
  ['Mon-Fri, Sat', MON_SAT], ['Sat', [6]], ['sun', [0]], ['Fri-Mon', [0, 1, 5, 6]],
  ['daily', [0, 1, 2, 3, 4, 5, 6]], ['Every day', [0, 1, 2, 3, 4, 5, 6]], ['7 days', [0, 1, 2, 3, 4, 5, 6]],
  ['', null], ['weekdays', null], ['Mon-Xyz', null], ['Mon-Sat except Thu', null], ['1-6', null], [null, null],
]) eq(parseDays(input), days, `parseDays(${JSON.stringify(input)})`);

// ---- isOpenNow (instants given in IST). 2026-10-05 is a Monday, 2026-10-04 a Sunday.
const ist = (s) => Date.parse(`${s}+05:30`);
const settings = { open_time: '09:00', close_time: '19:00', working_days: 'Mon-Sat' };
const open = (s, over = {}) => isOpenNow({ ...settings, ...over, now_ms: ist(s) });

eq(open('2026-10-05T09:00:00'), { open: true, source: 'settings' }, 'opens at 09:00');
eq(open('2026-10-05T08:59:59').open, false, 'one second before opening');
eq(open('2026-10-05T18:59:59').open, true, 'last second before closing');
eq(open('2026-10-05T19:00:00').open, false, 'closed at 19:00');
eq(open('2026-10-05T13:00:00').open, true, 'midday');
eq(open('2026-10-04T13:00:00').open, false, 'Sunday is not a working day');
eq(open('2026-10-10T13:00:00').open, true, 'Saturday is');
eq(open('2026-10-05T03:00:00').open, false, 'night');

// the India date, not the UTC date, decides the weekday: Monday 00:30 IST is still Sunday in UTC
eq(open('2026-10-05T00:30:00', { open_time: '00:00', close_time: '23:00', working_days: 'Mon' }).open, true, 'Monday 00:30 IST counts as Monday');
eq(open('2026-10-05T23:30:00', { open_time: '09:00', close_time: '24:00', working_days: 'Mon' }).open, true, '24:00 close works');

// fallbacks: missing / unreadable settings use 08:00-21:00 every day and say so
eq(isOpenNow({ now_ms: ist('2026-10-04T08:00:00') }), { open: true, source: 'default' }, 'nothing set: Sunday 08:00 open');
eq(isOpenNow({ now_ms: ist('2026-10-04T07:59:00') }).open, false, 'nothing set: before 08:00 closed');
eq(isOpenNow({ now_ms: ist('2026-10-04T20:59:00') }).open, true, 'nothing set: 20:59 open');
eq(isOpenNow({ now_ms: ist('2026-10-04T21:00:00') }).open, false, 'nothing set: 21:00 closed');
eq(open('2026-10-05T13:00:00', { open_time: 'late' }), { open: true, source: 'default' }, 'unreadable open_time falls back to 08:00-21:00');
eq(open('2026-10-05T20:00:00', { open_time: 'late' }).open, true, '...so 20:00 is open (default window), not closed by the 19:00 close_time');
eq(open('2026-10-05T13:00:00', { close_time: '08:00' }).source, 'default', 'close before open is ignored');
eq(open('2026-10-04T13:00:00', { working_days: 'weekdays' }), { open: true, source: 'default' }, 'unreadable working_days = every day');

// no clock => closed (fail safe)
eq(isOpenNow({ ...settings, now_ms: NaN }).open, false, 'NaN clock');
eq(isOpenNow({ ...settings, now_ms: undefined }).open, false, 'missing clock');

console.log(`All ${n} clinic-hours cases pass`);
