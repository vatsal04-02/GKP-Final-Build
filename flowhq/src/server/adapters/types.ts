// The contract between FLOW HQ and a backend. One adapter per backend kind; the first one is the Clinic Autopilot backend
// (Grist CRM + n8n workflows W1-W13). A new backend implements this interface; the API and every screen stay as they are.
import type {
  AiOverview, Analytics, Automation, AutomationKey, Booking, BookingStatus, Capabilities, ChannelKey, Contact, Conversation, Dashboard,
  KnowledgeItem, Message, MetricKey, ModuleKey, Report, SettingsView, Task, Activity, ActivityKind,
} from '../../core/domain';

import type { RecordsService } from '../records/service';
import type { StaffBooking } from '../booking/staff-service';
import type { PaymentService } from '../payments/service';
export type Role = 'admin' | 'staff';
export interface Viewer { email: string; name: string; role: Role; clinician?: string; doctorId?: string; grants?: string[] }   // doctorId: the stable Doctors.Doctor_ID this login is (booking rights); clinician: the name used on prescriptions   // clinician: set for a doctor's login
export interface Ctx { viewer: Viewer; now: number }

export interface BackendWorkspaceInfo {
  id: string;                 // stable slug
  name: string;
  timezone: string;
  locale: string;
  currency: string | null;
  channels: ChannelKey[];
  protected?: boolean;        // the main workspace (the first one ever registered): it cannot be removed
}

export interface Supported { modules: ModuleKey[]; automations: AutomationKey[]; metrics: MetricKey[] }

export interface ContactQuery { q?: string; status?: string; stage?: string; attention?: boolean; limit?: number }
export interface ConversationQuery { filter?: 'all' | 'unread' | 'attention' | 'ai' | 'paused' | 'mine'; q?: string }
export interface BookingQuery { view?: 'upcoming' | 'past' | 'needs_outcome' | 'all'; q?: string }
export interface ActivityQuery { kind?: ActivityKind | ''; contactId?: string; limit?: number }
export interface ContactPatch { status?: string; owner?: string; notes?: string; nextActionAt?: string | null }
export interface ConversationPatch { assignedTo?: string; automationPaused?: boolean; resolveAttention?: boolean; markRead?: boolean }

export interface WorkspaceBackend {
  info: BackendWorkspaceInfo;
  supported: Supported;
  capabilities(viewer: Viewer): Promise<Capabilities>;
  dashboard(days: number, ctx: Ctx): Promise<Dashboard>;
  contacts(q: ContactQuery, ctx: Ctx): Promise<Contact[]>;
  contact(id: string, ctx: Ctx): Promise<{ contact: Contact; bookings: Booking[]; activity: Activity[] } | null>;
  updateContact(id: string, patch: ContactPatch, ctx: Ctx): Promise<Contact>;
  conversations(q: ConversationQuery, ctx: Ctx): Promise<Conversation[]>;
  conversation(id: string, ctx: Ctx): Promise<{ conversation: Conversation; messages: Message[]; contact: Contact | null } | null>;
  reply(conversationId: string, body: string, ctx: Ctx): Promise<Message>;
  updateConversation(id: string, patch: ConversationPatch, ctx: Ctx): Promise<Conversation>;
  bookings(q: BookingQuery, ctx: Ctx): Promise<Booking[]>;
  updateBooking(id: string, status: BookingStatus, ctx: Ctx): Promise<Booking>;
  automations(ctx: Ctx): Promise<Automation[]>;
  setAutomation(key: AutomationKey, value: string, ctx: Ctx): Promise<Automation>;
  tasks(ctx: Ctx): Promise<Task[]>;
  activity(q: ActivityQuery, ctx: Ctx): Promise<Activity[]>;
  reports(ctx: Ctx): Promise<Report[]>;
  analytics(week: 'last' | 'this', ctx: Ctx): Promise<Analytics>;
  ai(ctx: Ctx): Promise<AiOverview>;
  knowledge(ctx: Ctx): Promise<KnowledgeItem[]>;
  saveKnowledge(item: Partial<KnowledgeItem> & { id?: string }, ctx: Ctx): Promise<KnowledgeItem>;
  // Clinic records (patients, prescriptions, invoices, visits): present only when the backend has the Clinic Records tables
  records?(): RecordsService | null;
  // Appointment booking (the one service that creates / moves / cancels appointments). Works against the clinic's Grist doc; fails closed if its tables are missing.
  booking?(): StaffBooking | null;
  payments?(): PaymentService | null;   // UPI payment requests / screenshot review for this workspace (src/server/payments)
  settings(ctx: Ctx): Promise<SettingsView>;
  updateSettings(values: Record<string, string>, ctx: Ctx): Promise<SettingsView>;
}

export interface BackendAdapter {
  key: string;
  label: string;
  listWorkspaces(): Promise<BackendWorkspaceInfo[]>;
  workspace(id: string): Promise<WorkspaceBackend | null>;
  /** Optional: create a new, separate workspace with its own empty data (admin only; the API checks that). */
  createWorkspace?(input: { name: string }): Promise<BackendWorkspaceInfo>;
  /** Optional: remove a workspace from FLOW HQ (admin only). Its data is kept in the backend, not erased. The main workspace refuses. */
  deleteWorkspace?(id: string): Promise<void>;
  health(): Promise<{ ok: boolean; detail: string; audit?: 'ok' | 'amber' | 'red' | null }>;   // audit = the worst audit-outbox state of the workspaces that have a booking service (null = none yet)
}
