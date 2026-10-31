// The printed patient register: A4 landscape, one patient per line, every patient in the current view (not just the visible page).
// Nothing is clipped: columns have fixed widths and a long address or complaint wraps inside its own cell instead of being cut off.
// Rows never split across pages and the column headings repeat on every page. Screen-hidden; shown only when printing.
import type { PatientRow } from '@core/clinical';
import { fdate, rs, useClinic } from './common';

const MARK: Record<string, string> = { Attended: '✓', Missed: '✗', Cancelled: '–' };
const DAY = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

// widths are relative; the table is scaled to 100% (week columns are added when the weekly view is on)
const COLS: Array<{ h: string; w: number; cls?: string; cell: (p: PatientRow) => string }> = [
  { h: 'S.No', w: 2.5, cls: 'r', cell: (p) => String(p.serialNo) },
  { h: 'Patient ID', w: 6.2, cls: 'n', cell: (p) => p.patientId },
  { h: 'Name', w: 10, cls: 'b', cell: (p) => `${p.name}${p.age || p.sex ? ` (${[p.age, p.sex?.charAt(0)].filter(Boolean).join(' ')})` : ''}` },
  { h: 'Contact', w: 7.6, cls: 'n', cell: (p) => p.phone || '—' },
  { h: 'Address', w: 10.4, cell: (p) => p.address || '—' },
  { h: 'Referred by', w: 5.8, cell: (p) => p.referredBy || '—' },
  { h: 'Occupation', w: 5.8, cell: (p) => p.occupation || '—' },
  { h: 'Disorder / complaint', w: 12, cell: (p) => p.mainComplaint || '—' },
  { h: 'Registered', w: 5.8, cls: 'n', cell: (p) => fdate(p.registeredOn) },
  { h: 'Billed', w: 5.6, cls: 'r', cell: (p) => rs(p.billedPaise) },
  { h: 'Paid', w: 5.6, cls: 'r', cell: (p) => rs(p.paidPaise) },
  { h: 'Balance', w: 5.6, cls: 'r b', cell: (p) => rs(p.outstandingPaise) },
  { h: 'Last visit', w: 5.6, cls: 'n', cell: (p) => fdate(p.latestVisit) },
  { h: 'Follow-up', w: 5.6, cls: 'n', cell: (p) => fdate(p.followUpOn) },
  { h: 'Status', w: 5.4, cls: 'n', cell: (p) => p.status },
];
const WEEK_W = 2.6;

export function RegisterPrint({ rows, totals, days, summary }: { rows: PatientRow[]; totals: { billedPaise: number; paidPaise: number; outstandingPaise: number }; days: string[] | null; summary: string }) {
  const clinic = useClinic().data;
  const total = COLS.reduce((a, c) => a + c.w, 0) + (days ? days.length * WEEK_W : 0);
  const pct = (w: number) => `${((w / total) * 100).toFixed(2)}%`;
  const label = COLS.length - 6;   // the totals line spans everything before "Billed"
  return (
    <div className="register-print hidden print:block">
      <div className="rp-head">
        <div><div className="rp-name">{clinic?.name || 'Patient register'}</div><div className="rp-title">Patient register · {rows.length} patient{rows.length === 1 ? '' : 's'}{summary ? ` · ${summary}` : ''}</div></div>
        <div className="rp-date">Printed {new Date().toLocaleDateString('en-GB')}</div>
      </div>
      <table className="rp-table">
        <colgroup>{COLS.map((c) => <col key={c.h} style={{ width: pct(c.w) }} />)}{days?.map((d) => <col key={d} style={{ width: pct(WEEK_W) }} />)}</colgroup>
        <thead><tr>{COLS.map((c) => <th key={c.h} className={c.cls}>{c.h}</th>)}{days?.map((d, i) => <th key={d} className="c">{DAY[i]}<br />{d.slice(8)}</th>)}</tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.patientId}>
              {COLS.map((c) => <td key={c.h} className={c.cls}>{c.cell(p)}</td>)}
              {days?.map((d) => <td key={d} className="c">{p.attendance?.[d] ? MARK[p.attendance[d]] : ''}</td>)}
            </tr>
          ))}
        </tbody>
        <tfoot><tr>
          <td colSpan={label} className="b">Totals for {rows.length} patient{rows.length === 1 ? '' : 's'}</td>
          <td className="r b">{rs(totals.billedPaise)}</td><td className="r b">{rs(totals.paidPaise)}</td><td className="r b">{rs(totals.outstandingPaise)}</td><td colSpan={3 + (days?.length || 0)} />
        </tr></tfoot>
      </table>
    </div>
  );
}
