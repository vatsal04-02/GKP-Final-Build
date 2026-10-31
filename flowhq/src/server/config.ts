// Environment configuration of the FLOW HQ server (BFF). Every secret stays here, on the server.
import path from 'node:path';
import { isIndustry } from '../core/industries';
import type { IndustryKey } from '../core/domain';

export interface Config {
  port: number;
  demo: boolean;
  grist: { baseUrl: string; apiKey: string; registryDocId: string; leadsTable: string };
  timezone: string;
  locale: string;
  currency: string;
  defaultIndustry: IndustryKey;
  sessionSecret: string;
  secureCookies: boolean;
  usersFile: string;
  usersJson: string;
  trustProxy: boolean;
  auditOutboxDir: string;
  auditRequireVolume: boolean;
  auditBreakGlass: boolean;
  bookingTokensFile: string;
  bookingTokensJson: string;
  workspacesFile: string;
  clinicFile: string;
  staticDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const demo = /^(1|true|yes|on)$/i.test(env.FLOWHQ_DEMO || '');
  const industry = env.FLOWHQ_DEFAULT_INDUSTRY || 'clinic';
  const cfg: Config = {
    port: Number(env.PORT || 8787),
    demo,
    grist: {
      baseUrl: env.GRIST_BASE_URL || '',
      apiKey: env.GRIST_API_KEY || '',
      registryDocId: env.GRIST_REGISTRY_DOC_ID || '',
      leadsTable: env.GRIST_LEADS_TABLE || 'LEADS',
    },
    timezone: env.FLOWHQ_TIMEZONE || 'Asia/Kolkata',
    locale: env.FLOWHQ_LOCALE || 'en-IN',
    currency: env.FLOWHQ_CURRENCY || 'INR',
    defaultIndustry: isIndustry(industry) ? industry : 'clinic',
    sessionSecret: env.FLOWHQ_SESSION_SECRET || (demo ? 'demo-session-secret-not-for-production-use-0001' : ''),
    secureCookies: env.FLOWHQ_SECURE_COOKIES ? /^(1|true|yes|on)$/i.test(env.FLOWHQ_SECURE_COOKIES) : !demo,
    usersFile: env.FLOWHQ_USERS_FILE || path.resolve('config/users.json'),
    usersJson: env.FLOWHQ_USERS || '',
    trustProxy: !/^(0|false|no|off)$/i.test(env.FLOWHQ_TRUST_PROXY || ''),   // default true: production runs behind Caddy. Set false if FLOW HQ is ever reachable without a proxy.
    auditOutboxDir: env.FLOWHQ_AUDIT_OUTBOX_DIR || path.resolve('config/audit-outbox'),   // on the persistent flowhq_config volume
    auditRequireVolume: env.FLOWHQ_AUDIT_REQUIRE_VOLUME ? /^(1|true|yes|on)$/i.test(env.FLOWHQ_AUDIT_REQUIRE_VOLUME) : process.platform === 'linux' && env.NODE_ENV === 'production',   // refuse to run on the container's own (ephemeral) layer
    auditBreakGlass: /^(1|true|yes|on)$/i.test(env.FLOWHQ_AUDIT_BREAKGLASS || ''),   // emergency only: see docs/booking-operations.md
    bookingTokensFile: env.FLOWHQ_BOOKING_TOKENS_FILE || path.resolve('config/booking-tokens.json'),
    bookingTokensJson: env.FLOWHQ_BOOKING_TOKENS || '',
    workspacesFile: env.FLOWHQ_WORKSPACES_FILE || path.resolve('config/workspaces.json'),
    clinicFile: env.FLOWHQ_CLINIC_FILE || path.resolve('config/clinic.json'),
    staticDir: env.FLOWHQ_STATIC_DIR || path.resolve('dist/web'),
  };
  if (!cfg.demo) {
    const missing = [!cfg.grist.baseUrl && 'GRIST_BASE_URL', !cfg.grist.apiKey && 'GRIST_API_KEY', !cfg.grist.registryDocId && 'GRIST_REGISTRY_DOC_ID'].filter(Boolean);
    if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')} (or set FLOWHQ_DEMO=true for demo data)`);
    if (cfg.sessionSecret.length < 32) throw new Error('FLOWHQ_SESSION_SECRET must be at least 32 characters');
  }
  return cfg;
}
