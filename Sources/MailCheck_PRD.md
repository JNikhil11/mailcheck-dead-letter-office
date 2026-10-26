# MailCheck — Product Requirements Document (PRD)

**Version:** 2.0 (Hardened Production Release)  
**Status:** Implementation-verified specification  
**Date:** 26 October 2026  
**Product:** Bulk Email Address Verification Web Application (The Dead Letter Office)

## 1. Executive summary
MailCheck accepts a list of email addresses and returns **Likely Deliverable**, **Likely Bounce**, or **Unknown** for each address. It combines RFC 5321/6531 UTF-8 byte-accurate syntax validation, DNS/MX lookups with parallel RFC 5321 A/AAAA fallback, RFC 7505 Null MX detection, a resolver health canary check, and SSRF-protected multi-tier recipient verification (external HTTPS API, direct SMTP socket probing when permitted, and honest serverless fallback). It communicates uncertainty clearly and never claims delivery is guaranteed.

MailCheck is rule-based and privacy-first: addresses are processed in memory and discarded without database or browser storage, unless an optional external verification API is configured. No emails are sent.

## 2. Problem statement
Users may have lists containing typos, domains that cannot receive email, or addresses whose mailbox status is unclear. MailCheck checks addresses in bulk, collapses duplicates case-insensitively while preserving display casing, and explains what the available evidence can and cannot establish.

## 3. Goals
- Accept multiple email addresses, up to 1,000 raw lines, chunked into batches of 50 in the UI.
- API accepts up to 100 unique addresses (from up to 1,000 raw lines, 64 KB max body) per request.
- Deduplicate case-insensitively (`toLowerCase()`) while preserving the first-seen display casing and presenting an occurrence badge (`× N`).
- Enforce RFC 5321 / RFC 6531 UTF-8 byte limits (64 octets local-part, 254 octets total).
- Provide DNS resolver health canary check (`gmail.com`) to prevent false bounces in sandboxed environments.
- Enforce 25 DNS concurrency, 2000ms DNS timeout, 8000ms batch time budget, 11000ms hard cutoff, 20000ms client timeout, and 15s Vercel `maxDuration`.
- Provide interactive `#cancel-btn` and full/partial failure `#error-banner` with retry.
- Export 7-column formula-safe CSV (`email,status,reason,syntax,mx,recipient,occurrences`) with ASCII + full-width Unicode injection sanitization.
- Provide strict Content-Security-Policy with zero inline styles (`'unsafe-inline'` forbidden).
- Return Unknown for inconclusive or blocked checks rather than falsely claiming an address is invalid.
- Avoid sending messages and avoid unnecessary retention of submitted addresses.

## 4. Non-goals
- Training or hosting an AI/ML model.
- Sending emails or test messages.
- Guaranteeing inbox delivery or spam-folder avoidance.
- Accounts, database, billing, or team administration in the MVP.
- Bypassing mail-server protections or sending unauthenticated relay traffic.

## 5. Target user and journey
A user opens the site, pastes a list of up to 1,000 addresses, clicks **Verify**, watches the live progress strip, cancels mid-flight if needed with `#cancel-btn`, reviews statuses, reasons, and postmarks in the ledger, filters by pigeonhole cubbies, retries failed chunks via `#retry-btn`, and copies or exports the results as formula-safe CSV.

## 6. Scope

### Core Capabilities (v2.0)
- Responsive multi-line intake slip with live address counter (up to 1,000 addresses).
- Case-insensitive deduplication with first-seen display casing and `× N` duplicate count badges.
- Chunked processing (50 unique addresses per client chunk, API limit 100 unique addresses).
- Verify, Cancel (`#cancel-btn`), Clear, and Load Sample controls.
- Interactive Pigeonhole filter cubbies with occurrence-weighted totals.
- Verification Ledger table with semantic headers, sorting, stamps, and postmarks.
- Client timeout (20000ms) and server batch budget (8000ms budget, 11000ms hard cutoff, 15s Vercel `maxDuration`).
- Partial/full batch error banner (`#error-banner`) with retry button (`#retry-btn`).
- 7-column formula-safe CSV export (`email,status,reason,syntax,mx,recipient,occurrences`).
- Clipboard copy with formatted occurrence badges.
- Plain view toggle and reduced-motion support.

## 7. Status rules
- **Likely Bounce:** malformed address (syntax failure / RFC byte length exceeded), confirmed nonexistent domain (NXDOMAIN with healthy resolver canary), no usable mail route after RFC 7505 Null MX and RFC 5321 A/AAAA fallback, or an explicit SMTP/API mailbox rejection (550 / 551 / 553 with 5.1.1).
- **Likely Deliverable:** a configured verification method (external HTTPS API or direct SMTP RCPT probe) provides positive recipient-level confirmation. Never infer this from syntax or MX records alone.
- **Unknown:** evidence is inconclusive, mailbox status is hidden/catch-all, DNS resolver is broken/sandboxed, verification is blocked by policy/spam filters (`554`, `5.7.1`), or a check times out.

