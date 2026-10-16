// FLOW HQ adapter #1: the Clinic Autopilot backend (Grist CRM per business + n8n workflows W1-W13).
//   Leads -> Contact · Appointments -> Booking · Conversations -> Conversation · Messages -> Message · Run_Log -> Activity
//   Settings -> workspace settings · Knowledge -> AI knowledge · W13 -> AI engine · W10 -> staff reply · W12 -> messaging gateway
// Reads and writes go to Grist only. The adapter never calls n8n, Meta, OpenRouter or the booking system: a staff reply is a
// Messages row with Send ticked, which W10 picks up and sends through W12, exactly as when staff write it in Grist.
import type {
  AiOverview, Analytics, AnalyticsMetric, Automation, AutomationKey, Booking, BookingStatus, Capabilities, Contact, ContactStage,
  Conversation, Dashboard, KnowledgeItem, Message, MetricValue, Priority, Report, SettingField, SettingsView, Task,
} from '../../../core/domain';
import { BackendError, GristClient, type FetchLike, type GristRecord } from '../../grist';
import { dayKey, iso, nextRun, scheduleLabel, sec, startOfDay } from '../../time';
import type { BackendAdapter, BackendWorkspaceInfo, Ctx, Supported, Viewer, WorkspaceBackend, ContactQuery, ConversationQuery, BookingQuery, ActivityQuery, ContactPatch, ConversationPatch } from '../types';
import { activityFrom, indexes, parseReport, toBooking, toContact, toConversation, toMessage, priorityOf, universal } from './mappers';
import { AUTOMATIONS as CATALOGUE } from '../../../core/registry';
import { AUTOMATIONS, AUTOMATION_BY_RUNLOG, BOOKING_SYSTEM, CHANNELS, COLUMNS, KNOWLEDGE_CATEGORIES, REPLY_WINDOW_SEC, SETTINGS, TABLES, isOn, isTestMode } from './schema';
import { clinicModules, normalizePhone, parseOpenHours } from './shared';
import { RecordsService, type ClinicConfig } from '../../records/service';
import { RECORD_TABLE_NAMES } from '../../records/schema';

export interface AutopilotConfig {
  gristBaseUrl: string;
  gristApiKey: string;
  registryDocId: string;
  leadsTable?: string;
  timezone: string;
  locale: string;
  currency: string;
  fetchImpl?: FetchLike;
  cacheMs?: number;
  readLimit?: number;
  clinic?: (slug: string, workspaceName: string) => ClinicConfig;   // letterhead + invoice rules (config/clinic.json)
}
const DAY = 86400000;
const SUPPORTED: Supported = {
  modules: ['bookings', 'ai', 'lead_qualification', 'reviews', 'follow_ups', 'reminders', 'reports', 'tasks', 'staff', 'analytics'],
  automations: Object.keys(AUTOMATIONS) as AutomationKey[],
  metrics: ['new_contacts', 'active_conversations', 'bookings', 'completed', 'pending_actions', 'ai_handled', 'human_handoffs', 'conversion', 'revenue', 'follow_ups', 'reviews', 'reminders', 'no_shows'],
};
const RECORD_MODULES: Supported['modules'] = ['patients', 'prescriptions', 'invoices', 'visits'];
const PROCESSED = ['replied', 'drafted', 'handed_off', 'no_reply', 'failed'];
const HANDLED = ['replied', 'no_reply'];
const PRIORITY_ORDER: Record<Priority, number> = { urgent: 0, high: 1, normal: 2 };
const LEAD_STATUS_BACK: Record<string, string> = { new: 'New', contacted: 'Contacted', booked: 'Booked', converted: 'Converted', lost: 'Lost' };

interface RegistryRow { slug: string; name: string; docId: string; waConnected: boolean }

export function createAutopilotAdapter(cfg: AutopilotConfig): BackendAdapter {
  const grist = new GristClient(cfg.gristBaseUrl, cfg.gristApiKey, cfg.fetchImpl);
  let registry: { at: number; rows: RegistryRow[] } | null = null;
  const instances = new Map<string, AutopilotWorkspace>();
  const loadRegistry = async (): Promise<RegistryRow[]> => {
    if (registry && Date.now() - registry.at < 60000) return registry.rows;
    const rows = await grist.records(cfg.registryDocId, TABLES.registry);
    const out = rows
      .filter((r) => String(r.fields.Active).toUpperCase() === 'TRUE' && String(r.fields.Grist_Doc_ID || '').trim() && String(r.fields.Clinic_Slug || '').trim())
      .map((r) => ({ slug: String(r.fields.Clinic_Slug).trim(), name: String(r.fields.Clinic_Name || r.fields.Clinic_Slug).trim(), docId: String(r.fields.Grist_Doc_ID).trim(), waConnected: !!String(r.fields.WA_Phone_Number_ID || '').trim() }));
    registry = { at: Date.now(), rows: out };
    return out;
  };
  const info = (r: RegistryRow): BackendWorkspaceInfo => ({ id: r.slug, name: r.name, timezone: cfg.timezone, locale: cfg.locale, currency: cfg.currency, channels: r.waConnected ? CHANNELS : [] });
  return {
    key: 'autopilot-grist-n8n',
    label: 'Clinic Autopilot (Grist + n8n)',
    async listWorkspaces() { return (await loadRegistry()).map(info); },
    async workspace(id: string) {
      const r = (await loadRegistry()).find((x) => x.slug === id);
      if (!r) return null;
      let inst = instances.get(id);
      if (!inst || inst.docId !== r.docId) { inst = new AutopilotWorkspace(grist, cfg, r, info(r)); instances.set(id, inst); }
      inst.info = info(r);
      await inst.probeRecords();
      return inst;
    },
    async health() {
      try { const n = (await loadRegistry()).length; return { ok: true, detail: `${n} active workspace(s) in the registry` }; } catch (e) { return { ok: false, detail: (e as Error).message }; }
    },
  };
}

class AutopilotWorkspace implements WorkspaceBackend {
  supported: Supported = SUPPORTED;
  private recordsSvc: RecordsService | null = null;
  private probedAt = 0;
  docId: string;
  private cache = new Map<string, { at: number; rows: GristRecord[] }>();
  private leadsTable: string;
  constructor(private grist: GristClient, private cfg: AutopilotConfig, private reg: RegistryRow, public info: BackendWorkspaceInfo) {
    this.docId = reg.docId;
    this.leadsTable = cfg.leadsTable || TABLES.leads;
  }

