// Which doctor's prescriptions and dues are on screen. A doctor's own login is fixed to that doctor by the server (nothing to pick);
// the admin (or front desk) sees everyone together and may narrow to one doctor. The patient register is shared and never filtered.
import { useState } from 'react';
import { useWs } from '../lib/workspace';
import { Segmented } from '../components/ui/primitives';
import { useClinic } from './common';

export function useDoctorFilter() {
  const { me } = useWs();
  const clinic = useClinic();
  const own = me.user.clinician || null;
  const doctors = (clinic.data?.clinicians || []).map((c) => c.name).filter(Boolean);
  const [pick, setPick] = useState('');                       // '' = all doctors
  const doctor = own ? '' : pick;
  return { own, doctors, pick, setPick, show: !own && doctors.length > 1, key: doctor, qs: doctor ? `&doctor=${encodeURIComponent(doctor)}` : '' };
}
export type DoctorFilterState = ReturnType<typeof useDoctorFilter>;

export function DoctorFilter({ f }: { f: DoctorFilterState }) {
  if (!f.show) return null;
  // on a phone the surname is dropped from the labels ("Dr. Sandeep"); the full name is in the tooltip and everywhere else
  const label = (d: string) => <span title={d}><span className="sm:hidden">{d.replace(/\s+\S+$/, '')}</span><span className="hidden sm:inline">{d}</span></span>;
  return <Segmented value={f.pick} onChange={f.setPick} options={[{ value: '', label: 'All doctors' }, ...f.doctors.map((d) => ({ value: d, label: label(d) }))]} />;
}
