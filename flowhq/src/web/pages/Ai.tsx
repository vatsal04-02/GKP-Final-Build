// The AI workspace: what the assistant decided and why, the mode it runs in, and the knowledge it answers from.
// The browser never talks to a model: the assistant runs in the backend's automation; this page reads its decisions.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Hand, Plus, Sparkles } from 'lucide-react';
import type { AiOverview, Automation, KnowledgeItem } from '@core/domain';
import { api, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { number, percent, relative } from '../lib/format';
import { cn } from '../lib/cn';
import { Page } from '../components/layout/Shell';
import { Badge, Button, Card, CardHeader, Input, Progress, Segmented, Select, Switch, Textarea } from '../components/ui/primitives';
import { EmptyState, ErrorState, Modal, Skeleton, SkeletonRows, useToast } from '../components/ui/feedback';
import { BarList } from '../components/data/charts';
import { Confidence, PriorityBadge } from '../components/data/widgets';

const MODE_HELP: Record<string, string> = {
  off: 'The assistant reads nothing and replies to nobody. Every message waits for a person.',
  draft: 'The assistant writes a reply and waits: a person reviews it in the inbox before anything is sent.',
  auto: 'The assistant answers on its own from the knowledge base, and hands anything sensitive to a person.',
};
const STATUS_LABEL: Record<string, { label: string; tone: 'blue' | 'amber' | 'red' | 'neutral' | 'green' }> = {
  replied: { label: 'Replied', tone: 'blue' }, drafted: { label: 'Draft', tone: 'blue' }, handed_off: { label: 'Handed off', tone: 'amber' }, no_reply: { label: 'No reply needed', tone: 'neutral' },
  skipped: { label: 'Skipped', tone: 'neutral' }, opted_out: { label: 'Opted out', tone: 'neutral' }, deferred: { label: 'Next morning', tone: 'neutral' }, failed: { label: 'Failed', tone: 'red' }, processing: { label: 'Processing', tone: 'blue' },
};

export default function Ai() {
  const { ws, t, tt, f, isAdmin } = useWs();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['ai', ws.id], queryFn: () => api<AiOverview>(wsPath(ws.id, '/ai')), refetchInterval: 30000 });
  const setMode = useMutation({
    mutationFn: (value: string) => api<Automation>(wsPath(ws.id, '/automations/ai_assistant'), { method: 'PATCH', body: { value } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ai', ws.id] }); qc.invalidateQueries({ queryKey: ['automations', ws.id] }); qc.invalidateQueries({ queryKey: ['conversations', ws.id] }); toast('ok', tt('{ai.name} mode updated')); },
    onError: (e: Error) => toast('bad', e.message),
  });
  const d = q.data;
  const handledRate = d && d.processed ? Math.round((d.handled / d.processed) * 1000) / 10 : null;
  return (
    <Page title={t('ai.name')} subtitle="Last 7 days. Every decision comes from the assistant that runs in your automations; nothing is sent from this page.">
      {q.error ? <Card><ErrorState error={q.error} retry={() => q.refetch()} /></Card> : (
        <div className="space-y-5">
          <Card className="ai-tint relative overflow-hidden border-blue/25 p-5">
            <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-blue/20 blur-3xl" />
            <div className="relative flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-bright to-blue text-white shadow-glow"><Sparkles className="h-5 w-5" /></span>
                <div>
                  <h2 className="text-[15px] font-semibold">Mode</h2>
                  <p className="mt-0.5 max-w-xl text-[13px] text-fg-2">{d?.mode ? MODE_HELP[d.mode.value] : ' '}</p>
                </div>
              </div>
              {!d ? <Skeleton className="h-9 w-48" /> : d.mode ? (
                <div className="flex flex-col items-end gap-1">
                  <Segmented value={d.mode.value} onChange={(v) => d.mode!.editable && v !== d.mode!.value && setMode.mutate(v)} options={d.mode.options} />
                  {!d.mode.editable && <span className="text-[11.5px] text-muted">Only an admin can change the mode</span>}
                </div>
              ) : null}
            </div>
          </Card>

          <section aria-label="Assistant numbers" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi label="Messages read" value={d ? number(f, d.processed) : null} />
            <Kpi label="Handled without a person" value={d ? (handledRate === null ? '—' : percent(f, handledRate)) : null} blue sub={d ? `${number(f, d.handled)} messages` : undefined} />
            <Kpi label="Handed to a person" value={d ? number(f, d.handoffs) : null} amber={!!d?.handoffs} />
            <Kpi label="Answered next morning" value={d ? number(f, d.deferred) : null} />
            <Kpi label="Failed" value={d ? number(f, d.failed) : null} red={!!d?.failed} />
            <Card className="p-4"><div className="text-[12.5px] text-fg-2">Average confidence</div>{!d ? <Skeleton className="mt-3 h-6 w-20" /> : <div className="mt-3"><div className="num mb-2 text-[24px] font-semibold leading-none">{d.avgConfidence === null ? '—' : `${Math.round(d.avgConfidence * 100)}%`}</div>{d.avgConfidence !== null && <Progress value={d.avgConfidence * 100} />}</div>}</Card>
          </section>

          <div className="grid gap-5 xl:grid-cols-3">
            <Card>
              <CardHeader title="What people asked about" subtitle="Intent the assistant recognised" />
              <div className="px-5 pb-5 pt-3">{!d ? <SkeletonRows rows={4} className="p-0" /> : <BarList items={d.intents.slice(0, 8).map((i) => ({ label: i.intent.replace(/_/g, ' '), value: i.count }))} format={(n) => number(f, n)} empty="No messages in the last 7 days" />}</div>
            </Card>
            <Card>
              <CardHeader title={tt('{contact.plural} by stage')} subtitle="How the assistant rated interest" />
              <div className="px-5 pb-5 pt-3">{!d ? <SkeletonRows rows={4} className="p-0" /> : <BarList items={d.stages.map((s) => ({ label: s.stage === 'not_rated' ? 'Not rated' : t(`contactStage.${s.stage}`), value: s.count }))} format={(n) => number(f, n)} />}</div>
            </Card>
            <Card>
              <CardHeader title="Waiting for a person" subtitle="Hand-offs not yet resolved" icon={<Hand className="h-4 w-4 !text-warn" />} />
              <div className="px-3 pb-3 pt-2">
                {!d ? <SkeletonRows rows={4} className="p-2" /> : d.recentHandoffs.length ? d.recentHandoffs.map((h) => (
                  <Link key={h.conversationId} to={`/w/${ws.id}/inbox/${h.conversationId}`} className="flex items-start gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-2">
                    <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', h.priority === 'urgent' ? 'bg-bad' : 'bg-warn')} />
                    <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-[13px] font-medium">{h.contactName || t('contact.singular')}</span>{h.priority !== 'normal' && <PriorityBadge p={h.priority} />}</div><p className="truncate text-[12px] text-fg-2">{h.reason || 'Needs a person'}</p></div>
                    <span className="shrink-0 text-[11.5px] text-muted">{relative(h.at)}</span>
                  </Link>
                )) : <EmptyState className="py-8" icon={<Hand className="h-5 w-5" />} title="Nobody is waiting" />}
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader title="Recent decisions" subtitle="What the assistant decided for each incoming message, with its reason" icon={<Sparkles className="h-4 w-4" />} />
            <div className="px-2 pb-2 pt-2">
              {!d ? <SkeletonRows rows={5} /> : !d.recentDecisions.length ? <EmptyState className="py-10" icon={<Sparkles className="h-5 w-5" />} title="No decisions yet" body={`They appear as soon as messages arrive with the mode set to Draft or Auto.`} /> : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-[13px]">
                    <thead><tr className="text-[11.5px] uppercase tracking-wide text-muted"><th className="px-3 py-2 font-medium">Message</th><th className="px-3 py-2 font-medium">Intent</th><th className="px-3 py-2 font-medium">Decision</th><th className="px-3 py-2 font-medium">Confidence</th><th className="px-3 py-2 font-medium">When</th></tr></thead>
                    <tbody>
                      {d.recentDecisions.map((m) => {
                        const st = STATUS_LABEL[m.ai?.status || ''] || { label: m.ai?.status || '—', tone: 'neutral' as const };
                        return (
                          <tr key={m.id} className="border-t border-line/60 align-top hover:bg-surface-2/60">
                            <td className="max-w-[340px] px-3 py-2.5"><Link to={`/w/${ws.id}/inbox/${m.conversationId}`} className="block hover:text-blue-soft"><span className="text-[12px] text-muted">{m.author.name}</span><p className="line-clamp-2 text-fg">{m.body}</p></Link>{m.ai?.reason && <p className="mt-1 line-clamp-2 text-[12px] text-fg-2"><span className="text-blue-soft">Why: </span>{m.ai.reason}</p>}</td>
                            <td className="px-3 py-2.5 text-fg-2">{m.ai?.intent ? m.ai.intent.replace(/_/g, ' ') : '—'}</td>
                            <td className="px-3 py-2.5"><Badge tone={st.tone}>{st.label}</Badge>{m.ai?.action && <div className="mt-1 text-[11.5px] text-muted">{m.ai.action.replace(/_/g, ' ')}</div>}</td>
                            <td className="px-3 py-2.5"><Confidence value={m.ai?.confidence ?? null} /></td>
                            <td className="whitespace-nowrap px-3 py-2.5 text-[12px] text-muted">{relative(m.createdAt)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Card>

          <Knowledge categories={d?.knowledgeCategories || []} editable={isAdmin && ws.backend.capabilities.knowledgeEdit} />
        </div>
      )}
    </Page>
  );
}

function Kpi({ label, value, sub, blue, amber, red }: { label: string; value: string | null; sub?: string; blue?: boolean; amber?: boolean; red?: boolean }) {
  return (
    <Card className={cn('relative overflow-hidden p-4', blue && 'border-blue/25')}>
      {blue && <div className="pointer-events-none absolute -right-10 -top-10 h-24 w-24 rounded-full bg-blue/20 blur-2xl" />}
      <div className="text-[12.5px] text-fg-2">{label}</div>
      {value === null ? <Skeleton className="mt-3 h-6 w-16" /> : <div className={cn('num mt-3 text-[24px] font-semibold leading-none', blue && 'text-blue-bright', amber && 'text-warn', red && 'text-bad')}>{value}</div>}
      {sub && <div className="mt-2 text-[11.5px] text-muted">{sub}</div>}
    </Card>
  );
}

// ---------------------------------------------------------------- knowledge base
function Knowledge({ categories, editable }: { categories: string[]; editable: boolean }) {
  const { ws, tt } = useWs();
  const q = useQuery({ queryKey: ['knowledge', ws.id], queryFn: () => api<KnowledgeItem[]>(wsPath(ws.id, '/knowledge')) });
  const [cat, setCat] = useState('all');
  const [edit, setEdit] = useState<KnowledgeItem | 'new' | null>(null);
  const items = (q.data || []).filter((k) => cat === 'all' || k.category === cat);
  const used = [...new Set((q.data || []).map((k) => k.category).filter((c): c is string => !!c))];
  return (
    <Card>
      <CardHeader title="Knowledge base" subtitle={tt('What the assistant may tell {contact.plural|lower}. It answers only from active entries.')} icon={<BookOpen className="h-4 w-4" />}
        action={editable ? <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEdit('new')}>Add entry</Button> : undefined} />
      <div className="px-5 pb-5 pt-3">
        {used.length > 1 && <div className="mb-3"><Segmented size="sm" value={cat} onChange={setCat} options={[{ value: 'all', label: 'All', count: q.data?.length }, ...used.map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1), count: q.data!.filter((k) => k.category === c).length }))]} /></div>}
        {q.error ? <ErrorState error={q.error} retry={() => q.refetch()} /> : q.isLoading ? <SkeletonRows rows={3} className="p-0" /> : !items.length ? (
          <EmptyState className="py-8" icon={<BookOpen className="h-5 w-5" />} title="No entries yet" body="Add your prices, hours, location and policies so the assistant can answer from them." />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map((k) => (
              <button key={k.id} disabled={!editable} onClick={() => setEdit(k)} className={cn('rounded-xl border border-line bg-bg-2 p-4 text-left transition-colors enabled:hover:border-blue/30', !k.active && 'opacity-55')}>
                <div className="flex items-center justify-between gap-2"><span className="truncate text-[13.5px] font-medium">{k.title}</span>{k.category && <Badge>{k.category}</Badge>}</div>
                <p className="mt-1.5 line-clamp-3 text-[12.5px] leading-relaxed text-fg-2">{k.content}</p>
                {!k.active && <p className="mt-2 text-[11.5px] text-muted">Not used by the assistant</p>}
              </button>
            ))}
          </div>
        )}
      </div>
      {edit && <KnowledgeEditor item={edit === 'new' ? null : edit} categories={categories} onClose={() => setEdit(null)} />}
    </Card>
  );
}

function KnowledgeEditor({ item, categories, onClose }: { item: KnowledgeItem | null; categories: string[]; onClose: () => void }) {
  const { ws } = useWs();
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState(item?.title || '');
  const [category, setCategory] = useState(item?.category || '');
  const [content, setContent] = useState(item?.content || '');
  const [active, setActive] = useState(item ? item.active : true);
  const save = useMutation({
    mutationFn: () => api<KnowledgeItem>(wsPath(ws.id, item ? `/knowledge/${item.id}` : '/knowledge'), { method: item ? 'PATCH' : 'POST', body: { title, category, content, active } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['knowledge', ws.id] }); qc.invalidateQueries({ queryKey: ['ai', ws.id] }); qc.invalidateQueries({ queryKey: ['automations', ws.id] }); toast('ok', 'Knowledge saved'); onClose(); },
    onError: (e: Error) => toast('bad', e.message),
  });
  return (
    <Modal open onClose={onClose} label={item ? 'Edit knowledge entry' : 'New knowledge entry'}>
      <form className="space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <h2 className="text-base font-semibold">{item ? 'Edit entry' : 'New entry'}</h2>
        <label className="block"><span className="mb-1.5 block text-[12.5px] text-fg-2">Title</span><Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} autoFocus /></label>
        <label className="block"><span className="mb-1.5 block text-[12.5px] text-fg-2">Category</span>
          <Select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">None</option>{categories.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}</Select>
        </label>
        <label className="block"><span className="mb-1.5 block text-[12.5px] text-fg-2">What the assistant may say</span><Textarea value={content} onChange={(e) => setContent(e.target.value)} required maxLength={4000} rows={6} /></label>
        <div className="flex items-center justify-between rounded-lg border border-line bg-bg-2 px-3 py-2.5"><span className="text-[13px] text-fg-2">Used by the assistant</span><Switch checked={active} onChange={setActive} label="Used by the assistant" /></div>
        <div className="flex justify-end gap-2 pt-1"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={save.isPending} disabled={!title.trim() || !content.trim()}>Save</Button></div>
      </form>
    </Modal>
  );
}
