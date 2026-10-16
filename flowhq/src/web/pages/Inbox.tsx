// The universal inbox. Channel-agnostic: a conversation has a channel key; the composer obeys the channel's reply window and
// sends through the backend's staff-reply path (never straight to a messaging provider).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Bot, Check, CheckCheck, Clock, Inbox as InboxIcon, Loader2, MessageSquareDashed, PauseCircle, PlayCircle, Search, Send, Sparkles, UserRound, UserRoundCheck } from 'lucide-react';
import type { ChannelKey, Contact, Conversation, Message } from '@core/domain';
import { api, ApiError, ws as wsPath } from '../lib/api';
import { useWs } from '../lib/workspace';
import { date, dateTime, initials, relative, time } from '../lib/format';
import { cn } from '../lib/cn';
import { Avatar, Badge, Button, Input, Segmented, StatusDot } from '../components/ui/primitives';
import { EmptyState, ErrorState, SkeletonRows, useToast } from '../components/ui/feedback';
import { AiBadge, AttentionBadge, Confidence, StageDot } from '../components/data/widgets';

const CHANNEL_LABEL: Record<ChannelKey, string> = { whatsapp: 'WhatsApp', website: 'Website', email: 'Email', instagram: 'Instagram', messenger: 'Messenger', sms: 'SMS' };
type Filter = 'all' | 'unread' | 'attention' | 'ai' | 'paused' | 'mine';
const label = (s: string | null) => (s ? s.replace(/_/g, ' ') : '—');

export default function Inbox() {
  const { ws, t } = useWs();
  const { conversationId } = useParams();
  const nav = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['conversations', ws.id, filter, q], queryFn: () => api<Conversation[]>(wsPath(ws.id, `/conversations?filter=${filter}&q=${encodeURIComponent(q)}`)), refetchInterval: 10000 });
  const all = useQuery({ queryKey: ['conversations', ws.id, 'all', ''], queryFn: () => api<Conversation[]>(wsPath(ws.id, '/conversations')), refetchInterval: 15000 });
  const counts = useMemo(() => {
    const c = all.data || [];
    return { all: c.length, unread: c.filter((x) => x.unread > 0).length, attention: c.filter((x) => x.attentionRequired).length, ai: c.filter((x) => x.aiActive && !x.attentionRequired).length, paused: c.filter((x) => x.automationPaused).length };
  }, [all.data]);
  return (
    <div className="flex h-[calc(100vh-56px)] min-h-[520px]">
      <section className={cn('flex w-full flex-col border-r border-line md:w-[340px] xl:w-[380px]', conversationId && 'hidden md:flex')} aria-label="Conversations">
        <div className="space-y-3 border-b border-line p-4">
          <div className="flex items-center justify-between"><h1 className="text-lg font-semibold tracking-tight">Inbox</h1>{counts.attention > 0 && <Badge tone="amber">{counts.attention} need a person</Badge>}</div>
          <Input icon={<Search className="h-4 w-4" />} placeholder="Search name, number or message" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search conversations" />
          <Segmented size="sm" value={filter} onChange={setFilter} options={[
            { value: 'all', label: 'All', count: counts.all }, { value: 'unread', label: 'Unread', count: counts.unread }, { value: 'attention', label: 'Attention', count: counts.attention },
            { value: 'ai', label: t('ai.short'), count: counts.ai }, { value: 'paused', label: 'Paused', count: counts.paused }, { value: 'mine', label: 'Mine' },
          ]} />
        </div>
        <div className="flex-1 overflow-y-auto">
          {list.isLoading ? <SkeletonRows rows={8} /> : list.error ? <ErrorState error={list.error} retry={() => list.refetch()} /> : !list.data?.length ? (
            <EmptyState icon={<InboxIcon className="h-5 w-5" />} title={filter === 'all' && !q ? 'No conversations yet' : 'Nothing here'} body={filter === 'all' && !q ? 'Messages appear here as soon as someone writes to you.' : 'Try another filter.'} />
          ) : (
            <ul>{list.data.map((c) => <ConversationItem key={c.id} c={c} active={c.id === conversationId} onOpen={() => nav(`/w/${ws.id}/inbox/${c.id}`)} />)}</ul>
          )}
        </div>
      </section>
      <section className={cn('min-w-0 flex-1', !conversationId && 'hidden md:block')}>
        {conversationId ? <Thread id={conversationId} key={conversationId} /> : <EmptyState className="h-full" icon={<MessageSquareDashed className="h-5 w-5" />} title="Pick a conversation" body="Replies you send here go out through your connected channel, inside its rules." />}
      </section>
    </div>
  );
}

