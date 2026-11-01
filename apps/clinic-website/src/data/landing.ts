/**
 * Search landing pages ("physiotherapy for X in Lucknow"). One entry = one page at /<slug>/ and one sitemap URL.
 *
 * Content rules (same as the home page, PRD §37): only what the clinic has confirmed — the conditions and services
 * listed in `site.ts`, the doctors' own descriptions, the clinic's three-step process. General descriptions of a
 * condition are plain-language and carry no promise, cure, timeline, price or outcome. Anything unconfirmed
 * (session length, fees, home visits) is left out rather than guessed.
 */

import { clinic, doctors, hours } from './site';

export interface LandingFaq {
  q: string;
  a: string;
}

export interface LandingPage {
  slug: string;
  kind: 'clinic' | 'speciality' | 'condition';
  /** Footer / related-link label */
  navLabel: string;
  title: string;
  description: string;
  h1: string;
  /** Answer-first paragraph: the sentence an assistant can quote on its own. */
  lead: string;
  aboutTitle: string;
  about: string[];
  listTitle: string;
  list: string[];
  /** Which doctors are introduced on the page */
  doctors: 'both' | 'sandeep' | 'mahesh';
  /** Name used in the page's Service structured data */
  serviceName: string;
  faqs: LandingFaq[];
  related: string[];
}

const place = 'Geeta Krishna Physiotherapy, B-1/127 Viram Khand, Gomti Nagar, near Deva Palace, Lucknow';
const when = `${hours.days}, ${hours.sessions.join(' and ')} (${hours.closed.toLowerCase()})`;

/** Questions every page answers, written once so they stay identical to the clinic's real process and timings. */
const common = (topic: string): LandingFaq[] => [
  {
    q: `What happens at the first visit for ${topic}?`,
    a: 'You share your concern and it is assessed by the clinic’s physiotherapists. Care is then based on that assessment, and your progress and next steps are discussed with you along the way.',
  },
  {
    q: 'How do I book, and when is the clinic open?',
    a: `Message the clinic on WhatsApp (${clinic.phone.whatsappDisplay}), call ${doctors.map((d) => `${d.name} on ${d.phone.display}`).join(' or ')}, or use the booking form on the website. The clinic is open ${when}.`,
  },
];

const condition = (
  slug: string,
  navLabel: string,
  topic: string,
  h1: string,
  description: string,
  about: string[],
  list: string[],
  opts: { doctors: 'both' | 'mahesh'; lead: string; related: string[] },
): LandingPage => ({
  slug,
  kind: 'condition',
  navLabel,
  title: `${h1} | Geeta Krishna Physiotherapy`,
  description,
  h1,
  lead: opts.lead,
  aboutTitle: `About ${topic}`,
  about,
  listTitle: 'What the assessment looks at',
  list,
  doctors: opts.doctors,
  serviceName: `Physiotherapy for ${topic}`,
  faqs: [
    {
      q: `Where can I get physiotherapy for ${topic} in Lucknow?`,
      a: `${place}. The clinic is led by two MPT (PT) physiotherapists, Dr. Sandeep Tiwari and Dr. Mahesh Tiwari, and provides physiotherapy for ${topic}.`,
    },
    ...common(topic),
  ],
  related: opts.related,
});

const assess = [
  'Where and when it hurts, and what makes it better or worse',
  'How the affected area moves',
  'Which everyday activities are affected',
  'Earlier treatment, and any scans or reports you bring',
];

