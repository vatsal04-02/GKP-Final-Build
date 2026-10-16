// The Clinic Autopilot backend as it really is: the Grist tables and columns (grist/schema.md + the live workflow export) and
// the n8n workflow sections W1-W13. Nothing here is invented; anything FLOW HQ needs that is not in this file is listed as
// missing in flowhq/README.md (J).
import type { AutomationKey, ChannelKey } from '../../../core/domain';
import type { Schedule } from '../../time';

export const TABLES = {
  registry: 'Clinics',                    // Agency Registry doc: Clinic_Slug, Clinic_Name, Grist_Doc_ID, WA_Phone_Number_ID, Active
  settings: 'Settings',                   // Key, Value
  leads: 'LEADS',                         // live name (grist/schema.md calls it Leads); override with GRIST_LEADS_TABLE
  appointments: 'Appointments',
  conversations: 'Conversations',
  messages: 'Messages',
  runLog: 'Run_Log',
  knowledge: 'Knowledge',
} as const;

// Columns, as used by the workflows (for reference and for write validation).
export const COLUMNS = {
  leads: ['Lead_id', 'Lead_ID', 'Created_At', 'Name', 'Phone', 'Source', 'Page_URL', 'UTM_Campaign', 'Enquiry', 'AI_Summary', 'Likely_Service', 'Status', 'Owner', 'Next_Action_At', 'First_Response_At', 'Lost_Reason', 'Opted_Out', 'Escalated', 'Followup_Sent', 'Notes', 'Lead_Stage'],
  appointments: ['Booking_UID', 'Lead', 'Service', 'Physio', 'Start', 'End', 'Status', 'Fee_INR', 'R24_Sent', 'R2_Sent', 'Rebook_Sent', 'Review_Sent', 'Outcome_Sent'],
  conversations: ['Lead', 'Phone', 'Last_Inbound_At', 'Unread', 'Automation_Paused', 'Assigned_To', 'Needs_Human', 'Handoff_Reason', 'Last_Intent'],
  messages: ['Conversation', 'Direction', 'Body', 'Template', 'Sent_By', 'WA_Message_ID', 'Status', 'Send', 'Created_At', 'Intent', 'AI_Action', 'AI_Confidence', 'AI_Status', 'Needs_Human', 'AI_Reply', 'AI_Reason'],
  runLog: ['Workflow', 'Record', 'Outcome', 'Error', 'At'],
  knowledge: ['Title', 'Category', 'Content', 'Active'],
};
export const LEAD_STATUS = { New: 'new', Contacted: 'contacted', Booked: 'booked', Converted: 'converted', Lost: 'lost' } as const;
export const APPT_STATUS = { Booked: 'scheduled', Rescheduled: 'rescheduled', Cancelled: 'cancelled', Completed: 'completed', 'No-show': 'no_show' } as const;
export const KNOWLEDGE_CATEGORIES = ['services', 'pricing', 'hours', 'location', 'policy', 'faq', 'general'];

// WhatsApp's customer-service window, as W12 / W10 apply it (24 h minus a 5-minute safety margin).
export const REPLY_WINDOW_SEC = 24 * 3600 - 5 * 60;
export const CHANNELS: ChannelKey[] = ['whatsapp'];
export const BOOKING_SYSTEM = 'Cal.com';                 // W4: the booking system is the source of truth for bookings

// Who wrote an outgoing message (Messages.Sent_By): the workflow sections that send to contacts.
export const SENDERS: Record<string, AutomationKey> = {
  W3: 'speed_to_lead', W5: 'booking_reminders', W6: 'follow_ups', W7: 'outcome_checkins', W8: 'review_requests', W13: 'ai_assistant', W9: 'weekly_reports',
};