function ConversationItem({ c, active, onOpen }: { c: Conversation; active: boolean; onOpen: () => void }) {
  const { tt } = useWs();
  return (
    <li>
      <button onClick={onOpen} className={cn('relative flex w-full gap-3 border-b border-line/60 px-4 py-3 text-left transition-colors', active ? 'bg-blue/[0.08]' : 'hover:bg-surface')} aria-current={active ? 'true' : undefined}>
        {active && <span className="absolute left-0 top-0 h-full w-[2px] bg-blue-bright shadow-[0_0_10px_rgb(var(--blue-bright))]" />}
        <Avatar text={initials(c.contactName)} size={36} tone={active ? 'blue' : 'neutral'} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn('truncate text-[13.5px]', c.unread ? 'font-semibold text-fg' : 'font-medium text-fg')}>{c.contactName}</span>
            <span className="ml-auto shrink-0 text-[11px] text-muted">{relative(c.lastMessageAt)}</span>
          </div>
          <p className={cn('mt-0.5 truncate text-[12.5px]', c.unread ? 'text-fg-2' : 'text-muted')}>{c.lastMessageDirection === 'out' && <span className="text-muted">You: </span>}{c.lastMessagePreview || '—'}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {c.attentionRequired && <AttentionBadge priority={c.priority} />}
            {!c.attentionRequired && c.aiActive && <AiBadge label={tt('{ai.short} active')} />}
            {c.automationPaused && <Badge icon={<PauseCircle className="h-3 w-3" />}>Paused</Badge>}
            {c.optedOut && <Badge tone="red">Opted out</Badge>}
            {c.unread > 0 && <span className="ml-auto flex items-center gap-1 text-[11px] font-medium text-blue-soft"><StatusDot tone="blue" />{c.unread}</span>}
          </div>
        </div>
      </button>
    </li>
  );
}

