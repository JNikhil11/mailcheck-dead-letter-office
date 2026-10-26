# MailCheck — Design Document

**Version:** 2.0 (Hardened Production Release)  
**Status:** Implementation-verified visual and interaction spec  
**Date:** 26 October 2026  
**Product:** Bulk Email Address Verification Web Application  
**Companion to:** MailCheck PRD v2.0  
**Design concept:** The Dead Letter Office

## 1. Executive summary

MailCheck verifies email addresses, so its interface is built as a **postal sorting office**. A pasted list is an *intake slip*, every address is a *letter*, every result is a *rubber stamp*, and every technical check leaves a *postmark*.

The metaphor is chosen because the post office already has a vocabulary for MailCheck's three outcomes:

| MailCheck status | Postal meaning |
|---|---|
| Likely Deliverable | Letter cleared for delivery |
| Likely Bounce | "Return to Sender" |
| Unknown | The Dead Letter Office, where mail goes when nobody can say where it belongs |

This makes the PRD's central principle visible in the design: **Unknown is a valid and honest answer.** It is not an error state, and it gets its own distinctive stamp and its own sorting cubby.

The look is deliberately tactile and print-like: uncoated paper, two-colour riso-style ink, typewriter text, and imperfect stamps. It avoids the dark-mode, gradient, glass-effect and glow styling common to generic AI-generated tool interfaces.

## 2. Design goals

- Look distinctive and human-made, never like a template.
- Make the evidence behind each verdict visible (what was checked, what was not).
- Present uncertainty as a first-class outcome, not a failure.
- Stay fast, accessible and readable at 1,000 rows; texture is decoration, never a barrier.
- Build with plain HTML, CSS and JavaScript so it deploys on Vercel with no framework.
- Keep status meanings identical across UI, API, tests and README (PRD §11).

## 3. Design principles

1. **Honest by design.** The interface never implies more certainty than the checks provide. A postmark proves a letter was posted, not that anyone lives at the address.
2. **Texture, not chaos.** Imperfection lives in surfaces, ink and type. Layout, table structure and navigation stay conventional and predictable.
3. **Text first, colour second.** Every status is readable as words and distinguishable by shape; colour is reinforcement only.
4. **One animation that matters.** The stamp landing is the only signature motion.
5. **Cheap to render.** Effects use SVG filters and CSS only, with no image downloads required.

## 4. Visual language

### 4.1 Colour tokens

Two-ink print palette on paper. No gradients, shadows with blur, glassmorphism or glow.

| Token | Hex | Use |
|---|---|---|
| `--paper` | `#EFE7D3` | Page background |
| `--paper-deep` | `#E4DAC0` | Panels, table stripes |
| `--ink` | `#1B1A17` | Body text, borders, Unknown stamp |
| `--ink-red` | `#E8431F` | Likely Bounce stamp, large display accents |
| `--ink-red-text` | `#B3290C` | Small red text (meets contrast on paper) |
| `--ink-blue` | `#1F3FBF` | Likely Deliverable stamp, links, focus ring |
| `--kraft` | `#C9A978` | Pigeonhole cubbies, dividers |

Contrast notes:
- `--ink` on `--paper` is well above 7:1.
- `--ink-blue` on `--paper` is above 4.5:1 for text.
- `--ink-red` is for large or bold display text and graphics only (3:1 minimum). Use `--ink-red-text` for any small red text.

### 4.2 Typography

| Role | Font | Fallback | Notes |
|---|---|---|---|
| Display / headings | **Anton** | Impact, "Arial Narrow", sans-serif | Uppercase, tight tracking |
| Body, addresses, reasons | **Courier Prime** | "Courier New", monospace | Minimum 16px; addresses in regular weight |
| Stamps | **Special Elite** | "Courier New", monospace | Used only inside stamp components |

Self-host the three fonts as `woff2` with `font-display: swap`. Limit to the weights actually used.

### 4.3 Paper grain and ink roughness

Implemented with inline SVG filters; no image assets.

