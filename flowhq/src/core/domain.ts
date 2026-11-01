// FLOW HQ universal domain model. Every screen works on these types only; no screen knows which business it serves or which
// backend tables the data came from. A backend adapter (src/server/adapters/*) translates its own storage into these shapes,
// and the industry profile (src/core/industries) decides what the user calls them.

export type ISODate = string;   // ISO 8601, UTC

// ---------------------------------------------------------------- workspace
export type IndustryKey =
  | 'clinic' | 'physiotherapy' | 'salon' | 'spa' | 'gym' | 'consultant' | 'agency' | 'real_estate' | 'coaching'
  | 'education' | 'local_services' | 'home_services' | 'professional_services' | 'custom';

export type ModuleKey =
  // core: always on
  | 'dashboard' | 'inbox' | 'contacts' | 'activity' | 'settings' | 'automations'
  // optional: shown only if the industry profile enables them AND the backend supports them
  | 'bookings' | 'ai' | 'lead_qualification' | 'reviews' | 'follow_ups' | 'reminders' | 'reports' | 'tasks'
  | 'payments' | 'campaigns' | 'forms' | 'staff' | 'analytics'
  // clinical records (patient register, prescriptions, invoices, attendance): shown only when the clinic doc has the Clinic Records tables
  | 'patients' | 'prescriptions' | 'invoices' | 'visits'
  // the clinic's own people (not patients): needs the optional Staff_Attendance table
  | 'staff_attendance'
  // appointment booking control (calendar, appointments, doctors, the AI booking switch): shown only when the booking tables exist
  | 'schedule';

export type AutomationKey =
  | 'contact_capture' | 'inbound_messaging' | 'speed_to_lead' | 'booking_sync' | 'booking_reminders' | 'follow_ups'
  | 'outcome_checkins' | 'review_requests' | 'ai_assistant' | 'weekly_reports' | 'staff_reply' | 'error_alerts';

export type MetricKey =
  | 'new_contacts' | 'active_conversations' | 'bookings' | 'completed' | 'pending_actions' | 'ai_handled'
  | 'human_handoffs' | 'conversion' | 'revenue' | 'follow_ups' | 'reviews' | 'reminders' | 'no_shows';

export type ChannelKey = 'whatsapp' | 'website' | 'email' | 'instagram' | 'messenger' | 'sms';

export interface Workspace {
  id: string;                         // stable slug
  name: string;
  logoUrl: string | null;
  initials: string;
  industry: IndustryKey;
  terminology: import('./terminology').Terminology;   // resolved: industry profile + workspace overrides
  modules: ModuleKey[];               // enabled AND supported by the backend
  automations: AutomationKey[];       // available in this backend, for enabled modules
  dashboardMetrics: MetricKey[];
  timezone: string;
  locale: string;
  currency: string | null;
  backend: { adapter: string; label: string; capabilities: Capabilities; modules: ModuleKey[] };   // modules: what the backend can power
  demo: boolean;
}

// What the connected backend can really do. The UI hides anything that is not here (no invented features).
export interface Capabilities {
  channels: ChannelKey[];                       // conversation channels with real data
  staffReply: boolean;                          // a person can reply from the inbox
  replyWindowHours: number | null;              // channel rule: free text only within N hours of the contact's last message
  contactFields: ContactField[];                // fields the backend stores (others are never shown as empty boxes)
  contactEditable: Array<'status' | 'owner' | 'notes' | 'nextActionAt'>;
  conversationEditable: Array<'assignedTo' | 'automationPaused' | 'resolveAttention'>;
  bookingStatusUpdate: BookingStatus[];         // statuses staff may set (others come from the booking system)
  bookingSourceOfTruth: string | null;          // e.g. the external calendar's name: shown, never edited here
  settingsEdit: boolean;
  knowledgeEdit: boolean;
  revenue: boolean;
  reports: boolean;
}
export type ContactField =
  | 'name' | 'phone' | 'email' | 'source' | 'status' | 'stage' | 'tags' | 'lastActivityAt' | 'nextActionAt' | 'owner'
  | 'aiSummary' | 'interest' | 'notes' | 'lostReason' | 'firstResponseAt' | 'campaign' | 'pageUrl' | 'enquiry';

// ---------------------------------------------------------------- contacts
export type ContactStatus = 'new' | 'contacted' | 'booked' | 'converted' | 'lost';
export type ContactStage = 'hot' | 'warm' | 'cold';

