# MailCheck — The Dead Letter Office

**Bulk email address verification.** Paste a list, get honest results.

MailCheck accepts up to 1,000 email addresses and returns **Likely Deliverable**, **Likely Bounce**, or **Unknown** for each one. It combines syntax validation with RFC 5321 length and internationalization checks, DNS/MX record lookups with parallel RFC 5321 A/AAAA fallback and RFC 7505 Null MX detection, SSRF-protected SMTP probing with multi-MX fallback and catch-all detection, and optional HTTPS recipient verification API. It communicates uncertainty clearly and never claims that delivery is guaranteed.

> A postmark proves a letter was posted, not that anyone lives at the address.

---

## Features

- **Bulk verification** — paste up to 1,000 addresses, one per line (chunks of 50 in UI; API supports up to 100 unique addresses from up to 1,000 raw lines)
- **Three honest statuses** — Likely Deliverable, Likely Bounce, and Unknown (a valid outcome, not an error)
- **Syntax validation & RFC limits** — enforces RFC 5321 / RFC 6531 byte-accurate length limits (254 UTF-8 octets total, 64 UTF-8 octets local-part) and internationalized domain/punycode support (IDN/EAI)
- **DNS/MX lookup & Canary health** — queries domain mail routing with parallel 2000ms A/AAAA fallback, DNS concurrency of 25, 8000ms batch time budget, 15s Vercel `maxDuration`, lazy per-batch `gmail.com` DNS resolver health canary check, and RFC 7505 Null MX detection
- **SSRF Protection** — uses Node.js `net.BlockList` plus IPv4-in-IPv6 extraction to block connections to loopback (`127.0.0.0/8`, `::1`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`), link-local, multicast, NAT64, 6to4, and IPv4-mapped/compatible private IPv6
- **Single-Flight Catch-All Detection** — coalesces concurrent catch-all probes per domain via a single-flight Promise cache, preventing duplicate probe traffic to mail servers
- **Multi-MX Fallback** — stores full priority-sorted MX exchanges and attempts up to the top 2 highest-priority MX hosts if the primary host is unreachable
- **Narrow 5xx Classification** — strictly narrows SMTP `rejected` verdicts to explicit 550/551/553 mailbox nonexistent responses, classifying policy/reputation/spam blocks (`554`, `5.7.1`) as `unknown`
- **Application-Level IP Rate Limiting** — sliding-window rate limiter (60 batch requests per 60s per client IP, in-memory per serverless instance, configurable via `RATE_LIMIT_MAX`) returning HTTP 429 with `Retry-After: 60`, strictly trusting proxy headers only when `VERCEL === '1'` or `TRUST_PROXY === 'true'`
- **Unified Case-Insensitive Deduplication** — deduplicates case-insensitively (`toLowerCase()`) while displaying first-seen casing (`× N` badge) because major email providers treat mailboxes case-insensitively, preventing duplicate ledger rows with identical verdicts
- **Progressive results & Cancel control** — large batches send in chunks of 50 unique addresses (API max 100 unique / 1,000 raw) with 20000ms client timeout, interactive cancellation (`#cancel-btn`), and retry for failed chunks
- **OWASP CSV sanitization & clipboard copy** — prefixes formulas (`=`, `+`, `-`, `@`, `|`, `%`, `\t`, `\r`, `\n`, and full-width Unicode triggers `\uFF1D`, `\uFF0B`, `\uFF0D`, `\uFF20`, `\u2212`, `\uFE62`, `\uFE63`, `\uFE66`) with `'` to prevent spreadsheet injection; replaces internal newlines with space; exports exact 7 columns (`email,status,reason,syntax,mx,recipient,occurrences`) and copies formatted results with occurrence counts
- **Accessible & High-Contrast** — WCAG contrast compliant red text (`#B3290C`), semantic table, `aria-sort`, `aria-pressed`, `aria-live` progress, and visible focus rings
- **Reduced motion & Plain view toggle** — respects `prefers-reduced-motion` and allows disabling decorative SVG filters
- **Privacy-first** — Addresses are checked in memory and discarded without database or browser storage, unless an optional external verification API is configured. No emails are sent.

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
  │ POST /api/verify (up to 50 unique addresses per chunk, 20000ms client timeout)
  ▼
Vercel Node.js Function: api/verify.js (maxDuration: 15s, batch budget: 8000ms, hard cutoff: 11000ms)
  ├─ enforces IP rate limit (60 req / 60s per IP, configurable via RATE_LIMIT_MAX)
  ├─ validates request payload (max 64 KB, max 1,000 raw lines, max 100 unique addresses)
  ├─ case-insensitively deduplicates (toLowerCase) while preserving first-seen display casing & counting occurrences
  ├─ Stage 1: validates email syntax & RFC 5321 / 6531 UTF-8 byte limits (254 octets total / 64 octets local)
  ├─ Stage 2: queries domain MX records (parallel 2000ms A/AAAA fallback, DNS concurrency 25, RFC 7505 Null MX, lazy gmail.com canary)
  ├─ Stage 3: bounded-concurrency recipient verification (max 10 concurrent checks):
  │    ├─ Tier 1. Tested Emailable v1 Adapter over HTTPS (SSRF-protected, Authorization: Bearer, 4000ms timeout)
  │    ├─ Tier 2. Direct SMTP Socket Probe on Port 25 (if enabled, single-flight catch-all probe, up to top 2 MX hosts, 2500ms timeout)
  │    └─ Default. Honest unknown fallback (Port 25 blocked in serverless)
  ├─ applies conservative classification rules
  └─ returns structured JSON with occurrence-weighted and unique summary counts; no email is ever sent
  │
  ▼
Browser renders stamps, postmarks, duplicate badges (× N), and pigeonhole counts progressively
```

---

## Recipient Verification Engine

### Serverless Hosting (Vercel)
In serverless environments like Vercel, outbound TCP Port 25 is blocked by network infrastructure:
- Direct SMTP probing is disabled by default to avoid hanging connections.
- **Tested Emailable v1 Adapter (Port 443)**: If `EMAIL_VERIFICATION_API_KEY` is configured, MailCheck routes recipient verification over HTTPS using the tested Emailable v1 integration with Bearer authorization and a 4000ms timeout.
- Otherwise, valid-syntax and MX-verified addresses honestly return `checks.recipient: "not_checked"`, `status: "unknown"`, and reason `"Domain accepts mail, but the mailbox was not confirmed"`.

### Local Development / Servers with Port 25 Outbound
When running in an environment where outbound Port 25 is permitted and `ENABLE_SMTP_PROBE=true`:
1. **SSRF Verification**: MailCheck resolves the MX exchange and verifies it via `net.BlockList` and IPv4-in-IPv6 parsing, ensuring it does not point to loopback, private, link-local, or reserved IP space.
2. Connects to the highest-priority MX host on port 25 with a strict 2500ms socket timeout, attempting up to the top 2 highest-priority MX hosts if connection fails.
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
- **Node.js 20+** (Node 20 or 22 recommended)

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
    "Alice@gmail.com",
    "alice@gmail.com",
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
      "email": "Alice@gmail.com",
      "status": "unknown",
      "reason": "Domain accepts mail, but the mailbox was not confirmed",
      "checks": {
        "syntax": "pass",
        "mx": "found",
        "recipient": "not_checked"
      },
      "occurrences": 2
    },
    {
      "email": "wrong-email",
      "status": "likely_bounce",
      "reason": "Invalid email format",
      "checks": {
        "syntax": "fail",
        "mx": "not_checked",
        "recipient": "not_checked"
      },
      "occurrences": 1
    },
    {
      "email": "someone@nonexistent-domain-xyz.com",
      "status": "likely_bounce",
      "reason": "Domain cannot be resolved",
      "checks": {
        "syntax": "pass",
        "mx": "domain_not_found",
        "recipient": "not_checked"
      },
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

---

## Privacy Notice

Addresses are checked in memory and discarded without database or browser storage, unless an optional external verification API is configured. No emails are sent.

---

## Testing

Run the automated test suite:

```bash
npm test
```

The test suite uses Node's built-in `node:test` runner and executes 80 automated tests across 22 suites with zero external network dependencies:
- **1 — Syntax validation & RFC 5321 length limits** (>254 chars total, >64 local part)
- **2 — Internationalized email (EAI / IDN)** (IDN punycode & UTF-8 local part)
- **3 — Domain mail routing & RFC 7505 Null MX detection** (including lazy `gmail.com` canary check for broken sandbox resolvers)
- **4 — RFC 5321 parallel A / AAAA fallback** on ENODATA with timeout protection
- **5 — SSRF protection & private IP blocking** (loopback, RFC 1918, link-local, multicast, reserved)
- **6 — SMTP probing & narrow 5xx classification** (catch-all detection, explicit user-unknown vs spam/policy)
- **7 — External HTTPS verification API** with Bearer authorization and network fallback
- **8 — Dependency injection in classifyEmail** (unit test isolation without global mutable state)
- **9 — Batch size limit & case-insensitive deduplication** (max 100 unique, max 1,000 raw lines, first-seen casing)
- **10 — In-memory sliding-window IP rate limiter** (60 requests / 60s per client IP)
- **11 — Security & input validation** (XSS payloads, non-string items, HTTP method guards, HTTP 429)
- **12 — Extended SSRF BlockList & IPv4-in-IPv6** (`net.BlockList`, IPv4-mapped, IPv4-compatible, NAT64, 6to4, deprecated site-local, documentation ranges)
- **13 — Distinct DNS error reason strings** (ETIMEOUT vs ESERVFAIL / ECONNREFUSED)
- **14 — Batch time budget enforcement** (8000ms budget, 11000ms hard cutoff prevents serverless timeouts)
- **15 — normalizeEmailAddress local-part case preservation** (preserves local case, lowercases domain)
- **16 — IP header trust order for rate limiting** (strictly enforces `VERCEL === '1'` and `TRUST_PROXY === 'true'`)
- **17 — UTF-8 byte-accurate length limits** (32 vs 33 two-byte UTF-8 chars, Punycode >253 octets)
- **18 — Single-flight promise coalescing for SMTP catch-all detection** (5 concurrent queries trigger 1 catch-all probe)
- **19 — HTTPS protocol & SSRF validation on EMAIL_VERIFICATION_API_URL** (blocks http://, localhost, internal domains, private IPs)
- **20 — Zero inline style attributes and DOM style assignments** (automated audit of `index.html` and `app.js`)
- **21 — Hardened CSV sanitization with Unicode & embedded newlines** (ASCII + full-width Unicode formula injection triggers, internal newlines)

---

## Deployment

- **GitHub Repository**: [https://github.com/JNikhil11/mailcheck-dead-letter-office](https://github.com/JNikhil11/mailcheck-dead-letter-office)
- **Live Vercel Production**: [https://mailcheck-dead-letter-office.vercel.app](https://mailcheck-dead-letter-office.vercel.app)

---

## License

MIT
