# MailCheck — The Dead Letter Office

**Bulk email address verification.** Paste a list, get honest results.

MailCheck accepts up to 1,000 email addresses and returns **Likely Deliverable**, **Likely Bounce**, or **Unknown** for each one. It combines syntax validation and DNS/MX record checks, with optional recipient verification if configured. It communicates uncertainty clearly and never claims that delivery is guaranteed.

> A postmark proves a letter was posted, not that anyone lives at the address.

---

## Features

- **Bulk verification** — paste up to 1,000 addresses, one per line
- **Three honest statuses** — Likely Deliverable, Likely Bounce, and Unknown (a valid outcome, not an error)
- **Syntax validation** — detects malformed addresses before network checks
- **DNS/MX lookup** — checks domain mail routing including RFC 5321 fallback and RFC 7505 null MX handling
- **Duplicate collapsing** — identical addresses show as one row with a `× N` badge; counts still sum correctly
- **Progressive results** — large batches send in chunks of 100; stamps land as each chunk returns
- **CSV export & clipboard copy** — download or copy results for further use
- **Sortable & filterable** — click column headers to sort; use pigeonhole cubbies to filter by status
- **Accessible** — semantic table, `aria-sort`, `aria-pressed`, `aria-live` progress, keyboard navigation, visible focus rings
- **Reduced motion & high contrast** — respects `prefers-reduced-motion` and `prefers-contrast: more`
- **Plain view toggle** — disables decorative SVG filters for users who find them distracting
- **Privacy-first** — addresses are checked and discarded; nothing is stored and no emails are sent

---

## Design Concept

The interface is themed as a **postal sorting office**:

| Concept | UI Element |
|---------|-----------|
| Intake slip | The textarea where you paste addresses |
| Letter | Each email address being checked |
| Rubber stamp | The status verdict on each row |
| Postmark | The three check indicators (SYN, MX, RCPT) |
| Pigeonhole | The summary filter cubbies |
| Ledger | The results table |
| Dead Letter Office | Where mail goes when nobody can say where it belongs — the Unknown status |

The visual style uses an uncoated paper background, two-colour riso-style ink, typewriter text, and imperfect rubber stamps. No dark mode, gradients, glassmorphism, or glow effects.

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML5, CSS3, vanilla JavaScript (ES modules) |
| Backend | Node.js serverless function |
| API endpoint | `POST /api/verify` |
| Email syntax | `validator` npm package (`isEmail`) |
| DNS/MX | Node.js built-in `node:dns/promises` |
| Fonts | Self-hosted WOFF2 (Anton, Courier Prime, Special Elite) |
| Hosting | Vercel (static + serverless) |
| Tests | Node.js built-in test runner (`node:test`) |
| Database | None |
| Framework | None |

---

## Architecture

```
Browser (index.html + styles.css + app.js)
  │
  │ POST /api/verify (up to 100 unique addresses per chunk)
  ▼
Vercel Node.js Function: api/verify.js
  ├─ validates request and batch limits
  ├─ checks email syntax (validator.isEmail)
  ├─ looks up domain MX records (node:dns/promises)
  ├─ applies conservative classification rules
  └─ returns structured JSON; no email is sent
  │
  ▼
Browser renders stamps, postmarks, and counts progressively
```

The browser accepts up to 1,000 entries, deduplicates them, and sends unique addresses to the API in chunks of 100. Progress updates after each chunk. Duplicate counts are tracked client-side so pigeonhole totals always sum to the total submitted addresses.

---

## Local Setup

### Prerequisites

- **Node.js 18+** (uses `node:test`, `node:dns/promises`, ES modules)

### Install and run

```bash
# Clone and enter the project
git clone <repo-url>
cd mailcheck

# Install dependencies
npm install

# Start the local dev server
npm run dev
# → MailCheck dev server running at http://localhost:3000

# Run the test suite
npm test
```

The dev server (`server.js`) serves static files and routes `POST /api/verify` to the serverless function, so the full application works locally without Vercel.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Local dev server port (default: `3000`) |
| `EMAIL_VERIFICATION_API_KEY` | No | Optional third-party recipient verification API key (server-side only) |

The baseline syntax + DNS/MX checks require no environment variables or API keys.

---

## Status Classification Rules

| Evidence | Status | Reason |
|----------|--------|--------|
| Address fails syntax validation | `likely_bounce` | Invalid email format |
| Domain confirmed not to exist (NXDOMAIN) | `likely_bounce` | Domain cannot be resolved |
| Domain has no usable mail route (null MX, no A/AAAA fallback) | `likely_bounce` | Domain has no usable mail route |
| MX records exist but recipient not verified | `unknown` | Domain accepts mail, but the mailbox was not confirmed |
| DNS check timed out or returned a transient error | `unknown` | The check timed out, so the result is inconclusive |
| Configured recipient verifier gives a positive result | `likely_deliverable` | Recipient verification received a positive response |
| Configured recipient verifier clearly rejects the mailbox | `likely_bounce` | Recipient mailbox does not exist |

### Key principles