- **Grain:** a full-page overlay using `feTurbulence` (`baseFrequency` about 0.8, 2 octaves) at 6–8% opacity, `pointer-events: none`, `mix-blend-mode: multiply`.
- **Ink roughness:** stamps pass through `feTurbulence` plus `feDisplacementMap` (scale 1.5–2.5) so edges look uneven.
- **Misregistration:** headings render in `--ink` with a 1.5px offset duplicate in `--ink-blue` or `--ink-red` using `mix-blend-mode: multiply`, imitating off-register riso printing.
- All effects switch off under `prefers-contrast: more` and when `data-texture="off"` is set (see §12).

### 4.4 Shape and border rules

- Corners are square. Borders are 2px solid `--ink`, with stamps using a double border.
- Dividers are dashed (perforation style).
- No rounded cards, soft shadows or blurred layers.

## 5. Layout

### 5.1 Page structure (desktop, 1024px and wider)

Single centred column, maximum width 1040px.

1. **Masthead.** "MAILCHECK" in Anton, subtitle "Dead Letter Office — address verification", and a small circular postmark showing the current date.
2. **Intake slip.** The input area (see §6.1).
3. **Pigeonholes.** Summary counts (see §6.3).
4. **Ledger.** The results table (see §6.4).
5. **Footnote.** The honesty statement (see §9).

### 5.2 Responsive behaviour

| Breakpoint | Behaviour |
|---|---|
| 1024px and above | Full table, pigeonholes in one row of four |
| 640–1023px | Table keeps Address, Status, Reason; postmarks wrap beneath the reason |
| Below 640px | Table becomes stacked **letter cards**: address on top, stamp, reason, postmarks. Pigeonholes become a 2×2 grid |

Touch targets are at least 44×44px. No horizontal page scroll at 320px width.

## 6. Components

### 6.1 Intake slip

- A lined-paper textarea: thin ruled lines drawn with a repeating CSS background sized to the line height, plus a left red margin rule.
- Label: "Paste addresses, one per line".
- Live counter: "N addresses · max 1,000".
- Buttons:
  - **Verify** (primary): solid `--ink` block, `--paper` text, 3px offset hard shadow in `--ink-red`.
  - **Cancel** (`#cancel-btn`, secondary, hidden initially): visible during verification to abort in-flight requests and return to idle without losing completed results.
  - **Clear** (secondary): outlined button to reset all state and inputs.
  - **Load sample** (tertiary text button): fills the example list from the specification.
- Validation messages appear directly under the textarea as a bordered note (`#validation-note`, hidden initially), never as an unstyled alert or intrusive popup.

### 6.2 Status stamps

The primary stamp text is **always the exact status label** used by the API and README. A secondary flavour line sits beneath it in smaller type.

| Status (API value) | Stamp text | Flavour line | Colour | Shape (non-colour cue) |
|---|---|---|---|---|
| `likely_deliverable` | LIKELY DELIVERABLE | CLEARED FOR DELIVERY | `--ink-blue` | Rectangle, double border, ✓ glyph |
| `likely_bounce` | LIKELY BOUNCE | RETURN TO SENDER | `--ink-red` | Rectangle, double border, ✕ and ↩ glyph |
| `unknown` | UNKNOWN | DEAD LETTER — NOT CONFIRMED | `--ink` | Dashed oval, ? glyph |

Rules:
- Rotation is deterministic: derived from a hash of the email address, mapped to pre-baked rotation CSS utility classes (`stamp-rot-n40` ... `stamp-rot-p40`) between −4° and +4°, ensuring strict CSP compliance with zero inline `style=` attributes.
- Stamp text never exceeds 4° rotation so it remains readable.
- Stamps do not use `role="img"`; the status word is real text in the DOM so screen readers read it directly.
- Ink opacity 0.9, with the roughness filter from §4.3.

### 6.3 Pigeonholes (summary and filter)

Four cubby buttons: **All**, **Likely Deliverable**, **Likely Bounce**, **Unknown**.

- Each shows the count in Anton at large size, with the label beneath.
- Styled as kraft-coloured sorting slots with a visible inner border.
- Clicking filters the ledger. Active cubby shows `aria-pressed="true"` and a thick underline.
- Counts are occurrence-weighted: duplicate occurrences add their full occurrence count (`item.count || item.occurrences || 1`), ensuring the totals sum exactly to the submitted non-empty address count.

### 6.4 Ledger (results table)

Semantic `<table>` with `<caption>`, `<thead>` and `scope="col"` headers.

