# Grist tables: Clinic Records (patients, prescriptions, invoices, payments, visits)

Added **inside each clinic's existing Grist doc**, next to Leads / Appointments / Messages. Purely additive: no existing table or column
is renamed or changed. One n8n workflow touches them: **W15** (follow-up reminder) reads `Patients` and writes only
`Patients.Followup_Reminded_For`; nothing else in n8n reads or writes these tables. Create them with `npm run provision-records` (in `flowhq/`),
which adds only what is missing. Column names are exact: `flowhq/src/server/records/schema.ts` is generated from this file by hand
and a test keeps the two in step.

Conventions: our own text ids (`Patient_ID`, `Rx_ID`, `Invoice_No`, `Payment_ID`) are the stable keys, never Grist row numbers.
Money is stored as **integer paise** (INR × 100). Dates are Grist `Date` (UTC midnight epoch seconds); timestamps are `DateTime` (Asia/Kolkata).
Nothing is ever deleted through the app: records are voided or superseded, so history is kept.

## Patients
| Column | Type | Notes |
|---|---|---|
| Patient_ID | Text | `GK-P-000001` (prefix from `config/clinic.json`), set by FLOW HQ, unique |
| Serial_No | Int | register serial number, set by FLOW HQ |
| Name | Text | required |
| Phone | Text | `+91XXXXXXXXXX` when given |
| Address | Text | |
| Age | Text | free text ("34", "8 months") |
| Sex | Choice | Male, Female, Other |
| Referred_By | Text | referring doctor |
| Occupation | Text | |
| Main_Complaint | Text | the disorder, as recorded by the clinician |
| Registered_On | Date | |
| Status | Choice | Active, Completed, Inactive |
| Follow_Up_On | Date | the next follow-up; FLOW HQ copies a prescription's Follow_Up_On here when a save sets or changes it |
| Followup_Reminded_For | Date | set by n8n W15: the Follow_Up_On date already reminded on WhatsApp (sent flag: same date = never again, a new date = a new reminder) |
| Source_Lead_ID | Text | optional link to Leads.Lead_ID, set only by a person, never automatically |
| Notes | Text | |
| Created_At, Created_By | DateTime, Text | |

## Prescriptions
Append-only: an edit writes a **new row** with the same `Rx_ID` and `Version + 1`; the latest version is the current sheet.
| Column | Type | Notes |
|---|---|---|
| Rx_ID | Text | `RX-000001` |
| Version | Int | starts at 1 |
| Patient_ID | Text | must exist in Patients |
| Rx_Date | Date | |
| Treating_Physio | Text | |
| BP | Text | |
| Vitals | Text | other recorded vitals |
| History | Text | |
| Examination | Text | O/E |
| Diagnosis | Text | entered by the clinician only |
| Treatment_Plan | Text | |
| Exercises | Text | |
| Advice | Text | |
| Follow_Up_On | Date | |
| Created_At, Created_By | DateTime, Text | of this version |

## Rx_Images
| Column | Type | Notes |
|---|---|---|
| Image_ID | Text | `IMG-000001` |
| Rx_ID | Text | |
| Patient_ID | Text | |
| File | Attachments | the Grist attachment (kept while referenced by this cell) |
| Mime | Text | image/jpeg or image/png, checked by file signature |
| Bytes | Int | |
| Caption | Text | |
| Removed | Toggle | removal hides the image, the file is kept |
| Created_At, Created_By | DateTime, Text | |

## Invoices
Saved invoices are final. A mistake is corrected by voiding the invoice (reason required) and issuing a new one.
| Column | Type | Notes |
|---|---|---|
| Invoice_No | Text | `GK-2026-000001`, prefix and year, set by FLOW HQ, unique |
| Patient_ID | Text | must exist in Patients |
| Invoice_Date | Date | |
| Status | Choice | issued, void |
| Subtotal_Paise, Discount_Paise, Tax_Paise, Total_Paise | Int | Total = Subtotal − Discount + Tax |
| Tax_Label | Text | empty when no tax |
| Tax_Rate_Bp | Int | basis points (1800 = 18%), 0 when no tax |
| Notes | Text | |
| Void_Reason | Text | |
| Idem_Key | Text | duplicate-submission guard |
| Created_At, Created_By | DateTime, Text | |

## Invoice_Lines
| Column | Type | Notes |
|---|---|---|
| Invoice_No | Text | |
| Line_No | Int | 1.. |
| Description | Text | |
| Qty | Int | sessions or units, at least 1 |
| Unit_Price_Paise | Int | |
| Line_Total_Paise | Int | Qty × Unit_Price_Paise |

## Payments
Append-only. A wrong payment is voided (reason required), never edited.
| Column | Type | Notes |
|---|---|---|
| Payment_ID | Text | `PAY-000001` |
| Invoice_No | Text | |
| Patient_ID | Text | |
| Paid_On | Date | |
| Amount_Paise | Int | greater than 0 and not more than the invoice balance |
| Method | Choice | Cash, UPI, Card, Bank transfer, Cheque, Other |
| Reference | Text | UPI / cheque / transaction reference |
| Notes | Text | |
| Voided | Toggle | |
| Void_Reason | Text | |
| Idem_Key | Text | duplicate-submission guard |
| Created_At, Created_By | DateTime, Text | |

