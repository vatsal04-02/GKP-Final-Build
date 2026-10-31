// Who may do what with appointments, in ONE place (pure, tested). The booking service enforces it on every staff write, so a route that forgets
// to check cannot leak a permission. Roles come from the signed-in CRM user (never from the request body).
//   admin                      everything, including the AI booking switch, settings, doctors, schedules and the audit log
//   staff (front desk)         view everything; create / move / cancel / change the status of appointments; add or remove leave and blocked time
//   staff with a doctor login  view everything; manage ONLY their own doctor's appointments; no blocks, no settings
// The AI booking switch (`booking_enabled`) is an AI switch only: it never limits what staff may do.
export type Right = 'view' | 'appointments:write' | 'blocks:write' | 'settings:write' | 'ai_switch' | 'audit:read' | 'consent:record_yes' | 'consent:record_no' | 'consent:correct';
// grants: explicit per-user permissions from users.json. Today only 'consent:write' (lets a non-admin record a reminder-consent YES).
export interface Identity { role?: 'admin' | 'staff'; clinician?: string; grants?: string[] }

export function can(who: Identity, right: Right): boolean {
  if (who.role === 'admin') return true;
  switch (right) {
    case 'view': case 'appointments:write': return true;          // an unknown role is treated as plain staff, never as admin
    case 'blocks:write': return !who.clinician;                    // a doctor's own login cannot close the clinic or block other people's time
    case 'consent:record_no': return true;                          // a withdrawal can only SUPPRESS reminders, so any authorised staff member may record it
    case 'consent:record_yes': return (who.grants || []).includes('consent:write');   // a YES needs an explicit grant (front desk and doctors alike); admins always (above)
    default: return false;                                         // settings, the AI switch and the audit log are admin only
  }
}
/** A doctor's login may only touch appointments of the doctor it belongs to. Everyone else is not limited by doctor. */
export const limitedToOwnDoctor = (who: Identity) => who.role !== 'admin' && !!who.clinician;
