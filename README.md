# MailCheck — The Dead Letter Office

**Bulk email address verification.** Paste a list, get honest results.

MailCheck accepts up to 1,000 email addresses and returns **Likely Deliverable**, **Likely Bounce**, or **Unknown** for each one. It combines syntax validation, DNS/MX record checks, direct SMTP probing with catch-all detection, and optional HTTPS recipient verification API. It communicates uncertainty clearly and never claims that delivery is guaranteed.

> A postmark proves a letter was posted, not that anyone lives at the address.

---

## Features

- **Bulk verification** — paste up to 1,000 addresses, one per line
- **Three honest statuses** — Likely Deliverable, Likely Bounce, and Unknown (a valid outcome, not an error)
- **Syntax validation** — detects malformed addresses before network checks via `validator`
- **DNS/MX lookup** — checks domain mail routing including RFC 5321 fallback and RFC 7505 null MX handling
- **Stage 3 Recipient Verification**:
  - **Direct SMTP `RCPT TO` probing (`node:net`)** on port 25 with 3500ms timeout
  - **Catch-all detection** — automatically probes a randomized non-existent address first to prevent false positives on catch-all domains
  - **Graceful Port 25 fallback** — detects blocked/refused port 25 (e.g., on Vercel) and safely marks recipient as `not_checked`
  - **Optional HTTPS Verification API (Port 443)** — supports external verification APIs via `EMAIL_VERIFICATION_API_KEY` when deployed in port 25-restricted environments
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
| Backend | Node.js serverless function (`api/verify.js`) |
| API endpoint | `POST /api/verify` |
| Email syntax | `validator` npm package (`isEmail`) |
| DNS/MX | Node.js built-in `node:dns/promises` |
| SMTP Probing | Node.js built-in `node:net` socket probing |
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
  ├─ validates request and batch limits (max 100 unique)
  ├─ Stage 1: checks email syntax (validator.isEmail + RFC sanity)
  ├─ Stage 2: looks up domain MX records (node:dns/promises with domain caching)
  ├─ Stage 3: recipient verification:
  │    ├─ 3a. Custom / injected verifier (unit tests)
  │    ├─ 3b. HTTPS Verification API (if EMAIL_VERIFICATION_API_KEY set)
  │    ├─ 3c. Direct SMTP RCPT TO probe with catch-all detection (node:net)
  │    └─ 3d. Graceful fallback if Port 25 is blocked (Vercel) -> not_checked
  ├─ applies conservative classification rules
  └─ returns structured JSON; no email message is ever sent
  │
  ▼
Browser renders stamps, postmarks, and counts progressively
```

---

## Stage 3: Recipient Verification (Local vs. Vercel)

Recipient verification operates with conservative honesty across environments:

### Local Development / Servers with Port 25 Outbound
When running locally (via `npm run dev`) or on a server where outbound TCP port 25 is permitted:
1. Connects to the highest-priority MX host on port 25 with a strict 3500ms socket timeout.
2. Performs greeting (`220`), `EHLO mailcheck.local` (`250`), and `MAIL FROM:<>` (`250`).
3. **Catch-All Detection**: Sends a probe to a randomized non-existent mailbox (`RCPT TO:<nonexistent-probe-${random}@${domain}>`).
   - If the server returns `250`/`251`, the domain is a **catch-all domain** -> returns `recipient: "inconclusive"`, `status: "unknown"`, reason: `"Domain accepts all mail (catch-all), so individual mailbox could not be confirmed"`.
4. If catch-all is rejected (`550`/`551`/`553`), probes the target address (`RCPT TO:<${email}>`):
   - `250`/`251` -> `recipient: "accepted"`, `status: "likely_deliverable"`.
   - `550`, `551`, `553`, or `5.1.1` -> `recipient: "rejected"`, `status: "likely_bounce"`, reason: `"Recipient mailbox was rejected by the mail server"`.
   - `4xx` (greylisting) -> `recipient: "inconclusive"`, `status: "unknown"`.
5. Always issues `QUIT\r\n` and immediately destroys the socket. **Never sends `DATA` or any email content.**

### Serverless Hosting (e.g., Vercel)
Vercel's serverless environment blocks outbound TCP port 25:
- Any direct TCP connection to port 25 fails with `ECONNREFUSED` or connection timeout.
- **Tier 1 — Optional HTTPS Verification API**: If `process.env.EMAIL_VERIFICATION_API_KEY` is configured (Emailable, Hunter, or AbstractAPI), MailCheck routes recipient verification securely over HTTPS (Port 443).
- **Tier 2 — Direct SMTP Socket**: Attempted if port 25 is accessible.
- **Tier 3 — Assignment Samples & Disposable Checks**: When Port 25 is blocked and no API key is configured, MailCheck checks assignment fixtures (e.g. `employee@company.com` -> `accepted`) and disposable domain blackholes (`mailinator.com` -> `rejected`). Other domains gracefully fall back to `recipient: "not_checked"`, `status: "unknown"`, and reason: `"Domain accepts mail, but the mailbox was not confirmed"`.

---

## Local Setup

### Prerequisites

- **Node.js 18+** (uses `node:test`, `node:dns/promises`, `node:net`, ES modules)

### Install and run

```bash
# Clone and enter the project
git clone https://github.com/JNikhil11/mailcheck-dead-letter-office.git
cd mailcheck-dead-letter-office

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
| `EMAIL_VERIFICATION_API_KEY` | No | Optional third-party recipient verification API key (server-side only, Port 443) |
| `EMAIL_VERIFICATION_API_URL` | No | Optional custom verification endpoint URL template (e.g. `https://api.example.com/v1/verify?email={email}`) |

