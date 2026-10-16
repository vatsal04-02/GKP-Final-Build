# DRAFT — privacy notice and consent wording for the booking form

**STATUS: DRAFT. Not approved. Do not publish until Geeta Krishna Physiotherapy (the clinic) has reviewed and approved it, ideally with a legal/privacy adviser.**
This is plain-language drafting help, not legal advice. Facts marked [CLINIC TO CONFIRM] must be filled in or corrected by the clinic.

The text currently in `src/components/Booking.astro` is the "on the form" wording below. The version string `CONSENT_VERSION` in `src/lib/enquiry-shared.mjs`
(`DRAFT-2026-10-v1`) is stored with every enquiry; **change it whenever the wording changes**, and drop the `DRAFT-` prefix only after approval.

## 1. Wording on the form (what is in the patch)

Note under the button:
> Your name, phone number and request details are sent to Geeta Krishna Physiotherapy so the clinic can respond to your request. This is a request only: your visit is not confirmed until the clinic contacts you.

WhatsApp checkbox (unticked by default, optional, **separate from sending the request**):
> WhatsApp is optional. Tick this box if you are happy for the clinic to message you on WhatsApp about this request and your care. Leave it unticked and the clinic can still handle your request, for example by phone.

Why this shape: sending an enquiry and agreeing to WhatsApp messages are two different things. The enquiry is stored either way; the consent flag is stored as
`false` when the box is unticked, and no WhatsApp template is ever sent to a patient without it (enforced in the CRM workflows, see TEST_PLAN.md).

## 2. Fuller privacy notice (needs a page or link on the site; the site has none today)

**What we collect.** The details you type in the booking form: your name, phone number, the concern you choose (for example "Back Pain"), whether you want a clinic or home visit, your preferred day and time, and whether you ticked the WhatsApp box. Our system also records when you sent the request and the page it came from.

**Why.** To answer your request and arrange an appointment. We do not use it for advertising [CLINIC TO CONFIRM].

**Who sees it.** The clinic's staff, through the clinic's customer record system, and the service providers that run that system for the clinic: website hosting (Vercel), the automation service and the record database [CLINIC TO CONFIRM provider names and where they store data].

**WhatsApp.** We message you on WhatsApp only if you ticked the box. You can tell us to stop at any time by replying STOP or telling the clinic; we will then stop.

**How long we keep it.** [CLINIC TO CONFIRM retention period.]

**Your choices.** To see, correct or delete your details, contact the clinic at [CLINIC TO CONFIRM contact].

**Health information.** The concern you choose is information about your health. Please do not put detailed medical history in the form.

## 3. Decisions the clinic must make before this goes live
1. Approve or edit the two texts above (and their translation, if the site is offered in Hindi).
2. Publish a privacy page and link it from the form's note.
3. Decide the retention period and who may delete records.
4. Confirm the clinic is happy to be contacted by phone for enquiries that do not tick the WhatsApp box.
