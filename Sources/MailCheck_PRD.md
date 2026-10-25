# MailCheck — Product Requirements Document (PRD)

**Version:** 1.0  
**Status:** Initial draft — implementation-ready scope  
**Date:** 25 October 2026  
**Product:** Bulk Email Address Verification Web Application

## 1. Executive summary
MailCheck accepts a list of email addresses and returns **Likely Deliverable**, **Likely Bounce**, or **Unknown** for each address. It combines syntax validation and DNS/MX checks, with optional recipient verification if supported. It must communicate uncertainty clearly and must not claim that delivery is guaranteed.

This is a rule-based application. It does not require training a machine-learning model, a database, user accounts, or a paid API. It must not send test emails to addresses the user does not own.

## 2. Problem statement
Users may have lists containing typos, domains that cannot receive email, or addresses whose mailbox status is unclear. MailCheck checks addresses in bulk and explains what the available evidence can and cannot establish.

## 3. Goals
- Accept multiple email addresses, one per line.
- Return one status and a human-readable reason per non-empty address.
- Detect malformed syntax and check domain email-routing configuration.
- Return Unknown for inconclusive or blocked checks rather than falsely claiming an address is invalid.
- Deploy publicly and document actual limitations.
- Avoid sending messages and avoid unnecessary retention of submitted addresses.

## 4. Non-goals
- Training or hosting an AI/ML model.
- Sending emails or test messages.
- Guaranteeing inbox delivery or spam-folder avoidance.
- Accounts, database, billing, or team administration in the MVP.
- Bypassing mail-server protections.

## 5. Target user and journey
A user opens the site, pastes a list, clicks **Verify**, reviews statuses and reasons, and optionally copies or exports results.

## 6. Scope

### MVP
- Responsive multi-line input.
- Verify button, loading state, and clear errors.
- Results table with status, reason, and checks performed.
- Summary counts by status.
- Backend endpoint for verification.
- Syntax validation and DNS/MX lookup.
- Timeouts and graceful error handling.
- README with setup, deployment, checks, and limitations.

### Optional
- CSV export and copy-to-clipboard.
- Filtering/sorting.
- Third-party verification API.
- SMTP recipient verification where permitted and appropriate.

## 7. Status rules
- **Likely Bounce:** malformed address, confirmed nonexistent domain, no usable mail route after applicable fallback rules, or a clear recipient rejection.
- **Likely Deliverable:** a configured verification method provides sufficiently positive recipient-level evidence. Never infer this from syntax or MX records alone.
- **Unknown:** evidence is inconclusive, mailbox status is hidden, verification is blocked, or a check times out.

A valid syntax result does not prove a mailbox exists. MX records show domain mail routing, not mailbox existence. Transient DNS/network failures must not be treated as proof that a mailbox is invalid.

## 8. Functional requirements
1. Accept multiple addresses, one per line.
2. Trim surrounding whitespace and ignore blank lines; document duplicate handling.
3. Apply a reasonable batch-size limit.
4. Validate syntax before network checks.
5. Look up DNS/MX records for plausible addresses.
6. Attempt SMTP or provider verification only if configured and permitted.
7. Return a status and reason for every submitted non-empty address.
8. Display summary counts.
9. Handle invalid requests, DNS errors, timeouts, and server errors.
10. Do not send emails or log full address lists unnecessarily.
11. Ensure deployed behavior matches the README.

## 9. Suggested architecture
- **Frontend:** HTML, CSS, JavaScript (or React).
- **Backend:** Node.js API route/serverless function.
- **Syntax:** maintained email parsing/validation library plus policy rules.
- **DNS:** Node.js DNS resolver, including MX lookup.
- **Optional provider:** call only from backend; store the key in an environment variable.
- **Hosting:** Vercel for frontend and API functions.

No database or ML model is needed. Syntax and DNS/MX checks do not require a third-party verification API key.

## 10. Hosting limitations
Vercel blocks outbound TCP port 25, commonly used for direct server-to-server SMTP. Do not promise direct mailbox verification over that port. The deployed MVP should support syntax and DNS/MX checks and return Unknown when mailbox existence cannot be established. If a provider API is added, document its coverage, quotas, cost, privacy terms, and failure behavior.

## 11. Suggested API
`POST /api/verify`

Example request:
```json
{ "emails": ["alice@example.com", "bad-address"] }
```

Example response:
```json
{
  "results": [
    {
      "email": "alice@example.com",
      "status": "unknown",
      "reason": "Mailbox existence could not be confirmed",
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