export interface Contact {
  id: string;
  ref: string | null;                 // the backend's human reference, if any
  name: string;
  phone: string | null;
  email: string | null;
  source: string | null;
  status: ContactStatus | null;
  stage: ContactStage | null;
  tags: string[];
  createdAt: ISODate | null;
  lastActivityAt: ISODate | null;
  nextActionAt: ISODate | null;
  owner: string | null;
  aiSummary: string | null;
  interest: string | null;
  enquiry: string | null;
  notes: string | null;
  lostReason: string | null;
  firstResponseAt: ISODate | null;
  campaign: string | null;
  pageUrl: string | null;
  attentionRequired: boolean;
  attentionReason: string | null;
  priority: Priority | null;
  optedOut: boolean;
  escalated: boolean;
  conversationId: string | null;
  automationPaused: boolean | null;    // the linked conversation's Human handling switch; null when the contact has no conversation
  custom: Record<string, string | number | boolean | null>;
}
export type Priority = 'urgent' | 'high' | 'normal';

// ---------------------------------------------------------------- bookings
export type BookingStatus = 'scheduled' | 'rescheduled' | 'cancelled' | 'completed' | 'no_show';
export interface Booking {
  id: string;
  ref: string | null;                 // external reference (booking system id)
  title: string;                      // the service, or a generic title
  contactId: string | null;
  contactName: string | null;
  start: ISODate | null;
  end: ISODate | null;
  status: BookingStatus;
  owner: string | null;               // the team member it is with
  service: string | null;
  source: { kind: 'external_calendar' | 'assistant' | 'manual' | 'unknown'; label: string };
  value: number | null;               // only when the backend stores it and the viewer may see it
  needsOutcome: boolean;              // in the past and still scheduled: someone must mark it completed / no-show
  automationsDone: Array<{ key: AutomationKey; at: ISODate | null; label: string }>;
}

// ---------------------------------------------------------------- conversations
export type AiStatus = 'processing' | 'replied' | 'drafted' | 'handed_off' | 'no_reply' | 'skipped' | 'opted_out' | 'deferred' | 'failed';
export interface Conversation {
  id: string;
  contactId: string | null;
  contactName: string;
  contactPhone: string | null;
  channel: ChannelKey;
  lastInboundAt: ISODate | null;
  lastMessageAt: ISODate | null;
  lastMessagePreview: string | null;
  lastMessageDirection: 'in' | 'out' | null;
  unread: number;
  assignedTo: string | null;
  attentionRequired: boolean;          // a person must take over (AI hand-off or ticked by staff)
  attentionReason: string | null;
  priority: Priority | null;
  automationPaused: boolean;
  lastIntent: string | null;
  aiActive: boolean;                   // the AI assistant is on for this workspace and not blocked for this conversation
  optedOut: boolean;
  replyWindow: { open: boolean; closesAt: ISODate | null; hours: number | null };
}

export type MessageAuthorKind = 'contact' | 'ai' | 'staff' | 'automation' | 'system';
export type MessageStatus = 'received' | 'pending' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'needs_template';
export interface Message {
  id: string;
  conversationId: string;
  direction: 'in' | 'out';
  body: string;
  template: string | null;
  author: { kind: MessageAuthorKind; name: string; automationKey: AutomationKey | null; testMode: boolean };
  status: MessageStatus;
  statusNote: string | null;
  createdAt: ISODate | null;
  externalId: string | null;
  ai: null | {
    intent: string | null;
    action: string | null;
    confidence: number | null;
    status: AiStatus | null;
    needsHuman: boolean;
    reply: string | null;
    reason: string | null;
  };
}

// ---------------------------------------------------------------- automations
export interface Automation {
  key: AutomationKey;
  module: ModuleKey;
  trigger: { kind: 'schedule' | 'event'; label: string };
  status: 'active' | 'off' | 'needs_setup' | 'attention' | 'always_on';
  control: null | { kind: 'toggle' | 'choice'; value: string; options: Array<{ value: string; label: string }>; label: string | null };   // label: what the control changes, when it is not the whole automation
  requirements: Array<{ label: string; ok: boolean }>;
  lastRunAt: ISODate | null;
  nextRunAt: ISODate | null;
  stats: { today: number; ok7d: number; failed7d: number; skipped7d: number; successRate: number | null };
  lastError: string | null;
  backendRef: string;                  // internal id of the implementation (shown small, for support)
  measures: string;                    // what "actions" counts, in plain words
}

// ---------------------------------------------------------------- activity
export type ActivityKind =
  | 'contact_created' | 'message_received' | 'ai_replied' | 'ai_handoff' | 'booking_created' | 'booking_rescheduled'
  | 'booking_cancelled' | 'reminder_sent' | 'follow_up_sent' | 'outcome_checkin_sent' | 'review_requested'
  | 'staff_replied' | 'contact_escalated' | 'report_generated' | 'automation_failed' | 'automation_skipped' | 'message_sent';
