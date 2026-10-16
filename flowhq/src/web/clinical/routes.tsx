// The clinical pages and print views, registered in one place so App.tsx stays free of clinic words.
import { lazy, type ReactElement } from 'react';
import type { ModuleKey } from '@core/domain';

const Register = lazy(() => import('./Register'));
const Prescriptions = lazy(() => import('./Prescriptions'));
const Invoices = lazy(() => import('./Invoices'));
const Attendance = lazy(() => import('./Attendance'));
const PrintPrescription = lazy(() => import('./PrintPages').then((m) => ({ default: m.PrintPrescription })));
const PrintInvoice = lazy(() => import('./PrintPages').then((m) => ({ default: m.PrintInvoice })));

export const CLINICAL_PAGES: Array<{ module: ModuleKey; path: string; el: ReactElement }> = [
  { module: 'patients', path: 'patients/:patientId?', el: <Register /> },
  { module: 'prescriptions', path: 'prescriptions/:rxId?', el: <Prescriptions /> },
  { module: 'invoices', path: 'invoices/:invoiceNo?', el: <Invoices /> },
  { module: 'visits', path: 'attendance', el: <Attendance /> },
];
// full-page views without the dashboard around them (opened in a new tab to print)
export const PRINT_PAGES: Array<{ module: ModuleKey; path: string; el: ReactElement }> = [
  { module: 'prescriptions', path: 'print/prescription/:rxId', el: <PrintPrescription /> },
  { module: 'invoices', path: 'print/invoice/:invoiceNo', el: <PrintInvoice /> },
];
