// n8n Code node helper: is a clinic open right now (India time)? Reads the clinic's Settings values.
// Paste parseClock, parseDays and isOpenNow into the Code node that builds the clinic's settings.
//
// Settings (Value text):
//   open_time, close_time   24-hour "09:00", "19:30" (also read: "9:00", "9 AM", "7:30 pm")
//   working_days            "Mon-Sat", "Mon,Tue,Thu", "Monday to Friday", "daily" (also "Fri-Mon" wrapping the week)
// Anything missing or unreadable falls back to the global send window 08:00-21:00 on every day (CLAUDE.md rule 5),
// and the answer says source: 'default' so the caller can tell. A bad clock (now_ms not a number) means CLOSED.
//
// Input:  { open_time, close_time, working_days, now_ms }
// Output: { open: boolean, source: 'settings' | 'default' }

const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseClock(text) {
  const m = String(text === null || text === undefined ? '' : text).trim().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3] ? m[3][0].toLowerCase() : '';
  if (min > 59) return null;
  if (meridiem) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (meridiem === 'p' ? 12 : 0);
  } else if (h > 24 || (h === 24 && min > 0)) {
    return null;
  }
  return h * 60 + min;   // minutes after midnight
}

function parseDays(text) {
  const s = String(text === null || text === undefined ? '' : text).toLowerCase().replace(/[–—]/g, '-').replace(/\s+to\s+/g, '-').replace(/\s+(and|&)\s+/g, ',').trim();
  if (!s) return null;
  if (/^(daily|every ?day|all days|7 ?days?)$/.test(s)) return [0, 1, 2, 3, 4, 5, 6];
  const dayOf = (t) => {
    const x = t.trim();
    return /^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?$/.test(x) ? DAY_INDEX[x.slice(0, 3)] : undefined;
  };
  const days = new Set();
  for (const token of s.split(/[,;/]+/)) {
    if (!token.trim()) continue;
    if (token.includes('-')) {
      const [a, b] = token.split('-').map(dayOf);
      if (a === undefined || b === undefined) return null;
      for (let d = a; ; d = (d + 1) % 7) { days.add(d); if (d === b) break; }
    } else {
      const d = dayOf(token);
      if (d === undefined) return null;
      days.add(d);
    }
  }
  return days.size ? [...days].sort() : null;   // 0 = Sunday
}

function isOpenNow(i) {
  if (!Number.isFinite(i.now_ms)) return { open: false, source: 'default' };
  let open = parseClock(i.open_time);
  let close = parseClock(i.close_time);
  let days = parseDays(i.working_days);
  let source = 'settings';
  if (open === null || close === null || close <= open) { open = 8 * 60; close = 21 * 60; source = 'default'; }
  if (days === null) { days = [0, 1, 2, 3, 4, 5, 6]; source = 'default'; }
  const t = new Date(i.now_ms + 5.5 * 3600 * 1000);   // IST wall-clock via UTC getters
  const minutes = t.getUTCHours() * 60 + t.getUTCMinutes();
  return { open: days.includes(t.getUTCDay()) && minutes >= open && minutes < close, source };
}

// ---- n8n Code node body (uncomment inside n8n) ----
// const hours = isOpenNow({ open_time: s.open_time, close_time: s.close_time, working_days: s.working_days, now_ms: Date.now() });

if (typeof module !== 'undefined') module.exports = { parseClock, parseDays, isOpenNow };
