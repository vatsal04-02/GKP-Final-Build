/**
 * Single source of truth for clinic facts.
 *
 * Only information verified in the Master PRD (§3) lives here. Anything unknown stays as
 * TBD so it is obvious on the page and in code review — never invent doctor details,
 * prices, testimonials, outcomes or home-visit availability.
 */

import type { IconName } from './icons';

export const TBD = '[TBD - confirm with clinic]';

export const clinic = {
  name: 'Geeta Krishna Physiotherapy',
  shortName: 'Geeta Krishna',
  monogram: 'GK',
  address: {
    street: 'B-1/127 Viram Khand',
    area: 'Gomti Nagar, near Deva Palace',
    city: 'Lucknow',
    region: 'UP',
    postalCode: '226010',
  },
  phone: {
    display: '+91 98386 81421',
    tel: '+919838681421',
    whatsapp: '919838681421',
  },
  rating: { value: '5.0', count: '467+' },
} as const;

export const hours = {
  days: 'Mon–Sat',
  sessions: ['9 AM–1 PM', '4 PM–8 PM'],
  closed: 'Sunday closed',
} as const;

/** Machine-readable hours for the live "Open now" pill. Always evaluated in clinic time (IST). */
export const schedule = {
  timeZone: 'Asia/Kolkata',
  days: [1, 2, 3, 4, 5, 6], // Mon–Sat (JS numbering: Sunday = 0)
  sessions: [
    ['09:00', '13:00'],
    ['16:00', '20:00'],
  ],
} as const;

/* ---------- Contact links ---------- */

export const GENERIC_MESSAGE =
  'Hello Geeta Krishna Physiotherapy,\n\nI found you through your website and would like to enquire about physiotherapy services.\n\nThank you.';

/** WhatsApp deep link with an optional pre-filled message. */
export function whatsappLink(message: string = GENERIC_MESSAGE): string {
  return `https://wa.me/${clinic.phone.whatsapp}?text=${encodeURIComponent(message)}`;
}

/** Contextual message for a specific concern, e.g. "physiotherapy for back pain". */
export function concernMessage(ask: string): string {
  return `Hello Geeta Krishna Physiotherapy,\n\nI found you through the website and would like to know more about ${ask}.\n\nThank you.`;
}

/** Message for a condition card, e.g. "…I'd like to ask about Back Pain." */
export function conditionMessage(title: string): string {
  return `Hello Geeta Krishna Physiotherapy, I found you through the website. I'd like to ask about ${title}.`;
}

/** Message for a doctor's "Book with" button — the visitor finishes the sentence. */
export function doctorBookMessage(name: string): string {
  return `Hello Geeta Krishna Physiotherapy, I'd like to book with ${name}. My concern is: `;
}

export const links = {
  whatsapp: whatsappLink(),
  tel: `tel:${clinic.phone.tel}`,
  // Built from the verified address, so it opens the correct place in Google Maps.
  // Swap for the clinic's Google Business Profile / review URLs once supplied.
  directions: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${clinic.name}, ${clinic.address.street}, ${clinic.address.area}, ${clinic.address.city} ${clinic.address.postalCode}`,
  )}`,
  // Keyless Google Maps embed for the clinic's listing (the iframe on the Visit section)
  embed: `https://www.google.com/maps?q=${encodeURIComponent(
    `${clinic.name}, Viram Khand, Gomti Nagar, ${clinic.address.city}`,
  )}&z=16&hl=en&output=embed`,
  reviews: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${clinic.name}, Gomti Nagar, ${clinic.address.city}`,
  )}`,
} as const;

/* ---------- Navigation ---------- */

export const nav = [
  { label: 'Book', href: '#book' },
  { label: 'Conditions', href: '#conditions' },
  { label: 'Doctors', href: '#doctors' },
  { label: 'How It Works', href: '#how-it-works' },
  { label: 'Reviews', href: '#reviews' },
  { label: 'FAQ', href: '#faq' },
  { label: 'Visit', href: '#visit' },
] as const;

/* ---------- Conditions / services (PRD §12) ---------- */