export const landingPages: LandingPage[] = [
  {
    slug: 'physiotherapy-in-gomti-nagar-lucknow',
    kind: 'clinic',
    navLabel: 'Physiotherapy in Gomti Nagar',
    title: 'Physiotherapy Clinic in Gomti Nagar, Lucknow | Geeta Krishna Physiotherapy',
    description:
      'Geeta Krishna Physiotherapy, Viram Khand, Gomti Nagar, Lucknow. Two MPT (PT) physiotherapists for neuro and ortho care. Open Mon–Sat. Book on WhatsApp.',
    h1: 'Physiotherapy clinic in Gomti Nagar, Lucknow',
    lead: `Geeta Krishna Physiotherapy is a physiotherapy clinic at B-1/127 Viram Khand, Gomti Nagar, near Deva Palace, Lucknow. It is led by two MPT (PT) physiotherapists, Dr. Sandeep Tiwari (neuro) and Dr. Mahesh Tiwari (ortho), and is open ${when}.`,
    aboutTitle: 'A local physiotherapy clinic',
    about: [
      'The clinic treats a range of orthopaedic and neurological concerns. Every concern is assessed individually before care is recommended, so the plan fits you rather than the diagnosis on a form.',
      'Besides physiotherapy for specific conditions, the clinic offers therapeutic exercise, balance and fall prevention, heat therapy and consultation.',
    ],
    listTitle: 'Conditions the clinic provides physiotherapy for',
    list: [
      'Back pain',
      'Neck pain',
      'Shoulder pain / frozen shoulder',
      'Knee pain / arthritis',
      'Hip pain',
      'Sciatica',
      'Slip disc',
      'Sports injuries',
      'Post-surgical rehabilitation',
      'Neurological conditions such as stroke, paralysis, Parkinson’s and spinal cord injuries',
    ],
    doctors: 'both',
    serviceName: 'Physiotherapy in Gomti Nagar, Lucknow',
    faqs: [
      {
        q: 'Which physiotherapy clinic is in Gomti Nagar, Lucknow?',
        a: `${place}, ${clinic.address.postalCode}. It is led by two MPT (PT) physiotherapists and is open ${when}.`,
      },
      {
        q: 'What conditions does the clinic provide physiotherapy for?',
        a: 'Back pain, neck pain, shoulder pain / frozen shoulder, knee pain / arthritis, hip pain, sciatica, slip disc, sports injuries, post-surgical rehabilitation and neurological conditions such as stroke, paralysis, Parkinson’s and spinal cord injuries.',
      },
      ...common('physiotherapy'),
    ],
    related: ['neuro-physiotherapy-lucknow', 'orthopaedic-physiotherapy-lucknow', 'back-pain-physiotherapy-lucknow'],
  },
  {
    slug: 'neuro-physiotherapy-lucknow',
    kind: 'speciality',
    navLabel: 'Neuro physiotherapy',
    title: 'Neuro Physiotherapy in Lucknow | Stroke & Paralysis Rehab | Geeta Krishna',
    description:
      'Neurological rehabilitation in Gomti Nagar, Lucknow with Dr. Sandeep Tiwari, MPT (PT): stroke, paralysis, Parkinson’s, spinal cord injury. Book on WhatsApp.',
    h1: 'Neuro physiotherapy in Lucknow',
    lead: 'Dr. Sandeep Tiwari, MPT (PT), is the neuro specialist at Geeta Krishna Physiotherapy in Gomti Nagar, Lucknow. He specialises in the physiotherapy management of neurological conditions such as stroke, paralysis, Parkinson’s, spinal cord injuries and other neuro-rehabilitation needs.',
    aboutTitle: 'What neurological rehabilitation involves',
    about: [
      'Neurological physiotherapy supports people whose movement, balance or strength has been affected by a condition of the brain, spinal cord or nerves. The focus is on helping you move and manage everyday activities as safely and independently as possible.',
      'Because every neurological condition and every person is different, the clinic begins with an individual assessment and bases the plan on it.',
    ],
    listTitle: 'Neurological needs the clinic provides physiotherapy for',
    list: ['Stroke', 'Paralysis', 'Parkinson’s disease', 'Spinal cord injuries', 'Other neuro-rehabilitation needs', 'Balance and fall prevention'],
    doctors: 'sandeep',
    serviceName: 'Neurological physiotherapy and rehabilitation',
    faqs: [
      {
        q: 'Is there a neuro physiotherapist in Lucknow?',
        a: 'Yes. Dr. Sandeep Tiwari, MPT (PT), is the neuro specialist at Geeta Krishna Physiotherapy, B-1/127 Viram Khand, Gomti Nagar, Lucknow.',
      },
      {
        q: 'Does the clinic provide physiotherapy after a stroke or for paralysis?',
        a: 'Yes. Physiotherapy management of stroke, paralysis, Parkinson’s, spinal cord injuries and other neuro-rehabilitation needs is Dr. Sandeep Tiwari’s speciality. Each person is assessed individually, and no result is guaranteed.',
      },
      ...common('neurological rehabilitation'),
    ],
    related: ['physiotherapy-in-gomti-nagar-lucknow', 'orthopaedic-physiotherapy-lucknow'],
  },
  {
    slug: 'orthopaedic-physiotherapy-lucknow',
    kind: 'speciality',
    navLabel: 'Orthopaedic physiotherapy',
    title: 'Orthopaedic Physiotherapy in Lucknow | Joint & Back Pain | Geeta Krishna',
    description:
      'Orthopaedic and musculoskeletal physiotherapy in Gomti Nagar, Lucknow with Dr. Mahesh Tiwari, MPT (PT): back, neck, joint pain, arthritis, post-surgery rehab.',
    h1: 'Orthopaedic physiotherapy in Lucknow',
    lead: 'Dr. Mahesh Tiwari, MPT (PT), is the ortho specialist at Geeta Krishna Physiotherapy in Gomti Nagar, Lucknow. He specialises in the physiotherapy management of orthopaedic and musculoskeletal conditions such as back and neck pain, joint pain, arthritis, post-surgery rehabilitation and sports injuries.',
    aboutTitle: 'What orthopaedic physiotherapy involves',
    about: [
      'Orthopaedic physiotherapy looks at problems of the bones, joints, muscles and spine: the aches, stiffness and restricted movement that get in the way of walking, working, exercising or sleeping.',
      'The clinic starts by understanding your concern, assesses how you move, and bases care on that assessment. Progress is reviewed and next steps are discussed with you.',
    ],
    listTitle: 'Orthopaedic and musculoskeletal concerns the clinic provides physiotherapy for',
    list: ['Back pain', 'Neck pain', 'Joint pain', 'Arthritis', 'Post-surgery rehabilitation', 'Sports injuries', 'Shoulder pain / frozen shoulder', 'Sciatica and slip disc'],
    doctors: 'mahesh',
    serviceName: 'Orthopaedic and musculoskeletal physiotherapy',
    faqs: [
      {
        q: 'Is there an orthopaedic physiotherapist in Lucknow?',
        a: 'Yes. Dr. Mahesh Tiwari, MPT (PT), is the ortho specialist at Geeta Krishna Physiotherapy, B-1/127 Viram Khand, Gomti Nagar, Lucknow.',
      },
      {
        q: 'Do you provide physiotherapy after surgery?',
        a: 'Yes. Post-surgery rehabilitation is among the orthopaedic needs the clinic provides physiotherapy for. Your plan is based on your assessment, and you should keep following your surgeon’s advice.',
      },
      ...common('orthopaedic physiotherapy'),
    ],
    related: ['physiotherapy-in-gomti-nagar-lucknow', 'back-pain-physiotherapy-lucknow', 'knee-pain-physiotherapy-lucknow'],
  },
  condition(
    'back-pain-physiotherapy-lucknow',
    'Back pain',
    'back pain',
    'Back pain physiotherapy in Lucknow',
    'Physiotherapy for back pain in Gomti Nagar, Lucknow. Assessment-led care from MPT (PT) physiotherapists at Geeta Krishna Physiotherapy. Book on WhatsApp.',
    [
      'Back pain is discomfort in the lower, middle or upper back. It can make sitting, bending, lifting and getting up from a chair stiff or painful, and the cause is not always obvious.',
      'That is why the clinic starts with an assessment, and recommends care only once your concern is understood.',
    ],
    assess,
    {
      doctors: 'mahesh',
      lead: 'Geeta Krishna Physiotherapy in Gomti Nagar, Lucknow provides physiotherapy for back pain. Dr. Mahesh Tiwari, MPT (PT), the clinic’s ortho specialist, works with back and neck pain, and every patient is assessed individually before care is recommended.',
      related: ['orthopaedic-physiotherapy-lucknow', 'sciatica-physiotherapy-lucknow', 'neck-pain-physiotherapy-lucknow'],
    },
  ),
  condition(
    'neck-pain-physiotherapy-lucknow',
    'Neck pain',
    'neck pain',
    'Neck pain physiotherapy in Lucknow',
    'Physiotherapy for neck and upper-back pain in Gomti Nagar, Lucknow. Assessment-led care from MPT (PT) physiotherapists. Book on WhatsApp.',
    [
      'Neck pain and upper-back discomfort can show up as stiffness, difficulty turning the head, or an ache that builds through the day.',
      'The clinic assesses the neck and the areas around it before recommending care, so the plan is based on what is actually happening for you.',
    ],
    assess,
    {
      doctors: 'mahesh',
      lead: 'Geeta Krishna Physiotherapy in Gomti Nagar, Lucknow provides physiotherapy for neck pain. Dr. Mahesh Tiwari, MPT (PT), the clinic’s ortho specialist, works with back and neck pain, and care is based on an individual assessment.',
      related: ['back-pain-physiotherapy-lucknow', 'frozen-shoulder-physiotherapy-lucknow', 'orthopaedic-physiotherapy-lucknow'],
    },
  ),
  condition(
    'frozen-shoulder-physiotherapy-lucknow',
    'Shoulder pain / frozen shoulder',
    'shoulder pain / frozen shoulder',
    'Frozen shoulder physiotherapy in Lucknow',
    'Physiotherapy for shoulder pain and frozen shoulder in Gomti Nagar, Lucknow. Assessment-led care from MPT (PT) physiotherapists. Book on WhatsApp.',
    [
      'Frozen shoulder is stiffness and restricted movement in the shoulder. It can make lifting the arm, reaching behind the back, dressing or sleeping on that side difficult.',
      'The clinic assesses how the shoulder moves and what limits it, and bases care on that assessment.',
    ],
    assess,
    {
      doctors: 'both',
      lead: 'Geeta Krishna Physiotherapy in Gomti Nagar, Lucknow provides physiotherapy for shoulder pain and frozen shoulder. The clinic’s MPT (PT) physiotherapists assess each shoulder individually before recommending care.',
      related: ['neck-pain-physiotherapy-lucknow', 'orthopaedic-physiotherapy-lucknow', 'sports-injury-physiotherapy-lucknow'],
    },
  ),
  condition(
    'knee-pain-physiotherapy-lucknow',
    'Knee pain / arthritis',
    'knee pain / arthritis',
    'Knee pain and arthritis physiotherapy in Lucknow',
    'Physiotherapy for knee pain and arthritis in Gomti Nagar, Lucknow. Assessment-led care from MPT (PT) physiotherapists. Book on WhatsApp.',
    [
      'Knee pain and arthritis can make stairs, walking, sitting on the floor and getting up from a chair uncomfortable, and often affect other joints and everyday routines too.',
      'The clinic assesses the knee and how you use it day to day, and bases care on that assessment.',
    ],
    assess,
    {
      doctors: 'mahesh',
      lead: 'Geeta Krishna Physiotherapy in Gomti Nagar, Lucknow provides physiotherapy for knee pain and arthritis. Dr. Mahesh Tiwari, MPT (PT), the clinic’s ortho specialist, works with joint pain and arthritis, and care is based on an individual assessment.',
      related: ['orthopaedic-physiotherapy-lucknow', 'back-pain-physiotherapy-lucknow', 'sports-injury-physiotherapy-lucknow'],
    },
  ),
  condition(
    'sciatica-physiotherapy-lucknow',
    'Sciatica',
    'sciatica',
    'Sciatica physiotherapy in Lucknow',
    'Physiotherapy for sciatica in Gomti Nagar, Lucknow. Assessment-led care from MPT (PT) physiotherapists at Geeta Krishna Physiotherapy. Book on WhatsApp.',
    [
      'Sciatica is pain that travels from the lower back or buttock down the leg, sometimes with tingling or numbness. It has different possible causes, so it is worth having it properly assessed.',
      'The clinic assesses your back, hips and legs, and bases care on what the assessment shows.',
    ],
    assess,
    {
      doctors: 'both',
      lead: 'Geeta Krishna Physiotherapy in Gomti Nagar, Lucknow provides physiotherapy for sciatica. The clinic’s MPT (PT) physiotherapists assess each patient individually before care is recommended.',
      related: ['back-pain-physiotherapy-lucknow', 'orthopaedic-physiotherapy-lucknow', 'physiotherapy-in-gomti-nagar-lucknow'],
    },
  ),
  condition(
    'sports-injury-physiotherapy-lucknow',
    'Sports injuries',
    'sports injuries',
    'Sports injury physiotherapy in Lucknow',
    'Physiotherapy for sports injuries, strains and sprains in Gomti Nagar, Lucknow with MPT (PT) physiotherapists. Book on WhatsApp.',
    [
      'Sports and activity injuries include strains, sprains and other injuries from exercise, training or play. Getting a new or recurring injury assessed early helps decide what kind of care you need.',
      'The clinic assesses the injury and how it affects your movement, and bases care on that assessment.',
    ],
    assess,
    {
      doctors: 'mahesh',
      lead: 'Geeta Krishna Physiotherapy in Gomti Nagar, Lucknow provides physiotherapy for sports injuries. Dr. Mahesh Tiwari, MPT (PT), the clinic’s ortho specialist, works with sports injuries, and care is based on an individual assessment.',
      related: ['orthopaedic-physiotherapy-lucknow', 'knee-pain-physiotherapy-lucknow', 'frozen-shoulder-physiotherapy-lucknow'],
    },
  ),
  condition(
    'post-surgery-rehabilitation-lucknow',
    'Post-surgery rehabilitation',
    'post-surgery rehabilitation',
    'Post-surgery rehabilitation in Lucknow',
    'Post-surgical physiotherapy and rehabilitation in Gomti Nagar, Lucknow with MPT (PT) physiotherapists at Geeta Krishna Physiotherapy. Book on WhatsApp.',
    [
      'Rehabilitation after surgery helps you get moving again in a safe, guided way as you recover. What is right for you depends on the procedure and on your surgeon’s advice.',
      'Bring your surgery details and any reports to the assessment, and the clinic will base your care on them and on how you are moving.',
    ],
    [
      'The procedure you had and when',
      'Your surgeon’s instructions and any reports you bring',
      'How the area moves and what you can currently do',
      'Which everyday activities you want to get back to',
    ],
    {
      doctors: 'mahesh',
      lead: 'Geeta Krishna Physiotherapy in Gomti Nagar, Lucknow provides post-surgery rehabilitation. Dr. Mahesh Tiwari, MPT (PT), the clinic’s ortho specialist, works with post-surgery rehabilitation, and care is based on an individual assessment and your surgeon’s advice.',
      related: ['orthopaedic-physiotherapy-lucknow', 'knee-pain-physiotherapy-lucknow', 'physiotherapy-in-gomti-nagar-lucknow'],
    },
  ),
];

export const landingBySlug = new Map(landingPages.map((p) => [p.slug, p]));