  records() { return this.recordsSvc; }
  // The clinical modules appear only when ALL Clinic Records tables exist in this clinic's doc (npm run provision-records creates them).
  // Concurrent requests share one probe: a request that arrives while the first probe is still running waits for its answer
  // (without this, the first page load after a restart could be served a workspace without the clinical pages).
  private probing: Promise<void> | null = null;
  probeRecords(): Promise<void> {
    if (this.probing) return this.probing;
    if (Date.now() - this.probedAt < 60000) return Promise.resolve();
    this.probing = this.runProbe().finally(() => { this.probing = null; });
    return this.probing;
  }
  private async runProbe(): Promise<void> {
    this.probedAt = Date.now();
    const missing: string[] = []; let unreachable = false;
    await Promise.all(RECORD_TABLE_NAMES.map(async (t) => { try { await this.grist.records(this.docId, t, { limit: 1 }); } catch (e) { if (e instanceof BackendError && e.status === 404) missing.push(t); else unreachable = true; } }));
    if (unreachable) { this.probedAt = Date.now() - 50000; return; }   // keep the last known state, look again in 10 s
    if (missing.length === 0) {
      this.supported = { ...SUPPORTED, modules: [...SUPPORTED.modules, ...RECORD_MODULES] };
      this.recordsSvc ||= new RecordsService(this.grist, this.docId, { tz: this.cfg.timezone, clinic: () => this.cfg.clinic ? this.cfg.clinic(this.info.id, this.info.name) : { idPrefix: 'GK', name: this.info.name, tagline: '', address: '', phones: [], timings: '', runBy: '', clinicians: [], tax: null } });
    } else {
      this.supported = SUPPORTED; this.recordsSvc = null;
      if (missing.length < RECORD_TABLE_NAMES.length) console.warn(`FLOW HQ: clinic records tables missing in ${this.info.id}: ${missing.join(', ')} (run npm run provision-records)`);
    }
  }

  // ---------------------------------------------------------------- reads (short cache, cleared on every write)
  private async table(name: string, q: { sort?: string; limit?: number } = {}): Promise<GristRecord[]> {
    const hit = this.cache.get(name);
    if (hit && Date.now() - hit.at < (this.cfg.cacheMs ?? 4000)) return hit.rows;
    const rows = await this.grist.records(this.docId, name, q);
    this.cache.set(name, { at: Date.now(), rows });
    return rows;
  }
  private invalidate(...names: string[]) { for (const n of names) this.cache.delete(n); }
  private limit() { return this.cfg.readLimit || 5000; }
  private leads() { return this.table(this.leadsTable); }
  private appointments() { return this.table(TABLES.appointments); }
  private conversationsRows() { return this.table(TABLES.conversations); }
  private messages() { return this.table(TABLES.messages, { sort: '-Created_At', limit: this.limit() }); }
  private runLog() { return this.table(TABLES.runLog, { sort: '-At', limit: this.limit() }); }
  private knowledgeRows() { return this.table(TABLES.knowledge); }
  private async settingsMap(): Promise<{ map: Record<string, string>; rows: GristRecord[] }> {
    const rows = await this.table(TABLES.settings);
    const map: Record<string, string> = {};
    for (const r of rows) if (r.fields.Key) map[String(r.fields.Key).trim()] = r.fields.Value === null || r.fields.Value === undefined ? '' : String(r.fields.Value);
    return { map, rows };
  }
  private async snap() {
    const [leads, appts, convs, msgs, logs, settings] = await Promise.all([this.leads(), this.appointments(), this.conversationsRows(), this.messages(), this.runLog(), this.settingsMap()]);
    return { leads, appts, convs, msgs, logs, settings: settings.map, ix: indexes(leads, convs) };
  }

  async capabilities(viewer: Viewer): Promise<Capabilities> {
    const appts = await this.appointments();
    return {
      channels: this.info.channels,
      staffReply: true,
      replyWindowHours: 24,
      contactFields: ['name', 'phone', 'source', 'status', 'stage', 'lastActivityAt', 'nextActionAt', 'owner', 'aiSummary', 'interest', 'enquiry', 'notes', 'lostReason', 'firstResponseAt', 'campaign', 'pageUrl'],
      contactEditable: ['status', 'owner', 'notes', 'nextActionAt'],
      conversationEditable: ['assignedTo', 'automationPaused', 'resolveAttention'],
      bookingStatusUpdate: ['completed', 'no_show'],
      bookingSourceOfTruth: BOOKING_SYSTEM,
      settingsEdit: viewer.role === 'admin',
      knowledgeEdit: viewer.role === 'admin',
      revenue: viewer.role === 'admin' && appts.some((a) => typeof a.fields.Fee_INR === 'number' && (a.fields.Fee_INR as number) > 0),   // Fee_INR: hidden from the front desk in Grist too
      reports: true,
    };
  }