## Visits
One row per patient per day (marking the same day again updates it). Feeds the Monday–Sunday attendance grid.
| Column | Type | Notes |
|---|---|---|
| Patient_ID | Text | |
| Visit_Date | Date | |
| Status | Choice | Attended, Missed, Cancelled |
| Notes | Text | |
| Recorded_By | Text | |
| Created_At | DateTime | |

## Staff_Attendance
**Optional table** (the clinical pages work without it; the "Staff attendance" page appears only once this table, `Staff_Members` AND `Staff_Settings` exist). One row per staff member per day. **A marked day is locked:** the first mark of a day is free, but changing or clearing it needs the attendance edit password (see `Staff_Settings`), enforced by the server; every change is written to `Audit_Log` (`staffatt.set` for a first mark, `staffatt.override` with the old and new status for an edit, `staffatt.edit_denied` for a wrong password), so the history of who changed what is kept. Rows are never deleted: clearing a mark empties `Status`. There are no clock times: a day is only Present, Absent, Half day or Leave. (A table created by the first version of this page may carry two extra empty columns, `Check_In` and `Check_Out`; they are ignored and never written.)
| Column | Type | Notes |
|---|---|---|
| Staff_Key | Text | stable key of the person: the FLOW HQ login's email (lower case), `doctor:<name>` for a doctor in `config/clinic.json` who has no login, or `staff:000001` for someone added on the page (see `Staff_Members`) |
| Staff_Name | Text | the name as shown when the mark was made |
| Att_Date | Date | clinic-local day; never in the future |
| Status | Choice | Present, Absent, Half day, Leave (empty = cleared) |
| Notes | Text | up to 500 characters |
| Recorded_By | Text | login email of who made the last change |
| Created_At, Updated_At | DateTime | |

## Staff_Members
**Optional table**, the second half of the staff attendance page: people added by name on the page, for staff who have no FLOW HQ login (a receptionist, a helper). Logins and the doctors in `config/clinic.json` are listed automatically and are not stored here. Rows are never deleted: "Remove" sets `Active` off, the person's past marks stay, and adding the same name again switches them back on. Changes are written to `Audit_Log` (`staff.add`, `staff.remove`).
| Column | Type | Notes |
|---|---|---|
| Staff_Key | Text | `staff:000001`, set by FLOW HQ, unique, never reused |
| Name | Text | 1 to 80 characters, unique ignoring capitals and extra spaces |
| Active | Toggle | off = removed from the list |
| Created_At, Created_By | DateTime, Text | |

## Staff_Settings
**Optional table**, the third part of the staff attendance page: settings for the page. Today it holds one row, `Key = edit_password_hash`: a salted scrypt hash of the **attendance edit password** that an admin sets on the page (the password itself is never stored or logged). Until that row exists, marked days are locked for everybody. Changing the password needs the current one and updates the row; nothing is deleted. Forgotten password (owner recovery in Grist): empty the `Value` cell; the page then treats the password as not set, and an admin sets a new one.
| Column | Type | Notes |
|---|---|---|
| Key | Text | `edit_password_hash` |
| Value | Text | `scrypt$<salt>$<hash>` |
| Updated_At, Updated_By | DateTime, Text | who last set it (login email) and when |

## Audit_Log
Who did what, when. Never contains clinical text or image data.
| Column | Type | Notes |
|---|---|---|
| At | DateTime | |
| User | Text | |
| Action | Text | e.g. patient.create, invoice.void, payment.add |
| Record | Text | the stable id |
| Summary | Text | short, non-clinical |

## Access (set in Grist by the agency): verified recipe
FLOW HQ writes with the API key of its own Grist user (the "service user", an **editor** of the clinic doc, read access to the registry doc). Left alone, every
front-desk **editor** can create, change and delete rows in these tables directly in Grist (verified: before the rules below, an editor's write succeeded).
So, in the clinic doc: **Access Rules** > add a table rule for each of the 8 required tables above (and for `Staff_Attendance` once you have created it), with these two rules **in this order**:

| # | Condition (Advanced) | Permissions |
|---|---|---|
| 1 | `user.Email == "<the FLOW HQ service user's email>"` | allow all (Read, Create, Update, Delete) |
| 2 | `user.Access != "owners"` | **deny** Create, Update, Delete (leave Read allowed) |

Result (verified on a real Grist with header identities, 24 checks): front-desk editors, viewers and anyone not signed in **cannot create, update or delete** a row in any of the 8 tables
(HTTP 403), cannot add a photo record, and cannot read as an anonymous user; they can still **read** the register (editors, viewers); the service user and doc owners can still write;
front desk can still edit Leads / Messages as before, so nothing else changes. Photos are Grist attachments referenced by `Rx_Images.File`: with writes denied, nobody but FLOW HQ
(or an owner) can attach or swap one.
These exact formulas were the ones tested (rules created through Grist's `_grist_ACLRules`, the same table the Access Rules page edits). After setting them, try one write as a front-desk login before relying on them.
FLOW HQ itself adds its own layer on top (sign-in, CSRF, per-workspace access, admin-only voiding), but Grist remains reachable by anyone with a Grist login, so these rules matter.
