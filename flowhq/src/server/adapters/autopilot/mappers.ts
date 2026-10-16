// Grist rows (Clinic Autopilot) -> FLOW HQ's universal model. Pure functions: no I/O, no clock (now is passed in).
// Backend column names are only read here; they are never renamed in Grist.
import type {
  Activity, ActivityKind, AutomationKey, Booking, BookingStatus, Contact, ContactStage, ContactStatus, Conversation, Message,
  MessageStatus, Priority, AiStatus,
} from '../../../core/domain';
import type { GristRecord } from '../../grist';
import { iso, sec } from '../../time';
import { APPT_STATUS, AUTOMATION_BY_RUNLOG, BOOKING_SYSTEM, LEAD_STATUS, REPLY_WINDOW_SEC, SENDERS } from './schema';

const txt = (v: unknown): string | null => { const s = v === null || v === undefined ? '' : String(v).trim(); return s ? s : null; };
const STAGES: ContactStage[] = ['hot', 'warm', 'cold'];
const AI_STATUSES: AiStatus[] = ['processing', 'replied', 'drafted', 'handed_off', 'no_reply', 'skipped', 'opted_out', 'deferred', 'failed'];

// "URGENT · Possible emergency..." / "HIGH · Unhappy..." (W13's hand-off reasons) -> priority
export function priorityOf(reason: unknown): Priority | null {
  const s = txt(reason);
  if (!s) return null;
  if (/^URGENT\b/i.test(s)) return 'urgent';
  if (/^HIGH\b/i.test(s)) return 'high';
  return 'normal';
}

export interface Indexes {
  leadsById: Map<string, GristRecord>;
  convByLead: Map<string, GristRecord>;
  convById: Map<string, GristRecord>;
  leadByRef: Map<string, GristRecord>;
}
export function indexes(leads: GristRecord[], convs: GristRecord[]): Indexes {
  const leadsById = new Map(leads.map((l) => [String(l.id), l]));
  const convByLead = new Map<string, GristRecord>();
  for (const c of convs) { const k = String(c.fields.Lead ?? ''); if (k && (!convByLead.has(k) || (sec(c.fields.Last_Inbound_At) || 0) > (sec(convByLead.get(k)!.fields.Last_Inbound_At) || 0))) convByLead.set(k, c); }
  const leadByRef = new Map<string, GristRecord>();
  for (const l of leads) { const r = txt(l.fields.Lead_id) || txt(l.fields.Lead_ID); if (r) leadByRef.set(r, l); }
  return { leadsById, convByLead, convById: new Map(convs.map((c) => [String(c.id), c])), leadByRef };
}

export function toContact(l: GristRecord, conv: GristRecord | null): Contact {
  const f = l.fields;
  const c = conv ? conv.fields : null;
  const status = (LEAD_STATUS as Record<string, ContactStatus>)[String(f.Status ?? '')] || null;
  const stage = STAGES.includes(f.Lead_Stage as ContactStage) ? (f.Lead_Stage as ContactStage) : null;
  const times = [sec(f.Created_At), sec(f.First_Response_At), c ? sec(c.Last_Inbound_At) : null].filter((x): x is number => !!x);
  return {
    id: String(l.id),
    ref: txt(f.Lead_id) || txt(f.Lead_ID),
    name: txt(f.Name) || txt(f.Phone) || `#${l.id}`,
    phone: txt(f.Phone),
    email: null,                                   // not stored by this backend
    source: txt(f.Source),
    status,
    stage,
    tags: [],                                      // not stored by this backend
    createdAt: iso(f.Created_At),
    lastActivityAt: times.length ? iso(Math.max(...times)) : null,
    nextActionAt: iso(f.Next_Action_At),
    owner: txt(f.Owner) || (c ? txt(c.Assigned_To) : null),
    aiSummary: txt(f.AI_Summary),
    interest: txt(f.Likely_Service),
    enquiry: txt(f.Enquiry),
    notes: txt(f.Notes),
    lostReason: txt(f.Lost_Reason),
    firstResponseAt: iso(f.First_Response_At),
    campaign: txt(f.UTM_Campaign),
    pageUrl: txt(f.Page_URL),
    attentionRequired: !!c && c.Needs_Human === true,
    attentionReason: c ? txt(c.Handoff_Reason) : null,
    priority: c && c.Needs_Human === true ? priorityOf(c.Handoff_Reason) || 'normal' : null,
    optedOut: f.Opted_Out === true,
    escalated: f.Escalated === true,
    conversationId: conv ? String(conv.id) : null,
    custom: {},
  };
}

