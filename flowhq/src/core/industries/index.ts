// Industry profiles: terminology, default modules, dashboard metrics and automation names per kind of business.
// Adding an industry = adding one entry here (or in the workspace config file). No screen changes.
import type { IndustryKey, MetricKey, ModuleKey } from '../domain';
import { mergeTerminology, type Terminology, type TerminologyOverrides } from '../terminology';

export interface IndustryProfile {
  key: IndustryKey;
  label: string;
  description: string;
  terminology: Terminology;
  modules: ModuleKey[];               // optional modules this kind of business normally uses (core modules are always on)
  dashboardMetrics: MetricKey[];
}

// The neutral base every profile starts from.
export const BASE_TERMINOLOGY: Terminology = {
  workspace: { singular: 'Business', plural: 'Businesses' },
  contact: { singular: 'Contact', plural: 'Contacts' },
  booking: { singular: 'Booking', plural: 'Bookings' },
  service: { singular: 'Service', plural: 'Services' },
  staff: { singular: 'Team member', plural: 'Team' },
  conversation: { singular: 'Conversation', plural: 'Conversations' },
  ai: { name: 'AI Assistant', short: 'AI' },
  contactStatus: { new: 'New', contacted: 'Contacted', booked: 'Booked', converted: 'Converted', lost: 'Lost' },
  contactStage: { hot: 'Hot', warm: 'Warm', cold: 'Cold' },
  bookingStatus: { scheduled: 'Scheduled', rescheduled: 'Rescheduled', cancelled: 'Cancelled', completed: 'Completed', no_show: 'No-show' },
  outcome: { better: 'Better', same: 'No change', worse: 'Worse' },
  automations: {
    contact_capture: { name: 'Website Capture', description: 'New {contact.plural|lower} from your website form land in {contact.plural|lower} instantly.' },
    inbound_messaging: { name: 'Inbound Messages', description: 'Every incoming message is stored, linked to its {contact.singular|lower} and handed to the assistant.' },
    speed_to_lead: { name: 'Speed to Lead', description: 'Alerts the team when a new {contact.singular|lower} has waited too long for a first reply.' },
    booking_sync: { name: '{booking.singular} Sync', description: 'Keeps {booking.plural|lower} in step with your booking system: created, rescheduled, cancelled.' },
    booking_reminders: { name: '{booking.singular} Reminders', description: 'Reminds {contact.plural|lower} the day before and shortly before their {booking.singular|lower}.' },
    follow_ups: { name: 'Follow-ups', description: 'Re-engages {contact.plural|lower} who did not book and offers a new time after a missed {booking.singular|lower}.' },
    outcome_checkins: { name: 'Outcome Check-ins', description: 'Asks {contact.plural|lower} how things went after a completed {booking.singular|lower}; worse or unsure answers go to a person.' },
    review_requests: { name: 'Review Requests', description: 'After a completed {booking.singular|lower}, asks every {contact.singular|lower} the same polite question for an honest review.' },
    ai_assistant: { name: '{ai.name}', description: 'Answers questions from your knowledge base, offers real free times and hands anything sensitive to a person.' },
    weekly_reports: { name: 'Weekly Reports', description: 'Every Monday: the numbers for last week, a short summary and suggested next steps.' },
    staff_reply: { name: 'Team Replies', description: 'Sends replies your team writes in the inbox through the official messaging gateway.' },
    error_alerts: { name: 'Error Alerts', description: 'Tells the agency when any automation step fails.' },
  },
  metrics: {},
};

const ALL_METRICS: MetricKey[] = ['new_contacts', 'active_conversations', 'bookings', 'completed', 'pending_actions', 'ai_handled', 'human_handoffs', 'conversion', 'revenue', 'follow_ups', 'reviews'];
const BOOKED_BUSINESS: ModuleKey[] = ['bookings', 'ai', 'tasks', 'reports', 'reminders', 'follow_ups', 'reviews', 'lead_qualification', 'staff', 'analytics'];

const profile = (key: IndustryKey, label: string, description: string, t: TerminologyOverrides, modules: ModuleKey[] = BOOKED_BUSINESS, dashboardMetrics: MetricKey[] = ALL_METRICS): IndustryProfile => ({
  key, label, description, terminology: mergeTerminology(BASE_TERMINOLOGY, t), modules, dashboardMetrics,
});

