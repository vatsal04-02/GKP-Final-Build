# Geeta Krishna Physiotherapy — Phase 1 website

Premium, mobile-first marketing site for **Geeta Krishna Physiotherapy** (B-1/127 Viram Khand, Gomti Nagar, Lucknow).
Built to the Master PRD and `design.md`: static Astro, one small TypeScript module, WhatsApp + phone as the conversion path.
There is **no appointment system** in Phase 1: the *Book your visit* form sends a request to the clinic's CRM through `/api/enquiry` (see `ENQUIRY_INTEGRATION.md`) and the clinic confirms the slot by contacting the visitor (no calendar, payment or login). If sending fails, the form offers the same request on WhatsApp.

| | |
|---|---|
| Stack | Astro 7 · TypeScript · Tailwind CSS 4 · Lucide icons · self-hosted DM Serif Display + Manrope |
| Client JS | ~6 KB gzipped (header, active nav, menu, reveals, counters, open-now pill, booking form, FAQ, review slider, map guard, optional live Google reviews) · CSS ~23 KB gzipped |
| Lighthouse (local) | Mobile 100 / 100 / 100 / 100 · Desktop 100 / 100 / 100 / 100 (perf / a11y / best-practices / SEO); mobile LCP 1.7 s, TBT 0, CLS 0 |

