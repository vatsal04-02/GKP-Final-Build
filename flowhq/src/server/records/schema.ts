// The Clinic Records tables, exactly as in grist/clinic-records-schema.md (tests keep the two in step).
export const RT = { patients: 'Patients', prescriptions: 'Prescriptions', rxImages: 'Rx_Images', invoices: 'Invoices', invoiceLines: 'Invoice_Lines', payments: 'Payments', visits: 'Visits', audit: 'Audit_Log' } as const;
export type ColType = 'Text' | 'Int' | 'Bool' | 'Date' | 'DateTime' | 'Attachments' | string[];   // string[] = Choice with these choices
const STAMP: Array<[string, ColType]> = [['Created_At', 'DateTime'], ['Created_By', 'Text']];
export const RECORD_COLUMNS: Record<(typeof RT)[keyof typeof RT], Array<[string, ColType]>> = {
  Patients: [['Patient_ID', 'Text'], ['Serial_No', 'Int'], ['Name', 'Text'], ['Phone', 'Text'], ['Address', 'Text'], ['Age', 'Text'], ['Sex', ['Male', 'Female', 'Other']], ['Referred_By', 'Text'], ['Occupation', 'Text'],
    ['Main_Complaint', 'Text'], ['Registered_On', 'Date'], ['Status', ['Active', 'Completed', 'Inactive']], ['Follow_Up_On', 'Date'], ['Followup_Reminded_For', 'Date'], ['Source_Lead_ID', 'Text'], ['Notes', 'Text'], ...STAMP],
  Prescriptions: [['Rx_ID', 'Text'], ['Version', 'Int'], ['Patient_ID', 'Text'], ['Rx_Date', 'Date'], ['Treating_Physio', 'Text'], ['BP', 'Text'], ['Vitals', 'Text'], ['History', 'Text'], ['Examination', 'Text'],
    ['Diagnosis', 'Text'], ['Treatment_Plan', 'Text'], ['Exercises', 'Text'], ['Advice', 'Text'], ['Follow_Up_On', 'Date'], ...STAMP],
  Rx_Images: [['Image_ID', 'Text'], ['Rx_ID', 'Text'], ['Patient_ID', 'Text'], ['File', 'Attachments'], ['Mime', 'Text'], ['Bytes', 'Int'], ['Caption', 'Text'], ['Removed', 'Bool'], ...STAMP],
  Invoices: [['Invoice_No', 'Text'], ['Patient_ID', 'Text'], ['Invoice_Date', 'Date'], ['Status', ['issued', 'void']], ['Subtotal_Paise', 'Int'], ['Discount_Paise', 'Int'], ['Tax_Paise', 'Int'], ['Total_Paise', 'Int'],
    ['Tax_Label', 'Text'], ['Tax_Rate_Bp', 'Int'], ['Notes', 'Text'], ['Void_Reason', 'Text'], ['Idem_Key', 'Text'], ...STAMP],
  Invoice_Lines: [['Invoice_No', 'Text'], ['Line_No', 'Int'], ['Description', 'Text'], ['Qty', 'Int'], ['Unit_Price_Paise', 'Int'], ['Line_Total_Paise', 'Int']],
  Payments: [['Payment_ID', 'Text'], ['Invoice_No', 'Text'], ['Patient_ID', 'Text'], ['Paid_On', 'Date'], ['Amount_Paise', 'Int'], ['Method', ['Cash', 'UPI', 'Card', 'Bank transfer', 'Cheque', 'Other']],
    ['Reference', 'Text'], ['Notes', 'Text'], ['Voided', 'Bool'], ['Void_Reason', 'Text'], ['Idem_Key', 'Text'], ...STAMP],
  Visits: [['Patient_ID', 'Text'], ['Visit_Date', 'Date'], ['Status', ['Attended', 'Missed', 'Cancelled']], ['Notes', 'Text'], ['Recorded_By', 'Text'], ['Created_At', 'DateTime']],
  Audit_Log: [['At', 'DateTime'], ['User', 'Text'], ['Action', 'Text'], ['Record', 'Text'], ['Summary', 'Text']],
};
export const RECORD_TABLE_NAMES = Object.values(RT);
// OPTIONAL tables: they are NOT in RT / RECORD_TABLE_NAMES on purpose, because the clinical pages appear only when every table in that list exists.
// A clinic that has not provisioned them keeps all its clinical pages; only the "Staff attendance" page stays hidden (it needs BOTH).
export const STAFF_ATT = 'Staff_Attendance';
export const STAFF_MEMBERS = 'Staff_Members';
export const STAFF_TABLE_NAMES = [STAFF_ATT, STAFF_MEMBERS] as const;
export const STAFF_COLUMNS: Record<(typeof STAFF_TABLE_NAMES)[number], Array<[string, ColType]>> = {
  [STAFF_ATT]: [['Staff_Key', 'Text'], ['Staff_Name', 'Text'], ['Att_Date', 'Date'], ['Status', ['Present', 'Absent', 'Half day', 'Leave']], ['Notes', 'Text'], ['Recorded_By', 'Text'], ['Created_At', 'DateTime'], ['Updated_At', 'DateTime']],
  [STAFF_MEMBERS]: [['Staff_Key', 'Text'], ['Name', 'Text'], ['Active', 'Bool'], ['Created_At', 'DateTime'], ['Created_By', 'Text']],
};
// what npm run provision-records creates: the required tables plus the optional ones
export const ALL_RECORD_COLUMNS: Record<string, Array<[string, ColType]>> = { ...RECORD_COLUMNS, ...STAFF_COLUMNS };
export const colNames = (t: keyof typeof RECORD_COLUMNS) => RECORD_COLUMNS[t].map(([n]) => n);
// Grist column definition for the provisioning tool
export function gristField(label: string, t: ColType): { type: string; label: string; widgetOptions?: string } {
  if (Array.isArray(t)) return { type: 'Choice', label, widgetOptions: JSON.stringify({ choices: t }) };
  return { type: t === 'DateTime' ? 'DateTime:Asia/Kolkata' : t, label };
}