// The n8n sections behind each universal automation. Run_Log names are what each section writes in Run_Log.Workflow.
export interface AutomationImpl {
  ref: string;                        // the n8n section(s)
  runLog: string[];
  trigger: { kind: 'schedule'; schedule: Schedule } | { kind: 'event'; label: string };
  switchKey?: string;                 // the per-workspace Settings switch, if the section has one
  switchKind?: 'onoff' | 'ai_mode';
  measures: string;                   // what one Run_Log 'ok' row means (terminology template)
}
export const AUTOMATIONS: Record<AutomationKey, AutomationImpl> = {
  contact_capture: { ref: 'W1', runLog: ['W1-website-lead'], trigger: { kind: 'event', label: 'When the website form is sent' }, measures: 'website enquiries processed' },
  inbound_messaging: { ref: 'W2', runLog: ['W2-WhatsApp-Inbound'], trigger: { kind: 'event', label: 'When a message arrives' }, measures: 'incoming messages stored' },
  speed_to_lead: { ref: 'W3', runLog: ['W3-speed-to-lead'], trigger: { kind: 'schedule', schedule: { kind: 'every', minutes: 10 } }, measures: 'team alerts sent' },
  booking_sync: { ref: 'W4', runLog: ['W4-booking-sync'], trigger: { kind: 'event', label: 'When the booking system changes {booking.singular|a}' }, measures: '{booking.singular|lower} changes synced' },
  booking_reminders: { ref: 'W5', runLog: ['W5-reminders'], trigger: { kind: 'schedule', schedule: { kind: 'every', minutes: 15 } }, measures: 'reminders sent' },
  follow_ups: { ref: 'W6', runLog: ['W6-followups'], trigger: { kind: 'schedule', schedule: { kind: 'daily', hour: 10, minute: 0 } }, measures: 'follow-ups sent' },
  outcome_checkins: { ref: 'W7', runLog: ['W7-outcome-nudge'], trigger: { kind: 'schedule', schedule: { kind: 'hourly', minute: 20 } }, switchKey: 'outcome_checkin', switchKind: 'onoff', measures: 'check-ins sent' },
  review_requests: { ref: 'W8', runLog: ['W8-review-request'], trigger: { kind: 'schedule', schedule: { kind: 'hourly', minute: 35 } }, switchKey: 'review_requests', switchKind: 'onoff', measures: 'review requests sent' },
  weekly_reports: { ref: 'W9', runLog: ['W9-weekly-report'], trigger: { kind: 'schedule', schedule: { kind: 'weekly', weekday: 1, hour: 9, minute: 0 } }, switchKey: 'weekly_report_whatsapp', switchKind: 'onoff', measures: 'reports generated' },
  staff_reply: { ref: 'W10 → W12', runLog: ['W10-staff-reply'], trigger: { kind: 'schedule', schedule: { kind: 'every', minutes: 1 } }, measures: 'replies sent' },
  error_alerts: { ref: 'W11', runLog: [], trigger: { kind: 'event', label: 'When an automation step fails' }, measures: '' },
  ai_assistant: { ref: 'W13', runLog: ['W13-ai-receptionist'], trigger: { kind: 'event', label: 'When a message arrives (and 08:05 for overnight messages)' }, switchKey: 'ai_mode', switchKind: 'ai_mode', measures: 'messages handled' },
};
export const AUTOMATION_BY_RUNLOG: Record<string, AutomationKey> = Object.fromEntries(
  Object.entries(AUTOMATIONS).flatMap(([k, v]) => v.runLog.map((r) => [r, k as AutomationKey])),
);

