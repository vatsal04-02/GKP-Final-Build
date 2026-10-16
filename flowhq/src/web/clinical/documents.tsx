// Printable A4 documents: the prescription / treatment sheet and the invoice. Plain black-on-white (readable in black-and-white
// printing); the page chrome (buttons, nav) is never part of these components. Clinic identity comes from the server (config/clinic.json).
import type { ReactNode } from 'react';
import type { ClinicProfile, Invoice, Patient, Prescription } from '@core/clinical';
import { amountInWords } from '@core/money';
import { fdate, rs } from './common';

function Letterhead({ clinic, title }: { clinic: ClinicProfile; title?: string }) {
  return (
    <header className="keep">
      <div className="flex items-center gap-4">
        <img src="/brand/gkp-logo-light.png" alt="" className="h-[20mm] w-auto shrink-0" />
        <div className="min-w-0 flex-1 text-center">
          <h1 className="font-display text-[18pt] font-bold uppercase leading-none tracking-wide">{clinic.name}</h1>
          <div className="mt-1 text-[9pt] font-semibold uppercase tracking-[0.2em]">Consultant Physiotherapist</div>
        </div>
      </div>
      {clinic.clinicians.length > 0 && (
        <div className="mt-3 flex justify-between gap-6 text-[9.5pt] leading-tight">
          {clinic.clinicians.map((c, i) => (
            <div key={c.regNo || c.name} className={i % 2 ? 'text-right' : ''}>
              <div className="text-[11.5pt] font-bold">{c.name}</div>
              <div>{c.qualifications}</div>
              {c.regNo && <div>Regd. No.: {c.regNo}</div>}
              {c.mobile && <div>Mob.: {c.mobile}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 border-y-2 border-black py-1 text-center text-[11pt] font-bold uppercase tracking-wide">{title || clinic.tagline}</div>
    </header>
  );
}

function Footer({ clinic }: { clinic: ClinicProfile }) {
  return (
    <footer className="keep mt-3 border-t border-black pt-1.5 text-center text-[8.5pt] leading-snug">
      <div>{clinic.address}</div>
      {clinic.phones.length > 0 && <div>Mobile: {clinic.phones.join(', ')}</div>}
      {clinic.timings && <div>{clinic.timings}</div>}
      {clinic.runBy && <div>{clinic.runBy}</div>}
    </footer>
  );
}

const Cell = ({ k, v }: { k: string; v: ReactNode }) => <div className="flex min-w-0 gap-1.5 border-b border-dotted border-black/60 pb-0.5"><span className="shrink-0 font-semibold">{k}</span><span className="min-w-0 break-words">{v || ''}</span></div>;
function Section({ label, text }: { label: string; text: string }) {
  return (
    <section className="keep mt-2.5">
      <h3 className="border-b border-black pb-0.5 text-[9.5pt] font-bold uppercase tracking-wider">{label}</h3>
      <div className="min-h-[9mm] whitespace-pre-wrap break-words pt-1 text-[10.5pt] leading-relaxed">{text}</div>
    </section>
  );
}

export function PrescriptionDocument({ clinic, rx, patient, imageUrl }: { clinic: ClinicProfile; rx: Prescription; patient: Pick<Patient, 'name' | 'patientId' | 'age' | 'sex' | 'phone'>; imageUrl: (imageId: string) => string }) {
  const physio = clinic.clinicians.find((c) => c.name.toLowerCase() === rx.treatingPhysio.trim().toLowerCase());
  return (
    <article className="paper text-[10.5pt]" aria-label="Prescription">
      <Letterhead clinic={clinic} />
      <div className="keep mt-3 grid grid-cols-[1.6fr_1fr_1fr] gap-x-5 gap-y-2 text-[10.5pt]">
        <Cell k="Name:" v={patient.name} /><Cell k="Age / Sex:" v={[patient.age, patient.sex].filter(Boolean).join(' / ')} /><Cell k="Date:" v={fdate(rx.rxDate)} />
        <Cell k="Patient ID:" v={patient.patientId} /><Cell k="Contact:" v={patient.phone} /><Cell k="Rx No.:" v={rx.rxId} />
        <Cell k="B.P.:" v={rx.bp} /><div className="col-span-2"><Cell k="Other vitals:" v={rx.vitals} /></div>
      </div>
      <Section label="History" text={rx.history} />
      <Section label="O/E (clinical examination)" text={rx.examination} />
      <Section label="Diagnosis" text={rx.diagnosis} />
      <Section label="Physiotherapy treatment" text={[rx.treatmentPlan, rx.exercises && `Exercises / instructions:\n${rx.exercises}`].filter(Boolean).join('\n\n')} />
      <Section label="Advice" text={[rx.advice, rx.followUpOn && `Follow-up: ${fdate(rx.followUpOn)}`].filter(Boolean).join('\n\n')} />
      {rx.images.length > 0 && (
        <section className="keep mt-2.5">
          <h3 className="border-b border-black pb-0.5 text-[9.5pt] font-bold uppercase tracking-wider">Attached photographs</h3>
          <div className="mt-2 grid grid-cols-2 gap-3">
            {rx.images.map((im) => <figure key={im.imageId} className="keep m-0"><img src={imageUrl(im.imageId)} alt={im.caption || 'Clinical photograph'} className="max-h-[52mm] w-full border border-black/50 object-contain" />{im.caption && <figcaption className="mt-0.5 text-[9pt]">{im.caption}</figcaption>}</figure>)}
          </div>
        </section>
      )}
      <div className="keep mt-4">
        <div className="flex justify-end"><div className="w-[68mm] text-center text-[10pt]"><div className="h-[10mm] border-b border-black" /><div className="mt-1 font-semibold">{rx.treatingPhysio || 'Treating physiotherapist'}</div><div className="text-[9pt]">Treating Physiotherapist{physio?.regNo ? ` · Regd. No. ${physio.regNo}` : ''}</div></div></div>
        <Footer clinic={clinic} />
      </div>
    </article>
  );
}

export function InvoiceDocument({ clinic, inv, patient }: { clinic: ClinicProfile; inv: Invoice; patient: Pick<Patient, 'name' | 'patientId' | 'phone' | 'address'> }) {
  const words = amountInWords(inv.totalPaise);
  const live = inv.payments.filter((p) => !p.voided);
  const label = { paid: 'PAID', partial: 'PART PAID', unpaid: 'UNPAID', void: 'VOID' }[inv.paymentStatus];
  return (
    <article className="paper relative text-[10.5pt]" aria-label="Invoice">
      <Letterhead clinic={clinic} title="Invoice" />
      <div className="keep mt-3 grid grid-cols-2 gap-x-6 gap-y-2">
        <Cell k="Invoice No.:" v={<b>{inv.invoiceNo}</b>} /><Cell k="Date:" v={fdate(inv.date)} />
        <Cell k="Patient:" v={patient.name} /><Cell k="Patient ID:" v={patient.patientId} />
        <Cell k="Contact:" v={patient.phone} /><Cell k="Address:" v={patient.address} />
      </div>
      <table className="mt-4 w-full border-collapse text-[10.5pt]">
        <thead><tr className="border-y-2 border-black text-left text-[9.5pt] uppercase tracking-wide"><th className="w-8 py-1.5">#</th><th className="py-1.5">Service / treatment</th><th className="w-14 py-1.5 text-right">Qty</th><th className="w-28 py-1.5 text-right">Unit price</th><th className="w-28 py-1.5 text-right">Amount</th></tr></thead>
        <tbody>{inv.lines.map((l) => <tr key={l.lineNo} className="keep border-b border-black/30 align-top"><td className="py-1.5">{l.lineNo}</td><td className="whitespace-pre-wrap break-words py-1.5 pr-2">{l.description}</td><td className="num py-1.5 text-right">{l.qty}</td><td className="num py-1.5 text-right">{rs(l.unitPaise)}</td><td className="num py-1.5 text-right">{rs(l.totalPaise)}</td></tr>)}</tbody>
      </table>
      <div className="keep mt-3 flex justify-end">
        <table className="w-[78mm] border-collapse text-[10.5pt]"><tbody>
          <tr><td className="py-0.5">Subtotal</td><td className="num py-0.5 text-right">{rs(inv.subtotalPaise)}</td></tr>
          {inv.discountPaise > 0 && <tr><td className="py-0.5">Discount</td><td className="num py-0.5 text-right">− {rs(inv.discountPaise)}</td></tr>}
          {inv.taxPaise > 0 && <tr><td className="py-0.5">{inv.taxLabel || 'Tax'} ({inv.taxRateBp / 100}%)</td><td className="num py-0.5 text-right">{rs(inv.taxPaise)}</td></tr>}
          <tr className="border-t-2 border-black text-[12pt] font-bold"><td className="py-1">Total</td><td className="num py-1 text-right">{rs(inv.totalPaise)}</td></tr>
          <tr><td className="py-0.5">Amount paid</td><td className="num py-0.5 text-right">{rs(inv.paidPaise)}</td></tr>
          <tr className="border-t border-black font-bold"><td className="py-0.5">Balance due</td><td className="num py-0.5 text-right">{rs(inv.balancePaise)}</td></tr>
        </tbody></table>
      </div>
      {words && <p className="keep mt-3 text-[10pt]"><b>Amount in words:</b> {words}</p>}
      <div className="keep mt-3 flex items-start justify-between gap-4 text-[10pt]">
        <div className="min-w-0"><b>Payment status:</b> <span className="ml-1 inline-block border-2 border-black px-2 py-px font-bold tracking-wider">{label}</span>
          {live.length > 0 && <ul className="mt-1.5 list-none p-0 text-[9.5pt]">{live.map((p) => <li key={p.paymentId}>{fdate(p.paidOn)} · {p.method}{p.reference ? ` (${p.reference})` : ''} · {rs(p.amountPaise)}</li>)}</ul>}
          {inv.status === 'void' && <p className="mt-1.5 font-semibold">This invoice has been voided{inv.voidReason ? `: ${inv.voidReason}` : ''}.</p>}
        </div>
      </div>
      {inv.notes && <p className="keep mt-3 whitespace-pre-wrap text-[10pt]"><b>Notes:</b> {inv.notes}</p>}
      <div className="keep mt-10">
        <div className="flex justify-end"><div className="w-[68mm] text-center text-[10pt]"><div className="h-[14mm] border-b border-black" /><div className="mt-1 font-semibold">Authorised Signatory</div><div className="text-[9pt]">{clinic.name}</div></div></div>
        <Footer clinic={clinic} />
      </div>
      {inv.status === 'void' && <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center"><span className="-rotate-[24deg] border-[6px] border-black/25 px-8 py-2 font-display text-[64pt] font-bold tracking-widest text-black/20">VOID</span></div>}
    </article>
  );
}