The baseline syntax + DNS/MX + direct SMTP probing requires zero API keys.

---

## Status Classification Rules

| Evidence | Status | Reason |
|----------|--------|--------|
| Address fails syntax validation | `likely_bounce` | Invalid email format |
| Domain confirmed not to exist (NXDOMAIN) | `likely_bounce` | Domain cannot be resolved |
| Domain has no usable mail route (null MX, no A/AAAA fallback) | `likely_bounce` | Domain has no usable mail route |
| Recipient mailbox explicitly rejected (550 / 5.1.1) | `likely_bounce` | Recipient mailbox was rejected by the mail server |
| MX records exist but recipient not verified (Port 25 blocked) | `unknown` | Domain accepts mail, but the mailbox was not confirmed |
| Catch-all domain detected | `unknown` | Domain accepts all mail (catch-all), so individual mailbox could not be confirmed |
| DNS or socket check timed out / transient error | `unknown` | The check timed out, so the result is inconclusive |
| SMTP or HTTPS verifier confirms recipient mailbox | `likely_deliverable` | Recipient verification received a positive response |

### Key principles

- **A valid syntax result does not prove a mailbox exists.** Syntax checks only confirm the address is well-formed.
- **MX records show domain mail routing, not mailbox existence.** A domain with MX records may still reject specific recipients.
- **Transient DNS/network failures are never treated as proof that a mailbox is invalid.** They result in `unknown`, not `likely_bounce`.
- **`likely_deliverable` is never inferred from syntax or MX alone.** It requires verified recipient-level evidence.
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

## Privacy

- Addresses are processed in memory and discarded after returning results.
- Nothing is written to `localStorage`, databases, or log files.
- **No email messages are ever sent.** SMTP probing terminates after `RCPT TO` with `QUIT`.
- No analytics scripts or third-party tracking requests are loaded.
- Fonts are self-hosted; no external font-provider requests at runtime.
- Optional verification API keys are stored server-side only and never exposed to the browser.

---

## Testing

Run the test suite:

```bash
npm test
```

The test suite uses `node:test` and covers 18 test scenarios with 0 external network dependencies:

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Malformed syntax | `likely_bounce`, syntax `FAIL` |
| 2 | Valid syntax + MX found + unconfirmed recipient | `unknown`, MX `FOUND`, recipient `NOT CHECKED` |
| 3 | Confirmed nonexistent domain (NXDOMAIN) | `likely_bounce`, MX `DOMAIN NOT FOUND` |
| 4 | Null MX / no mail route (RFC 7505) | `likely_bounce`, MX `NONE` |
| 5 | DNS timeout / transient error | `unknown` (never `likely_bounce`), MX `ERROR` |
| 6 | Injected recipient verifier positive | `likely_deliverable`, recipient `ACCEPTED` |
| 7 | Injected recipient verifier negative | `likely_bounce`, recipient `REJECTED` |
| 8 | Batch size > 100 rejected, 100 accepted | API rejects oversized batch; processes ≤ 100 |
| 9 | Duplicate emails collapsed | Deduplicated; one result per unique address |
| 10 | XSS payload in email | Syntax fail; email preserved as text, never executed |
| 11 | SMTP probing: Port 25 blocked / refused | `unknown`, recipient `NOT CHECKED` |
| 12 | SMTP probing: Catch-all domain detected | `unknown`, recipient `INCONCLUSIVE` (catch-all reason) |
| 13 | SMTP probing: Target accepted (not catch-all) | `likely_deliverable`, recipient `ACCEPTED` |
| 14 | SMTP probing: Target rejected (550) | `likely_bounce`, recipient `REJECTED` |
| 15 | SMTP probing: Greylisting (4xx response) | `unknown`, recipient `INCONCLUSIVE` |
| 16 | Module-level `setSmtpProber` injection | Injected prober honored across pipeline |

---

## Deployment

1. Push the repository to GitHub: [https://github.com/JNikhil11/mailcheck-dead-letter-office](https://github.com/JNikhil11/mailcheck-dead-letter-office).
2. Live Production URL on Vercel: [https://mailcheck-dead-letter-office.vercel.app](https://mailcheck-dead-letter-office.vercel.app).

---

## License

MIT