## Commands

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # static site → dist/
npm run preview    # serve the build
npm run check      # astro check (TypeScript 6 — TS 7 is not yet supported by astro check)
npm test           # enquiry API + shared rules (node --test, synthetic data, no network)
```

Environment (see `.env.example`):

- `PUBLIC_SITE_URL` — deployed URL; drives canonical, sitemap, `robots.txt`, social tags. **Confirm before launch.**
- `PUBLIC_GA_ID` — optional GA4 ID. Leave empty to ship with no analytics (needs clinic approval).

## Where things live

```
src/data/site.ts        ALL clinic facts, copy lists, FAQ, reviews, gallery — edit content here
src/components/         One component per page section (Header, Hero, Conditions, …)
src/components/Placeholder.astro   Shared "photograph goes here" slot (only shown if a gallery photo file is missing)
src/components/Booking.astro + src/scripts/booking.ts   The "Book your visit" request form
src/styles/global.css   Design tokens, glass surfaces, buttons, motion system, reduced-motion rules
src/scripts/main.ts     Progressive enhancement (every feature degrades without JS)
src/assets/clinic/      Drop real photos here (see below)
scripts/make-logo-assets.mjs    Rebuilds the logo marks, tab icon, iOS icon and public/og.png from src/assets/brand/ (the clinic's two logo files)
```

## Adding real photography

Put approved photos in `src/assets/clinic/` (`.jpg .jpeg .png .webp .avif`). The file name is the slot:

| File name | Where it appears |
|---|---|
| `hero-poster` | First frame of the hero loop. It is what paints first (the LCP image), what stays on screen for visitors who ask for reduced motion or are on data-saver / 2G, and what shows if playback fails. If you re-cut the video, re-export its first frame to this name (see *Hero video* below). The older still `hero.webp` (the entrance photo) is no longer used by the page |
| `doctor-sandeep`, `doctor-mahesh` | Doctor cards — currently head-and-shoulders crops of the supplied pair image (left Dr. Sandeep Tiwari, right Dr. Mahesh Tiwari; `object-position` in `Doctors.astro` keeps the face in frame). Delete a file and that card falls back to its ST / MT monogram |
| `doctors-together` | Joint photo beside the doctors' intro (caption is a `[TBD]` until the clinic confirms who is pictured) |
| `gallery-1`, `gallery-2`, … | The clinic banner. Each one also needs a line in `gallery` in `src/data/site.ts` (label + a plain description for the alt text); `galleryPending` lists what is still to come. Photos **1000 px wide or more** go into the large swipeable viewer (arrows, counter, thumbnails, keyboard; in the order listed); smaller ones sit in the "Treatment sessions" row beneath it at their own size |

Every photo that goes through `ClinicImage` also gets the `.clinic-photo` class: one warm grade (`sepia .12, saturate 1.06, contrast 1.02`) so photos from different cameras sit together. Remove the rule in `ClinicImage.astro` to turn it off.

Each is converted to AVIF/WebP, given fixed dimensions (no layout shift), and **never up-scaled**: a small source is served at its own size. The supplied treatment and doctor photos are only ~250 px wide, so they are shown at about their native size; send the originals (1200 px+ wide) before putting any of them in a large slot. Photo-overlay labels sit on solid pine so they stay legible on any image.
No stock or generated imagery is ever substituted. **Patient photos need the patients' consent before publishing.**

## Live Google reviews

The page asks its own Vercel function, `api/reviews.mjs`, which calls Google's Places API (New) with a key that stays on the server and lets Vercel cache the answer for 24 hours (one Google call a day, not one per visitor). Nothing Google-related is in the page source.

**Set up (once):**
1. Find the clinic's place id with Google's free *Place ID Finder*.
2. In Google Cloud Console create an API key, restrict it to **Places API (New)** only, and make sure billing is enabled on the project (Google requires it for this API; usage at this volume stays inside Google's free monthly allowance, but check the current pricing page).
3. In Vercel → Project → Settings → Environment Variables add `GOOGLE_PLACES_API_KEY` and `GOOGLE_PLACE_ID` (never with a `PUBLIC_` prefix), then redeploy.

**Behaviour** (`src/scripts/google-reviews.ts`):
- Until both variables are set the function answers 204 and the section keeps the three built-in, clinic-approved reviews from `reviews` in `src/data/site.ts`. The same happens on any Google error, timeout, a missing function (local `npm run preview`) or an empty answer: the built-in cards stay, silently. There are no loading placeholders; the built-in cards are shown until live ones arrive.
- With live data it updates the hero badge, the stats strip and the reviews score with the exact rating and review count (so the "+" goes away), replaces the cards with the live reviews (author linked to their Google profile, stars, "x months ago", text clamped to 3 lines with Read more / Show less) and points "Read all reviews on Google" at the clinic's listing (`place_id:`).
- Google returns at most **5 reviews** for a place and decides which; the rating and the total count are exact. The response is kept in the tab's `sessionStorage` for the visit.
- Tests: `tests/reviews-api.test.mjs` (fake Google, no network). The structured data (`aggregateRating`) is generated at build time from `clinic.rating`, so update that occasionally too.

## Launch checklist — details the clinic must confirm

Everything below is intentionally left as `[TBD - confirm with clinic]` (PRD §3, §41). Search the repo for `TBD` to find each one.

- [ ] Doctor portraits: the supplied pair image looks AI-generated/enhanced (a Gemini sparkle sits in the right-hand photo; it falls outside the crops used). Patients will see these faces at the clinic, so swap in unretouched photographs of the doctors if these are not genuine
- [ ] Gallery photos `gallery-4` … `gallery-7` (the large viewer): they show identifiable patients, so confirm consent; `gallery-6` has a wall board with fee amounts and a doctor's name that are legible at full size (the site deliberately lists no prices and no such doctor) — crop it, swap it, or confirm the board is current; the same board suggests home visits exist, which would settle the `[TBD]` FAQ answer, but nothing on the page claims it until the clinic confirms
- [ ] Hero video + poster: the supplied loop and the entrance photo both look AI-generated (a small Google sparkle mark sits near the bottom right of the footage, and the signboard in it shows hours 9:00–1:30 / 4:30–8:30, "B.Sc. B.P.T." qualifications, a second phone number, "Since 2004" — none of which match the site). Patients will see this as the clinic, so replace it with real footage or confirm the sign with the clinic. The source is 1280×720, so it is a little soft on very large screens
- [ ] Doctor experience, certifications and awards (specialities and bios are in; `doctors` in `src/data/site.ts`)
- [ ] Set `GOOGLE_PLACES_API_KEY` + `GOOGLE_PLACE_ID` in Vercel (see *Live Google reviews*); confirm the three built-in fallback reviews are approved for use
- [ ] Home visits: the booking form offers a "Home visit" chip and the FAQ answer is still `[TBD]` — confirm the clinic does them (or remove the chip in `Booking.astro`)
- [ ] FAQ answers: home visits, session length (`faqs` — unconfirmed ones are excluded from FAQ structured data). The pricing section and the starting-price question were removed; add them back only once the clinic confirms real prices
- [ ] Sign-off on promise-style copy — "Physiotherapy that puts an expiry date on your pain.", "Gomti Nagar's trusted physio clinic", the first built-in review ("within 3 days he became quite normal"), read as outcome commitments, which PRD §37 steers away from
- [ ] Clinic's Google Business Profile URL (`links.directions` and `links.reviews` use a Maps search built from the verified address until a place ID is set; the map embed searches for the clinic by name and area — check it lands on the right pin)
- [x] Production domain: `https://geetakrishnaphysiotherapy.co.in` is the built-in default (`astro.config.mjs` + `seo.siteUrl`) and `www` redirects to it (`vercel.json`); `PUBLIC_SITE_URL` still overrides it. Canonical, sitemap and `og:image` are built from it; confirm title/meta description copy. The meta description says "460+ Google reviews" and the structured data says 467 (the figure on the page) — update both as the count grows. A bespoke `og-image.jpg` was not supplied, so social previews keep using the generated `og.png`
- [ ] **Clinic-reported figures** (`stats` in `src/data/site.ts`; owner confirmed both on 1 Nov 2026, but the evidence has not been seen by the developer): "2 Lakh+ Patients Treated" (hero chip, stats strip, FAQ, `/llms.txt`, meta description) and "70–80%+ Positive Treatment Outcomes" (stats strip, FAQ, `/llms.txt`; always shown with `stats.outcomeNote`). Keep the clinic's written definition of a "positive outcome" and which patients/treatments it covers on file, and refresh the figures if they change. Not in structured data (no schema.org type fits).
- [ ] GA4 + Search Console approval

## Local SEO / AEO / GEO

- **Canonical + sitemap** use the production domain; `www` 308-redirects to the bare domain.
- **Title / description** target "physiotherapy in Gomti Nagar, Lucknow" (`seo` in `site.ts`), with `geo.region` / `geo.placename` meta, an `en-IN` hreflang and full Open Graph + Twitter tags.
- **Structured data** (one linked `@graph` in `Base.astro`): WebSite, WebPage (with `speakable`), the Physiotherapy clinic (address, hours, areaServed, services, rating), a Person per doctor (credential, specialities), plus `FAQPage` from the confirmed FAQs. No coordinates are published yet: add `geo` once the clinic's Google Business Profile pin is confirmed.
- **Answer engines:** the FAQ answers "neuro / ortho physiotherapist in Lucknow", who the doctors are and where the clinic is. `/llms.txt` is generated from the same data; `/robots.txt` welcomes search and AI crawlers and keeps only `/api/` out.
- **Landing pages:** `src/data/landing.ts` holds ten pages ("neuro physiotherapy Lucknow", "back pain physiotherapy Lucknow", …), all rendered by `src/pages/[slug].astro` at `/<slug>/`, each with its own title, FAQ, `Service` + `BreadcrumbList` + `FAQPage` data, doctor card, and internal links. They are linked from the footer, and every one lands in the sitemap automatically. To add a page, add an entry to `landingPages`; keep to confirmed facts (no outcomes, prices, timelines or home visits).
- **Sitemap:** generated at build (`/sitemap-index.xml` → `/sitemap-0.xml`); `/sitemap.xml` is rewritten to it (`vercel.json`). `seo/sitemap.xml` is a plain copy for manual upload; regenerate it from `dist/sitemap-0.xml` after adding pages.
- **Still needs the clinic (off-site, the biggest local lever):** claim and complete the Google Business Profile (same name, address, phone and hours as the site), keep collecting Google reviews, and list the same name/address/phone on Practo and Justdial.

## Design & accessibility notes

- **Typography is deliberately restrained:** hero 34→76px (it now sits on a video, so it is larger), section headings 30→46px, subheadings 21→28px, body 16–18px on desktop. On phones the scale is fluid: hero `clamp(34px, 9vw, 72px)`, headings `clamp(28px, 7vw, 56px)`, body 15–16px. The `min()` in `global.css` hands over to the desktop scale at ~430px, so tablet and desktop sizes are unchanged (the 56 / 72px ceilings would have enlarged them ~20%).
- **Photography leads where it exists.** Real photos replace their slot automatically; the doctors show monograms until a portrait is supplied, and the gallery is one banner holding the photos supplied so far. Decoration is limited to fine lines, dot texture and soft background circles.
- **Map:** a real, lazy-loaded Google Maps iframe with a translucent teal wash over it. It is covered by a "Tap to explore" layer so a page scroll can't be swallowed by the map on phones; one tap hands it over, tapping elsewhere takes it back. "Open in Google Maps" stays as a plain link.
- **Glassmorphism** is used sparingly on floating layers only (header, mobile menu, sticky CTA bar, review/contact panels; the hero chips are plain translucent fills — see *Hero video*). Blur is capped on small screens and has a solid fallback where `backdrop-filter` is unsupported.
- **Motion** is CSS keyframes/transitions, native CSS scroll-driven animations, and one IntersectionObserver-driven script — no animation library. Everything animates `transform`/`opacity` only (plus one `clip-path` wipe on the doctor portraits):
  - **Load:** eyebrow → headline → subtext → Hindi line → CTAs → pills → hours card fade up 24px over 0.7s, 120ms apart (pure CSS, so CTAs never wait on JavaScript).
  - **Scroll reveal:** an IntersectionObserver adds `.in-view` once per element (then stops watching it). Sections fade up 24px over 0.7s (`ease`); card grids (conditions, approach steps, reviews) stagger by 80ms. The stats count up 5.0 / 467+ / 2 over 1.2s (ease-out), once, when the band comes into view.
  - **Background depth** (`Depth.astro`): warm base → soft teal/sand glow → faint dots → a barely-there 1px grid (large cells, 5–7% alpha, faded toward the edges) → a few oversized thin circles and a hairline. Used on conditions, "why", gallery and visit sections. On the hero and conditions sections the glow + circles (`.d-far`, ±14px) and the grid (±6px) drift as the section scrolls past; on the dark and gallery sections the same texture stands still (see Performance). Only decorative layers ever move.
  - **Per-section choreography** (all once per entry): trust numbers rise one after another and the labels trail them; "why" blocks draw their rule, surface the numeral, then bring in the text; doctor portraits wipe down (clip-path) with name/details ~110ms behind; gallery tiles arrive from different directions with captions sliding in after them; the "How it works" line draws as you scroll and the active step lifts 3px with a ring while the previous one settles back; the reviews section plays quote mark → text → rating and stars last; the visit text and map arrive from opposite sides (wide screens).
  - **Hero:** a full-bleed looping video (see *Hero video*); nothing else in the hero moves.
  - **Transition moments (two only):** a soft glow passes behind the "why" content, and the contact band's concentric rings settle into place — both one-shot when the section arrives.
  - **Hover** (0.2–0.25s): buttons lift 1px, the arrow nudges 4px and orange buttons brighten (a white veil fading in, so only opacity animates); the two main WhatsApp CTAs get a soft glow that belongs to the button (no pulse); condition cards lift 4px with a soft shadow, the ↗ slides 3px and a teal highlight passes across; doctor cards lift 2px (desktop); images zoom at most 1.02; the active nav link gets a thin teal underline; the FAQ opens/closes with an animated height and the + turns 45°.
  - **Header:** past 40px of scroll the bar tucks up and shrinks slightly and its frosted (blurred) layer fades in — transform and opacity only, so nothing reflows.
  - **Ambient:** the ticker between hero and conditions (pauses on hover). Looping animations pause whenever their section is off screen.
  - `prefers-reduced-motion` turns it all off: reveals and the hero entrance show immediately, no parallax or depth drift, no ambient loops, no hover movement, the ticker becomes a static wrapped list, count-up/autoplay stop.
  - **Anchors:** `scroll-behavior: smooth`, and every `section[id]` has `scroll-margin-top` equal to the header height, so headings never land under it.
  - Scroll-driven animations are a progressive enhancement (`animation-timeline: view()/scroll()`); browsers without them simply show the layers still. **Gotcha:** they are written as animation *longhands* — the CSS minifier folds `animation` + `animation-timeline` into one shorthand that Chromium silently rejects.
- **Dark sections** share one `DarkFx` layer: a static film-grain tile plus a teal and a warm-orange orb at 20% opacity (radial gradients, no `filter: blur`). The orange orb is a deliberate, subtle exception to "orange is for actions only".
- **Curved dividers:** any section with the `curve` class rises over the padding of the one above with an elliptical top edge, so light/dark bands never meet in a hard cut (pure `border-radius`, no images).
- **Live "Open now" pill** is computed in the browser against clinic time (Asia/Kolkata), so a visitor abroad still sees the right status. Without JS it shows the plain hours.
- **Condition cards** open WhatsApp in a new tab with "…I'd like to ask about <Condition>."; the doctors' buttons ("Book with Dr. …") do the same with their own message. The **booking form** is the only form on the page (the old concern-only form in the contact band was merged into it); it only builds a ready-to-send WhatsApp message and stores nothing.
- **Book your visit** (`01` — it sits straight after the hero, before the stats strip; the nav lists *Book* first and the other eyebrow numbers follow the page order): name, +91 phone (exactly 10 digits), concern, visit type, one of the next six open days (Mon–Sat, in clinic time — a visitor abroad still sees clinic dates; today counts only until the last session ends) and a time of day. Invalid input shows inline errors and WhatsApp stays closed; valid input opens one new tab with the request. The copy says *request* throughout; availability is never claimed.
- **Phones (≤768px):** a fixed bottom bar (Call + WhatsApp the Clinic, 60px plus the safe-area inset) replaces the floating bubble, the page has 76px of bottom padding (the footer's colour is painted into it), and the menu is one scrollable column with the WhatsApp button pinned at the bottom. Touch targets are ≥44px (chips 48px, form fields 52px / 16px text so iOS doesn't zoom).
- **Review slider:** one card at a time on phones, three across on desktop; dots, arrows, a pause button, and a 6s autoplay that stops on hover, touch, focus, when off screen, in a background tab, and for reduced-motion users.
- **CTA contrast:** white on the PRD's CTA orange `#EA580C` is 3.55:1, which meets WCAG AA only as *large text*. Primary-button labels are therefore bold and ≥ 14pt (18.7px). If a stricter 4.5:1 is wanted, change `--color-cta` to `#C2410C`.
- Content rules from PRD §37 are followed: no superlatives, guarantees, urgency or invented statistics.

### Hero video

- **What it is:** `src/assets/video/hero-loop.mp4` (1280×720) and `hero-loop-m.mp4` (a 640×720 crop of the same shot around the entrance, for phones), both ~5s, H.264, no audio track, 1.0 MB and 0.5 MB. They are the first continuous shot of the supplied clip (the clip has hard cuts at 6.0s and 8.4s, which would fight the headline), looped with a 1s dissolve so the seam is soft.
- **Loading:** nothing blocks the page. The poster (`hero-poster.webp`, served as AVIF/WebP, eager + high priority, fixed size) paints first; after `load` and an idle moment `scripts/hero-video.ts` attaches the right file and fades it in once it is really playing. Reduced motion, data-saver and 2G keep the still; so does a blocked autoplay or a failed download.
- **Behaviour:** muted, looped, `playsinline`; paused while the hero is off screen or the tab is hidden; a visible pause button (WCAG 2.2.2) appears once it plays and a visitor's own pause is respected.
- **Layout:** phones (<640px) show the 4:5 picture as a band across the top with the words on the pine below it, so no face sits behind text; tablets (640–1023px) the same with a 16:9 band; from 1024px it is full-bleed with a shade that follows the text column (contrast was measured behind every text element at nine widths and six moments of the loop: ≥4.5:1 for body text, ≥4.6:1 for the headline).
- **No blur over the video:** the chips use plain translucent fills, and the header turns from frosted glass to a near-opaque bar while it floats over the hero (`.is-over-video`), because a backdrop blur redraws on every video frame (measured: it was the whole cost of scrolling past the video).
- **To re-cut it:** keep one continuous shot, export the desktop and phone files as above (`ffmpeg … -an -c:v libx264 -crf 27 -movflags +faststart`; phone crop `crop=640:720:540:0`), and export frame 0 of the loop as `src/assets/clinic/hero-poster.webp`. The poster's phone framing (`object-position` in `Hero.astro`) assumes that crop window.

### Elevation pass

- **Hero:** see *Hero video* above. The rating and open/closed pills and the hours card sit on translucent dark chips over the picture.
- **Hindi line** under the hero subtext: Tiro Devanagari Hindi italic, teal, 90% of the subtext size. The webfont is **subset to that one line (13 KB instead of 100 KB)** — if the wording changes, regenerate it with the command in the comment above the `@font-face` in `global.css` (the full font is a dev dependency for that purpose).
- **Pain list + body map** — the list is exactly six cards (Back, Neck, Shoulder / Frozen Shoulder, Knee / Arthritis, Sciatica, Sports Injuries), one hotspot each; the other conditions and services live in the FAQ answer only. The booking form's *Concern* dropdown has its own, longer list (`concerns` in `Booking.astro`) and is unchanged.
- **Body map** (top of *02 / Conditions*): six pulsing hotspots (Neck, Shoulder, Back, Knee, Leg → Sciatica, Sports → Sports Injuries; 44px touch areas) scroll to the condition card with the matching title and ring it in orange for 1.2s. The mapping lives in `BodyMap.astro`, and the build fails if a target title disappears from `conditions`. Reduced motion: no pulse, the ring shows still.
- **Doctor intro video:** drop `public/doctor-intro.mp4` in and a rounded 16:9 player (native controls, `preload="none"`) appears in *03 / Doctors* at the next build; without the file nothing is rendered. Add captions before publishing a spoken video.
- **Fonts** are self-hosted (`font-display: swap`), so there is no Google Fonts preconnect; the page preconnects to `www.google.com` for the map embed only.
- **Structured data** (`Physiotherapy` JSON-LD) carries the address, phone, hours and an `aggregateRating` of 5.0 / 467 — the site's own figures. Google does not show star snippets for a business's reviews of itself; the markup is there for completeness.

## Performance notes

Scroll smoothness is measured with scripted full-page scrolls in headless Chromium at 1440×900 and 390×844. That build renders in **software** (no GPU), so absolute numbers are pessimistic — the *comparison* between builds is what matters. Share of frames slower than 33 ms (real mouse-wheel scrolling; 2 runs each):

| Build | Desktop | Mobile (390px) |
|---|---|---|
| Motion pass (before the depth/choreography pass) | 3–4% | 0% |
| Depth pass, first cut (every section drifting) | 23–24% | 0.3% |
| Master update (real photos, map, live reviews) | 9–13% | 0% |
| **Shipped** (booking, mobile pass, animation pass; page is shorter, so the hero weighs more) | **14–16%** — measured *the same* as the build before the animation pass (A/B, interleaved) | **0.3%** |

So on a software compositor the depth pass still costs desktop scrolling roughly 6–9 percentage points; mobile is unaffected. Extra translated layers should be much cheaper in a GPU-composited browser, but that could not be measured in this environment — check on a real laptop before launch. If you want the old numbers back, set `drift={false}` on the `<Depth>` in `Hero.astro` / `Conditions.astro` (the texture stays, the drift stops) or delete the `.hero__orbit` element.

What the profiling found, and the rules that came out of it:

- **Never clip a whole section to a rounded rectangle.** Curved dividers built with `border-radius` + `overflow: clip` on each section cost ~46 points of dropped frames, because clipping a subtree that contains glass to a rounded rect forces extra per-frame compositor work. The dome is now a painted `::before`; only leaf ambient layers (`.fx`, `.bg`) follow the dome shape.
- **Large `backdrop-filter` panels are the most expensive thing on the page** (~16 points on their own). Panels on dark bands (`.glass-dark`) sit over flat gradients, so they keep the translucent-gradient glass look without the blur. Real blur stays on the header, hero cards and small photo chips, which measured free.
- **Every layer that animates behind content is its own composited surface, and the cost tracks the number of such layers far more than their size or how far they move.** Measured: merging layers, shrinking them, `will-change`, `contain`, removing masks and rounded clips all made little difference; *removing the animation* (or not promoting the layer) is what helps. Hence: depth drift only where it reads (light sections), one shared drifting layer for glow + circles, a grid that only exists on the busy side of the section, and the two transition moments as one-shot transitions instead of scroll-scrubbed animations. Continuous time-based loops on the same layers were twice as expensive as scroll-linked ones.
- The map's teal tint is a plain translucent overlay: a `mix-blend-mode` over the iframe, or a CSS `filter` on it, each made scrolling past the map 4–20% slower; both together were worst.
- Film grain (one 160px tile), the ticker, dot textures and the curve domes all measured as free. Orbs are static radial gradients.
- Re-measure after adding any new full-width or animated layer; a regression this size is invisible in a screenshot and in Lighthouse (which scores load, not scroll).

## Phase 2 (not built)

A real booking system (calendar, confirmations), doctor and condition pages, blog and admin are deliberately absent. The component-per-section structure and the single data module are the extension points.
