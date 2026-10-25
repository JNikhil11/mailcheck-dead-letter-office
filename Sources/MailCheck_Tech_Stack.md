# MailCheck — Technology Stack Document

**Version:** 1.0  
**Date:** 25 October 2026  
**Based on:** MailCheck PRD v1.0 and MailCheck Design Document v1.0  
**Design concept:** *The Dead Letter Office*

## 1. Recommendation at a glance

Build MailCheck as a **static website with a small serverless backend**. Use plain HTML, CSS, and JavaScript on the frontend, one Node.js API route on Vercel, Node's built-in DNS functions for MX checks, and a small validation library for email syntax. Do not add a frontend framework, database, AI model, or bundler for the MVP.

| Area | Selected technology | Why it fits |
|---|---|---|
| Frontend | HTML5 | Semantic, accessible page structure; no framework required |
| Styling | CSS | Paper-and-ink visual design, responsive layout, texture and stamp effects |
| Browser logic | Vanilla JavaScript ES modules | Input parsing, filtering, sorting, chunking, progress, rendering and export |
| Backend | Node.js serverless function | Runs verification logic without managing a server |
| Backend endpoint | `POST /api/verify` in `api/verify.js` | Matches the PRD/design API contract and Vercel's function model |
| Email syntax | `validator` npm package (`isEmail`) or equivalent maintained validator | Avoids maintaining a custom syntax parser |
| DNS/MX | Node.js built-in `node:dns/promises` | Looks up MX records without a paid verification API |
| Hosting | Vercel | Serves static files and the API function from one deployment |
| Source control | Git + GitHub (recommended) | Version history and straightforward Vercel deployment |
| Tests | Node.js built-in test runner (`node:test`) | Tests classification and API helper logic without a large test framework |
| Fonts | Self-hosted WOFF2 files for Anton, Courier Prime and Special Elite | Matches the design and avoids runtime font-provider requests |
| Data storage | None | The MVP processes submissions and discards them; no accounts or database |

## 2. System architecture

```text
User's browser
  ├─ index.html      → semantic page structure
  ├─ styles.css      → paper, ink, stamps, responsive/accessibility styles
  └─ app.js          → input parsing, deduplication, filters, table, progress
           │
           │ POST /api/verify with up to 100 unique addresses per request
           ▼
Vercel Node.js Function: api/verify.js
  ├─ validates request and limits
  ├─ checks address syntax
  ├─ looks up domain MX records using node:dns/promises
  ├─ assigns conservative status and reason
  └─ returns structured JSON; no email is sent
           │
           ▼
Browser renders stamps, postmarks and counts
```

The browser accepts up to 1,000 non-empty address entries, collapses duplicate addresses for display, and sends unique addresses to the API in chunks of 100. Progress is shown after each chunk. Aggregate counts should account for duplicate frequency so the four status totals still sum to the total number of non-empty submitted entries, while the ledger can show one row per unique address with an `× N` duplicate marker.

## 3. Frontend stack

### HTML

Use semantic HTML elements, including a labelled `<textarea>`, buttons, a results `<table>` with `<caption>`, `<thead>` and column scopes, and visible validation/error messages. Keep status words as real DOM text rather than image-only stamps.

### CSS

Use CSS custom properties for the colour tokens defined in the design document. Implement the paper background, ruled intake slip, perforation dividers, stamps, responsive layouts, high-contrast mode, and plain-view toggle in CSS. Use inline SVG filters for paper grain and stamp roughness; no image assets are needed.

Use the design document's three typefaces, self-hosted as WOFF2: Anton for display text, Courier Prime for body/address text, and Special Elite for stamps. Keep fallback fonts defined. Check font licensing before redistributing the font files.

### Vanilla JavaScript (`app.js`)

Use ES modules and browser APIs only; no React, Vue, build system, or bundler is required. The frontend owns:

- splitting the textarea into lines, trimming whitespace, ignoring blank lines and enforcing the 1,000-entry limit;
- normalizing and deduplicating addresses for checks/display, while retaining duplicate counts;
- calling `/api/verify` in chunks of 100;
- progress text and partial-failure handling;
- rendering results safely with `textContent`, never `innerHTML` for user-supplied values;
- filter cubbies, sortable table headings, copy and CSV export;
- the stamp animation, keyboard interactions, `aria-live` progress, reduced-motion handling and Plain view toggle.

## 4. Backend stack

### Runtime and deployment

Use a Vercel Node.js Function at `api/verify.js`. The function processes one batch of at most 100 unique addresses. It does not need Express or a long-running server. Keep verification logic in small helpers so it can be tested independently.

### Syntax validation