## 8. Functional requirements
1. Accept multiple addresses, one per line (up to 1,000 lines).
2. Trim surrounding whitespace and ignore blank lines; deduplicate case-insensitively while preserving first-seen casing.
3. Enforce API payload limits: max 1,000 raw lines, max 100 unique deduplicated addresses, max 64 KB request body.
4. Validate RFC 5321 / RFC 6531 UTF-8 byte lengths before network checks (local <= 64 bytes, total <= 254 bytes, domain <= 253 bytes, label 1..63 bytes).
5. Look up DNS/MX records for plausible addresses with 25 DNS concurrency and 2000ms timeout.
6. Run per-batch `gmail.com` DNS resolver health canary check before treating NXDOMAIN as `likely_bounce`.
7. Run single-flight Promise catch-all probe per domain to coalesce concurrent checks and prevent probe flooding.
8. Enforce SSRF protection via `net.BlockList` and IPv4-in-IPv6 parsing on all socket connections and external API URLs.
9. Return a status, reason, postmarks, and occurrences for every submitted unique address, along with occurrence-weighted and unique-level summaries.
10. Do not send emails or log full address lists.

## 9. System architecture
- **Frontend:** Semantic HTML5, CSS3 with zero inline styles, Vanilla ES modules (`app.js`).
- **Backend:** Node.js Vercel serverless function (`api/verify.js`) with 15s `maxDuration`.
- **Syntax:** `validator` (`isEmail`) with UTF-8 local part and Punycode conversion.
- **DNS:** `node:dns/promises` with parallel A/AAAA fallback, Null MX detection, and `gmail.com` health canary.
- **Recipient Verification:** 3-tier engine (Tier 1: HTTPS External API with Bearer token, Tier 2: Direct Port 25 SMTP Probing with single-flight catch-all, Tier 3: Honest serverless fallback).
- **Rate Limiting:** Sliding-window limiter (60 req / 60s per client IP), strictly validating proxy headers only when `VERCEL === '1'` or `TRUST_PROXY === 'true'`.

## 10. API Contract
`POST /api/verify`

**Request:**
```json
{
  "emails": ["Alice@gmail.com", "alice@gmail.com", "wrong-email", "someone@nonexistent-domain-xyz.com"]
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

## 11. Privacy statement
Addresses are checked in memory and discarded without database or browser storage, unless an optional external verification API is configured. No emails are sent.
      "checks": { "syntax": "pass", "mx": "found", "recipient": "not_checked" }
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

This is an illustrative schema; status meanings must stay consistent across UI, API, tests, and README.

## 12. Non-functional requirements
- Simple, responsive, accessible interface.
- Timeouts and reasonable concurrency limits.
- One failed lookup must not fail the entire batch.
- Validate requests and cap input size.
- Keep secrets server-side.
- Avoid unnecessary persistence of addresses.
- Communicate status with text as well as colour.

## 13. Acceptance criteria
- Multiple addresses produce separate results.
- Malformed addresses are detected.
- MX records are not treated as proof of mailbox existence.
- Blocked/inconclusive checks return Unknown.
- Reasons and summary counts are accurate.
- DNS errors and timeouts are handled.
- No email messages are sent.
- A public URL works.
- README covers setup, architecture, classification, deployment, privacy, and limitations.

## 14. Test plan
| Scenario | Expected behavior |
|---|---|
| Malformed syntax | Likely Bounce with syntax reason |
| Plausible address on known provider | Show syntax/DNS results; Unknown unless recipient is actually verified |
| Confirmed nonexistent domain | Likely Bounce |
| MX exists but mailbox is unconfirmed | Unknown |
| DNS/network timeout | Unknown or explicit check error; batch continues |
| Blank lines and duplicates | Blank lines ignored; duplicate behavior documented |
| Excessive input | Clear validation error |

## 15. Risks and mitigations
- **Mailbox status hidden:** return Unknown.
- **SMTP blocked:** document limits or use a provider API.
- **Catch-all domains:** avoid overstating certainty.
- **DNS transient failures:** distinguish them from confirmed nonexistence.
- **Address privacy:** avoid full-address logs and unnecessary persistence.
- **API cost/quotas:** keep integration optional and enforce limits.

## 16. README contents
- Overview and features.
- Technology stack and architecture.
- Local setup.
- Environment variables, if any.
- Status classification rules.
- Public deployment URL.
- Deployed capabilities and limitations.
- Privacy statement.

## 17. Release plan
1. Build the UI.
2. Implement backend syntax and DNS/MX checks.
3. Add timeouts, conservative classification, and tests.
4. Deploy and test the public URL.
5. Finish README.
6. Optionally assess an API or SMTP-capable host for stronger recipient verification.

## 18. Definition of done
A user can submit a batch through the public site and receive one reasoned status per address. Unknown is handled as a valid outcome, and documentation accurately describes what the deployed app can and cannot verify.