function Thread({ id }: { id: string }) {
  const { ws, t, tt, f, automation, has, me } = useWs();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['conversation', ws.id, id], queryFn: () => api<{ conversation: Conversation; messages: Message[]; contact: Contact | null }>(wsPath(ws.id, `/conversations/${id}`)), refetchInterval: (query) => (query.state.data?.messages.some((m) => m.status === 'pending' || m.status === 'queued') ? 2500 : 8000) });
  const caps = ws.backend.capabilities;
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Conversation>(wsPath(ws.id, `/conversations/${id}`), { method: 'PATCH', body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['conversation', ws.id, id] }); qc.invalidateQueries({ queryKey: ['conversations', ws.id] }); },
    onError: (e) => toast('bad', (e as Error).message),
  });
  const marked = useRef(false);
  useEffect(() => { if (q.data && q.data.conversation.unread > 0 && !marked.current) { marked.current = true; patch.mutate({ markRead: true }); } }, [q.data]);   // eslint-disable-line react-hooks/exhaustive-deps
  const end = useRef<HTMLDivElement>(null);
  const count = q.data?.messages.length || 0;
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [count]);
  if (q.isLoading) return <SkeletonRows rows={6} />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data) return null;
  const { conversation: c, messages, contact } = q.data;
  let lastDay = '';
  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <button className="rounded-lg p-1.5 text-fg-2 hover:bg-surface md:hidden" onClick={() => nav(`/w/${ws.id}/inbox`)} aria-label="Back"><ArrowLeft className="h-4 w-4" /></button>
          <Avatar text={initials(c.contactName)} size={36} tone="blue" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2"><h2 className="truncate text-[15px] font-semibold">{c.contactName}</h2><Badge>{CHANNEL_LABEL[c.channel]}</Badge></div>
            <p className="truncate text-[12px] text-fg-2">{c.contactPhone}{c.assignedTo ? ` · with ${c.assignedTo}` : ''}</p>
          </div>
          <div className="flex items-center gap-1.5">
            {caps.conversationEditable.includes('assignedTo') && !c.assignedTo && <Button size="sm" variant="ghost" icon={<UserRoundCheck className="h-4 w-4" />} onClick={() => patch.mutate({ assignedTo: me.user.name })} aria-label="Take it" title="Assign this conversation to me"><span className="hidden 2xl:inline">Take it</span></Button>}
            {caps.conversationEditable.includes('automationPaused') && (
              <Button size="sm" variant="ghost" icon={c.automationPaused ? <PlayCircle className="h-4 w-4" /> : <PauseCircle className="h-4 w-4" />} onClick={() => patch.mutate({ automationPaused: !c.automationPaused })} title={c.automationPaused ? 'Let automations and the assistant write again' : 'Stop automations and the assistant for this conversation'} aria-label={c.automationPaused ? 'Resume automations' : 'Pause automations'}><span className="hidden 2xl:inline">{c.automationPaused ? 'Resume automations' : 'Pause automations'}</span></Button>
            )}
            {c.attentionRequired && caps.conversationEditable.includes('resolveAttention') && <Button size="sm" variant="subtle" icon={<Check className="h-4 w-4" />} onClick={() => patch.mutate({ resolveAttention: true })}>Mark handled</Button>}
          </div>
        </header>
        {c.attentionRequired && (
          <div className={cn('mx-4 mt-3 flex items-start gap-2.5 rounded-lg border px-3 py-2 text-[13px]', c.priority === 'urgent' ? 'border-bad/30 bg-bad/10' : 'border-warn/30 bg-warn/10')}>
            <AlertTriangle className={cn('mt-0.5 h-4 w-4 shrink-0', c.priority === 'urgent' ? 'text-bad' : 'text-warn')} />
            <div><span className="font-medium text-fg">A person should reply.</span> <span className="text-fg-2">{c.attentionReason || tt('The {ai.name} handed this conversation over.')}</span></div>
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {!messages.length && <EmptyState icon={<MessageSquareDashed className="h-5 w-5" />} title="No messages yet" />}
          <div className="mx-auto max-w-3xl space-y-3">
            {messages.map((m) => {
              const day = m.createdAt ? date(f, m.createdAt) : '';
              const sep = day !== lastDay ? (lastDay = day) : null;
              return (
                <div key={m.id}>
                  {sep && <div className="my-4 flex items-center gap-3 text-[11px] text-muted"><span className="h-px flex-1 bg-line" />{sep}<span className="h-px flex-1 bg-line" /></div>}
                  <Bubble m={m} automationName={m.author.automationKey ? automation(m.author.automationKey).name : ''} aiName={t('ai.name')} showAi={has('ai')} />
                </div>
              );
            })}
            <div ref={end} />
          </div>
        </div>
        <Composer c={c} />
      </div>
      <ContextPanel c={c} contact={contact} />
    </div>
  );
}