| Column | Content |
|---|---|
| # | Row number in Courier Prime |
| Address | The submitted address (first-seen casing, with `× N` duplicate badge if duplicated), monospace, break-all on narrow screens |
| Status | The stamp (§6.2) |
| Reason | One human-readable sentence from the API |
| Postmarks | Three check postmarks (§6.5) |

- Rows are separated by dashed rules; every second row uses `--paper-deep`.
- Sorting: click a column header (Address, Status). Header buttons expose `aria-sort`.
- Rows render in submission order by default.

### 6.5 Postmarks (checks performed)

Three small circular marks per row, one for each check from the API's `checks` object.

| Check | States and labels |
|---|---|
| Syntax | PASS, FAIL |
| MX | FOUND, NONE, DOMAIN NOT FOUND, ERROR |
| Recipient | NOT CHECKED, ACCEPTED, REJECTED, INCONCLUSIVE |

- Circle outline plus the abbreviation (SYN, MX, RCPT) and the state word on two lines, in uppercase at a minimum of 11px. Postmarks are the only place text may be smaller than 16px; all other text is 16px or larger.
- Failed or negative states use `--ink-red-text`; positive states use `--ink-blue`; not-checked and inconclusive use `--ink` with a dashed outline.
- **Recipient: NOT CHECKED** is the honest default state when Port 25 is blocked and no external verification API is configured.
- Each postmark has a `title` and visually hidden text, for example "Recipient check: not checked".

### 6.6 Progress & Error Handling

Large batches are sent to the API in chunks of 50 unique addresses with a 20000ms client timeout so each serverless call stays comfortably within Vercel's 15s `maxDuration` and 8000ms batch budget.

- A paper-tape progress strip reads "Sorted 300 of 1,000".
- Interactive cancellation is supported via `#cancel-btn` and `#cancel-btn-collapsed`.
- If a batch fails (partially or fully), a visible `#error-banner` displays the exact failure reason and provides `#retry-btn` to re-attempt only failed chunks without re-processing successful rows.
- Progress text sits in an `aria-live="polite"` region and updates at most once per chunk.

### 6.7 Export

- **Bundle results (CSV)** button and **Copy results** button above the ledger.
- Exact 7 CSV columns: `email,status,reason,syntax,mx,recipient,occurrences`.
- Formula sanitization: prefixes formula injection triggers (`=`, `+`, `-`, `@`, `|`, `%`, `\t`, `\r`, `\n`, and full-width Unicode variants `\uFF1D`, `\uFF0B`, `\uFF0D`, `\uFF20`, `\u2212`, `\uFE62`, `\uFE63`, `\uFE66`) with `'` and replaces internal newlines with space.
- Buttons appear only when there is at least one result.

## 7. Interaction and motion

### 7.1 Verify flow

1. User presses **Verify**. Button changes to "Sorting…" and is disabled.
2. The intake slip collapses to a one-line summary ("1,000 addresses submitted") with an **Edit list** link.
3. The ledger appears with empty rows; each row shows a dashed "awaiting stamp" outline.
4. As each result arrives, its stamp lands (see §7.2).
5. Pigeonhole counts increment as results arrive.
6. When complete, the progress strip reads "Sorting complete" and focus moves to the ledger caption.

### 7.2 Stamp animation

| Property | Value |
|---|---|
| Duration | 220ms |
| Keyframes | Scale 1.35 to 1.0, opacity 0 to 0.9, rotation settles to its assigned angle |
| Easing | `cubic-bezier(0.2, 0.9, 0.3, 1.2)` (slight overshoot) |
| Stagger | 15ms per row within a chunk, capped at 600ms total |

- Only the first 30 rows of a chunk animate; the rest appear instantly to protect performance.
- Under `prefers-reduced-motion: reduce`, stamps appear instantly with no scale or rotation animation, and the progress strip updates without motion.

### 7.3 Other motion

- Hover on buttons: the hard shadow shifts 2px (press-in effect).
- Focus ring: 3px solid `--ink-blue` with 2px offset, always visible, never removed.
- No parallax, scroll-jacking, cursor effects or looping animation.

## 8. States

