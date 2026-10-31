// "WhatsApp" button: opens WhatsApp with a ready-made message to this patient. The staff member reads it and presses send.
import { MessageCircle } from 'lucide-react';
import { cn } from '../lib/cn';
import { useClinic } from './common';
import { waLink } from './whatsapp';

export function WhatsAppButton({ phone, name, message, size = 'md', label = 'WhatsApp', className }: { phone: string; name: string; message: (clinic: string) => string; size?: 'sm' | 'md' | 'lg'; label?: string; className?: string }) {
  const clinic = useClinic();
  const href = phone ? waLink(phone, message(clinic.data?.name || '')) : null;
  if (!href) return <span className="text-[12px] text-muted">{phone ? 'Number not valid' : 'No phone'}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`Message ${name} on WhatsApp`} title="Opens WhatsApp with a message ready to send"
      className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-lg font-semibold text-white transition-colors hover:brightness-95',
        'bg-[#0E7A6D]', size === 'sm' ? 'h-8 px-3 text-[12.5px]' : size === 'lg' ? 'h-10 px-4 text-sm' : 'h-9 px-3.5 text-[13px]', className)}>
      <MessageCircle className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />{label}
    </a>
  );
}