function Bubble({ m, automationName, aiName, showAi }: { m: Message; automationName: string; aiName: string; showAi: boolean }) {
  const { f } = useWs();
  const out = m.direction === 'out';
  const who = m.author.kind === 'ai' ? aiName : m.author.kind === 'automation' ? automationName : m.author.kind === 'staff' ? m.author.name : m.author.kind === 'system' ? m.author.name : m.author.name;
  return (
    <div className={cn('flex animate-fade-up flex-col', out ? 'items-end' : 'items-start')}>
      <div className={cn('max-w-[78%] rounded-2xl border px-3.5 py-2.5 text-[13.5px] leading-relaxed',
        !out && 'rounded-bl-md border-line bg-surface text-fg',
        out && m.author.kind === 'ai' && 'ai-tint rounded-br-md text-fg',
        out && m.author.kind === 'staff' && 'rounded-br-md border-blue/25 bg-blue/[0.07] text-fg',
        out && (m.author.kind === 'automation' || m.author.kind === 'system') && 'rounded-br-md border-line bg-surface-2 text-fg-2',
        (m.status === 'failed' || m.status === 'needs_template') && 'border-bad/40')}>
        <p className="whitespace-pre-wrap break-words">{m.body}</p>
      </div>
      <div className={cn('mt-1 flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-muted', out ? 'justify-end' : '')}>
        {out && (m.author.kind === 'ai' ? <Sparkles className="h-3 w-3 text-blue-bright" /> : m.author.kind === 'automation' ? <Bot className="h-3 w-3" /> : <UserRound className="h-3 w-3" />)}
        {out && <span>{who}</span>}
        {m.author.testMode && <Badge className="h-[18px]">test mode</Badge>}
        <span title={m.createdAt || ''}>{time(f, m.createdAt)}</span>
        {out && <SendStatus m={m} />}
      </div>
      {showAi && m.ai && (m.ai.intent || m.ai.status) && (
        <div className="mt-1.5 flex max-w-[78%] flex-wrap items-center gap-2 rounded-lg border border-blue/20 bg-blue/[0.05] px-2.5 py-1.5 text-[11.5px]">
          <Sparkles className="h-3 w-3 text-blue-bright" />
          <span className="text-fg-2">Intent <span className="text-fg">{label(m.ai.intent)}</span></span>
          {m.ai.confidence !== null && <Confidence value={m.ai.confidence} />}
          {m.ai.status && <Badge tone={m.ai.status === 'handed_off' ? 'amber' : m.ai.status === 'failed' ? 'red' : 'blue'} className="h-[18px]">{label(m.ai.status)}</Badge>}
          {m.ai.status === 'drafted' && m.ai.reply && <span className="w-full text-fg-2">Draft: <span className="text-fg">{m.ai.reply}</span></span>}
          {m.ai.reason && m.ai.status !== 'replied' && <span className="w-full truncate text-muted" title={m.ai.reason}>{m.ai.reason}</span>}
        </div>
      )}
    </div>
  );
}
function SendStatus({ m: raw }: { m: Message }) {
  const { tt } = useWs();
  const m = raw.statusNote ? { ...raw, statusNote: tt(raw.statusNote) } : raw;   // notes may carry terminology tokens
  if (m.status === 'pending') return m.statusNote
    ? <span className="inline-flex items-center gap-1 text-warn" title={m.statusNote}><Clock className="h-3 w-3" />{m.statusNote.slice(0, 90)}</span>   // held by the backend (e.g. quiet hours)
    : <span className="inline-flex items-center gap-1 text-blue-soft"><Loader2 className="h-3 w-3 animate-spin" />queued: goes out within a minute</span>;
  if (m.status === 'queued') return <span className="inline-flex items-center gap-1 text-blue-soft"><Loader2 className="h-3 w-3 animate-spin" />sending</span>;
  if (m.status === 'sent' || m.status === 'delivered' || m.status === 'read') return <span className="inline-flex items-center gap-1 text-fg-2">{m.status === 'read' ? <CheckCheck className="h-3 w-3 text-blue-bright" /> : <Check className="h-3 w-3" />}{m.statusNote ? m.statusNote : ''}</span>;
  return <span className="inline-flex items-center gap-1 text-bad" title={m.statusNote || ''}><AlertTriangle className="h-3 w-3" />{m.status === 'needs_template' ? 'needs a template' : 'not sent'}{m.statusNote ? `: ${m.statusNote.slice(0, 90)}` : ''}</span>;
}