| State | Presentation |
|---|---|
| Empty (first load) | Intake slip with placeholder lines showing the assignment's sample addresses in faded type, plus the "Load sample" link |
| Validating input | Counter turns `--ink-red-text` and note appears if over the 1,000 limit: "Too many addresses. The sorting office handles up to 1,000 at a time." |
| Loading | See §7.1 and §6.6 |
| Partial failure | A failed chunk marks its rows with the Unknown stamp and reason "This batch could not be checked. Try again."; other rows are unaffected (PRD §12) |
| Full failure (network or server) | A bordered banner above the ledger: "The request failed. Nothing was sent to any address." with a **Try again** button |
| No results after filter | Row reading "No letters in this slot." |
| Duplicates | Duplicate addresses are collapsed to one row with a "× N" tag; this behaviour is stated in the README (PRD §8.2) |
| Blank lines | Ignored silently; the counter shows only non-empty lines |

## 9. Content and microcopy

Tone: plain, dry, slightly postal. Humour is light and never obscures meaning. Error messages state what happened and what to do.

| Location | Copy |
|---|---|
| Masthead subtitle | Dead Letter Office — address verification |
| Textarea label | Paste addresses, one per line |
| Primary button | Verify |
| Button while running | Sorting… |
| Reason, malformed | Invalid email format |
| Reason, domain missing | Domain cannot be resolved |
| Reason, no mail route | Domain has no usable mail route |
| Reason, MX found, mailbox unconfirmed | Domain accepts mail, but the mailbox was not confirmed |
| Reason, recipient accepted | Recipient verification received a positive response |
| Reason, timeout | The check timed out, so the result is inconclusive |
| Footnote (always visible) | A postmark proves a letter was posted, not that anyone lives at the address. MX records show that a domain can receive mail, not that a particular mailbox exists. Results are predictions, not guarantees. |
| Privacy line | Addresses are checked in memory and discarded without database or browser storage, unless an optional external verification API is configured. No emails are sent. |

Reason strings must match those produced by the backend; the UI renders what the API returns and does not invent its own.

## 10. API-to-UI mapping

Uses the PRD's `POST /api/verify` response.

| API field | UI element |
|---|---|
| `results[].email` | Ledger Address column |
| `results[].status` | Stamp type, row filter, pigeonhole membership |
| `results[].reason` | Ledger Reason column |
| `results[].checks.syntax` | Syntax postmark |
| `results[].checks.mx` | MX postmark |
| `results[].checks.recipient` | Recipient postmark |
| `summary.*` | Pigeonhole counts (client recomputes across chunks) |

Status values (`likely_deliverable`, `likely_bounce`, `unknown`) are the only strings used for logic; display labels are looked up from one constant map so UI, tests and README cannot drift.

## 11. Technical implementation notes

- **Files:** `index.html`, `styles.css`, `app.js`, plus `api/verify.js` from the PRD. No bundler required.
- **JavaScript:** vanilla ES modules; no framework.
- **Rendering large lists:** render rows in batches with `requestAnimationFrame`, or paginate at 100 rows with a "Show more" button, so 1,000 rows never block the main thread.
- **SVG filters:** defined once in a hidden inline `<svg>` and referenced by CSS `filter: url(#ink-rough)`.
- **Stamp rotation:** `rotate = ((hash(email) % 81) - 40) / 10` degrees.
- **Security:** insert addresses with `textContent`, never `innerHTML`, since user input is untrusted.
- **Privacy:** no analytics scripts, no third-party requests except self-hosted fonts; addresses are never written to `localStorage` or logs.

Starter token block:

```css
:root {
  --paper: #EFE7D3;
  --paper-deep: #E4DAC0;
  --ink: #1B1A17;
  --ink-red: #E8431F;
  --ink-red-text: #B3290C;
  --ink-blue: #1F3FBF;
  --kraft: #C9A978;
  --font-display: "Anton", Impact, "Arial Narrow", sans-serif;
  --font-body: "Courier Prime", "Courier New", monospace;
  --font-stamp: "Special Elite", "Courier New", monospace;
}
```

## 12. Accessibility