Use the `validator` package's `isEmail` function or an equivalent maintained email syntax library. Syntax validation establishes only that an address is plausible in format; it does not establish that the domain or mailbox exists.

### DNS/MX checks

Use Node.js `node:dns/promises`, particularly MX resolution, to inspect the domain's email routing. Handle outcomes deliberately:

- usable MX records found → `mx: "found"`;
- confirmed domain not found → `mx: "domain_not_found"`;
- confirmed absence of usable mail routing → `mx: "none"`;
- transient resolver error or timeout → `mx: "error"` or an equivalent documented inconclusive state.

Consider applicable mail-routing fallback behavior before classifying a domain as having no usable route. A temporary DNS failure is not proof that a domain does not exist.

### SMTP and third-party verification

**Do not make direct SMTP recipient verification a required part of the initial Vercel implementation.** Vercel blocks outbound TCP port 25, which is commonly used for direct mail-server connections. Mail servers may also conceal mailbox existence or accept all recipients during a probe.

For the MVP, set `checks.recipient` to `"not_checked"` unless a permitted, configured verification mechanism actually runs. If the project later integrates a third-party verification API, call it only from the backend, store the API key in a Vercel environment variable, and document the provider's cost, quotas, privacy terms and failure states. Never put an API key in `app.js` or another public asset.

A positive domain/MX check alone must never produce `likely_deliverable`. Reserve that status for sufficient recipient-level evidence from a configured method. In the no-provider Vercel MVP, many plausible addresses will correctly remain `unknown`.

## 5. API contract

**Endpoint:** `POST /api/verify`  
**Maximum batch:** 100 unique addresses per call.

Example request:

```json
{
  "emails": ["alice@example.com", "bad-address"]
}
```

Example response shape:

```json
{
  "results": [
    {
      "email": "alice@example.com",
      "status": "unknown",
      "reason": "Domain accepts mail, but the mailbox was not confirmed",
      "checks": {
        "syntax": "pass",
        "mx": "found",
        "recipient": "not_checked"
      }
    }
  ],
  "summary": {
    "total": 1,
    "likely_deliverable": 0,
    "likely_bounce": 0,
    "unknown": 1
  }
}
```

The example is illustrative, not a live verification. Use these exact status values throughout the frontend, API, tests and README:

- `likely_deliverable`
- `likely_bounce`
- `unknown`

Recommended check-state values:

- `checks.syntax`: `pass` or `fail`
- `checks.mx`: `found`, `none`, `domain_not_found`, `error`, or `not_checked`
- `checks.recipient`: `not_checked`, `accepted`, `rejected`, or `inconclusive`

Keep machine values lowercase and stable. Convert them to the design's uppercase postmark labels only in the UI. The reason string is supplied by the backend; the frontend must display it rather than inventing a separate explanation.

## 6. Classification rules

| Evidence | Result | Notes |
|---|---|---|
| Address fails syntax validation | `likely_bounce` | Reason: `Invalid email format` |
| Domain is confirmed not to exist | `likely_bounce` | Reason: `Domain cannot be resolved` |
| Domain has no usable email route after applicable fallback rules | `likely_bounce` | Reason: `Domain has no usable mail route` |
| MX records exist but recipient was not verified | `unknown` | Reason: `Domain accepts mail, but the mailbox was not confirmed` |
| Recipient check was blocked, timed out or inconclusive | `unknown` | Reason must explain the inconclusive check |
| A configured recipient verifier gives a reliable positive result | `likely_deliverable` | Still not a guarantee of eventual inbox delivery |
| A configured recipient verifier clearly rejects the mailbox | `likely_bounce` | Interpret provider response conservatively |

Do not convert an API/network error into `likely_bounce`. Do not send mail messages as part of any check. A postmark proves that a check occurred, not that a real user owns the mailbox.

## 7. Recommended repository structure

```text
mailcheck/
├── index.html
├── styles.css
├── app.js
├── api/
│   └── verify.js
├── assets/
│   └── fonts/
│       ├── anton-*.woff2
│       ├── courier-prime-*.woff2
│       └── special-elite-*.woff2
├── tests/
│   └── verify.test.js
├── package.json
├── README.md
└── .gitignore
```

No `vercel.json` is needed for a standard static site plus a conventionally located API function unless custom routing/configuration is later required. Do not commit secrets, generated font files without checking their licence, or user-submitted address lists.

## 8. Dependencies

### Runtime dependency

- `validator` — for email syntax validation, if selected. Keep the dependency list small and pin compatible versions in `package-lock.json`.

### Built-in capabilities

