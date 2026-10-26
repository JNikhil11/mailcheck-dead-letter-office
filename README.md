# MailCheck — The Dead Letter Office

**Bulk email address verification.** Paste a list, get honest results.

MailCheck accepts up to 1,000 email addresses and returns **Likely Deliverable**, **Likely Bounce**, or **Unknown** for each one. It combines syntax validation with RFC 5321 length and internationalization checks, DNS/MX record lookups with parallel RFC 5321 A/AAAA fallback and RFC 7505 Null MX detection, SSRF-protected SMTP probing with multi-MX fallback and catch-all detection, and optional HTTPS recipient verification API. It communicates uncertainty clearly and never claims that delivery is guaranteed.

> A postmark proves a letter was posted, not that anyone lives at the address.

---

## Features

- **Bulk verification** — paste up to 1,000 addresses, one per line
- **Three honest statuses** — Likely Deliverable, Likely Bounce, and Unknown (a valid outcome, not an error)
- **Syntax validation & RFC limits** — enforces RFC 5321 length limits (254 total, 64 local part) and internationalized domain/punycode support (IDN/EAI)
- **DNS/MX lookup** — queries domain mail routing with parallel 2500ms A/AAAA fallback and RFC 7505 Null MX detection
- **SSRF Protection** — blocks connections to loopback (`127.0.0.0/8`, `::1`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`), link-local, multicast, and IPv4-mapped private IPv6
- **Multi-MX Fallback** — stores full priority-sorted MX exchanges and attempts secondary MX hosts if the primary host is unreachable
- **Narrow 5xx Classification** — strictly narrows SMTP `rejected` verdicts to explicit 550/551/553 mailbox nonexistent responses, classifying policy/reputation/spam blocks (`554`, `5.7.1`) as `unknown`
- **Application-Level IP Rate Limiting** — sliding-window rate limiter (60 batch requests per 60s per client IP, configurable via `RATE_LIMIT_MAX`) returning HTTP 429 with `Retry-After: 60`
- **Duplicate collapsing** — identical addresses (case-insensitively deduplicated) show as one row with a `× N` badge; counts still sum correctly
- **Progressive results & Cancel control** — large batches send in chunks of 100 with interactive cancellation and retry for failed chunks
- **OWASP CSV sanitization & clipboard copy** — prefixes formulas (`=`, `+`, `-`, `@`, `\t`, `\r` after optional whitespace) with `'` to prevent spreadsheet injection; exports exact 7 columns (`email,status,reason,syntax,mx,recipient,occurrences`) and copies formatted results with occurrence counts
- **Accessible & High-Contrast** — WCAG contrast compliant red text (`#B3290C`), semantic table, `aria-sort`, `aria-pressed`, `aria-live` progress, and visible focus rings
- **Reduced motion & Plain view toggle** — respects `prefers-reduced-motion` and allows disabling decorative SVG filters
- **Privacy-first** — addresses are processed in memory and discarded; nothing is stored and no emails are sent

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
| Backend | Node.js serverless function (`api/verify.js`) |
| API endpoint | `POST /api/verify` |
| Email syntax | `validator` npm package (`isEmail` with UTF-8 local part and punycode domain conversion) |
| DNS/MX | Node.js built-in `node:dns/promises` |
| SMTP Probing | Node.js built-in `node:net` socket probing with SSRF verification |
| Fonts | Self-hosted WOFF2 (Anton, Courier Prime, Special Elite) |
| Hosting | Vercel (static + serverless) |
| Tests | Node.js built-in test runner (`node:test`) |
| CI/CD | GitHub Actions (`.github/workflows/ci.yml`) |

---

## Architecture

```
Browser (index.html + styles.css + app.js)
  │
  │ POST /api/verify (up to 100 unique addresses per chunk)
  ▼
Vercel Node.js Function: api/verify.js
  ├─ enforces IP rate limit (60 req / 60s, configurable via RATE_LIMIT_MAX)
  ├─ validates request types, string lengths (<2048 chars), and batch limit (max 100)
  ├─ case-insensitively deduplicates emails
  ├─ Stage 1: validates email syntax & RFC 5321 length limits (254 total / 64 local)
  ├─ Stage 2: queries domain MX records (parallel 2500ms A/AAAA fallback, RFC 7505 Null MX)
  ├─ Stage 3: bounded-concurrency recipient verification (max 10 concurrent checks):
  │    ├─ Tier 1. External HTTPS Verification API (Authorization header, 4000ms timeout)
  │    ├─ Tier 2. Direct SMTP Socket Probe on Port 25 (if enabled, with SSRF block & catch-all cache)
  │    └─ Default. Honest unknown fallback (Port 25 blocked in serverless)
  ├─ applies conservative classification rules
  └─ returns structured JSON; no email message is ever sent
  │
  ▼
Browser renders stamps, postmarks, and counts progressively
```

---

## Recipient Verification Engine

### Serverless Hosting (Vercel)
In serverless environments like Vercel, outbound TCP Port 25 is blocked by network infrastructure:
- Direct SMTP probing is disabled by default to avoid hanging connections.
- **Optional HTTPS Verification API (Port 443)**: If `EMAIL_VERIFICATION_API_KEY` is configured (supporting Emailable, Hunter, or AbstractAPI), MailCheck routes recipient verification over HTTPS with Bearer authorization and a 4000ms timeout.
- Otherwise, valid-syntax and MX-verified addresses honestly return `checks.recipient: "not_checked"`, `status: "unknown"`, and reason `"Domain accepts mail, but the mailbox was not confirmed"`.

### Local Development / Servers with Port 25 Outbound
When running in an environment where outbound Port 25 is permitted and `ENABLE_SMTP_PROBE=true`:
1. **SSRF Verification**: MailCheck resolves the MX exchange and ensures it does not point to loopback, private, link-local, or reserved IP space.
2. Connects to the highest-priority MX host on port 25 with a strict 2500ms socket timeout.
3. Performs greeting (`220`), `EHLO` with configurable `SMTP_HELO_DOMAIN`, and `MAIL FROM:<${SMTP_MAIL_FROM}>`.
4. **Catch-All Detection**: Sends a randomized non-existent mailbox probe (`RCPT TO:<nonexistent-probe-...>`) and caches results per domain across the batch:
   - If the server accepts the random probe (`250`/`251`), the domain is classified as catch-all $\rightarrow$ `recipient: "inconclusive"`, `status: "unknown"`.
   - If the random probe receives a policy block or ambiguous 5xx, MailCheck immediately marks the domain as `inconclusive` rather than risking a false bounce on the real address.
5. If catch-all is explicitly rejected, probes the target address:
   - `250`/`251` $\rightarrow$ `recipient: "accepted"`, `status: "likely_deliverable"`.
   - `550`, `551`, `553` with `5.1.1` or explicit user-unknown phrasing $\rightarrow$ `recipient: "rejected"`, `status: "likely_bounce"`.
   - Policy blocks (`554`, `5.7.1`, spam, reputation, blacklist) $\rightarrow$ `recipient: "inconclusive"`, `status: "unknown"`.
6. Always sends `QUIT\r\n` and immediately destroys the socket. **Never sends `DATA` or any email content.**

---

## Local Setup

### Prerequisites
- **Node.js 18+** (Node 20 or 22 recommended)

### Install and run

```bash
# Clone the repository
git clone https://github.com/JNikhil11/mailcheck-dead-letter-office.git
cd mailcheck-dead-letter-office

# Install dependencies
npm install

# Start the hardened local development server
npm run dev
# → MailCheck dev server running at http://localhost:3000

# Run the automated test suite
npm test
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Local dev server port (default: `3000`) |
| `RATE_LIMIT_MAX` | No | Maximum batch requests per 60 seconds per IP (default: `60`) |
| `ENABLE_SMTP_PROBE` | No | Set to `"true"` to enable direct Port 25 SMTP socket probing (default: disabled) |
| `SMTP_HELO_DOMAIN` | No | Valid FQDN sent in EHLO/HELO commands (must contain a dot and not end in `.local`/`.internal`/`.lan`; defaults to valid FQDN hostname) |
| `SMTP_MAIL_FROM` | No | Address sent in `MAIL FROM:<...>` (default: `<>`) |
| `EMAIL_VERIFICATION_API_KEY` | No | Optional API key for external HTTPS recipient verification over Port 443 |
| `EMAIL_VERIFICATION_API_URL` | No | Optional custom verification endpoint URL template |

---

## Status Classification Rules

| Evidence | Status | Reason |
|----------|--------|--------|
| Address fails syntax validation or RFC length limits | `likely_bounce` | Invalid email format |
| Domain confirmed not to exist (NXDOMAIN) | `likely_bounce` | Domain cannot be resolved |
| Domain has no usable mail route (null MX, no A/AAAA fallback) | `likely_bounce` | Domain has no usable mail route |
| Recipient mailbox explicitly rejected (550 / 5.1.1) | `likely_bounce` | Recipient mailbox was rejected by the mail server |
| MX records exist but recipient not verified | `unknown` | Domain accepts mail, but the mailbox was not confirmed |
| Catch-all domain detected | `unknown` | Domain accepts all mail (catch-all), so individual mailbox could not be confirmed |
| DNS or socket check timed out / transient error | `unknown` | The check timed out, so the result is inconclusive |
| SMTP or HTTPS verifier confirms recipient mailbox | `likely_deliverable` | Recipient verification received a positive response |

---

## API Contract

### `POST /api/verify`

**Request:**
```json
{
  "emails": [
    "alice@gmail.com",
    "bob@company.com",
    "wrong-email",
    "someone@nonexistent-domain-xyz.com"
  ]
}
```

**Response:**
```json
{
  "results": [
    {
      "email": "alice@gmail.com",
      "status": "unknown",
      "reason": "Domain accepts mail, but the mailbox was not confirmed",
      "checks": {
        "syntax": "pass",
        "mx": "found",
        "recipient": "not_checked"
      }
    },
    {
      "email": "wrong-email",
      "status": "likely_bounce",
      "reason": "Invalid email format",
      "checks": {
        "syntax": "fail",
        "mx": "not_checked",
        "recipient": "not_checked"
      }
    }
  ],
  "summary": {
    "total": 2,
    "likely_deliverable": 0,
    "likely_bounce": 1,
    "unknown": 1
  }
}
```

---

## Privacy Notice

MailCheck does not intentionally store submitted address lists in a database or browser storage, and no email messages are sent. If an optional external verification provider is configured, submitted addresses are checked via that provider.

---

## Testing

Run the automated test suite:

```bash
npm test
```

The test suite uses Node's built-in `node:test` runner and executes 37 automated tests across 12 suites with zero external network dependencies:
- Syntax validation & RFC 5321 length limits (>254 chars, >64 local)
- Internationalized email (IDN punycode & UTF-8 local part)
- Domain mail routing & RFC 7505 Null MX detection
- RFC 5321 parallel A / AAAA fallback with timeout protection
- SSRF protection & private/loopback/link-local/multicast IP blocking
- SMTP probing, catch-all detection, and narrow 5xx classification
- External HTTPS verification API with Bearer authorization
- Case-insensitive deduplication and batch size enforcement
- In-memory sliding-window IP rate limiting
- Security input validation (XSS payloads, non-string items, HTTP method guards)

---

## Deployment

- **GitHub Repository**: [https://github.com/JNikhil11/mailcheck-dead-letter-office](https://github.com/JNikhil11/mailcheck-dead-letter-office)
- **Live Vercel Production**: [https://mailcheck-dead-letter-office.vercel.app](https://mailcheck-dead-letter-office.vercel.app)

---

## License

MIT