export interface Activity {
  id: string;
  kind: ActivityKind;
  at: ISODate;
  contactId: string | null;
  contactName: string | null;
  conversationId: string | null;
  bookingRef: string | null;
  automationKey: AutomationKey | null;
  outcome: 'ok' | 'skipped' | 'failed' | null;
  detail: string | null;
}

// ---------------------------------------------------------------- tasks (derived: the backend has no task table)
export type TaskKind = 'reply_needed' | 'next_action_due' | 'booking_outcome' | 'reply_failed' | 'first_response';
export interface Task {
  id: string;
  kind: TaskKind;
  priority: Priority;
  dueAt: ISODate | null;
  contactId: string | null;
  contactName: string | null;
  conversationId: string | null;
  bookingId: string | null;
  detail: string | null;
}

// ---------------------------------------------------------------- dashboard, reports, analytics
export interface MetricValue { key: MetricKey; value: number | null; unit: 'count' | 'percent' | 'currency'; previous: number | null; hint: string | null }
export interface Series { key: string; points: Array<{ date: string; value: number }> }
// Enquiries created in the period. The new count and the conversion rate are the `new_contacts` and `conversion` metrics.
export interface EnquirySummary {
  converted: number;       // booked or converted: the same rule as the `conversion` metric
  awaitingReply: number;   // still New, not opted out, and no outbound message has reached them yet
}
export interface Dashboard {
  range: { from: ISODate; to: ISODate; days: number };
  metrics: MetricValue[];
  enquiries: EnquirySummary;
  series: Series[];
  attention: Task[];
  upcoming: Booking[];
  recent: Activity[];
}

export type AnalyticsCategory = 'acquisition' | 'engagement' | 'bookings' | 'conversion' | 'automation' | 'ai' | 'handoffs' | 'retention' | 'feedback';
export interface AnalyticsMetric { key: string; category: AnalyticsCategory; label: string; value: number | null; unit: 'count' | 'percent' | 'minutes' }
export interface Analytics {
  period: { start: ISODate; end: ISODate; label: string };
  engine: string;                       // which automation computes these numbers (same code as the report)
  metrics: AnalyticsMetric[];
  breakdowns: Array<{ key: string; category: AnalyticsCategory; label: string; items: Array<{ label: string; value: number }> }>;
  incomplete: boolean;
}
export interface Report {
  id: string;
  generatedAt: ISODate | null;
  periodLabel: string | null;
  title: string;
  sections: Array<{ key: string; title: string; lines: string[] }>;
  note: string | null;                   // e.g. why AI text was not used
  text: string;
}

// ---------------------------------------------------------------- AI
export interface AiOverview {
  mode: { value: string; options: Array<{ value: string; label: string }>; editable: boolean } | null;
  range: { from: ISODate; to: ISODate };
  processed: number;
  handled: number;
  handoffs: number;
  failed: number;
  deferred: number;
  avgConfidence: number | null;
  intents: Array<{ intent: string; count: number }>;
  stages: Array<{ stage: ContactStage | 'not_rated'; count: number }>;
  recentHandoffs: Array<{ conversationId: string; contactName: string; reason: string | null; priority: Priority | null; at: ISODate | null }>;
  recentDecisions: Message[];
  knowledgeCount: number;
  knowledgeCategories: string[];
}
export interface KnowledgeItem { id: string; title: string; category: string | null; content: string; active: boolean }

// ---------------------------------------------------------------- settings
export type SettingsSection = 'workspace' | 'branding' | 'team' | 'channels' | 'ai' | 'automations' | 'notifications' | 'business_hours' | 'terminology' | 'integrations';
export interface SettingField {
  key: string;                // the backend's own key (shown small)
  section: SettingsSection;
  label: string;
  help: string | null;
  type: 'text' | 'textarea' | 'url' | 'phone' | 'time' | 'windows' | 'number' | 'boolean' | 'choice';
  options?: Array<{ value: string; label: string }>;
  value: string | null;
  editable: boolean;
  sensitive: boolean;         // shown masked to non-admins
}
export interface SettingsView {
  fields: SettingField[];
  team: { users: Array<{ name: string; email: string; role: string }>; namesInData: string[] };
  channels: Array<{ key: ChannelKey; label: string; status: 'connected' | 'not_connected' | 'unknown'; detail: string }>;
  integrations: Array<{ key: string; label: string; status: 'connected' | 'error' | 'unknown'; detail: string }>;
}
