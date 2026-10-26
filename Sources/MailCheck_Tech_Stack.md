# MailCheck — Technology Stack Document

**Version:** 2.0 (Hardened Production Release)  
**Date:** 26 October 2026  
**Based on:** MailCheck PRD v2.0 and MailCheck Design Document v2.0  
**Design concept:** *The Dead Letter Office*

## 1. Recommendation at a glance

Build MailCheck as a **static website with a hardened serverless backend**. Use plain HTML, CSS, and JavaScript on the frontend, one Node.js API route on Vercel, Node's built-in DNS functions for MX checks with parallel A/AAAA fallback, a lazy `gmail.com` resolver canary, and RFC 5321 / 6531 byte-accurate syntax validation. Do not add a frontend framework, database, AI model, or bundler.

| Area | Selected technology | Why it fits |
|---|---|---|
| Frontend | HTML5 | Semantic, accessible page structure with zero inline styles; strict CSP compliant |
| Styling | CSS | Paper-and-ink visual design, responsive layout, texture, and stamp rotation utility classes |
| Browser logic | Vanilla JavaScript ES modules | Input parsing, case-insensitive deduplication, 50-address chunks, 20000ms timeout, `#cancel-btn` |
| Backend | Node.js serverless function (`api/verify.js`) | 15s `maxDuration`, 8000ms batch budget, 11000ms hard cutoff, 64 KB body limit |
| Backend endpoint | `POST /api/verify` in `api/verify.js` | Accepts up to 100 unique addresses from up to 1,000 raw lines |
| Email syntax | `validator` (`isEmail`) + RFC byte checks | Enforces 64-octet local-part, 253-octet domain, 254-octet total UTF-8 byte limits |
| DNS/MX | Node.js built-in `node:dns/promises` | 25 concurrency, 2000ms timeout, parallel A/AAAA fallback, RFC 7505 Null MX, lazy canary |
| SSRF Defense | Node.js built-in `node:net.BlockList` | Blocks loopback, RFC 1918, link-local, multicast, NAT64, 6to4, and IPv4-mapped IPv6 |
| SMTP Probing | Node.js built-in `node:net` | Lightweight non-sending probe with single-flight catch-all detection promise coalescing |
| Hosting | Vercel | Serves static assets with strict security headers (`Cache-Control: public, max-age=0, must-revalidate`) |
| Source control | Git + GitHub | Version history and automated CI/CD (`.github/workflows/ci.yml`) |
| Tests | Node.js built-in test runner (`node:test`) | 80 automated tests across 22 suites with 0 external network dependencies |
| Fonts | Self-hosted WOFF2 files (Anton, Courier Prime, Special Elite) | Matches design and eliminates external font-provider tracking |
| Data storage | None | Submissions are checked in memory and discarded; zero database or browser storage |

## 2. System architecture

```text
User's browser
  ├─ index.html      → semantic page structure (zero inline styles, #cancel-btn, #error-banner)
  ├─ styles.css      → paper, ink, stamps, responsive/accessibility styles, .svg-defs
  └─ app.js          → input parsing, case-insensitive deduplication, 50-address chunks, 20s timeout
           │
           │ POST /api/verify with up to 50 unique addresses per chunk (API limit 100 unique / 1,000 raw)
           ▼
Vercel Node.js Function: api/verify.js (15s maxDuration, 8000ms budget, 11000ms hard cutoff)
  ├─ enforces IP rate limit (60 req / 60s per client IP, strictly guarding proxy headers)
  ├─ validates request payload (max 64 KB, max 1,000 raw lines, max 100 unique addresses)
  ├─ case-insensitively deduplicates (toLowerCase) while preserving first-seen casing & counting occurrences
  ├─ checks RFC 5321 / RFC 6531 UTF-8 byte limits (64 octets local-part, 254 octets total)
  ├─ looks up domain MX records with 25 concurrency, 2000ms timeout, and lazy gmail.com resolver canary
  ├─ Stage 3: bounded concurrency recipient verification (max 10 concurrent):
  │    ├─ Tier 1. Tested Emailable v1 HTTPS adapter (SSRF-protected, Bearer auth, 4000ms timeout)
  │    ├─ Tier 2. Direct Port 25 SMTP probe (if enabled, single-flight catch-all probe, 2500ms timeout)
  │    └─ Default. Honest serverless fallback (Port 25 blocked on Vercel)
  ├─ assigns conservative status and reason
  └─ returns structured JSON with occurrence-weighted and unique counts; no email is sent
           │
           ▼
Browser renders stamps, postmarks, duplicate badges (× N), and pigeonhole counts progressively
```

The browser accepts up to 1,000 non-empty address entries, collapses duplicate addresses case-insensitively (`toLowerCase()`) for display while preserving the first-seen casing, and sends unique addresses to the API in chunks of 50. Progress is shown after each chunk. Aggregate counts account for duplicate frequency (`item.occurrences || item.count || 1`) so the four status totals sum to the total number of non-empty submitted entries, while the ledger shows one row per unique address with an `× N` duplicate marker.

## 3. Frontend stack

### HTML
Use semantic HTML elements, including a labelled `<textarea>`, buttons (including `#cancel-btn`), a results `<table>` with `<caption>`, `<thead>` and column scopes, a progress strip (`#progress-strip`, initially `hidden`), and an error banner (`#error-banner`, initially `hidden`) with `#retry-btn`. Zero inline `style=` attributes are permitted anywhere in the document.

