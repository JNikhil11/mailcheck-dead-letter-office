import dns from "node:dns/promises";
import validator from "validator";
const { isEmail } = validator;

// ---------------------------------------------------------------------------
// Module-level recipient verifier (set via env var or injected for testing)
// ---------------------------------------------------------------------------
let _recipientVerifier = null;

/**
 * Inject a custom recipient-verification function for unit tests.
 * The function must accept an email string and return one of:
 *   "accepted" | "rejected" | "inconclusive"
 * @param {Function|null} fn
 */
export function setRecipientVerifier(fn) {
  _recipientVerifier = fn;
}

/** Remove any previously injected verifier. */
export function clearRecipientVerifier() {
  _recipientVerifier = null;
}

// ---------------------------------------------------------------------------
// Stage 1 — Syntax Check
// ---------------------------------------------------------------------------

/**
 * Validate email syntax.
 * @param {string} email
 * @returns {{ valid: boolean, email: string }}
 */
export function checkSyntax(email) {
  if (typeof email !== "string") return { valid: false, email: String(email) };

  // Reject emails that contain spaces
  if (/\s/.test(email)) return { valid: false, email };

  // Must contain exactly one @
  const atParts = email.split("@");
  if (atParts.length !== 2) return { valid: false, email };

  const domain = atParts[1];

  // Domain labels must not start or end with a hyphen
  const labels = domain.split(".");
  for (const label of labels) {
    if (label.startsWith("-") || label.endsWith("-")) {
      return { valid: false, email };
    }
  }

  // Use validator's isEmail with strict options
  const valid = isEmail(email, {
    allow_display_name: false,
    allow_utf8_local_part: false,
  });

  return { valid, email };
}

// ---------------------------------------------------------------------------
// Stage 2 — DNS / MX Check
// ---------------------------------------------------------------------------

/**
 * Check MX (or implicit A/AAAA fallback) for a domain.
 * @param {string} domain
 * @param {object} [dnsResolver=dns] — injectable for testing
 * @returns {Promise<{ mx: string, reason?: string }>}
 */
export async function checkMx(domain, dnsResolver = dns) {
  try {
    const mxRecords = await withTimeout(
      dnsResolver.resolveMx(domain),
      4000,
    );

    // Check for null MX (RFC 7505) — all exchanges are "" or "."
    const usable = mxRecords.filter(
      (r) => r.exchange && r.exchange !== ".",
    );
    if (usable.length > 0) {
      return { mx: "found" };
    }
    return {
      mx: "none",
      reason: "Domain has no usable mail route",
    };
  } catch (err) {
    // ENODATA — no MX record at all; try A / AAAA fallback (RFC 5321 §5)
    if (err.code === "ENODATA") {
      return await fallbackToAddressRecords(domain, dnsResolver);
    }
    if (err.code === "ENOTFOUND") {
      return { mx: "domain_not_found", reason: "Domain cannot be resolved" };
    }
    // Transient / timeout / servfail
    if (
      err.code === "ETIMEOUT" ||
      err.code === "ESERVFAIL" ||
      err.code === "TIMEOUT" ||
      err.message === "DNS_TIMEOUT"
    ) {
      return {
        mx: "error",
        reason: "The check timed out, so the result is inconclusive",
      };
    }
    // Any other unexpected error → treat as transient
    return {
      mx: "error",
      reason: "The check timed out, so the result is inconclusive",
    };
  }
}

/**
 * RFC 5321 fallback: if no MX records exist, check for A or AAAA records.
 */
async function fallbackToAddressRecords(domain, dnsResolver) {
  try {
    const a = await withTimeout(dnsResolver.resolve4(domain), 4000);
    if (a && a.length > 0) return { mx: "found" };
  } catch {
    // ignore — try AAAA next
  }

  try {
    const aaaa = await withTimeout(dnsResolver.resolve6(domain), 4000);
    if (aaaa && aaaa.length > 0) return { mx: "found" };
  } catch {
    // ignore
  }

  return { mx: "none", reason: "Domain has no usable mail route" };
}

/** Race a promise against a timeout. */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error("DNS_TIMEOUT");
      err.code = "ETIMEOUT";
      reject(err);
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Stage 3 — Recipient Check
// ---------------------------------------------------------------------------

/**
 * Attempt recipient verification using an injected verifier or env-based one.
 * @param {string} email
 * @param {Function|null} [verifier]
 * @returns {Promise<string>}  "accepted" | "rejected" | "inconclusive" | "not_checked"
 */
