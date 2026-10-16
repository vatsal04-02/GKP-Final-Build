// One contacts system for every industry. Columns and editable fields follow the backend's capabilities.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, MessageCircle, Search, Sparkles, Users } from 'lucide-react';
import type { Activity, Booking, Contact, ContactStatus } from '@core/domain';
import { api, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { dateTime, initials, money, relative } from '../lib/format';
import { cn } from '../lib/cn';
import { Page } from '../components/layout/Shell';
import { Avatar, Badge, Button, Card, Input, Segmented, Select, Textarea } from '../components/ui/primitives';
import { Drawer, EmptyState, ErrorState, SkeletonRows, useToast } from '../components/ui/feedback';
import { ActivityRow, AttentionBadge, StageDot } from '../components/data/widgets';

const STATUSES: ContactStatus[] = ['new', 'contacted', 'booked', 'converted', 'lost'];
const STATUS_TONE: Record<ContactStatus, 'blue' | 'neutral' | 'green' | 'amber'> = { new: 'blue', contacted: 'neutral', booked: 'green', converted: 'green', lost: 'neutral' };

export default function Contacts() {
  const { ws, t, tt } = useWs();
  const { contactId } = useParams();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | ContactStatus>('all');
  const [stage, setStage] = useState('');
  const [attention, setAttention] = useState(false);
  const list = useQuery({ queryKey: ['contacts', ws.id, q, status, stage, attention], queryFn: () => api<Contact[]>(wsPath(ws.id, `/contacts?q=${encodeURIComponent(q)}${status !== 'all' ? `&status=${status}` : ''}${stage ? `&stage=${stage}` : ''}${attention ? '&attention=1' : ''}`)), refetchInterval: 30000 });
  const fields = ws.backend.capabilities.contactFields;
  return (
    <Page title={t('contact.plural')} subtitle={list.data ? tt(`${list.data.length} {contact.plural|lower}`) : ' '} wide>
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <div className="w-full max-w-xs"><Input icon={<Search className="h-4 w-4" />} placeholder="Search name, number, interest" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /></div>
        <Segmented value={status} onChange={setStatus} options={[{ value: 'all', label: 'All' }, ...STATUSES.map((s) => ({ value: s, label: t(`contactStatus.${s}`) }))]} />
        {fields.includes('stage') && (
          <Select value={stage} onChange={(e) => setStage(e.target.value)} className="w-36" aria-label="Stage">
            <option value="">Any stage</option>{(['hot', 'warm', 'cold'] as const).map((s) => <option key={s} value={s}>{t(`contactStage.${s}`)}</option>)}<option value="not_rated">Not rated</option>
          </Select>
        )}
        <Button variant={attention ? 'subtle' : 'secondary'} icon={<AlertTriangle className="h-4 w-4" />} onClick={() => setAttention((a) => !a)} aria-pressed={attention}>Needs attention</Button>
      </div>
      <Card className="overflow-hidden">
        {list.isLoading ? <SkeletonRows rows={10} /> : list.error ? <ErrorState error={list.error} retry={() => list.refetch()} /> : !list.data?.length ? (
          <EmptyState icon={<Users className="h-5 w-5" />} title={tt('No {contact.plural|lower} found')} body={q || status !== 'all' || stage || attention ? 'Try clearing the filters.' : tt('New {contact.plural|lower} appear here automatically from your channels.')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-left text-[13px]">
              <thead><tr className="border-b border-line text-[11.5px] uppercase tracking-wide text-muted">
                <th className="px-4 py-2.5 font-medium">Name</th><th className="px-3 py-2.5 font-medium">Status</th>
                {fields.includes('stage') && <th className="px-3 py-2.5 font-medium">Stage</th>}
                {fields.includes('interest') && <th className="px-3 py-2.5 font-medium">{t('service.singular')}</th>}
                <th className="px-3 py-2.5 font-medium">Source</th><th className="px-3 py-2.5 font-medium">Owner</th>
                <th className="px-3 py-2.5 font-medium">Last activity</th>{fields.includes('nextActionAt') && <th className="px-3 py-2.5 font-medium">Next action</th>}
              </tr></thead>
              <tbody>
                {list.data.map((c) => (
                  <tr key={c.id} onClick={() => nav(`/w/${ws.id}/contacts/${c.id}`)} className={cn('cursor-pointer border-b border-line/60 transition-colors last:border-0 hover:bg-surface-2', c.id === contactId && 'bg-blue/[0.06]')}>
                    <td className="px-4 py-2.5"><div className="flex items-center gap-2.5"><Avatar text={initials(c.name)} size={30} /><div className="min-w-0"><div className="flex items-center gap-2"><span className="truncate font-medium text-fg">{c.name}</span>{c.attentionRequired && <AttentionBadge priority={c.priority} />}{c.optedOut && <Badge tone="red">Opted out</Badge>}</div><div className="truncate text-[12px] text-muted">{c.phone || c.email || '—'}</div></div></div></td>
                    <td className="px-3 py-2.5">{c.status ? <Badge tone={STATUS_TONE[c.status]}>{t(`contactStatus.${c.status}`)}</Badge> : '—'}</td>
                    {fields.includes('stage') && <td className="px-3 py-2.5"><StageDot stage={c.stage} /></td>}
                    {fields.includes('interest') && <td className="max-w-[200px] truncate px-3 py-2.5 text-fg-2">{c.interest || '—'}</td>}
                    <td className="px-3 py-2.5 text-fg-2">{c.source || '—'}</td>
                    <td className="px-3 py-2.5 text-fg-2">{c.owner || '—'}</td>
                    <td className="px-3 py-2.5 text-fg-2">{relative(c.lastActivityAt)}</td>
                    {fields.includes('nextActionAt') && <td className={cn('px-3 py-2.5', c.nextActionAt && Date.parse(c.nextActionAt) < Date.now() ? 'text-warn' : 'text-fg-2')}>{c.nextActionAt ? relative(c.nextActionAt) : '—'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <ContactDrawer id={contactId || null} onClose={() => nav(`/w/${ws.id}/contacts`)} />
    </Page>
  );
}

function ContactDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { ws, t, tt, f, has, automation } = useWs();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['contact', ws.id, id], queryFn: () => api<{ contact: Contact; bookings: Booking[]; activity: Activity[] }>(wsPath(ws.id, `/contacts/${id}`)), enabled: !!id });
  const caps = ws.backend.capabilities;
  const [draft, setDraft] = useState<{ status?: string; owner?: string; notes?: string; nextActionAt?: string }>({});
  useEffect(() => setDraft({}), [id]);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Contact>(wsPath(ws.id, `/contacts/${id}`), { method: 'PATCH', body }),
    onSuccess: () => { toast('ok', 'Saved'); setDraft({}); qc.invalidateQueries({ queryKey: ['contact', ws.id, id] }); qc.invalidateQueries({ queryKey: ['contacts', ws.id] }); },
    onError: (e) => toast('bad', (e as Error).message),
  });
  const c = q.data?.contact;
  const dirty = Object.keys(draft).length > 0;
  return (
    <Drawer open={!!id} onClose={onClose} width={560} title={c ? c.name : ' '} subtitle={c ? [c.phone, c.ref].filter(Boolean).join(' · ') : undefined}
      footer={c && caps.contactEditable.length ? <div className="flex justify-end gap-2"><Button variant="ghost" disabled={!dirty} onClick={() => setDraft({})}>Discard</Button><Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate({ ...draft, ...(draft.nextActionAt !== undefined ? { nextActionAt: draft.nextActionAt ? new Date(draft.nextActionAt).toISOString() : null } : {}) })}>Save changes</Button></div> : undefined}>
      {q.isLoading ? <SkeletonRows rows={6} /> : q.error ? <ErrorState error={q.error} retry={() => q.refetch()} /> : c && (
        <div className="space-y-5 p-5">
          <div className="flex flex-wrap items-center gap-2">
            {c.status && <Badge tone={STATUS_TONE[c.status]}>{t(`contactStatus.${c.status}`)}</Badge>}<StageDot stage={c.stage} />
            {c.attentionRequired && <AttentionBadge priority={c.priority} />}{c.optedOut && <Badge tone="red">Opted out</Badge>}
            {c.conversationId && <Link to={`/w/${ws.id}/inbox/${c.conversationId}`} className="ml-auto"><Button size="sm" variant="subtle" icon={<MessageCircle className="h-4 w-4" />}>Open conversation</Button></Link>}
          </div>
          {has('ai') && (c.aiSummary || c.interest || c.attentionReason) && (
            <section className="ai-tint rounded-xl border p-4">
              <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-blue-soft"><Sparkles className="h-3.5 w-3.5" />{tt('{ai.name} summary')}</div>
              {c.aiSummary && <p className="text-[13.5px] leading-relaxed text-fg">{c.aiSummary}</p>}
              <div className="mt-3 grid grid-cols-2 gap-3 text-[12.5px]">
                <div><div className="text-[11px] uppercase tracking-wide text-muted">{t('service.singular')}</div><div className="text-fg">{c.interest || '—'}</div></div>
                <div><div className="text-[11px] uppercase tracking-wide text-muted">Next action</div><div className="text-fg">{c.nextActionAt ? dateTime(f, c.nextActionAt) : '—'}</div></div>
                {c.attentionRequired && <div className="col-span-2"><div className="text-[11px] uppercase tracking-wide text-muted">Why a person is needed</div><div className="text-warn">{c.attentionReason || '—'}</div></div>}
              </div>
            </section>
          )}
          <section className="grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
            {caps.contactEditable.includes('status') ? (
              <label className="block"><span className="mb-1 block text-[11px] uppercase tracking-wide text-muted">Status</span>
                <Select value={draft.status ?? c.status ?? ''} onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}>{STATUSES.map((s) => <option key={s} value={s}>{t(`contactStatus.${s}`)}</option>)}</Select></label>
            ) : <Field k="Status" v={c.status ? t(`contactStatus.${c.status}`) : null} />}
            {caps.contactEditable.includes('owner') ? (
              <label className="block"><span className="mb-1 block text-[11px] uppercase tracking-wide text-muted">Owner</span><Input value={draft.owner ?? c.owner ?? ''} onChange={(e) => setDraft((d) => ({ ...d, owner: e.target.value }))} placeholder={t('staff.singular')} /></label>
            ) : <Field k="Owner" v={c.owner} />}
            {caps.contactEditable.includes('nextActionAt') && (
              <label className="col-span-2 block"><span className="mb-1 block text-[11px] uppercase tracking-wide text-muted">Next action</span>
                <Input type="datetime-local" value={draft.nextActionAt ?? (c.nextActionAt ? new Date(Date.parse(c.nextActionAt) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '')} onChange={(e) => setDraft((d) => ({ ...d, nextActionAt: e.target.value }))} /></label>
            )}
            <Field k="Source" v={c.source} /><Field k="Created" v={c.createdAt ? dateTime(f, c.createdAt) : null} />
            <Field k="First reply" v={c.firstResponseAt ? dateTime(f, c.firstResponseAt) : null} /><Field k="Last activity" v={relative(c.lastActivityAt)} />
            {caps.contactFields.includes('enquiry') && c.enquiry && <div className="col-span-2"><Field k="Enquiry" v={c.enquiry} /></div>}
            {caps.contactFields.includes('campaign') && c.campaign && <Field k="Campaign" v={c.campaign} />}
            {c.lostReason && <Field k="Lost reason" v={c.lostReason} />}
            {caps.contactEditable.includes('notes') && (
              <label className="col-span-2 block"><span className="mb-1 block text-[11px] uppercase tracking-wide text-muted">Notes</span><Textarea value={draft.notes ?? c.notes ?? ''} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} placeholder="Internal notes (not sent to anyone)" /></label>
            )}
          </section>
          {has('bookings') && (
            <section>
              <h3 className="label mb-2">{t('booking.plural')}</h3>
              {q.data!.bookings.length ? <ul className="divide-y divide-line rounded-xl border border-line">
                {q.data!.bookings.map((b) => <li key={b.id} className="flex items-center gap-3 px-3 py-2.5 text-[13px]"><div className="min-w-0 flex-1"><div className="truncate font-medium">{b.title || t('booking.singular')}</div><div className="text-[12px] text-muted">{dateTime(f, b.start)}{b.owner ? ` · ${b.owner}` : ''}</div></div>{b.value !== null && <span className="num text-[12px] text-fg-2">{money(f, b.value)}</span>}<Badge tone={b.status === 'completed' ? 'green' : b.status === 'no_show' ? 'amber' : b.status === 'cancelled' ? 'neutral' : 'blue'}>{t(`bookingStatus.${b.status}`)}</Badge></li>)}
              </ul> : <p className="text-[13px] text-muted">{tt('No {booking.plural|lower} yet.')}</p>}
            </section>
          )}
          <section>
            <h3 className="label mb-1">Timeline</h3>
            {q.data!.activity.length ? <div className="divide-y divide-line/60">{q.data!.activity.slice(0, 25).map((a) => <ActivityRow key={a.id} a={a} />)}</div> : <p className="text-[13px] text-muted">No activity yet.</p>}
            {c.escalated && <p className="mt-2 text-[12px] text-muted">{automation('speed_to_lead').name}: the team was alerted.</p>}
          </section>
        </div>
      )}
    </Drawer>
  );
}
function Field({ k, v }: { k: string; v: string | null }) {
  return <div><div className="mb-1 text-[11px] uppercase tracking-wide text-muted">{k}</div><div className={v ? 'text-fg' : 'text-muted'}>{v || '—'}</div></div>;
}