export function toBooking(a: GristRecord, ix: Indexes, now: number, showValue: boolean): Booking {
  const f = a.fields;
  const status = (APPT_STATUS as Record<string, BookingStatus>)[String(f.Status ?? '')] || 'scheduled';
  const lead = ix.leadsById.get(String(f.Lead ?? ''));
  const uid = txt(f.Booking_UID);
  const start = sec(f.Start);
  const done: Booking['automationsDone'] = [];
  const mark = (col: string, key: AutomationKey, label: string) => { if (f[col]) done.push({ key, at: iso(f[col]), label }); };
  mark('R24_Sent', 'booking_reminders', 'Day-before reminder');
  mark('R2_Sent', 'booking_reminders', 'Same-day reminder');
  mark('Rebook_Sent', 'follow_ups', 'New time offered');
  mark('Outcome_Sent', 'outcome_checkins', 'Check-in sent');
  mark('Review_Sent', 'review_requests', 'Review requested');
  return {
    id: String(a.id),
    ref: uid,
    title: txt(f.Service) || '',
    contactId: lead ? String(lead.id) : null,
    contactName: lead ? txt(lead.fields.Name) || txt(lead.fields.Phone) : null,
    start: iso(start),
    end: iso(f.End) || (start ? iso(start + 45 * 60) : null),
    status,
    owner: txt(f.Physio),
    service: txt(f.Service),
    source: uid && uid.startsWith('wa-') ? { kind: 'assistant', label: 'Booked in chat' } : { kind: 'external_calendar', label: BOOKING_SYSTEM },
    value: showValue && typeof f.Fee_INR === 'number' ? (f.Fee_INR as number) : null,
    needsOutcome: (status === 'scheduled' || status === 'rescheduled') && !!start && start * 1000 < now - 3600000,
    automationsDone: done,
  };
}

export function toConversation(c: GristRecord, lead: GristRecord | null, last: GristRecord | null, aiMode: string, nowSec: number): Conversation {
  const f = c.fields;
  const lastIn = sec(f.Last_Inbound_At);
  const open = !!lastIn && nowSec - lastIn < REPLY_WINDOW_SEC;
  const optedOut = !!lead && lead.fields.Opted_Out === true;
  return {
    id: String(c.id),
    contactId: lead ? String(lead.id) : null,
    contactName: (lead && (txt(lead.fields.Name) || txt(lead.fields.Phone))) || txt(f.Phone) || `#${c.id}`,
    contactPhone: txt(f.Phone) || (lead ? txt(lead.fields.Phone) : null),
    channel: 'whatsapp',
    lastInboundAt: iso(lastIn),
    lastMessageAt: last ? iso(last.fields.Created_At) : iso(lastIn),
    lastMessagePreview: last ? txt(last.fields.Body)?.slice(0, 140) || null : null,
    lastMessageDirection: last ? (last.fields.Direction === 'In' ? 'in' : 'out') : null,
    unread: Number(f.Unread) || 0,
    assignedTo: txt(f.Assigned_To),
    attentionRequired: f.Needs_Human === true,
    attentionReason: txt(f.Handoff_Reason),
    priority: f.Needs_Human === true ? priorityOf(f.Handoff_Reason) || 'normal' : null,
    automationPaused: f.Automation_Paused === true,
    lastIntent: txt(f.Last_Intent),
    aiActive: aiMode !== 'off' && f.Automation_Paused !== true && !optedOut,
    optedOut,
    replyWindow: { open, closesAt: lastIn ? iso(lastIn + REPLY_WINDOW_SEC) : null, hours: 24 },
  };
}

