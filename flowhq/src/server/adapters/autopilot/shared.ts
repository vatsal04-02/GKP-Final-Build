// The workflow's own shared code (n8n/snippets), loaded as-is: W9's weekly numbers and phone normalisation are computed by the
// SAME functions the n8n Code nodes run, so FLOW HQ can never show a different number for the same week.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function snippetsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.FLOWHQ_SNIPPETS_DIR,
    path.resolve(here, '../../../../../n8n/snippets'),   // src/server/adapters/autopilot -> repo/n8n/snippets
    path.resolve(here, '../../../n8n/snippets'),         // dist/server -> repo/n8n/snippets
    path.resolve(process.cwd(), '../n8n/snippets'),
    path.resolve(process.cwd(), 'n8n/snippets'),
  ].filter(Boolean) as string[];
  const found = candidates.find((d) => existsSync(path.join(d, 'clinic-modules.js')));
  if (!found) throw new Error('n8n/snippets not found: set FLOWHQ_SNIPPETS_DIR to the repository\'s n8n/snippets folder');
  return found;
}
const dir = snippetsDir();
const req = createRequire(path.join(dir, 'index.js'));

export interface WeekWindow { start: number; end: number; label: string }
export interface WeeklyMetrics {
  leads: { new: number; by_source: Record<string, number>; contacted: number; booked: number; still_new: number; median_first_response_minutes: number | null; stage: Record<'hot' | 'warm' | 'cold' | 'not_rated', number>; opted_out_total: number };
  appointments: { this_week: number; completed: number; no_show: number; cancelled: number; rescheduled: number; still_marked_booked: number; booked_next_7_days: number };
  ai: { patient_messages: number; replied: number; drafted: number; handed_off: number; no_reply: number; skipped: number; deferred: number; failed: number; opted_out: number; outcome_better: number; outcome_same: number; outcome_worse: number };
  people: { waiting_for_a_person: number; paused_conversations: number; staff_replies_sent: number };
  sent: { speed_to_lead_alerts: number; reminders: number; day2_followups: number; noshow_rebooks: number; outcome_checkins: number; review_requests: number; ai_runs: number };
  failures: { total: number; by_workflow: Record<string, number> };
  incomplete: { messages: boolean; run_log: boolean };
}
type Rec = { id: number; fields: Record<string, unknown> };
export const clinicModules = req('./clinic-modules.js') as {
  cmWeekWindow(nowMs: number): WeekWindow;
  cmWeeklyMetrics(data: { leads: Rec[]; appointments: Rec[]; conversations: Rec[]; messages: Rec[]; runlog: Rec[] }, nowMs: number, win: WeekWindow, caps?: { messages?: number; runlog?: number }): WeeklyMetrics;
  cmRenderReport(m: WeeklyMetrics, ai: { summary: string; observations: string[]; recommendations: string[]; dropped: number; error: string }, clinicName: string, win: WeekWindow, reviewLinkSet: boolean): { text: string; headline: string; top_action: string };
  cmHttps(v: unknown): string;
};
// Opening windows ("09:00-13:00, 16:00-20:00"): the receptionist's own parser, so Settings accepts exactly what W13 will read. undefined = empty, null = unreadable.
export const parseOpenHours = (text: string) => (req('./ai-receptionist.js') as { aiParseWindows(t: string, parseClock: (x: string) => number | null): number[][] | null | undefined }).aiParseWindows(text, (req('./clinic-hours.js') as { parseClock(x: string): number | null }).parseClock);
export const normalizePhone = (req('./normalize-phone.js') as { normalizeIndianPhone(raw: unknown): { phone: string | null; valid: boolean } }).normalizeIndianPhone;
export const sendGuard = req('./send-guard.js') as { decideSend(i: Record<string, unknown>): { send: boolean; to: string | null; reason: string; test_mode: boolean } };
// W10's own decision functions (used by demo mode to behave like the real staff-reply automation)
export const staffReply = req('./clinic-modules.js') as {
  cmStaffReplyCheck(row: Rec, conv: Rec | null, lead: Rec | null, settings: Record<string, unknown>, nowMs: number, h: unknown): { action: 'send' | 'reject' | 'hold' | 'none'; reason: string; patch?: Record<string, unknown> | null; claim?: Record<string, unknown>; decision?: { to: string; test_mode: boolean } };
  cmStaffReplyResult(rowId: number, res: Record<string, unknown>, nowSec: number): { message_patch: Record<string, unknown>; conversation_patch: Record<string, unknown> | null; log: Record<string, unknown> };
};