### CSS
Use CSS custom properties for the colour tokens defined in the design document. Implement the paper background, ruled intake slip, perforation dividers, stamps, responsive layouts, high-contrast mode, and plain-view toggle in CSS. Use SVG filters for paper grain and stamp roughness, with `.svg-defs` styled purely in CSS (`position: absolute; width: 0; height: 0; overflow: hidden; pointer-events: none;`).

Use the design document's three typefaces, self-hosted as WOFF2: Anton for display text, Courier Prime for body/address text, and Special Elite for stamps.

### Vanilla JavaScript (`app.js`)
Use ES modules and browser APIs only; no framework or bundler is required. The frontend owns:
- splitting the textarea into lines, trimming whitespace, ignoring blank lines and enforcing the 1,000-entry limit;
- case-insensitively normalizing and deduplicating addresses using `getDedupeKey` (`toLowerCase()`), while retaining first-seen casing and duplicate counts;
- calling `/api/verify` in chunks of 50 unique addresses with a 20000ms client `AbortController` timeout;
- interactive cancellation via `#cancel-btn` and error recovery via `#retry-btn`;
- rendering results safely with `textContent`, never `innerHTML` for user-supplied values;
- Pigeonhole filter cubbies with occurrence-weighted totals, sortable table headings, clipboard copy and formula-safe CSV export (`email,status,reason,syntax,mx,recipient,occurrences`);
- formula sanitization prefixing formula injection triggers (`=`, `+`, `-`, `@`, `|`, `%`, `\t`, `\r`, `\n`, `\uFF1D`, `\uFF0B`, `\uFF0D`, `\uFF20`, `\u2212`, `\uFE62`, `\uFE63`, `\uFE66`) with `'` and replacing internal newlines with space.

## 4. Backend stack

### Runtime and deployment
Use a Vercel Node.js Function at `api/verify.js` with `maxDuration: 15`. The function processes batches of at most 100 unique addresses (from up to 1,000 raw lines, 64 KB request body). It enforces an 8000ms batch time budget with an 11000ms hard cutoff.

### Syntax validation
Use the `validator` package (`isEmail`) combined with RFC 5321 / RFC 6531 byte-accurate limits via `Buffer.byteLength(str, 'utf8')`. Enforces <= 64 octets in local-part, <= 253 octets in ASCII punycode domain, and <= 254 octets in total normalized address.

### DNS/MX checks
Use Node.js `node:dns/promises` with 25 concurrency and 2000ms timeout per query:
- usable MX records found → `mx: "found"`;
- RFC 7505 Null MX detected (exchange `.` or `""`) → `mx: "none"`;
- confirmed absence of usable mail routing after parallel A/AAAA fallback → `mx: "none"`;
- transient resolver error or timeout → `mx: "error"`;
- lazy per-batch `gmail.com` DNS resolver health canary check: if any domain encounters `ENOTFOUND` or `ENODATA`, queries `gmail.com`. If `gmail.com` also fails, detects broken sandbox resolver and returns `mx: "error"`, `status: "unknown"` instead of false bounce.

### SMTP and third-party verification
Outbound TCP port 25 is blocked on Vercel. For recipient verification:
- **Tier 1 (HTTPS External API)**: If `EMAIL_VERIFICATION_API_KEY` is set, verifies recipient over HTTPS Port 443 with Bearer authorization and a 4000ms timeout. Strictly validates URL scheme (`https:`) and blocks SSRF targets (`net.BlockList`, localhost, `.local`, `.internal`, `.lan`).
- **Tier 2 (Direct SMTP Probe)**: When permitted (`ENABLE_SMTP_PROBE=true`), executes non-sending socket probe on Port 25 with 2500ms timeout and single-flight Promise catch-all coalescing.
- **Default (Honest Fallback)**: In standard Vercel deployments, valid syntax + MX records honestly returns `checks.recipient: "not_checked"`, `status: "unknown"`, `"Domain accepts mail, but the mailbox was not confirmed"`.

## 5. API contract

**Endpoint:** `POST /api/verify`  
**Limits:** Maximum 64 KB request body, 1,000 raw email lines, 100 unique deduplicated addresses.

Example request:
```json
{
  "emails": ["Alice@gmail.com", "alice@gmail.com", "wrong-email", "someone@nonexistent-domain-xyz.com"]
}
```

Example response:
```json
{
  "results": [
    {
      "email": "Alice@gmail.com",
      "status": "unknown",
      "reason": "Domain accepts mail, but the mailbox was not confirmed",
      "checks": { "syntax": "pass", "mx": "found", "recipient": "not_checked" },
      "occurrences": 2
    },
    {
      "email": "wrong-email",
      "status": "likely_bounce",
      "reason": "Invalid email format",
      "checks": { "syntax": "fail", "mx": "not_checked", "recipient": "not_checked" },
      "occurrences": 1
    },
    {
      "email": "someone@nonexistent-domain-xyz.com",
      "status": "likely_bounce",
      "reason": "Domain cannot be resolved",
      "checks": { "syntax": "pass", "mx": "domain_not_found", "recipient": "not_checked" },
      "occurrences": 1
    }
  ],
  "summary": {
    "total": 4,
    "likely_deliverable": 0,
    "likely_bounce": 2,
    "unknown": 2,
    "submitted_count": 4,
    "unique_count": 3,
    "unique_summary": {
      "total": 3,
      "likely_deliverable": 0,
      "likely_bounce": 2,
      "unknown": 1
    }
  }
}
```

## 6. Privacy notice
Addresses are checked in memory and discarded without database or browser storage, unless an optional external verification API is configured. No emails are sent.
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
