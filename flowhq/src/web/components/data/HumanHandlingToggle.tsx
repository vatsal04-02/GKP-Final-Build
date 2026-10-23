// "Human handling" / "AI active" switch for one conversation. It writes Conversations.Automation_Paused through the existing
// PATCH route and shows the new state only after the server has read it back from Grist: while saving the switch keeps the
// old state, and on a failure it stays where it was and says why.
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { Conversation } from '@core/domain';
import { api, ws as wsPath } from '../../lib/api';
import { useWs } from '../../lib/workspace';
import { cn } from '../../lib/cn';
import { Switch } from '../ui/primitives';
import { useToast } from '../ui/feedback';

export const handlingHint = (who: string) => `Human handling stops the AI assistant from replying to this ${who}. It also pauses automated reminders and follow-ups for them until you switch it off. Staff replies are never blocked.`;

export function HumanHandlingToggle({ conversationId, paused, className }: { conversationId: string; paused: boolean; className?: string }) {
  const { ws, tt } = useWs();
  const qc = useQueryClient();
  const toast = useToast();
  const [saved, setSaved] = useState(paused);          // the last state the server confirmed
  useEffect(() => setSaved(paused), [paused, conversationId]);
  const save = useMutation({
    mutationFn: (next: boolean) => api<Conversation>(wsPath(ws.id, `/conversations/${conversationId}`), { method: 'PATCH', body: { automationPaused: next } }),
    onSuccess: (c) => {
      setSaved(c.automationPaused);
      toast('ok', c.automationPaused ? 'Human handling is on: the AI will not reply' : 'AI is active again for new messages');
      qc.invalidateQueries({ queryKey: ['conversation', ws.id, conversationId] });
      qc.invalidateQueries({ queryKey: ['conversations', ws.id] });
      qc.invalidateQueries({ queryKey: ['contact', ws.id] });
      qc.invalidateQueries({ queryKey: ['contacts', ws.id] });
    },
    onError: (e) => toast('bad', `Not saved: ${(e as Error).message}`),
  });
  return (
    <div className={cn('inline-flex items-center gap-2', className)} title={handlingHint(tt('{contact.singular|lower}'))}>
      <Switch checked={saved} disabled={save.isPending} onChange={(v) => save.mutate(v)} label={saved ? 'Human handling is on. Switch to let the AI reply again' : 'AI is active. Switch to handle this conversation yourself'} />
      <span className="text-[12.5px] font-medium text-fg-2" aria-live="polite">
        {save.isPending ? <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" />Saving…</span> : saved ? <span className="text-warn">Human handling</span> : 'AI active'}
      </span>
    </div>
  );
}