async function checkRecipient(email, verifier) {
  const fn = verifier || _recipientVerifier;
  if (!fn) return "not_checked";
  try {
    const result = await fn(email);
    if (["accepted", "rejected", "inconclusive"].includes(result)) {
      return result;
    }
    return "not_checked";
  } catch {
    return "inconclusive";
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Full classification pipeline for a single email address.
 * @param {string} email
 * @param {{ dnsResolver?: object, recipientVerifier?: Function }} [options]
 * @returns {Promise<{ email: string, status: string, reason: string, checks: object }>}
 */
export async function classifyEmail(email, options = {}) {
  const { dnsResolver, recipientVerifier } = options;

  // Stage 1 — Syntax
  const syntaxResult = checkSyntax(email);
  if (!syntaxResult.valid) {
    return {
      email,
      status: "likely_bounce",
      reason: "Invalid email format",
      checks: { syntax: "fail", mx: "not_checked", recipient: "not_checked" },
    };
  }

  // Stage 2 — MX
  const domain = email.split("@")[1];
  const mxResult = await checkMx(domain, dnsResolver);

  if (mxResult.mx === "domain_not_found" || mxResult.mx === "none") {
    return {
      email,
      status: "likely_bounce",
      reason: mxResult.reason,
      checks: { syntax: "pass", mx: mxResult.mx, recipient: "not_checked" },
    };
  }

  if (mxResult.mx === "error") {
    return {
      email,
      status: "unknown",
      reason: mxResult.reason,
      checks: { syntax: "pass", mx: "error", recipient: "not_checked" },
    };
  }

  // Stage 3 — Recipient
  const recipientStatus = await checkRecipient(email, recipientVerifier);

  if (recipientStatus === "accepted") {
    return {
      email,
      status: "likely_deliverable",
      reason: "Recipient verification received a positive response",
      checks: { syntax: "pass", mx: "found", recipient: "accepted" },
    };
  }
  if (recipientStatus === "rejected") {
    return {
      email,
      status: "likely_bounce",
      reason: "Recipient mailbox does not exist",
      checks: { syntax: "pass", mx: "found", recipient: "rejected" },
    };
  }
  if (recipientStatus === "inconclusive") {
    return {
      email,
      status: "unknown",
      reason: "Recipient check was inconclusive",
      checks: { syntax: "pass", mx: "found", recipient: "inconclusive" },
    };
  }

  // recipient not_checked, syntax pass, mx found
  return {
    email,
    status: "unknown",
    reason: "Domain accepts mail, but the mailbox was not confirmed",
    checks: { syntax: "pass", mx: "found", recipient: "not_checked" },
  };
}

// ---------------------------------------------------------------------------
// Batch verification
// ---------------------------------------------------------------------------

const MAX_BATCH = 100;
const DNS_CONCURRENCY = 10;

/**
 * Verify a batch of email addresses.
 * @param {string[]} emails — raw array from the client (may contain duplicates)
 * @param {{ dnsResolver?: object, recipientVerifier?: Function }} [options]
 * @returns {Promise<{ results: object[], summary: object } | { error: string }>}
 */
export async function verifyBatch(emails, options = {}) {
  if (!Array.isArray(emails) || emails.length === 0) {
    return { error: "emails must be a non-empty array" };
  }

  // Trim & filter empty strings
  const trimmed = emails.map((e) => (typeof e === "string" ? e.trim() : String(e))).filter((e) => e.length > 0);

  if (trimmed.length === 0) {
    return { error: "emails must be a non-empty array" };
  }

  if (trimmed.length > MAX_BATCH) {
    return { error: `Batch size exceeds the maximum of ${MAX_BATCH}` };
  }

  // Deduplicate
  const unique = [...new Set(trimmed)];

  // Pre-cache MX results per domain with bounded concurrency
  const domains = [
    ...new Set(
      unique
        .filter((e) => checkSyntax(e).valid)
        .map((e) => e.split("@")[1]),
    ),
  ];

  const mxCache = new Map();
  const dnsResolver = options.dnsResolver;

  // Bounded-concurrency DNS lookups
  await runWithConcurrency(DNS_CONCURRENCY, domains, async (domain) => {
    const result = await checkMx(domain, dnsResolver);
    mxCache.set(domain, result);
  });

  // Classify each unique email (MX results come from cache via a resolver wrapper)
  const cachedDnsResolver = {
    resolveMx: async (d) => {
      const cached = mxCache.get(d);
      if (!cached) throw Object.assign(new Error("uncached"), { code: "ENODATA" });
      if (cached.mx === "found") return [{ exchange: "mx." + d, priority: 10 }];
      if (cached.mx === "none") return [{ exchange: ".", priority: 0 }];
      if (cached.mx === "domain_not_found") {
        const err = new Error("NXDOMAIN");
        err.code = "ENOTFOUND";
        throw err;
      }
      // error
      const err = new Error("DNS_TIMEOUT");
      err.code = "ETIMEOUT";
      throw err;
    },
    resolve4: async () => [],
    resolve6: async () => [],
  };

  const results = await Promise.all(
    unique.map((email) =>
      classifyEmail(email, {
        dnsResolver: cachedDnsResolver,
        recipientVerifier: options.recipientVerifier,
      }),
    ),
  );

  // Build summary
  const summary = {
    total: unique.length,
    likely_deliverable: 0,
    likely_bounce: 0,
    unknown: 0,
  };
  for (const r of results) {
    if (summary[r.status] !== undefined) {
      summary[r.status]++;
    }
  }

  return { results, summary };
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

async function runWithConcurrency(limit, items, fn) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Vercel Serverless Handler (default export)
// ---------------------------------------------------------------------------

/**
 * Vercel-compatible serverless handler.
 * POST /api/verify  →  { emails: [...] }
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body;
  if (!body || !Array.isArray(body.emails)) {
    return res.status(400).json({ error: "Request body must include an emails array" });
  }

  if (body.emails.length === 0) {
    return res.status(400).json({ error: "emails array must not be empty" });
  }

  if (body.emails.length > MAX_BATCH) {
    return res.status(400).json({ error: `Batch size exceeds the maximum of ${MAX_BATCH}` });
  }

  const result = await verifyBatch(body.emails);

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  return res.status(200).json(result);
}