function Composer({ c }: { c: Conversation }) {
  const { ws, f, tt } = useWs();
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const caps = ws.backend.capabilities;
  const send = useMutation({
    mutationFn: (body: string) => api<Message>(wsPath(ws.id, `/conversations/${c.id}/reply`), { method: 'POST', body: { body } }),
    onSuccess: (m) => {
      setText('');
      qc.setQueryData<{ conversation: Conversation; messages: Message[]; contact: Contact | null }>(['conversation', ws.id, c.id], (d) => (d ? { ...d, messages: [...d.messages, m] } : d));
      qc.invalidateQueries({ queryKey: ['conversations', ws.id] });
    },
    onError: (e) => toast('bad', e instanceof ApiError ? e.message : 'Could not queue the reply'),
  });
  const blocked = !caps.staffReply ? 'Replies are not available for this channel.' : c.optedOut ? tt('This {contact.singular|lower} opted out: no messages can be sent.') : !c.replyWindow.open ? `The ${c.replyWindow.hours ?? 24}-hour reply window closed ${relative(c.replyWindow.closesAt)}. The channel only allows approved templates now: ask them to write first, or call.` : null;
  const submit = () => { const v = text.trim(); if (v && !blocked) send.mutate(v); };
  return (
    <div className="border-t border-line bg-bg-2/60 p-3">
      {blocked ? <p className="flex items-start gap-2 rounded-lg border border-line bg-surface px-3 py-2.5 text-[13px] text-fg-2"><Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted" />{blocked}</p> : (
        <div className="rounded-xl border border-line bg-surface transition-colors focus-within:border-blue/50 focus-within:shadow-[0_0_0_3px_rgb(var(--blue)/0.12)]">
          <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
            placeholder={`Reply to ${c.contactName}…`} rows={3} maxLength={4096} aria-label="Reply"
            className="block w-full resize-none bg-transparent px-3.5 pt-3 text-[13.5px] leading-relaxed text-fg outline-none placeholder:text-muted" />
          <div className="flex items-center justify-between gap-3 px-3 pb-2.5">
            <span className="text-[11.5px] text-muted">{c.replyWindow.closesAt ? `Reply window open until ${dateTime(f, c.replyWindow.closesAt)}` : ''}</span>
            <div className="flex items-center gap-2"><span className="hidden text-[11px] text-muted sm:inline">⌘↵ to send</span><Button variant="primary" size="sm" icon={<Send className="h-3.5 w-3.5" />} loading={send.isPending} disabled={!text.trim()} onClick={submit}>Send</Button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function ContextPanel({ c, contact }: { c: Conversation; contact: Contact | null }) {
  const { ws, t, tt, f, has } = useWs();
  return (
    <aside className="hidden w-[320px] shrink-0 overflow-y-auto border-l border-line bg-bg-2/40 p-4 xl:block" aria-label="Details">
      <div className="label mb-2">{t('contact.singular')}</div>
      {contact ? (
        <div className="space-y-3">
          <Link to={`/w/${ws.id}/contacts/${contact.id}`} className="block rounded-xl border border-line bg-surface p-3 transition-colors hover:border-line-2">
            <p className="text-sm font-semibold">{contact.name}</p>
            <p className="text-[12px] text-fg-2">{contact.phone}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">{contact.status && <Badge>{t(`contactStatus.${contact.status}`)}</Badge>}<StageDot stage={contact.stage} /></div>
          </Link>
          {has('ai') && (
            <div className="ai-tint rounded-xl border p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-blue-soft"><Sparkles className="h-3.5 w-3.5" />{tt('{ai.name} insight')}</div>
              <dl className="space-y-2 text-[12.5px]">
                <Row k="Summary" v={contact.aiSummary} />
                <Row k={t('service.singular')} v={contact.interest} />
                <Row k="Last intent" v={c.lastIntent ? c.lastIntent.replace(/_/g, ' ') : null} />
                <Row k="Next action" v={contact.nextActionAt ? dateTime(f, contact.nextActionAt) : null} />
                {c.attentionRequired && <Row k="Handoff" v={c.attentionReason} tone="amber" />}
              </dl>
            </div>
          )}
          <dl className="space-y-2 rounded-xl border border-line bg-surface p-3 text-[12.5px]">
            <Row k="Source" v={contact.source} />
            <Row k="Owner" v={contact.owner || c.assignedTo} />
            <Row k="First contact" v={contact.createdAt ? dateTime(f, contact.createdAt) : null} />
            <Row k="Opted out" v={contact.optedOut ? 'Yes' : 'No'} />
          </dl>
        </div>
      ) : <p className="text-[13px] text-fg-2">{tt('No {contact.singular|lower} record is linked to this conversation.')}</p>}
    </aside>
  );
}
function Row({ k, v, tone }: { k: string; v: string | null; tone?: 'amber' }) {
  return <div><dt className="text-[11px] uppercase tracking-wide text-muted">{k}</dt><dd className={cn('mt-0.5', tone === 'amber' ? 'text-warn' : v ? 'text-fg' : 'text-muted')}>{v || '—'}</dd></div>;
}