export interface Condition {
  title: string;
  /** Short, claim-free descriptor. */
  blurb: string;
  /** Used in the WhatsApp pre-fill: "…would like to know more about {ask}." */
  ask: string;
  icon: IconName;
}

export const conditions: Condition[] = [
  { title: 'Back Pain', blurb: 'Stiffness, aches and everyday movement.', ask: 'physiotherapy for back pain', icon: 'bone' },
  { title: 'Neck Pain', blurb: 'Neck and upper-back discomfort.', ask: 'physiotherapy for neck pain', icon: 'user-round' },
  { title: 'Shoulder Pain / Frozen Shoulder', blurb: 'Shoulder stiffness and restricted movement.', ask: 'physiotherapy for shoulder pain / frozen shoulder', icon: 'accessibility' },
  { title: 'Knee Pain / Arthritis', blurb: 'Knee and joint discomfort.', ask: 'physiotherapy for knee pain / arthritis', icon: 'footprints' },
  { title: 'Sciatica', blurb: 'Pain that travels down the leg.', ask: 'physiotherapy for sciatica', icon: 'zap' },
  { title: 'Sports Injuries', blurb: 'Strains, sprains and activity-related injuries.', ask: 'physiotherapy for sports injuries', icon: 'bandage' },
];

/** Marquee ticker between the hero and the conditions grid — all drawn from the verified service list. */
export const ticker = ['Back Pain', 'Sciatica', 'Frozen Shoulder', 'Slip Disc', 'Arthritis', 'Sports Injuries'] as const;

/* ---------- Why this approach (PRD §13) ---------- */

export const principles = [
  { n: '01', title: 'Assess First', body: 'Understand your concern before care is recommended.' },
  { n: '02', title: 'Individualised Care', body: 'Care is based on clinical assessment.' },
  { n: '03', title: 'Clear Next Steps', body: 'Progress and next steps are discussed with you.' },
  { n: '04', title: 'Local & Accessible', body: 'Gomti Nagar, Lucknow.' },
] as const;

/* ---------- Doctors (PRD §14) — unknown details stay TBD ---------- */

export const doctors = [
  {
    n: '01',
    slot: 'doctor-sandeep',
    name: 'Dr. Sandeep Tiwari',
    short: 'Dr. Sandeep',
    initials: 'ST',
    qualification: 'MPT (PT)',
    role: 'Clinic Lead',
    specialisation: TBD,
    bio: '[TBD - clinic approval]',
  },
  {
    n: '02',
    slot: 'doctor-mahesh',
    name: 'Dr. Mahesh Tiwari',
    short: 'Dr. Mahesh',
    initials: 'MT',
    qualification: 'MPT (PT)',
    role: 'Clinic Lead',
    specialisation: TBD,
    bio: '[TBD - clinic approval]',
  },
] as const;

/* ---------- Clinic gallery (PRD §15) ----------
 * Photos are picked up by filename from src/assets/clinic/ (gallery-1, gallery-2, …). To add one, drop
 * the file in and add a line here with a plain description of what it shows. Wide photographs (1000px+)
 * go into the large swipeable viewer in the order listed; smaller ones sit in the "treatment sessions"
 * row beneath it at their own size. Slots still waiting on a photo are listed in `galleryPending` and
 * shown as "coming soon".
 */

export const gallery = [
  { slot: 'gallery-1', label: 'Treatment session', alt: 'A physiotherapist in a white coat treating a patient lying on a couch while a colleague looks on from behind' },
  { slot: 'gallery-2', label: 'Treatment area', alt: 'A therapist standing beside a patient lying face down on a wooden treatment couch, with other couches behind' },
  { slot: 'gallery-3', label: 'Treatment session', alt: 'A masked therapist working with a patient lying on a couch in the treatment area' },
  { slot: 'gallery-4', label: 'The treatment room', alt: 'The treatment room, with patients resting on wooden couches, staff in white coats attending to them and blue curtains behind' },
  { slot: 'gallery-5', label: 'Therapist with patient', alt: 'A therapist in a white coat standing beside a patient lying on a couch, with a second patient and a staff member seated behind' },
  { slot: 'gallery-6', label: 'Several sessions at once', alt: 'A therapist working on a patient lying face down while other patients rest on couches with electrotherapy leads attached' },
  { slot: 'gallery-7', label: 'Hands-on treatment', alt: 'A therapist in a white coat treating a patient’s back in the treatment room, with other patients on couches beside her' },
] as const;

