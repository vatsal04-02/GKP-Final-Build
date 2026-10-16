// DEMO ONLY: plays the part of n8n's W10 (staff reply) every few seconds, using W10's own decision functions
// (cmStaffReplyCheck / cmStaffReplyResult from n8n/snippets/clinic-modules.js). Nothing is sent anywhere: a reply that W10 would
// send is marked sent with a fake message id. In production this file is not used; the real W10 in n8n does the work.
import type { GristRecord } from '../grist';
import { normalizePhone, sendGuard, staffReply } from '../adapters/autopilot/shared';

type Docs = Record<string, Record<string, GristRecord[]>>;
export function processStaffReplies(docs: Docs, nowMs = Date.now()) {
  let n = 0;
  for (const [doc, tables] of Object.entries(docs)) {
    if (!tables.Messages) continue;
    const settings: Record<string, unknown> = {};
    for (const r of tables.Settings || []) settings[String(r.fields.Key)] = r.fields.Value;
    for (const row of tables.Messages) {
      if (row.fields.Direction !== 'Out' || row.fields.Send !== true) continue;
      const conv = (tables.Conversations || []).find((c) => c.id === Number(row.fields.Conversation)) || null;
      const lead = conv ? (tables.LEADS || []).find((l) => l.id === Number(conv.fields.Lead)) || null : null;
      const check = staffReply.cmStaffReplyCheck(row, conv, lead, settings, nowMs, { normalizeIndianPhone: normalizePhone, decideSend: sendGuard.decideSend });
      const nowSec = Math.floor(nowMs / 1000);
      if (check.action === 'send') {
        Object.assign(row.fields, check.claim);
        const res = staffReply.cmStaffReplyResult(row.id, { sent: true, send_status: 'accepted', wa_message_id: `wamid.DEMO.${doc}.${row.id}`, decision: check.decision }, nowSec);
        Object.assign(row.fields, res.message_patch);
        if (res.conversation_patch && conv) Object.assign(conv.fields, res.conversation_patch);
        (tables.Run_Log ||= []).push({ id: Math.max(0, ...tables.Run_Log.map((r) => r.id)) + 1, fields: res.log as GristRecord['fields'] });
        n++;
      } else if (check.patch) {
        Object.assign(row.fields, check.patch);
        if (check.action === 'reject' && !/^already sent/.test(check.reason)) (tables.Run_Log ||= []).push({ id: Math.max(0, ...tables.Run_Log.map((r) => r.id)) + 1, fields: { Workflow: 'W10-staff-reply', Record: `message ${row.id} (staff reply not sent)`, Outcome: 'failed', Error: check.reason, At: nowSec } });
      }
    }
  }
  return n;
}
export function startStaffReplySimulator(docs: Docs, everyMs = 2500) {
  const t = setInterval(() => { try { processStaffReplies(docs); } catch (e) { console.error('demo W10 simulator:', (e as Error).message); } }, everyMs);
  t.unref();
  return t;
}