  // ---------------------------------------------------------------- dashboard
  async dashboard(days: number, ctx: Ctx): Promise<Dashboard> {
    const s = await this.snap();
    const tz = this.info.timezone;
    const to = ctx.now;
    const from = startOfDay(to - (days - 1) * DAY, tz);
    const prevFrom = from - days * DAY;
    const inR = (t: number | null, a: number, b: number) => !!t && t * 1000 >= a && t * 1000 < b;
    const leadsIn = (a: number, b: number) => s.leads.filter((l) => inR(sec(l.fields.Created_At), a, b));
    const inbound = (a: number, b: number) => s.msgs.filter((m) => m.fields.Direction === 'In' && inR(sec(m.fields.Created_At), a, b));
    const apptsIn = (a: number, b: number) => s.appts.filter((x) => inR(sec(x.fields.Start), a, b));
    const logsIn = (wf: string, a: number, b: number) => s.logs.filter((r) => r.fields.Workflow === wf && r.fields.Outcome === 'ok' && inR(sec(r.fields.At), a, b)).length;
    const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
    const caps = await this.capabilities(ctx.viewer);
    const calc = (a: number, b: number) => {
      const nl = leadsIn(a, b);
      const ib = inbound(a, b);
      const processed = ib.filter((m) => PROCESSED.includes(String(m.fields.AI_Status)));
      const ap = apptsIn(a, b);
      const completed = ap.filter((x) => x.fields.Status === 'Completed');
      return {
        new_contacts: nl.length,
        active_conversations: new Set(ib.map((m) => String(m.fields.Conversation))).size,
        bookings: ap.filter((x) => x.fields.Status !== 'Cancelled').length,
        completed: completed.length,
        no_shows: ap.filter((x) => x.fields.Status === 'No-show').length,
        ai_handled: pct(processed.filter((m) => HANDLED.includes(String(m.fields.AI_Status))).length, processed.length),
        human_handoffs: ib.filter((m) => m.fields.AI_Status === 'handed_off').length,
        conversion: pct(nl.filter((l) => l.fields.Status === 'Booked' || l.fields.Status === 'Converted').length, nl.length),
        revenue: caps.revenue ? completed.reduce((t, x) => t + (typeof x.fields.Fee_INR === 'number' ? (x.fields.Fee_INR as number) : 0), 0) : null,
        follow_ups: logsIn('W6-followups', a, b),
        reviews: logsIn('W8-review-request', a, b),
        reminders: logsIn('W5-reminders', a, b),
      };
    };
    const cur = calc(from, to + 1);
    const prev = calc(prevFrom, from);
    const tasks = await this.tasks(ctx);
    const unit = (k: string): MetricValue['unit'] => (k === 'ai_handled' || k === 'conversion' ? 'percent' : k === 'revenue' ? 'currency' : 'count');
    const metrics: MetricValue[] = (Object.keys(cur) as Array<keyof typeof cur>)
      .filter((k) => k !== 'revenue' || caps.revenue)
      .map((k) => ({ key: k, value: cur[k], unit: unit(k), previous: prev[k], hint: null }));
    metrics.push({ key: 'pending_actions', value: tasks.length, unit: 'count', previous: null, hint: null });
    // daily series in the workspace time zone
    const keys: string[] = [];
    for (let t = from; t <= to; t += DAY) keys.push(dayKey(t + 3600000, this.info.timezone));
    const bucket = (rows: GristRecord[], col: string, pred: (r: GristRecord) => boolean = () => true) => {
      const m = new Map(keys.map((k) => [k, 0]));
      for (const r of rows) { const t = sec(r.fields[col]); if (!t || t * 1000 < from || t * 1000 > to + DAY || !pred(r)) continue; const k = dayKey(t * 1000, tz); if (m.has(k)) m.set(k, (m.get(k) || 0) + 1); }
      return keys.map((k) => ({ date: k, value: m.get(k) || 0 }));
    };
    const ins = s.msgs.filter((m) => m.fields.Direction === 'In');
    const series = [
      { key: 'new_contacts', points: bucket(s.leads, 'Created_At') },
      { key: 'messages_in', points: bucket(ins, 'Created_At') },
      { key: 'ai_handled', points: bucket(ins, 'Created_At', (m) => HANDLED.includes(String(m.fields.AI_Status))) },
      { key: 'human_handoffs', points: bucket(ins, 'Created_At', (m) => m.fields.AI_Status === 'handed_off') },
      { key: 'bookings', points: bucket(s.appts, 'Start', (a) => a.fields.Status !== 'Cancelled') },
    ];
    const bookings = (await this.bookings({ view: 'upcoming' }, ctx)).slice(0, 6);
    const recent = (await this.activity({ limit: 12 }, ctx));
    return { range: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), days }, metrics, series, attention: tasks.slice(0, 6), upcoming: bookings, recent };
  }

  // ---------------------------------------------------------------- contacts
  async contacts(q: ContactQuery, _ctx?: Ctx): Promise<Contact[]> {
    const s = await this.snap();
    let out = s.leads.map((l) => toContact(l, s.ix.convByLead.get(String(l.id)) || null));
    const needle = (q.q || '').trim().toLowerCase();
    if (needle) out = out.filter((c) => [c.name, c.phone, c.ref, c.interest, c.source].some((v) => v && v.toLowerCase().includes(needle)));
    if (q.status) out = out.filter((c) => c.status === q.status);
    if (q.stage) out = out.filter((c) => (q.stage === 'not_rated' ? !c.stage : c.stage === q.stage));
    if (q.attention) out = out.filter((c) => c.attentionRequired);
    out.sort((a, b) => (b.lastActivityAt || '').localeCompare(a.lastActivityAt || ''));
    return out.slice(0, q.limit || 500);
  }
  async contact(id: string, ctx: Ctx) {
    const s = await this.snap();
    const l = s.ix.leadsById.get(id);
    if (!l) return null;
    const contact = toContact(l, s.ix.convByLead.get(id) || null);
    const caps = await this.capabilities(ctx.viewer);
    const bookings = s.appts.filter((a) => String(a.fields.Lead) === id).map((a) => toBooking(a, s.ix, ctx.now, caps.revenue)).sort((a, b) => (b.start || '').localeCompare(a.start || ''));
    const activity = activityFrom([l], s.msgs, s.logs, s.ix).filter((a) => a.contactId === id).slice(0, 60);
    return { contact, bookings, activity };
  }
  async updateContact(id: string, patch: ContactPatch, ctx: Ctx): Promise<Contact> {
    const l = (await this.leads()).find((x) => String(x.id) === id);
    if (!l) throw new BackendError(404, 'not_found', 'Not found');
    const fields: Record<string, unknown> = {};
    if (patch.status !== undefined) { if (!LEAD_STATUS_BACK[patch.status]) throw new BackendError(400, 'invalid', 'Unknown status'); fields.Status = LEAD_STATUS_BACK[patch.status]; }
    if (patch.owner !== undefined) fields.Owner = String(patch.owner).slice(0, 80);
    if (patch.notes !== undefined) fields.Notes = String(patch.notes).slice(0, 2000);
    if (patch.nextActionAt !== undefined) {
      if (patch.nextActionAt === null || patch.nextActionAt === '') fields.Next_Action_At = null;
      else { const t = Date.parse(patch.nextActionAt); if (!Number.isFinite(t)) throw new BackendError(400, 'invalid', 'Invalid date'); fields.Next_Action_At = Math.floor(t / 1000); }
    }
    if (!Object.keys(fields).length) throw new BackendError(400, 'invalid', 'Nothing to change');
    await this.grist.update(this.docId, this.leadsTable, [{ id: Number(id), fields: fields as GristRecord['fields'] }]);
    this.invalidate(this.leadsTable);
    return (await this.contact(id, ctx))!.contact;
  }

  // ---------------------------------------------------------------- conversations
  async conversations(q: ConversationQuery, ctx: Ctx): Promise<Conversation[]> {
    const s = await this.snap();
    const last = new Map<string, GristRecord>();
    for (const m of s.msgs) { const k = String(m.fields.Conversation ?? ''); if (!last.has(k)) last.set(k, m); }   // msgs are newest first
    const nowSec = Math.floor(ctx.now / 1000);
    let out = s.convs.map((c) => toConversation(c, s.ix.leadsById.get(String(c.fields.Lead ?? '')) || null, last.get(String(c.id)) || null, (s.settings.ai_mode || 'off').toLowerCase(), nowSec));
    const f = q.filter || 'all';
    if (f === 'unread') out = out.filter((c) => c.unread > 0);
    if (f === 'attention') out = out.filter((c) => c.attentionRequired);
    if (f === 'ai') out = out.filter((c) => c.aiActive && !c.attentionRequired);
    if (f === 'paused') out = out.filter((c) => c.automationPaused);
    if (f === 'mine') out = out.filter((c) => c.assignedTo && c.assignedTo.toLowerCase() === ctx.viewer.name.toLowerCase());
    const needle = (q.q || '').trim().toLowerCase();
    if (needle) out = out.filter((c) => [c.contactName, c.contactPhone, c.lastMessagePreview].some((v) => v && v.toLowerCase().includes(needle)));
    out.sort((a, b) => (b.lastMessageAt || '').localeCompare(a.lastMessageAt || ''));
    return out;
  }
  async conversation(id: string, ctx: Ctx) {
    const s = await this.snap();
    const c = s.ix.convById.get(id);
    if (!c) return null;
    const lead = s.ix.leadsById.get(String(c.fields.Lead ?? '')) || null;
    const rows = await this.grist.records(this.docId, TABLES.messages, { filter: { Conversation: [Number(id)] }, sort: 'Created_At' });
    const conversation = toConversation(c, lead, rows[rows.length - 1] || null, (s.settings.ai_mode || 'off').toLowerCase(), Math.floor(ctx.now / 1000));
    const messages = rows.map((m) => toMessage(m, conversation.contactName));
    return { conversation, messages, contact: lead ? toContact(lead, c) : null };
  }
  async reply(conversationId: string, body: string, ctx: Ctx): Promise<Message> {
    const text = String(body || '').replace(/\r\n/g, '\n').trim();
    if (!text) throw new BackendError(400, 'empty', 'Write a message first');
    if (text.length > 4096) throw new BackendError(400, 'too_long', 'Messages are limited to 4096 characters');
    const found = await this.conversation(conversationId, ctx);
    if (!found) throw new BackendError(404, 'not_found', 'Conversation not found');
    if (found.conversation.optedOut) throw new BackendError(409, 'opted_out', 'This contact opted out of messages');
    if (!found.conversation.replyWindow.open) throw new BackendError(409, 'window_closed', 'The 24-hour reply window is closed: only approved templates can be sent now');
    const now = Math.floor(ctx.now / 1000);
    const [id] = await this.grist.add(this.docId, TABLES.messages, [{ Conversation: Number(conversationId), Direction: 'Out', Body: text, Sent_By: ctx.viewer.name.slice(0, 80) || 'Staff', Send: true, Created_At: now }]);
    this.invalidate(TABLES.messages);
    return toMessage({ id, fields: { Conversation: Number(conversationId), Direction: 'Out', Body: text, Sent_By: ctx.viewer.name, Send: true, Created_At: now } }, found.conversation.contactName);
  }
  async updateConversation(id: string, patch: ConversationPatch, ctx: Ctx): Promise<Conversation> {
    const fields: Record<string, unknown> = {};
    if (patch.assignedTo !== undefined) fields.Assigned_To = String(patch.assignedTo).slice(0, 80);
    if (patch.automationPaused !== undefined) fields.Automation_Paused = patch.automationPaused === true;
    if (patch.resolveAttention) fields.Needs_Human = false;
    if (patch.markRead) fields.Unread = 0;
    if (!Object.keys(fields).length) throw new BackendError(400, 'invalid', 'Nothing to change');
    if (!(await this.conversationsRows()).some((c) => String(c.id) === id)) throw new BackendError(404, 'not_found', 'Conversation not found');
    await this.grist.update(this.docId, TABLES.conversations, [{ id: Number(id), fields: fields as GristRecord['fields'] }]);
    this.invalidate(TABLES.conversations);
    return (await this.conversation(id, ctx))!.conversation;
  }

  // ---------------------------------------------------------------- bookings
  async bookings(q: BookingQuery, ctx: Ctx): Promise<Booking[]> {
    const s = await this.snap();
    const caps = await this.capabilities(ctx.viewer);
    let out = s.appts.map((a) => toBooking(a, s.ix, ctx.now, caps.revenue));
    const today = startOfDay(ctx.now, this.info.timezone);
    const t = (b: Booking) => (b.start ? Date.parse(b.start) : 0);
    const v = q.view || 'upcoming';
    if (v === 'upcoming') out = out.filter((b) => t(b) >= today && b.status !== 'cancelled').sort((a, b) => t(a) - t(b));
    else if (v === 'past') out = out.filter((b) => t(b) < ctx.now).sort((a, b) => t(b) - t(a));
    else if (v === 'needs_outcome') out = out.filter((b) => b.needsOutcome).sort((a, b) => t(b) - t(a));
    else out.sort((a, b) => t(b) - t(a));
    const needle = (q.q || '').trim().toLowerCase();
    if (needle) out = out.filter((b) => [b.contactName, b.service, b.owner, b.ref].some((x) => x && x.toLowerCase().includes(needle)));
    return out;
  }
  async updateBooking(id: string, status: BookingStatus, ctx: Ctx): Promise<Booking> {
    if (status !== 'completed' && status !== 'no_show') throw new BackendError(400, 'invalid', 'Only Completed or No-show can be set here: other changes come from the booking system');
    const a = (await this.appointments()).find((x) => String(x.id) === id);
    if (!a) throw new BackendError(404, 'not_found', 'Not found');
    if (!['Booked', 'Rescheduled'].includes(String(a.fields.Status))) throw new BackendError(409, 'not_scheduled', 'Only a scheduled booking can be marked');
    const start = sec(a.fields.Start);
    if (!start || start * 1000 > ctx.now) throw new BackendError(409, 'in_future', 'It has not started yet');
    await this.grist.update(this.docId, TABLES.appointments, [{ id: Number(id), fields: { Status: status === 'completed' ? 'Completed' : 'No-show' } }]);
    this.invalidate(TABLES.appointments);
    const s = await this.snap();
    const caps = await this.capabilities(ctx.viewer);
    return toBooking(s.appts.find((x) => String(x.id) === id)!, s.ix, ctx.now, caps.revenue);
  }

  // ---------------------------------------------------------------- automations
  async automations(ctx: Ctx): Promise<Automation[]> {
    const s = await this.snap();
    const tz = this.info.timezone;
    const today = startOfDay(ctx.now, tz);
    const weekAgo = ctx.now - 7 * DAY;
    const knowledge = await this.knowledgeRows().catch(() => []);
    return SUPPORTED.automations.map((key) => {
      const impl = AUTOMATIONS[key];
      const rows = s.logs.filter((r) => impl.runLog.includes(String(r.fields.Workflow)));
      const at = (r: GristRecord) => (sec(r.fields.At) || 0) * 1000;
      const ok7 = rows.filter((r) => r.fields.Outcome === 'ok' && at(r) >= weekAgo).length;
      const failed7 = rows.filter((r) => r.fields.Outcome === 'failed' && at(r) >= weekAgo).length;
      const skipped7 = rows.filter((r) => r.fields.Outcome === 'skipped' && at(r) >= weekAgo).length;
      const lastRow = rows.reduce<GristRecord | null>((m, r) => (!m || at(r) > at(m) ? r : m), null);
      const lastFailed = rows.filter((r) => r.fields.Outcome === 'failed').reduce<GristRecord | null>((m, r) => (!m || at(r) > at(m) ? r : m), null);
      const requirements: Automation['requirements'] = [];
      let control: Automation['control'] = null;
      let status: Automation['status'] = 'always_on';
      const v = (k: string) => s.settings[k];
      if (impl.switchKind === 'ai_mode') {
        const mode = (v('ai_mode') || 'off').toLowerCase();
        control = { kind: 'choice', value: ['off', 'draft', 'auto'].includes(mode) ? mode : 'off', options: [{ value: 'off', label: 'Off' }, { value: 'draft', label: 'Draft' }, { value: 'auto', label: 'Auto' }], label: null };
        status = control.value === 'off' ? 'off' : 'active';
        requirements.push({ label: 'Knowledge base has active entries', ok: knowledge.some((k) => k.fields.Active !== false && String(k.fields.Content || '').trim()) });
      } else if (impl.switchKey && key !== 'weekly_reports') {
        const on = isOn(v(impl.switchKey));
        control = { kind: 'toggle', value: on ? 'on' : 'off', options: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], label: null };
        status = on ? 'active' : 'off';
        if (key === 'review_requests') requirements.push({ label: 'Review link set (https)', ok: !!clinicModules.cmHttps(v('review_link')) });
        if (key === 'outcome_checkins' && s.appts.length) requirements.push({ label: 'Check-in tracking column present', ok: s.appts.some((a) => Object.prototype.hasOwnProperty.call(a.fields, 'Outcome_Sent')) });
        if (on && requirements.some((r) => !r.ok)) status = 'needs_setup';
      } else if (key === 'weekly_reports') {
        control = { kind: 'toggle', value: isOn(v('weekly_report_whatsapp')) ? 'on' : 'off', options: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], label: 'Owner copy on WhatsApp' };
      }
      if (key === 'booking_reminders' || key === 'follow_ups' || key === 'outcome_checkins' || key === 'review_requests') requirements.push({ label: 'Test mode off (messages reach real recipients)', ok: !isTestMode(v('TEST_MODE')) });
      if (status !== 'off' && lastFailed && lastRow && lastFailed === lastRow) status = 'attention';
      const trig = impl.trigger;
      return {
        key,
        module: CATALOGUE[key].module,
        trigger: trig.kind === 'schedule' ? { kind: 'schedule', label: scheduleLabel(trig.schedule) } : { kind: 'event', label: trig.label },
        status,
        control,
        requirements,
        lastRunAt: lastRow ? iso(sec(lastRow.fields.At)) : null,
        nextRunAt: trig.kind === 'schedule' && status !== 'off' ? new Date(nextRun(trig.schedule, ctx.now, tz)).toISOString() : null,
        stats: { today: rows.filter((r) => r.fields.Outcome === 'ok' && at(r) >= today).length, ok7d: ok7, failed7d: failed7, skipped7d: skipped7, successRate: ok7 + failed7 ? Math.round((ok7 / (ok7 + failed7)) * 1000) / 10 : null },
        lastError: lastFailed ? String(lastFailed.fields.Error || lastFailed.fields.Record || '').slice(0, 300) || null : null,
        backendRef: impl.ref,
        measures: impl.measures,
      } as Automation;
    });
  }
  async setAutomation(key: AutomationKey, value: string, ctx: Ctx): Promise<Automation> {
    if (ctx.viewer.role !== 'admin') throw new BackendError(403, 'forbidden', 'Only an admin can change automations');
    const impl = AUTOMATIONS[key];
    if (!impl || !impl.switchKey) throw new BackendError(400, 'no_switch', 'This automation has no per-workspace switch: it runs on the workflow schedule');
    let v: string;
    if (impl.switchKind === 'ai_mode') { if (!['off', 'draft', 'auto'].includes(value)) throw new BackendError(400, 'invalid', 'Choose off, draft or auto'); v = value; }
    else { if (!['on', 'off'].includes(value)) throw new BackendError(400, 'invalid', 'Choose on or off'); v = value; }
    await this.upsertSettings({ [impl.switchKey]: v });
    return (await this.automations(ctx)).find((a) => a.key === key)!;
  }

  // ---------------------------------------------------------------- tasks (derived)
  async tasks(ctx: Ctx): Promise<Task[]> {
    const s = await this.snap();
    const out: Task[] = [];
    const now = ctx.now;
    const name = (l?: GristRecord | null) => (l ? String(l.fields.Name || l.fields.Phone || `#${l.id}`) : null);
    for (const c of s.convs) {
      if (c.fields.Needs_Human !== true) continue;
      const l = s.ix.leadsById.get(String(c.fields.Lead ?? '')) || null;
      out.push({ id: `reply-${c.id}`, kind: 'reply_needed', priority: priorityOf(c.fields.Handoff_Reason) || 'normal', dueAt: iso(c.fields.Last_Inbound_At), contactId: l ? String(l.id) : null, contactName: name(l) || String(c.fields.Phone || ''), conversationId: String(c.id), bookingId: null, detail: c.fields.Handoff_Reason ? String(c.fields.Handoff_Reason) : null });
    }
    const seen = new Set<string>();
    for (const m of s.msgs) {
      if (m.fields.Direction !== 'Out' || m.fields.Send === true || !['failed', 'needs_template'].includes(String(m.fields.Status))) continue;
      const by = String(m.fields.Sent_By || '');
      if (/^W\d+(?!\w)/.test(by)) continue;
      const t = sec(m.fields.Created_At);
      if (!t || now - t * 1000 > 7 * DAY) continue;
      const conv = s.ix.convById.get(String(m.fields.Conversation ?? ''));
      const key = String(m.fields.Conversation);
      if (seen.has(key)) continue;
      seen.add(key);
      const l = conv ? s.ix.leadsById.get(String(conv.fields.Lead ?? '')) || null : null;
      out.push({ id: `failed-${m.id}`, kind: 'reply_failed', priority: 'high', dueAt: iso(t), contactId: l ? String(l.id) : null, contactName: name(l), conversationId: conv ? String(conv.id) : null, bookingId: null, detail: m.fields.AI_Reason ? universal(String(m.fields.AI_Reason)) : String(m.fields.Status) });
    }
    for (const a of s.appts) {
      const b = toBooking(a, s.ix, now, false);
      if (!b.needsOutcome || !b.start || now - Date.parse(b.start) > 60 * DAY) continue;
      out.push({ id: `outcome-${a.id}`, kind: 'booking_outcome', priority: 'normal', dueAt: b.start, contactId: b.contactId, contactName: b.contactName, conversationId: null, bookingId: b.id, detail: b.service });
    }
    const endOfToday = startOfDay(now, this.info.timezone) + DAY;
    for (const l of s.leads) {
      const f = l.fields;
      if (f.Opted_Out === true || f.Status === 'Lost' || f.Status === 'Converted') continue;
      const next = sec(f.Next_Action_At);
      const conv = s.ix.convByLead.get(String(l.id));
      if (next && next * 1000 < endOfToday) out.push({ id: `next-${l.id}`, kind: 'next_action_due', priority: next * 1000 < now ? 'high' : 'normal', dueAt: iso(next), contactId: String(l.id), contactName: name(l), conversationId: conv ? String(conv.id) : null, bookingId: null, detail: f.AI_Summary ? String(f.AI_Summary) : null });
      const created = sec(f.Created_At);
      if (f.Status === 'New' && created && now - created * 1000 > 30 * 60000 && now - created * 1000 < 7 * DAY && !(conv && conv.fields.Needs_Human === true)) {
        out.push({ id: `first-${l.id}`, kind: 'first_response', priority: f.Lead_Stage === 'hot' ? 'high' : 'normal', dueAt: iso(created), contactId: String(l.id), contactName: name(l), conversationId: conv ? String(conv.id) : null, bookingId: null, detail: f.Enquiry ? String(f.Enquiry) : null });
      }
    }
    return out.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || (a.dueAt || '').localeCompare(b.dueAt || ''));
  }

  // ---------------------------------------------------------------- activity, reports, analytics
  async activity(q: ActivityQuery, _ctx?: Ctx): Promise<import('../../../core/domain').Activity[]> {
    const s = await this.snap();
    let out = activityFrom(s.leads, s.msgs, s.logs, s.ix);
    if (q.kind) out = out.filter((a) => a.kind === q.kind);
    if (q.contactId) out = out.filter((a) => a.contactId === q.contactId);
    return out.slice(0, Math.min(q.limit || 100, 500));
  }
  async reports(): Promise<Report[]> {
    const logs = await this.runLog();
    return logs
      .filter((r) => r.fields.Workflow === 'W9-weekly-report' && /^WEEKLY REPORT/.test(String(r.fields.Record || '')))
      .sort((a, b) => (sec(b.fields.At) || 0) - (sec(a.fields.At) || 0))
      .map((r) => {
        const p = parseReport(r);
        return { id: String(r.id), generatedAt: iso(r.fields.At), periodLabel: p.periodLabel, title: p.title, sections: p.sections, note: r.fields.Error ? String(r.fields.Error) : null, text: String(r.fields.Record) };
      });
  }
  async analytics(week: 'last' | 'this', ctx: Ctx): Promise<Analytics> {
    const s = await this.snap();
    const last = clinicModules.cmWeekWindow(ctx.now);
    const win = week === 'this' ? { start: last.end, end: last.end + 7 * 86400, label: 'this week so far' } : last;
    const cap = this.limit();
    const m = clinicModules.cmWeeklyMetrics({ leads: s.leads, appointments: s.appts, conversations: s.convs, messages: s.msgs, runlog: s.logs }, ctx.now, win, { messages: cap, runlog: cap });
    const metric = (key: string, category: AnalyticsMetric['category'], label: string, value: number | null, unit: AnalyticsMetric['unit'] = 'count'): AnalyticsMetric => ({ key, category, label, value, unit });
    const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
    const metrics: AnalyticsMetric[] = [
      metric('new', 'acquisition', 'New {contact.plural|lower}', m.leads.new),
      metric('opted_out_total', 'acquisition', 'Opted out (all time)', m.leads.opted_out_total),
      metric('messages_in', 'engagement', 'Incoming messages', m.ai.patient_messages),
      metric('median_first_response', 'engagement', 'Median first response', m.leads.median_first_response_minutes, 'minutes'),
      metric('staff_replies', 'engagement', 'Replies by the team', m.people.staff_replies_sent),
      metric('bookings_week', 'bookings', '{booking.plural} in the week', m.appointments.this_week),
      metric('completed', 'bookings', 'Completed', m.appointments.completed),
      metric('no_show', 'bookings', 'No-shows', m.appointments.no_show),
      metric('cancelled', 'bookings', 'Cancelled', m.appointments.cancelled),
      metric('rescheduled', 'bookings', 'Rescheduled', m.appointments.rescheduled),
      metric('still_booked', 'bookings', 'Past, outcome not marked', m.appointments.still_marked_booked),
      metric('conversion_rate', 'conversion', 'New → booked', pct(m.leads.booked, m.leads.new), 'percent'),
      metric('contacted', 'conversion', 'Contacted', m.leads.contacted),
      metric('booked', 'conversion', 'Booked or converted', m.leads.booked),
      metric('still_new', 'conversion', 'Never contacted', m.leads.still_new),
      metric('alerts', 'automation', 'Team alerts', m.sent.speed_to_lead_alerts),
      metric('reminders', 'automation', 'Reminders', m.sent.reminders),
      metric('followups', 'automation', 'Follow-ups', m.sent.day2_followups),
      metric('failures', 'automation', 'Failed steps', m.failures.total),
      metric('ai_replied', 'ai', 'Replied', m.ai.replied),
      metric('ai_drafted', 'ai', 'Drafted for review', m.ai.drafted),
      metric('ai_no_reply', 'ai', 'No reply needed', m.ai.no_reply),
      metric('ai_deferred', 'ai', 'Answered next morning', m.ai.deferred),
      metric('ai_failed', 'ai', 'Failed', m.ai.failed),
      metric('handed_off', 'handoffs', 'Handed to a person', m.ai.handed_off),
      metric('waiting', 'handoffs', 'Waiting for a person now', m.people.waiting_for_a_person),
      metric('paused', 'handoffs', 'Paused conversations', m.people.paused_conversations),
      metric('rebooks', 'retention', 'New times offered after a no-show', m.sent.noshow_rebooks),
      metric('checkins', 'retention', 'Check-ins sent', m.sent.outcome_checkins),
      metric('booked_ahead', 'retention', 'Booked for the next 7 days', m.appointments.booked_next_7_days),
      metric('better', 'feedback', '{outcome.better}', m.ai.outcome_better),
      metric('same', 'feedback', '{outcome.same}', m.ai.outcome_same),
      metric('worse', 'feedback', '{outcome.worse}', m.ai.outcome_worse),
      metric('reviews', 'feedback', 'Review requests', m.sent.review_requests),
    ];
    return {
      period: { start: new Date(win.start * 1000).toISOString(), end: new Date(win.end * 1000).toISOString(), label: win.label },
      engine: 'weekly_reports',
      metrics,
      breakdowns: [
        { key: 'by_source', category: 'acquisition', label: 'By source', items: Object.entries(m.leads.by_source).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value) },
        { key: 'stage', category: 'acquisition', label: 'Stage of new {contact.plural|lower}', items: [{ label: '{contactStage.hot}', value: m.leads.stage.hot }, { label: '{contactStage.warm}', value: m.leads.stage.warm }, { label: '{contactStage.cold}', value: m.leads.stage.cold }, { label: 'Not rated', value: m.leads.stage.not_rated }] },
        { key: 'failures', category: 'automation', label: 'Failures by automation', items: Object.entries(m.failures.by_workflow).map(([wf, value]) => ({ label: AUTOMATION_BY_RUNLOG[wf] ? `automation:${AUTOMATION_BY_RUNLOG[wf]}` : wf, value })).sort((a, b) => b.value - a.value) },
      ],
      incomplete: m.incomplete.messages || m.incomplete.run_log,
    };
  }

  // ---------------------------------------------------------------- AI
  async ai(ctx: Ctx): Promise<AiOverview> {
    const s = await this.snap();
    const from = ctx.now - 7 * DAY;
    const ins = s.msgs.filter((m) => m.fields.Direction === 'In' && (sec(m.fields.Created_At) || 0) * 1000 >= from);
    const count = (st: string) => ins.filter((m) => m.fields.AI_Status === st).length;
    const conf = ins.map((m) => m.fields.AI_Confidence).filter((v): v is number => typeof v === 'number');
    const intents = new Map<string, number>();
    for (const m of ins) if (m.fields.Intent) intents.set(String(m.fields.Intent), (intents.get(String(m.fields.Intent)) || 0) + 1);
    const stages = new Map<string, number>([['hot', 0], ['warm', 0], ['cold', 0], ['not_rated', 0]]);
    for (const l of s.leads) { const st = ['hot', 'warm', 'cold'].includes(String(l.fields.Lead_Stage)) ? String(l.fields.Lead_Stage) : 'not_rated'; stages.set(st, (stages.get(st) || 0) + 1); }
    const conversationName = (convId: unknown) => { const c = s.ix.convById.get(String(convId ?? '')); const l = c ? s.ix.leadsById.get(String(c.fields.Lead ?? '')) : null; return l ? String(l.fields.Name || l.fields.Phone || '') : c ? String(c.fields.Phone || '') : ''; };
    const mode = (s.settings.ai_mode || 'off').toLowerCase();
    return {
      mode: { value: ['off', 'draft', 'auto'].includes(mode) ? mode : 'off', options: [{ value: 'off', label: 'Off' }, { value: 'draft', label: 'Draft' }, { value: 'auto', label: 'Auto' }], editable: ctx.viewer.role === 'admin' },
      range: { from: new Date(from).toISOString(), to: new Date(ctx.now).toISOString() },
      processed: ins.filter((m) => PROCESSED.includes(String(m.fields.AI_Status))).length,
      handled: ins.filter((m) => HANDLED.includes(String(m.fields.AI_Status))).length,
      handoffs: count('handed_off'),
      failed: count('failed'),
      deferred: count('deferred'),
      avgConfidence: conf.length ? Math.round((conf.reduce((a, b) => a + b, 0) / conf.length) * 100) / 100 : null,
      intents: [...intents.entries()].map(([intent, n]) => ({ intent, count: n })).sort((a, b) => b.count - a.count),
      stages: [...stages.entries()].map(([stage, n]) => ({ stage: stage as ContactStage | 'not_rated', count: n })),
      recentHandoffs: s.convs.filter((c) => c.fields.Needs_Human === true).map((c) => ({ conversationId: String(c.id), contactName: conversationName(c.id), reason: c.fields.Handoff_Reason ? String(c.fields.Handoff_Reason) : null, priority: priorityOf(c.fields.Handoff_Reason) || 'normal', at: iso(c.fields.Last_Inbound_At) })).sort((a, b) => (b.at || '').localeCompare(a.at || '')).slice(0, 8),
      recentDecisions: ins.filter((m) => m.fields.AI_Status).slice(0, 20).map((m) => toMessage(m, conversationName(m.fields.Conversation))),
      knowledgeCount: (await this.knowledgeRows().catch(() => [])).filter((k) => k.fields.Active !== false).length,
      knowledgeCategories: KNOWLEDGE_CATEGORIES,
    };
  }
  async knowledge(): Promise<KnowledgeItem[]> {
    return (await this.knowledgeRows()).map((k) => ({ id: String(k.id), title: String(k.fields.Title || ''), category: k.fields.Category ? String(k.fields.Category) : null, content: String(k.fields.Content || ''), active: k.fields.Active !== false }));
  }
  async saveKnowledge(item: Partial<KnowledgeItem> & { id?: string }, ctx: Ctx): Promise<KnowledgeItem> {
    if (ctx.viewer.role !== 'admin') throw new BackendError(403, 'forbidden', 'Only an admin can edit the knowledge base');
    const fields: Record<string, unknown> = {};
    if (item.title !== undefined) fields.Title = String(item.title).trim().slice(0, 200);
    if (item.content !== undefined) fields.Content = String(item.content).trim().slice(0, 4000);
    if (item.category !== undefined) { if (item.category && !KNOWLEDGE_CATEGORIES.includes(item.category)) throw new BackendError(400, 'invalid', 'Unknown category'); fields.Category = item.category || ''; }
    if (item.active !== undefined) fields.Active = item.active === true;
    let id = item.id;
    if (id) {
      if (!(await this.knowledgeRows()).some((k) => String(k.id) === id)) throw new BackendError(404, 'not_found', 'Not found');
      await this.grist.update(this.docId, TABLES.knowledge, [{ id: Number(id), fields: fields as GristRecord['fields'] }]);
    } else {
      if (!fields.Title || !fields.Content) throw new BackendError(400, 'invalid', 'Title and content are required');
      if (fields.Active === undefined) fields.Active = true;
      id = String((await this.grist.add(this.docId, TABLES.knowledge, [fields as GristRecord['fields']]))[0]);
    }
    this.invalidate(TABLES.knowledge);
    return (await this.knowledge()).find((k) => k.id === id)!;
  }

  // ---------------------------------------------------------------- settings
  async settings(ctx: Ctx): Promise<SettingsView> {
    const s = await this.snap();
    const admin = ctx.viewer.role === 'admin';
    const mask = (v: string) => (v ? v.replace(/\d(?=\d{4})/g, '•') : v);
    const fields: SettingField[] = SETTINGS.map((d) => {
      const raw = s.settings[d.key];
      // switches reach the screen as plain on / off, applying the workflows' own rule for a missing value
      const value = d.type === 'boolean' ? ((d.key === 'TEST_MODE' ? isTestMode(raw) : isOn(raw)) ? 'on' : 'off') : raw === undefined ? null : d.sensitive && !admin ? mask(raw) : raw;
      return { key: d.key, section: d.section, label: d.label, help: d.help || null, type: d.type, options: d.options, value, editable: admin, sensitive: !!d.sensitive };
    });
    const names = new Set<string>();
    for (const c of s.convs) if (c.fields.Assigned_To) names.add(String(c.fields.Assigned_To));
    for (const l of s.leads) if (l.fields.Owner) names.add(String(l.fields.Owner));
    for (const m of s.msgs) if (m.fields.Direction === 'Out' && m.fields.Sent_By && !/^W\d+(?!\w)/.test(String(m.fields.Sent_By))) names.add(String(m.fields.Sent_By));
    for (const a of s.appts) if (a.fields.Physio) names.add(String(a.fields.Physio));
    const lastLog = s.logs.reduce((m, r) => Math.max(m, sec(r.fields.At) || 0), 0);
    const sentWa = s.msgs.some((m) => m.fields.Direction === 'Out' && m.fields.WA_Message_ID);
    const calSynced = s.logs.some((r) => r.fields.Workflow === 'W4-booking-sync' && r.fields.Outcome === 'ok') || s.appts.some((a) => a.fields.Booking_UID && !String(a.fields.Booking_UID).startsWith('wa-'));
    const ago = (t: number) => { const mins = Math.round((ctx.now - t * 1000) / 60000); return mins < 60 ? `${mins} min ago` : mins < 2880 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`; };
    return {
      fields,
      team: { users: [], namesInData: [...names].sort() },
      channels: [
        { key: 'whatsapp', label: 'WhatsApp', status: this.reg.waConnected ? 'connected' : 'not_connected', detail: this.reg.waConnected ? `Business number linked. Messages go out only through the messaging gateway${isTestMode(s.settings.TEST_MODE) ? '; test mode is ON' : ''}.` : 'No WhatsApp number is linked to this workspace yet.' },
        { key: 'website', label: 'Website form', status: s.leads.some((l) => l.fields.Source === 'Website') ? 'connected' : 'unknown', detail: s.leads.some((l) => l.fields.Source === 'Website') ? 'Enquiries arrive from the website form.' : 'No website enquiries yet.' },
      ],
      integrations: [
        { key: 'crm', label: 'Grist CRM', status: 'connected', detail: 'Read and written by FLOW HQ through the server; the key never reaches the browser.' },
        { key: 'automation', label: 'n8n automations', status: lastLog ? 'connected' : 'unknown', detail: lastLog ? `Last automation activity ${ago(lastLog)}.` : 'No automation activity logged yet.' },
        { key: 'booking', label: BOOKING_SYSTEM, status: calSynced ? 'connected' : 'unknown', detail: `Source of truth for ${'{booking.plural|lower}'}: FLOW HQ shows them, the booking system changes them.` },
        { key: 'messaging', label: 'WhatsApp Cloud API', status: sentWa ? 'connected' : this.reg.waConnected ? 'unknown' : 'error', detail: sentWa ? 'Messages are being accepted.' : 'No accepted message seen yet.' },
      ],
    };
  }
  async updateSettings(values: Record<string, string>, ctx: Ctx): Promise<SettingsView> {
    if (ctx.viewer.role !== 'admin') throw new BackendError(403, 'forbidden', 'Only an admin can change settings');
    const clean: Record<string, string> = {};
    for (const [k, raw] of Object.entries(values)) {
      const d = SETTINGS.find((x) => x.key === k);
      if (!d) throw new BackendError(400, 'invalid', `${k} cannot be changed here`);
      const v = String(raw ?? '').trim();
      if (d.type === 'boolean') { if (!['true', 'false', 'on', 'off'].includes(v)) throw new BackendError(400, 'invalid', `${d.label}: on or off`); clean[k] = k === 'TEST_MODE' ? (v === 'on' || v === 'true' ? 'true' : 'false') : (v === 'on' || v === 'true' ? 'on' : 'off'); continue; }
      if (d.type === 'phone') { if (!v) { clean[k] = ''; continue; } const p = normalizePhone(v); if (!p.phone) throw new BackendError(400, 'invalid', `${d.label}: not a valid mobile number`); clean[k] = p.phone; continue; }
      if (d.type === 'url') { if (v && !/^https:\/\/[^\s<>"']+$/i.test(v)) throw new BackendError(400, 'invalid', `${d.label}: must start with https://`); clean[k] = v; continue; }
      if (d.type === 'time') { if (v && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) throw new BackendError(400, 'invalid', `${d.label}: use 24-hour HH:MM`); clean[k] = v; continue; }
      if (d.type === 'windows') { if (v && parseOpenHours(v) === null) throw new BackendError(400, 'invalid', `${d.label}: use windows like 09:00-13:00, 16:00-20:00 (each one ends after it starts, none overlap, at most 4)`); clean[k] = v; continue; }
      if (d.type === 'number') { if (v && !/^\d{1,4}$/.test(v)) throw new BackendError(400, 'invalid', `${d.label}: a whole number`); clean[k] = v; continue; }
      if (d.type === 'choice') { if (!d.options!.some((o) => o.value === v)) throw new BackendError(400, 'invalid', `${d.label}: choose one of the options`); clean[k] = v; continue; }
      if (k === 'staff_alert_phones' && v) {
        const list = v.split(/[,;]+/).map((x) => normalizePhone(x.trim()).phone);
        if (list.some((x) => !x)) throw new BackendError(400, 'invalid', `${d.label}: one or more numbers are not valid mobiles`);
        clean[k] = list.join(','); continue;
      }
      clean[k] = v.slice(0, d.type === 'textarea' ? 2000 : 300);
    }
    await this.upsertSettings(clean);
    return this.settings(ctx);
  }
  private async upsertSettings(values: Record<string, string>) {
    const { rows } = await this.settingsMap();
    const updates: GristRecord[] = [];
    const adds: Array<Record<string, string>> = [];
    for (const [k, v] of Object.entries(values)) {
      const row = rows.find((r) => String(r.fields.Key).trim() === k);
      if (row) updates.push({ id: row.id, fields: { Value: v } });
      else adds.push({ Key: k, Value: v });
    }
    if (updates.length) await this.grist.update(this.docId, TABLES.settings, updates);
    if (adds.length) await this.grist.add(this.docId, TABLES.settings, adds);
    this.invalidate(TABLES.settings);
  }
}
export { COLUMNS, REPLY_WINDOW_SEC };