export const galleryPending = ['reception', 'equipment'] as const;

/** Joint photo shown with the doctors. Who is pictured is for the clinic to confirm — see caption. */
export const doctorsPhoto = {
  slot: 'doctors-together',
  alt: 'Two men in white shirts standing side by side in front of a flowering plant',
  caption: '[TBD - confirm who is pictured]',
} as const;

/* ---------- How it works (PRD §16) ---------- */

export const steps = [
  { n: '01', title: 'Assess', body: 'Share your concern and have it assessed by the clinic’s physiotherapists.' },
  { n: '02', title: 'Treat', body: 'Receive individualised care based on your assessment.' },
  { n: '03', title: 'Review', body: 'Progress is reviewed and the next steps are discussed with you.' },
] as const;

/* ---------- Reviews (PRD §17) ----------
 * Only add reviews the clinic has approved for republishing, with attribution. Never fabricate.
 * These are the fallback cards: they render whenever live Google reviews are not configured or fail to
 * load (see src/scripts/google-reviews.ts), so the section is never empty.
 */
export interface Review {
  quote: string;
  author: string;
  source?: string;
}
export const reviews: Review[] = [
  {
    quote:
      'Best physiotherapy centre in Gomtinagar. Nice behaviour of doctor Sandeep Tiwari and his staff. Actual diagnosis and proper treatment was done by Dr Tiwari only — within 3 days he became quite normal.',
    author: 'Advocate V Tripathi',
  },
  {
    quote: 'Staff behaviour is very polite. Neat and clean place, and you can feel relief from the first day.',
    author: 'Garima Pandey',
  },
  {
    quote: 'Very nice and soft-spoken staff, highly dedicated in work. Very clean and disciplined premises.',
    author: 'Amit Kumar',
  },
];

/* ---------- FAQ (PRD §20) ----------
 * `confirmed: false` answers are shown as TBD and excluded from FAQPage structured data.
 */

export interface Faq {
  q: string;
  a: string;
  confirmed: boolean;
}

export const faqs: Faq[] = [
  {
    q: 'What conditions do you provide physiotherapy for?',
    a: 'The clinic provides physiotherapy for back pain, neck pain, shoulder pain / frozen shoulder, knee pain / arthritis, hip pain, sciatica, slip disc, sports injuries and post-surgical rehabilitation. It also offers therapeutic exercise, balance and fall prevention, heat therapy and consultation. Each concern is assessed individually before care is recommended.',
    confirmed: true,
  },
  {
    q: 'How do I contact the clinic?',
    a: `You can message the clinic on WhatsApp or call ${clinic.phone.display}. Tell them what you’re experiencing and they will help you with the next step.`,
    confirmed: true,
  },
  {
    q: 'What are the clinic timings?',
    a: 'Monday to Saturday, 9 AM–1 PM and 4 PM–8 PM. The clinic is closed on Sunday.',
    confirmed: true,
  },
  {
    q: 'Where is the clinic located?',
    a: `${clinic.name}, ${clinic.address.street}, ${clinic.address.area}, ${clinic.address.city}, ${clinic.address.region} ${clinic.address.postalCode}.`,
    confirmed: true,
  },
  {
    q: 'Do you treat sports injuries?',
    a: 'Yes — sports injuries are one of the concerns the clinic provides physiotherapy for. Message or call the clinic to discuss your situation.',
    confirmed: true,
  },
  { q: 'Do you offer home visits?', a: TBD, confirmed: false },
  { q: 'How long is a session?', a: TBD, confirmed: false },
];

/* ---------- SEO (PRD §34) ---------- */

export const seo = {
  title: 'Geeta Krishna Physiotherapy | Physiotherapist in Gomti Nagar, Lucknow',
  description:
    'Physiotherapy in Gomti Nagar, Lucknow by two MPT doctors. 5.0 rated from 460+ Google reviews. Back pain, sciatica, frozen shoulder, sports injuries. Book on WhatsApp.',
} as const;