- **A valid syntax result does not prove a mailbox exists.** Syntax checks only confirm the address is well-formed.
- **MX records show domain mail routing, not mailbox existence.** A domain with MX records may still reject specific recipients.
- **Transient DNS/network failures are never treated as proof that a mailbox is invalid.** They result in `unknown`, not `likely_bounce`.
- **`likely_deliverable` is never inferred from syntax or MX alone.** It requires recipient-level evidence from a configured verification method.
- **`unknown` is a valid and honest answer**, not an error state.

---

## API Contract

### `POST /api/verify`

**Request:**
```json
{
  "emails": ["alice@example.com", "bad-address"]
}
```

Maximum 100 unique addresses per call. The frontend chunks larger lists automatically.

**Response:**
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

**Status values:** `likely_deliverable`, `likely_bounce`, `unknown`

**Check states:**
- `checks.syntax`: `pass` | `fail`
- `checks.mx`: `found` | `none` | `domain_not_found` | `error` | `not_checked`
- `checks.recipient`: `not_checked` | `accepted` | `rejected` | `inconclusive`

---

## Duplicate Handling

Duplicate addresses are collapsed into a single ledger row with a `× N` badge showing the occurrence count. The three status pigeonhole counts multiply each unique address's status by its duplicate count, so **Likely Deliverable + Likely Bounce + Unknown always equals the total number of non-empty submitted addresses**.

---

## Deployed Capabilities and Limitations

### What the deployed app checks
- ✅ Email syntax validation (RFC-compliant format checking)
- ✅ DNS/MX record lookup (domain mail routing, including RFC 5321 A/AAAA fallback and RFC 7505 null MX detection)
- ✅ Timeout and error resilience (transient failures never produce false bounces)

### What the deployed app does NOT check
- ❌ **Recipient mailbox existence** — Vercel blocks outbound TCP port 25, which is required for direct SMTP recipient verification. Most addresses with valid syntax and MX records will correctly remain `unknown`.
- ❌ **Inbox delivery** — even a `likely_deliverable` result (from a configured verifier) is not a guarantee of inbox delivery. Spam filters, quotas, and policies may still prevent delivery.
- ❌ **Catch-all domains** — some domains accept all recipients during verification but may silently discard undeliverable mail.

### Why many results are "Unknown"
On the standard Vercel deployment without a third-party verification API, `recipient` checks cannot run. This means any address with valid syntax and a working domain will be classified as `unknown` — this is honest and correct behaviour, not an error.

---

## Privacy

- Addresses are processed in memory and discarded after returning results.
- Nothing is written to `localStorage`, databases, or log files.
- No emails are sent to any address.
- No analytics scripts or third-party tracking requests are loaded.
- Fonts are self-hosted; no external font-provider requests at runtime.
- Optional verification API keys are stored server-side only and never exposed to the browser.

---

## Testing

Run the test suite:

```bash
npm test
```

The test suite uses `node:test` and covers all required scenarios:

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Malformed syntax | `likely_bounce`, syntax `FAIL` |
| 2 | Valid syntax + MX found + unconfirmed recipient | `unknown`, MX `FOUND`, recipient `NOT CHECKED` |
| 3 | Confirmed nonexistent domain | `likely_bounce`, MX `DOMAIN NOT FOUND` |
| 4 | Null MX / no mail route | `likely_bounce`, MX `NONE` |
| 5 | DNS timeout / transient error | `unknown` (never `likely_bounce`), MX `ERROR` |
| 6 | Recipient verifier positive | `likely_deliverable`, recipient `ACCEPTED` |
| 7 | Recipient verifier negative | `likely_bounce`, recipient `REJECTED` |
| 8 | Batch size > 100 | API rejects with error; ≤ 100 accepted |
| 9 | Duplicate emails | Deduplicated; one result per unique address |
| 10 | XSS payload in email | Syntax fail; email preserved as text, never executed |

DNS resolution is mocked via dependency injection so tests are fast, deterministic, and don't hit the network.

---

## Repository Structure

```
mailcheck/
├── index.html              Semantic page structure
├── styles.css              Paper, ink, stamps, responsive & accessibility styles
├── app.js                  Input parsing, chunking, rendering, filters, export
├── api/
│   └── verify.js           Vercel serverless function + exported test helpers
├── server.js               Zero-dependency local dev server
├── assets/
│   └── fonts/
│       ├── anton-regular.woff2
│       ├── courier-prime-regular.woff2
│       └── special-elite-regular.woff2
├── tests/
│   └── verify.test.js      Comprehensive unit & integration tests
├── package.json            Project manifest (type: module)
├── .gitignore              node_modules, .env, .vercel
└── README.md               This file
```

---

## Deployment

1. Push the repository to GitHub.
2. Import the repository in [Vercel](https://vercel.com).
3. Vercel will automatically detect the static frontend and deploy `api/verify.js` as a serverless function.
4. No environment variables are needed for the baseline deployment.
5. Test the public URL with the sample addresses.

No `vercel.json` is required for the standard layout.

---

## License

MIT
