// Printable A4 documents: the prescription / treatment sheet and the invoice. Plain black-on-white (readable in black-and-white
// printing); the page chrome (buttons, nav) is never part of these components. Clinic identity comes from the server (config/clinic.json).
import type { ReactNode } from 'react';
import type { ClinicProfile, Invoice, Patient, Prescription } from '@core/clinical';
import { amountInWords } from '@core/money';
import { fdate, rs } from './common';

// Change this whenever a file in public/brand changes: the server lets browsers keep brand images for a day, so a new picture under the same name would not show.
const BRAND_V = '20261122b';

function Letterhead({ clinic, title, big }: { clinic: ClinicProfile; title?: string; big?: boolean }) {
  return (
    <header className={big ? 'keep mb-2' : 'keep'}>
      <div className="flex items-center gap-6">
        {big
          ? <div className="shrink-0 text-center"><img src={`/brand/gkp-logo-light.png?v=${BRAND_V}`} alt="" className="h-[18mm] w-auto" /><div className="mt-0.5 text-[9.5pt] font-bold uppercase tracking-[0.18em]">Since 2004</div></div>
          : <img src={`/brand/gkp-logo-light.png?v=${BRAND_V}`} alt="" className="h-[20mm] w-auto shrink-0" />}
        {big
          ? <img src={`/brand/gkp-name-cross.png?v=${BRAND_V}`} alt={clinic.name} className="h-auto max-h-[26mm] min-w-0 flex-1 object-contain" />
          : <div className="min-w-0 flex-1 text-center">
              <h1 className="font-display text-[18pt] font-bold uppercase leading-none tracking-wide">{clinic.name}</h1>
              <div className="mt-1 text-[9pt] font-semibold uppercase tracking-[0.2em]">Consultant Physiotherapist</div>
            </div>}
      </div>
      {clinic.clinicians.length > 0 && (
        <div className="mt-3 flex flex-wrap justify-between gap-x-6 gap-y-2 text-[9.5pt] leading-tight">
          {clinic.clinicians.map((c, i) => (
            <div key={c.regNo || c.name} className={i % 2 ? 'text-right' : ''}>
              <div className="text-[11.5pt] font-bold">{c.name}{c.title ? ` ${c.title}` : ''}</div>
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

function Footer({ clinic, rich }: { clinic: ClinicProfile; rich?: boolean }) {
  const lines = (
    <>
      {rich && <div className="font-semibold">www.geetakrishnaphysiotherapy.co.in</div>}
      <div>{clinic.address}</div>
      {clinic.phones.length > 0 && <div>Mobile: {clinic.phones.join(', ')}</div>}
      {clinic.timings && <div>{clinic.timings}</div>}
      {clinic.runBy && <div>{clinic.runBy}</div>}
    </>
  );
  return (
    <footer className="keep mt-3 border-t border-black pt-1.5 text-center text-[9.5pt] leading-snug">
      {rich ? (
        <div className="flex items-center justify-center gap-4">
          <div className="min-w-0 flex-1">{lines}</div>
          <div className="shrink-0 text-center"><img src={`/brand/locate-us-qr.png?v=${BRAND_V}`} alt="QR code: locate us on Google Maps" className="h-[19mm] w-[19mm]" /><div className="mt-0.5 text-[8pt] font-bold uppercase tracking-wider">Locate us</div></div>
        </div>
      ) : lines}
    </footer>
  );
}

const Cell = ({ k, v }: { k: string; v: ReactNode }) => <div className="flex min-w-0 gap-1.5 border-b border-dotted border-black/60 pb-0.5"><span className="shrink-0 font-semibold">{k}</span><span className="min-w-0 break-words">{v || ''}</span></div>;
function Section({ label, text }: { label: string; text: string }) {
  return (
    <section className="keep mt-3">
      <h3 className="border-b border-black pb-1 text-[10pt] font-bold uppercase tracking-wider">{label}</h3>
      <div className="min-h-[8mm] whitespace-pre-wrap break-words pt-1.5 text-[11pt] leading-loose">{text}</div>
    </section>
  );
}

export function PrescriptionDocument({ clinic, rx, patient, imageUrl }: { clinic: ClinicProfile; rx: Prescription; patient: Pick<Patient, 'name' | 'patientId' | 'age' | 'sex' | 'phone'>; imageUrl: (imageId: string) => string }) {
  return (
    <article className="paper flex flex-col text-[10.5pt] print:min-h-[235mm]" aria-label="Prescription">
      <Letterhead clinic={clinic} big />
      <div className="keep mt-4 grid grid-cols-2 gap-x-5 gap-y-3 text-[10.5pt] print:grid-cols-[1.6fr_1fr_1fr] sm:grid-cols-[1.6fr_1fr_1fr]">
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
      <div className="keep mt-auto pt-3">
        <div className="flex justify-end"><div className="w-[68mm] max-w-full text-center text-[10pt]"><div className="h-[8mm] border-b border-black" /><div className="mt-1 font-semibold">{rx.treatingPhysio || 'Treating physiotherapist'}</div></div></div>
        <Footer clinic={clinic} rich />
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
      <div className="keep mt-3 grid grid-cols-1 gap-x-6 gap-y-2 print:grid-cols-2 sm:grid-cols-2">
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
        <div className="flex justify-end"><div className="w-[68mm] max-w-full text-center text-[10pt]"><div className="h-[14mm] border-b border-black" /><div className="mt-1 font-semibold">Authorised Signatory</div><div className="text-[9pt]">{clinic.name}</div></div></div>
        <Footer clinic={clinic} />
      </div>
      {inv.status === 'void' && <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center"><span className="-rotate-[24deg] border-[6px] border-black/25 px-8 py-2 font-display text-[64pt] font-bold tracking-widest text-black/20">VOID</span></div>}
    </article>
  );
}
