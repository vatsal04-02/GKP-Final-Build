// Common physiotherapy conditions offered as a typing shortcut in the prescription form. NAMES ONLY: no treatment, exercise or advice text is built in.
// What the clinic actually prescribes for a condition is learned from its own saved prescriptions (GET /prescriptions/suggestions). The doctor reviews and edits everything.
export const COMMON_CONDITIONS = [
  'Low back pain', 'Cervical spondylosis', 'Neck pain (cervicalgia)', 'Lumbar disc prolapse (slip disc)', 'Sciatica', 'Frozen shoulder (adhesive capsulitis)', 'Rotator cuff tendinopathy',
  'Knee osteoarthritis', 'Patellofemoral pain syndrome', 'Post knee replacement rehabilitation', 'ACL injury / reconstruction rehabilitation', 'Plantar fasciitis', 'Ankle sprain',
  'Tennis elbow (lateral epicondylitis)', "Golfer's elbow (medial epicondylitis)", 'Carpal tunnel syndrome', 'Cervical radiculopathy', 'Lumbar spondylosis', 'Sacroiliac joint pain',
  'Piriformis syndrome', 'Muscle strain', 'Post-fracture rehabilitation', 'Stroke (hemiplegia) rehabilitation', "Bell's palsy", 'Ankylosing spondylitis', 'TMJ dysfunction',
] as const;