- `node:dns/promises` — DNS/MX lookup.
- `fetch` — available in supported modern Node.js runtimes for any later server-side API integration.
- Browser DOM, `fetch`, `requestAnimationFrame`, Clipboard API and Blob/object URLs — frontend calls, rendering, progress and CSV export.
- `node:test` and `node:assert` — backend/helper tests.

No database, authentication provider, queue, analytics service, CSS framework, UI framework, or model-serving platform is needed for the MVP.

## 9. Privacy and security

- Process addresses in memory and discard them after returning results; do not save the list to `localStorage`.
- Do not log full submitted addresses or the complete request body.
- Do not send email messages.
- Use `textContent` for user-controlled values; never concatenate address input into `innerHTML`.
- Validate JSON structure and enforce the batch-size limit on the backend too, not only in the browser.
- Add request timeouts and limit concurrent DNS lookups to avoid resource exhaustion.
- Do not expose optional verification API keys to the browser.
- Avoid analytics and unrelated third-party requests; fonts are self-hosted as specified by the design.

## 10. Performance and accessibility implementation

- Keep HTML, CSS and JavaScript at or below the design's 40 KB gzipped budget where practical; budget up to 120 KB total for the three subsetted WOFF2 fonts.
- Render long tables in batches or paginate at 100 rows; avoid a single blocking render task over 100 ms.
- Send API requests in chunks of 100 addresses; preserve completed chunks if a later chunk fails.
- Animate only the first 30 results per chunk; show remaining results immediately.
- Respect `prefers-reduced-motion` and high-contrast preferences.
- Use visible keyboard focus, accessible names, semantic table markup, `aria-sort`, `aria-pressed`, and an `aria-live="polite"` progress region.
- Convey statuses through text, glyph and shape—not colour alone.
- Offer the Plain view toggle to remove texture effects.

## 11. Testing approach

Use `node:test` for unit tests of syntax handling, normalization, DNS-result interpretation, status classification, and response-shape validation. Test the browser manually at minimum; automated browser testing with Playwright can be added if useful but is not required for the MVP.

Required scenarios:

1. Malformed syntax → `likely_bounce`, syntax postmark `FAIL`.
2. Valid-looking address with MX but unconfirmed mailbox → `unknown`, MX `FOUND`, recipient `NOT CHECKED`.
3. Confirmed nonexistent domain → `likely_bounce`, MX `DOMAIN NOT FOUND`.
4. DNS timeout/resolver error → inconclusive/`unknown`, not a false bounce.
5. 1,000 submitted entries → ten chunks of 100 unique addresses or fewer if duplicates are collapsed; progress remains responsive.
6. 1,001 entries → frontend blocks submission and backend independently rejects an oversized request.
7. Duplicate entries → one ledger row with an `× N` tag; aggregate status counts account for each occurrence.
8. A mid-batch failure → failed chunk receives `unknown` with the retry reason; completed results remain visible.
9. Address containing `<script>` → rendered as text; no execution.
10. Keyboard-only, screen-reader, grayscale, reduced-motion and narrow-screen checks pass.

## 12. Deployment and environment variables

1. Put the project in a Git repository and push it to GitHub.
2. Import the repository into Vercel.
3. Use the standard static frontend + Node.js function layout; verify `/api/verify` is deployed as a function.
4. Deploy and test the public URL using the test plan.
5. Add no environment variables for the baseline syntax + DNS version.
6. If an external verification provider is added later, add a server-side environment variable such as `EMAIL_VERIFICATION_API_KEY` in Vercel and configure it locally through an ignored `.env` file. Do not commit the secret.
7. Document that direct SMTP recipient checking on TCP port 25 is not available on Vercel; explain which checks are performed and why many recipients remain `unknown`.

## 13. Implementation order

1. Create `index.html`, `styles.css` and `app.js`; implement the paper-and-ink look and responsive input section.
2. Implement sample-data results, status stamps, postmarks, filters, sorting and summary counts.
3. Create `api/verify.js` with request validation, syntax checking, DNS/MX logic and conservative classification.
4. Connect the frontend with chunks of 100, progress updates, retry behavior and partial-failure handling.
5. Add accessible motion/contrast behavior, Plain view, and export/copy controls.
6. Write unit tests and run the design's acceptance checklist.
7. Deploy to Vercel, verify the live API and page, and document actual limitations in `README.md`.

## 14. Definition of done

The deployed application follows the Dead Letter Office design, accepts up to 1,000 entries, displays one reasoned result per unique address, shows postmarks that accurately reflect the checks performed, keeps summary counts consistent with duplicate entries, works accessibly on mobile and desktop, does not send email, and accurately describes the limitations of its live verification method. No AI/ML model, database or paid API is required for the base release.