export const INDUSTRIES: Record<IndustryKey, IndustryProfile> = {
  clinic: profile('clinic', 'Clinic', 'Medical and health practices', {
    workspace: { singular: 'Clinic', plural: 'Clinics' },
    contact: { singular: 'Patient', plural: 'Patients' },
    booking: { singular: 'Appointment', plural: 'Appointments' },
    service: { singular: 'Treatment', plural: 'Treatments' },
    staff: { singular: 'Practitioner', plural: 'Practitioners' },
    ai: { name: 'AI Receptionist', short: 'AI' },
    outcome: { better: 'Feeling better', same: 'No change', worse: 'Feeling worse' },
    automations: { contact_capture: { name: 'Website Enquiries' } },
  }),
  physiotherapy: profile('physiotherapy', 'Physiotherapy', 'Physiotherapy and rehab centres', {
    workspace: { singular: 'Clinic', plural: 'Clinics' },
    contact: { singular: 'Enquiry', plural: 'Enquiries' },   // marketing leads: registered patients live in the Patients register
    booking: { singular: 'Appointment', plural: 'Appointments' },
    service: { singular: 'Treatment', plural: 'Treatments' },
    staff: { singular: 'Physiotherapist', plural: 'Physiotherapists' },
    ai: { name: 'AI Receptionist', short: 'AI' },
    outcome: { better: 'Feeling better', same: 'No change', worse: 'Feeling worse' },
    automations: { contact_capture: { name: 'Website Enquiries' } },
  }, [...BOOKED_BUSINESS, 'patients', 'prescriptions', 'invoices', 'visits']),
  salon: profile('salon', 'Salon', 'Hair, beauty and nail salons', {
    workspace: { singular: 'Salon', plural: 'Salons' },
    contact: { singular: 'Client', plural: 'Clients' },
    booking: { singular: 'Appointment', plural: 'Appointments' },
    service: { singular: 'Service', plural: 'Services' },
    staff: { singular: 'Stylist', plural: 'Stylists' },
    ai: { name: 'AI Front Desk', short: 'AI' },
    outcome: { better: 'Loved it', same: 'It was okay', worse: 'Not happy' },
    automations: { outcome_checkins: { name: 'Visit Check-ins' } },
  }),
  spa: profile('spa', 'Spa & wellness', 'Spas, massage and wellness centres', {
    workspace: { singular: 'Spa', plural: 'Spas' },
    contact: { singular: 'Guest', plural: 'Guests' },
    booking: { singular: 'Session', plural: 'Sessions' },
    service: { singular: 'Treatment', plural: 'Treatments' },
    staff: { singular: 'Therapist', plural: 'Therapists' },
    ai: { name: 'AI Concierge', short: 'AI' },
    outcome: { better: 'Relaxed', same: 'No change', worse: 'Not satisfied' },
  }),
  gym: profile('gym', 'Gym & fitness', 'Gyms, studios and personal trainers', {
    workspace: { singular: 'Gym', plural: 'Gyms' },
    contact: { singular: 'Member', plural: 'Members' },
    booking: { singular: 'Session', plural: 'Sessions' },
    service: { singular: 'Programme', plural: 'Programmes' },
    staff: { singular: 'Coach', plural: 'Coaches' },
    ai: { name: 'AI Membership Assistant', short: 'AI' },
    contactStatus: { booked: 'Trial booked', converted: 'Member' },
    outcome: { better: 'Great session', same: 'Okay', worse: 'Not great' },
  }),
  consultant: profile('consultant', 'Consultant', 'Independent consultants and advisors', {
    workspace: { singular: 'Practice', plural: 'Practices' },
    contact: { singular: 'Client', plural: 'Clients' },
    booking: { singular: 'Meeting', plural: 'Meetings' },
    service: { singular: 'Engagement', plural: 'Engagements' },
    staff: { singular: 'Consultant', plural: 'Consultants' },
    ai: { name: 'AI Client Assistant', short: 'AI' },
    outcome: { better: 'Helpful', same: 'Neutral', worse: 'Not helpful' },
  }, ['bookings', 'ai', 'tasks', 'reports', 'reminders', 'follow_ups', 'lead_qualification', 'analytics']),
  agency: profile('agency', 'Agency', 'Marketing, creative and service agencies', {
    workspace: { singular: 'Agency', plural: 'Agencies' },
    contact: { singular: 'Prospect', plural: 'Prospects' },
    booking: { singular: 'Meeting', plural: 'Meetings' },
    service: { singular: 'Service', plural: 'Services' },
    staff: { singular: 'Account manager', plural: 'Account managers' },
    ai: { name: 'AI Sales Assistant', short: 'AI' },
    contactStatus: { booked: 'Meeting booked', converted: 'Client' },
    outcome: { better: 'Positive', same: 'Neutral', worse: 'Negative' },
  }, ['bookings', 'ai', 'tasks', 'reports', 'follow_ups', 'lead_qualification', 'analytics'],
  ['new_contacts', 'active_conversations', 'bookings', 'conversion', 'pending_actions', 'ai_handled', 'human_handoffs', 'follow_ups']),
  real_estate: profile('real_estate', 'Real estate', 'Agents, brokers and developers', {
    workspace: { singular: 'Agency', plural: 'Agencies' },
    contact: { singular: 'Lead', plural: 'Leads' },
    booking: { singular: 'Site visit', plural: 'Site visits' },
    service: { singular: 'Property', plural: 'Properties' },
    staff: { singular: 'Agent', plural: 'Agents' },
    ai: { name: 'AI Lead Assistant', short: 'AI' },
    contactStatus: { booked: 'Visit booked', converted: 'Closed' },
    outcome: { better: 'Interested', same: 'Undecided', worse: 'Not interested' },
    automations: { booking_sync: { name: 'Site Visit Sync' }, booking_reminders: { name: 'Site Visit Reminders' } },
  }, ['bookings', 'ai', 'tasks', 'reports', 'reminders', 'follow_ups', 'lead_qualification', 'analytics'],
  ['new_contacts', 'active_conversations', 'bookings', 'completed', 'conversion', 'pending_actions', 'ai_handled', 'human_handoffs', 'follow_ups']),
  coaching: profile('coaching', 'Coaching', 'Coaches and mentoring programmes', {
    workspace: { singular: 'Practice', plural: 'Practices' },
    contact: { singular: 'Client', plural: 'Clients' },
    booking: { singular: 'Session', plural: 'Sessions' },
    service: { singular: 'Programme', plural: 'Programmes' },
    staff: { singular: 'Coach', plural: 'Coaches' },
    ai: { name: 'AI Client Assistant', short: 'AI' },
    outcome: { better: 'Making progress', same: 'Stuck', worse: 'Struggling' },
  }),
  education: profile('education', 'Education', 'Tutors, academies and training centres', {
    workspace: { singular: 'Academy', plural: 'Academies' },
    contact: { singular: 'Student', plural: 'Students' },
    booking: { singular: 'Class', plural: 'Classes' },
    service: { singular: 'Course', plural: 'Courses' },
    staff: { singular: 'Instructor', plural: 'Instructors' },
    ai: { name: 'AI Admissions Assistant', short: 'AI' },
    contactStatus: { booked: 'Trial booked', converted: 'Enrolled' },
    outcome: { better: 'Enjoyed it', same: 'Okay', worse: 'Struggling' },
  }),
  local_services: profile('local_services', 'Local services', 'Repair shops, studios and local businesses', {
    contact: { singular: 'Customer', plural: 'Customers' },
    booking: { singular: 'Appointment', plural: 'Appointments' },
    staff: { singular: 'Technician', plural: 'Technicians' },
    ai: { name: 'AI Customer Assistant', short: 'AI' },
    outcome: { better: 'Happy', same: 'Okay', worse: 'Not happy' },
  }),
  home_services: profile('home_services', 'Home services', 'Plumbing, cleaning, electrical and repairs', {
    contact: { singular: 'Customer', plural: 'Customers' },
    booking: { singular: 'Job', plural: 'Jobs' },
    service: { singular: 'Service', plural: 'Services' },
    staff: { singular: 'Technician', plural: 'Technicians' },
    ai: { name: 'AI Dispatch Assistant', short: 'AI' },
    bookingStatus: { scheduled: 'Scheduled', completed: 'Done' },
    outcome: { better: 'All fixed', same: 'Partly fixed', worse: 'Still a problem' },
  }),
  professional_services: profile('professional_services', 'Professional services', 'Law, accounting and advisory firms', {
    workspace: { singular: 'Firm', plural: 'Firms' },
    contact: { singular: 'Client', plural: 'Clients' },
    booking: { singular: 'Consultation', plural: 'Consultations' },
    service: { singular: 'Matter', plural: 'Matters' },
    staff: { singular: 'Advisor', plural: 'Advisors' },
    ai: { name: 'AI Intake Assistant', short: 'AI' },
    outcome: { better: 'Satisfied', same: 'Neutral', worse: 'Dissatisfied' },
  }, ['bookings', 'ai', 'tasks', 'reports', 'reminders', 'follow_ups', 'lead_qualification', 'analytics']),
  custom: profile('custom', 'Custom', 'Start from neutral words and rename them in Settings', {}),
};

export const INDUSTRY_KEYS = Object.keys(INDUSTRIES) as IndustryKey[];
export const isIndustry = (v: unknown): v is IndustryKey => typeof v === 'string' && v in INDUSTRIES;