// Messages.Sent_By: "Patient" / "W13-ai-receptionist" / "W5-reminders (TEST_MODE: sent to ...)" / a person's name.
export function authorOf(m: GristRecord, contactName: string): Message['author'] {
  const f = m.fields;
  const by = txt(f.Sent_By) || '';
  const testMode = /TEST_MODE/.test(by);
  if (f.Direction === 'In') return { kind: 'contact', name: contactName, automationKey: null, testMode: false };
  const w = by.match(/^W(\d+)(?!\w)/);
  if (w) {
    const key = SENDERS[`W${w[1]}`] || null;
    if (key === 'ai_assistant') return { kind: 'ai', name: '', automationKey: key, testMode };
    if (key) return { kind: 'automation', name: '', automationKey: key, testMode };
    return { kind: 'system', name: by.replace(/\s*\(TEST_MODE.*$/, ''), automationKey: null, testMode };
  }
  return { kind: 'staff', name: by || 'Team', automationKey: 'staff_reply', testMode: false };
}

// The workflows write their notes for a clinic ("the patient's last message..."); FLOW HQ shows them in the workspace's words.
export const universal = (s: string | null) => (s ? s.replace(/\bpatient's\b/gi, "{contact.singular|lower}'s").replace(/\bpatients\b/gi, '{contact.plural|lower}').replace(/\bpatient\b/gi, '{contact.singular|lower}') : s);
export function statusOf(m: GristRecord): { status: MessageStatus; note: string | null } {
  const f = m.fields;
  if (f.Direction === 'In') return { status: 'received', note: null };
  const s = String(f.Status ?? '');
  const wa = txt(f.WA_Message_ID);
  const reason = universal(txt(f.AI_Reason));
  if (f.Send === true && !wa) return { status: 'pending', note: reason };            // waiting for the staff-reply automation
  if (s === 'failed') return { status: 'failed', note: reason };
  if (s === 'needs_template') return { status: 'needs_template', note: reason };
  if (s === 'delivered' || s === 'read') return { status: s, note: null };
  if (wa) return { status: 'sent', note: /TEST_MODE/.test(reason || '') ? reason : null };   // accepted by the messaging provider
  if (s === 'queued') return { status: 'queued', note: reason };
  return { status: 'sent', note: null };
}

export function toMessage(m: GristRecord, contactName: string): Message {
  const f = m.fields;
  const st = statusOf(m);
  const hasAi = f.Direction === 'In' && (f.AI_Status || f.Intent);
  return {
    id: String(m.id),
    conversationId: String(f.Conversation ?? ''),
    direction: f.Direction === 'In' ? 'in' : 'out',
    body: String(f.Body ?? ''),
    template: txt(f.Template),
    author: authorOf(m, contactName),
    status: st.status,
    statusNote: st.note,
    createdAt: iso(f.Created_At),
    externalId: txt(f.WA_Message_ID),
    ai: hasAi ? {
      intent: txt(f.Intent),
      action: txt(f.AI_Action),
      confidence: typeof f.AI_Confidence === 'number' ? (f.AI_Confidence as number) : null,
      status: AI_STATUSES.includes(f.AI_Status as AiStatus) ? (f.AI_Status as AiStatus) : null,
      needsHuman: f.Needs_Human === true,
      reply: txt(f.AI_Reply),
      reason: txt(f.AI_Reason),
    } : null,
  };
}

// ---------------------------------------------------------------- activity: Leads + Messages + Run_Log, without double counting
const SEND_KIND: Partial<Record<AutomationKey, ActivityKind>> = {
  booking_reminders: 'reminder_sent', follow_ups: 'follow_up_sent', outcome_checkins: 'outcome_checkin_sent', review_requests: 'review_requested', speed_to_lead: 'message_sent', weekly_reports: 'message_sent',
};
export function activityFrom(leads: GristRecord[], messages: GristRecord[], runLog: GristRecord[], ix: Indexes): Activity[] {
  const out: Activity[] = [];
  const contactOfConv = (convId: unknown) => { const c = ix.convById.get(String(convId ?? '')); const l = c ? ix.leadsById.get(String(c.fields.Lead ?? '')) : undefined; return { c, l }; };
  const nameOf = (l?: GristRecord) => (l ? txt(l.fields.Name) || txt(l.fields.Phone) : null);
  for (const l of leads) {
    const at = iso(l.fields.Created_At);
    if (at) out.push({ id: `lead-${l.id}`, kind: 'contact_created', at, contactId: String(l.id), contactName: nameOf(l), conversationId: ix.convByLead.get(String(l.id)) ? String(ix.convByLead.get(String(l.id))!.id) : null, bookingRef: null, automationKey: null, outcome: 'ok', detail: txt(l.fields.Source) });
  }
  for (const m of messages) {
    const at = iso(m.fields.Created_At);
    if (!at) continue;
    const { c, l } = contactOfConv(m.fields.Conversation);
    const base = { contactId: l ? String(l.id) : null, contactName: nameOf(l) || (c ? txt(c.fields.Phone) : null), conversationId: c ? String(c.id) : null, bookingRef: null };
    const body = txt(m.fields.Body)?.slice(0, 120) || null;
    if (m.fields.Direction === 'In') {
      out.push({ id: `msg-${m.id}`, kind: 'message_received', at, ...base, automationKey: 'inbound_messaging', outcome: 'ok', detail: body });
      if (m.fields.AI_Status === 'handed_off') out.push({ id: `handoff-${m.id}`, kind: 'ai_handoff', at, ...base, automationKey: 'ai_assistant', outcome: 'ok', detail: txt(m.fields.AI_Reason) });
      continue;
    }
    const a = authorOf(m, '');
    const st = statusOf(m).status;
    if (st === 'pending' || st === 'queued') continue;
    const failed = st === 'failed' || st === 'needs_template';
    if (a.kind === 'ai') out.push({ id: `msg-${m.id}`, kind: 'ai_replied', at, ...base, automationKey: 'ai_assistant', outcome: failed ? 'failed' : 'ok', detail: body });
    else if (a.kind === 'staff') out.push({ id: `msg-${m.id}`, kind: failed ? 'automation_failed' : 'staff_replied', at, ...base, automationKey: 'staff_reply', outcome: failed ? 'failed' : 'ok', detail: failed ? txt(m.fields.AI_Reason) : body });
    else if (a.automationKey) out.push({ id: `msg-${m.id}`, kind: failed ? 'automation_failed' : SEND_KIND[a.automationKey] || 'message_sent', at, ...base, automationKey: a.automationKey, outcome: failed ? 'failed' : 'ok', detail: body });
  }
  for (const r of runLog) {
    const f = r.fields;
    const at = iso(f.At);
    if (!at) continue;
    const wf = String(f.Workflow ?? '');
    const key = AUTOMATION_BY_RUNLOG[wf] || null;
    const rec = String(f.Record ?? '');
    const outcome = f.Outcome === 'failed' ? 'failed' : f.Outcome === 'skipped' ? 'skipped' : 'ok';
    const ref = rec.match(/L-\d{8}-\d{3,}/);
    const lead = ref ? ix.leadByRef.get(ref[0]) : undefined;
    const base = { contactId: lead ? String(lead.id) : null, contactName: nameOf(lead), conversationId: lead && ix.convByLead.get(String(lead.id)) ? String(ix.convByLead.get(String(lead.id))!.id) : null, automationKey: key };
    if (outcome === 'failed') { out.push({ id: `log-${r.id}`, kind: 'automation_failed', at, ...base, bookingRef: null, outcome, detail: txt(f.Error) || rec.slice(0, 160) }); continue; }
    if (outcome === 'skipped' && key !== 'contact_capture') { out.push({ id: `log-${r.id}`, kind: 'automation_skipped', at, ...base, bookingRef: null, outcome, detail: txt(f.Error) || rec.slice(0, 160) }); continue; }
    if (key === 'booking_sync') {
      const k = /\(cancel/i.test(rec) ? 'booking_cancelled' : /\(reschedul/i.test(rec) ? 'booking_rescheduled' : 'booking_created';
      out.push({ id: `log-${r.id}`, kind: k, at, ...base, bookingRef: rec.split(' ')[0] || null, outcome, detail: null });
    } else if (key === 'speed_to_lead') out.push({ id: `log-${r.id}`, kind: 'contact_escalated', at, ...base, bookingRef: null, outcome, detail: null });
    else if (key === 'weekly_reports' && /^WEEKLY REPORT/.test(rec)) out.push({ id: `log-${r.id}`, kind: 'report_generated', at, ...base, bookingRef: null, outcome, detail: rec.split('\n')[0].slice(0, 160) });
    // W1 / W2 / W5-W8 / W10 / W13 'ok' rows repeat what Leads and Messages already show: not listed twice
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

// W9's stored report (Run_Log.Record) -> sections
export function parseReport(r: GristRecord): { title: string; periodLabel: string | null; sections: Array<{ key: string; title: string; lines: string[] }>; preface: string[] } {
  const lines = String(r.fields.Record ?? '').split('\n');
  const title = lines[0] || 'Weekly report';
  const m = title.match(/ - ([^-]+ to [^-]+)$/);
  const sections: Array<{ key: string; title: string; lines: string[] }> = [];
  const preface: string[] = [];
  for (const line of lines.slice(1)) {
    const h = line.match(/^(\d)\. (.+)$/);
    if (h) { sections.push({ key: `s${h[1]}`, title: h[2], lines: [] }); continue; }
    if (!line.trim()) continue;
    if (sections.length) sections[sections.length - 1].lines.push(line.replace(/^- /, ''));
    else preface.push(line);
  }
  return { title, periodLabel: m ? m[1].trim() : null, sections, preface };
}