- Status is conveyed by text, shape and glyph as well as colour (PRD §12).
- Body text is at least 16px; postmark labels are the only smaller text and are duplicated in accessible text.
- Table semantics, `aria-sort`, `aria-pressed` on filter cubbies, and an `aria-live` progress region.
- Full keyboard operation: Tab order follows visual order; Enter and Space activate cubbies and buttons.
- Visible focus indicator on every interactive element.
- `prefers-reduced-motion` removes all animation (§7.2).
- `prefers-contrast: more` removes grain, roughness and misregistration, and thickens borders.
- Stamp rotation never exceeds 4°, and rotated text is never the only place information appears.
- Texture overlay has `pointer-events: none` and `aria-hidden="true"`.
- A **Plain view** toggle in the footer sets `data-texture="off"`, removing grain and ink filters for users who find them distracting.

## 13. Performance budget

| Item | Budget |
|---|---|
| HTML + CSS + JS (gzipped) | 40 KB or less |
| Fonts (three `woff2` files, subset to Latin) | 120 KB or less |
| Images | None required |
| Largest contentful paint (mid-range phone, 4G) | 2.5 s or less |
| Rendering 1,000 result rows | No single main-thread task over 100 ms |

## 14. Acceptance criteria

- The interface uses the paper, ink, typewriter and stamp language described above, with no dark theme, gradients, blur or glow.
- Each status renders with its exact label, glyph and shape, and is distinguishable in greyscale.
- Pigeonhole counts always sum to the number of submitted non-empty addresses and filter the ledger correctly.
- Every row shows three postmarks that reflect the API's `checks` values, including "Recipient: NOT CHECKED" when recipient verification did not run.
- The footnote and privacy line are visible without scrolling past the ledger on desktop.
- Layout works from 320px to 1440px with no horizontal page scroll.
- All interactions work by keyboard, and reduced-motion and high-contrast preferences are honoured.
- A failed chunk does not blank the rest of the results.
- The deployed page matches the README's description of what it can and cannot verify (PRD §8.11).

## 15. Test plan

| Scenario | Expected behaviour |
|---|---|
| Paste the assignment's four sample addresses | Four rows, one stamp each, counts sum to 4 |
| Malformed address | Likely Bounce stamp, Syntax postmark FAIL, reason "Invalid email format" |
| Known provider, mailbox unconfirmed | Unknown stamp, MX postmark FOUND, Recipient postmark NOT CHECKED |
| Nonexistent domain | Likely Bounce stamp, MX postmark DOMAIN NOT FOUND |
| 1,000 addresses | Ten chunks, progress strip updates, no frozen UI |
| 1,001 addresses | Validation note appears, Verify is blocked |
| Duplicate addresses | Collapsed into one row with a count tag |
| Network failure mid-batch | Affected rows marked Unknown with retry message; others retained |
| Keyboard only | Every control reachable and operable; focus always visible |
| Reduced motion enabled | No animation; results appear instantly |
| Greyscale screenshot | Three statuses still distinguishable by shape and text |
| Screen reader | Table, status words, filters and progress are announced correctly |
| Address containing `<script>` | Rendered as plain text, never executed |

## 16. Risks and mitigations

- **Style obscures function.** Mitigation: conventional table and navigation structure, strict contrast and size rules, Plain view toggle.
- **Filters hurt performance on low-end phones.** Mitigation: filter applied only to stamps and grain overlay, disabled in Plain view and when reduced motion or contrast preferences are set.
- **Cute copy confuses meaning.** Mitigation: the exact status words are always primary; postal phrases are secondary lines only.
- **Fonts fail to load.** Mitigation: monospace and Impact fallbacks keep layout intact.
- **Large result sets slow rendering.** Mitigation: batched rendering and a 100-row page size.

## 17. Build plan

1. Set up tokens, fonts, paper background and SVG filters.
2. Build the intake slip, counter and validation.
3. Build the ledger table, stamps and postmarks using hard-coded sample data.
4. Build pigeonhole filters and sorting.
5. Connect to `POST /api/verify` with chunking, progress and error states.
6. Add motion, reduced-motion and contrast handling, and the Plain view toggle.
7. Add CSV export and copy.
8. Run the test plan and accessibility checks, then deploy and verify the public URL.
9. Write the README, including a short note on the design concept and the deployment's actual verification limits.

## 18. Definition of done

A user can open the public site, paste a list, and watch each address receive a stamp, a reason and three postmarks that honestly show what was and was not checked. The design is unmistakably its own, works for keyboard and screen-reader users, respects motion and contrast preferences, and the interface wording matches the PRD's status rules and the README exactly.
