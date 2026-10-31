import type { APIRoute } from 'astro';
import { aboutSummary, clinic, conditions, doctors, faqs, hours, seo } from '../data/site';

// Plain-text brief for AI assistants and answer engines (https://llmstxt.org). Built from the same data as the
// page, so the two can never disagree. Unconfirmed (TBD) facts are left out.
export const GET: APIRoute = ({ site }) => {
  const base = site ?? new URL(seo.siteUrl);
  const url = base.href;
  const { address } = clinic;

  const lines = [
    `# ${clinic.name}`,
    '',
    `> ${aboutSummary}`,
    '',
    '## Clinic details',
    `- Name: ${clinic.name}`,
    `- Address: ${address.street}, ${address.area}, ${address.city}, ${address.region} ${address.postalCode}, India`,
    `- Phone / WhatsApp: ${clinic.phone.display}`,
    `- Hours: ${hours.days}, ${hours.sessions.join(' and ')}. ${hours.closed}.`,
    `- Google rating: ${clinic.rating.value} from ${clinic.rating.count} reviews`,
    `- Website: ${url}`,
    '',
    '## Doctors',
    ...doctors.map((d) => `- ${d.name}, ${d.qualification} — ${d.role}. ${d.bio}`),
    '',
    '## Conditions treated',
    ...conditions.map((c) => `- ${c.title}`),
    '',
    '## Frequently asked questions',
    ...faqs.filter((f) => f.confirmed).flatMap((f) => [`### ${f.q}`, f.a, '']),
    '## Contact',
    `Message the clinic on WhatsApp (https://wa.me/${clinic.phone.whatsapp}) or call ${clinic.phone.display}.`,
    '',
  ];

  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