// Settings keys the workflows read (grist/schema.md > Settings), how FLOW HQ shows them, and who may change them.
export interface SettingDef { key: string; section: 'workspace' | 'channels' | 'ai' | 'automations' | 'notifications' | 'business_hours'; label: string; help?: string; type: 'text' | 'textarea' | 'url' | 'phone' | 'time' | 'windows' | 'number' | 'boolean' | 'choice'; options?: Array<{ value: string; label: string }>; sensitive?: boolean }
export const SETTINGS: SettingDef[] = [
  { key: 'clinic_name', section: 'workspace', label: 'Business name', help: 'Used in every message to {contact.plural|lower}.', type: 'text' },
  { key: 'services', section: 'workspace', label: '{service.plural}', help: 'The list the team and the assistant refer to.', type: 'textarea' },
  { key: 'booking_link', section: 'workspace', label: 'Booking link', help: 'The page {contact.plural|lower} use to book (https). Added to follow-ups and assistant replies.', type: 'url' },
  { key: 'open_time', section: 'business_hours', label: 'Opens', help: '24-hour time, e.g. 09:00. Used to offer free times.', type: 'time' },
  { key: 'close_time', section: 'business_hours', label: 'Closes', help: '24-hour time, e.g. 19:30.', type: 'time' },
  { key: 'open_hours', section: 'business_hours', label: 'Opening hours (with a break)', help: 'Only if the day has a break, e.g. 09:00-13:00, 16:00-20:00. Times are offered only inside these windows. Leave empty to use Opens / Closes.', type: 'windows' },
  { key: 'working_days', section: 'business_hours', label: 'Working days', help: 'e.g. Mon-Sat, Mon,Tue,Thu or daily.', type: 'text' },
  { key: 'owner_phone', section: 'notifications', label: 'Owner phone', help: 'Receives team alerts and the weekly report copy.', type: 'phone', sensitive: true },
  { key: 'staff_alert_phones', section: 'notifications', label: 'Team alert phones', help: 'Comma-separated mobile numbers.', type: 'text', sensitive: true },
  { key: 'TEST_MODE', section: 'channels', label: 'Test mode', help: 'On: every message to {contact.plural|lower} goes to the test phone instead. Missing counts as on.', type: 'boolean' },
  { key: 'TEST_PHONE', section: 'channels', label: 'Test phone', help: 'Where messages go while test mode is on.', type: 'phone', sensitive: true },
  { key: 'ai_mode', section: 'ai', label: 'Assistant mode', help: 'Off, Draft (replies wait for a person) or Auto (replies are sent).', type: 'choice', options: [{ value: 'off', label: 'Off' }, { value: 'draft', label: 'Draft' }, { value: 'auto', label: 'Auto' }] },
  { key: 'booking_mode', section: 'ai', label: 'Booking by the assistant', help: 'Link: the {contact.singular|lower} confirms on the booking page. Direct: the assistant books the slot itself.', type: 'choice', options: [{ value: 'link', label: 'Booking link' }, { value: 'direct', label: 'Direct' }] },
  { key: 'handoff_reply', section: 'ai', label: 'Hand-off reply', help: 'What the {contact.singular|lower} receives when a person takes over.', type: 'textarea' },
  { key: 'slot_minutes', section: 'ai', label: 'Slot length (minutes)', type: 'number' },
  { key: 'booking_capacity', section: 'ai', label: '{contact.plural} per slot', type: 'number' },
  { key: 'booking_notice_minutes', section: 'ai', label: 'Minimum notice (minutes)', type: 'number' },
  { key: 'outcome_checkin', section: 'automations', label: 'Outcome check-ins', help: 'Switch on once the check-in template is approved for your number.', type: 'boolean' },
  { key: 'review_requests', section: 'automations', label: 'Review requests', help: 'Switch on once the review template is approved.', type: 'boolean' },
  { key: 'review_link', section: 'automations', label: 'Review link', help: 'Your own review page (https). Without it no review request is sent.', type: 'url' },
  { key: 'weekly_report_whatsapp', section: 'notifications', label: 'Weekly report to the owner', help: 'A short copy of the weekly report on WhatsApp.', type: 'boolean' },
];
export const isOn = (v: unknown) => ['on', 'true', 'yes', '1'].includes(String(v ?? '').trim().toLowerCase());
export const isTestMode = (v: unknown) => !['false', '0', 'no', 'off'].includes(String(v ?? '').trim().toLowerCase());
