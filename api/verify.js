import net from "node:net";
import dns from "node:dns/promises";
import validator from "validator";
const { isEmail } = validator;

// ---------------------------------------------------------------------------
// Module-level injection hooks (for unit tests and overrides)
// ---------------------------------------------------------------------------
let _recipientVerifier = null;
let _smtpProber = null;

/**
 * Inject a custom recipient-verification function for unit tests.
 * @param {Function|null} fn
 */
export function setRecipientVerifier(fn) {
  _recipientVerifier = fn;
}

/** Remove any previously injected verifier. */
export function clearRecipientVerifier() {
  _recipientVerifier = null;
}

/**
 * Inject a custom SMTP prober function for unit tests.
 * @param {Function|null} fn
 */
export function setSmtpProber(fn) {
  _smtpProber = fn;
}

/** Remove any previously injected SMTP prober. */
export function clearSmtpProber() {
  _smtpProber = null;
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
 * @returns {Promise<{ mx: string, exchange?: string, reason?: string, records?: object[] }>}
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
      usable.sort((a, b) => (a.priority || 0) - (b.priority || 0));
      return { mx: "found", exchange: usable[0].exchange, records: usable };
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
    if (a && a.length > 0) return { mx: "found", exchange: domain };
  } catch {
    // ignore — try AAAA next
  }

  try {
    const aaaa = await withTimeout(dnsResolver.resolve6(domain), 4000);
    if (aaaa && aaaa.length > 0) return { mx: "found", exchange: domain };
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
// Stage 3 — Direct SMTP Probing (`node:net`) with Safe Fallback
// ---------------------------------------------------------------------------

/**
 * Helper to extract a complete single or multiline SMTP response.
 */
function extractSmtpResponse(buffer) {
  const lines = buffer.split(/\r?\n/);
  if (lines.length < 2) return null;

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    // A terminal line starts with 3 digits followed by a space or end of line
    const match = line.match(/^(\d{3})(?: (.*))?$/);
    if (match) {
      const lineEnd = buffer.indexOf(line) + line.length;
      let nextIndex = lineEnd;
      if (buffer[nextIndex] === "\r") nextIndex++;
      if (buffer[nextIndex] === "\n") nextIndex++;

      return {
        code: parseInt(match[1], 10),
        lastLine: line,
        remaining: buffer.slice(nextIndex),
      };
    }
  }
  return null;
}

/**
 * Perform a lightweight non-sending SMTP probe on port 25.
 * Strictly sends only EHLO, MAIL FROM:<>, and RCPT TO.
 * NEVER sends DATA or any email body.
 * Always sends QUIT and closes socket immediately.
 * 
 * @param {string} email - Email address to verify
 * @param {string} mxHost - Resolved MX hostname
 * @param {object} [options]
 * @param {number} [options.port=25]
 * @param {number} [options.timeout=3500]
 * @returns {Promise<{ recipient: string, status: string, reason: string }>}
 */
export async function probeSmtpRecipient(email, mxHost, options = {}) {
  const port = options.port || 25;
  const timeoutMs = options.timeout || 3500;
  const domain = email.split("@")[1];
  const randomProbe = `nonexistent-probe-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@${domain}`;

  return new Promise((resolve) => {
    let resolved = false;
    let greetingReceived = false;
    let socket = null;

    function safeResolve(result) {
      if (!resolved) {
        resolved = true;
        clearTimeout(overallTimer);
        if (socket) {
          try {
            socket.write("QUIT\r\n");
          } catch {}
          socket.on("error", () => {}); // swallow late socket resets
          socket.destroy();
        }
        resolve(result);
      }
    }

    // Strict overall timeout
    const overallTimer = setTimeout(() => {
      if (!greetingReceived) {
        safeResolve({
          recipient: "not_checked",
          status: "unknown",
          reason: "Domain accepts mail, but the mailbox was not confirmed",
        });
      } else {
        safeResolve({
          recipient: "inconclusive",
          status: "unknown",
          reason: "The check timed out, so the result is inconclusive",
        });
      }
    }, timeoutMs);

    try {
      socket = net.createConnection({ host: mxHost, port });
    } catch {
      return safeResolve({
        recipient: "not_checked",
        status: "unknown",
        reason: "Domain accepts mail, but the mailbox was not confirmed",
      });
    }

    socket.setTimeout(timeoutMs);

    socket.on("error", (err) => {
      // Connect errors (ECONNREFUSED, ETIMEDOUT, ENETUNREACH, EHOSTUNREACH, ENOTFOUND)
      if (!greetingReceived || ["ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EACCES"].includes(err.code)) {
        safeResolve({
          recipient: "not_checked",
          status: "unknown",
          reason: "Domain accepts mail, but the mailbox was not confirmed",
        });
      } else {
        safeResolve({
          recipient: "inconclusive",
          status: "unknown",
          reason: "Domain accepts mail, but the mailbox was not confirmed",
        });
      }
    });

    socket.on("timeout", () => {
      if (!greetingReceived) {
        safeResolve({
          recipient: "not_checked",
          status: "unknown",
          reason: "Domain accepts mail, but the mailbox was not confirmed",
        });
      } else {
        safeResolve({
          recipient: "inconclusive",
          status: "unknown",
          reason: "The check timed out, so the result is inconclusive",
        });
      }
    });

    let buffer = "";
    let state = "WAIT_GREETING";

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      while (true) {
        const response = extractSmtpResponse(buffer);
        if (!response) break;
        buffer = response.remaining;

        const code = response.code;
        const line = response.lastLine;

        if (state === "WAIT_GREETING") {
          if (code === 220) {
            greetingReceived = true;
            state = "WAIT_EHLO";
            socket.write("EHLO mailcheck.local\r\n");
          } else {
            return safeResolve({
              recipient: "inconclusive",
              status: "unknown",
              reason: "Domain accepts mail, but the mailbox was not confirmed",
            });
          }
        } else if (state === "WAIT_EHLO") {
          if (code === 250) {
            state = "WAIT_MAIL";
            socket.write("MAIL FROM:<>\r\n");
          } else if (code >= 500 && code < 600) {
            // EHLO rejected, fallback to standard HELO
            state = "WAIT_HELO";
            socket.write("HELO mailcheck.local\r\n");
          } else {
            return safeResolve({
              recipient: "inconclusive",
              status: "unknown",
              reason: "Domain accepts mail, but the mailbox was not confirmed",
            });
          }
        } else if (state === "WAIT_HELO") {
          if (code === 250) {
            state = "WAIT_MAIL";
            socket.write("MAIL FROM:<>\r\n");
          } else {
            return safeResolve({
              recipient: "inconclusive",
              status: "unknown",
              reason: "Domain accepts mail, but the mailbox was not confirmed",
            });
          }
        } else if (state === "WAIT_MAIL") {
          if (code === 250) {
            // Step 1: Perform quick catch-all probe with random address
            state = "WAIT_CATCHALL";
            socket.write(`RCPT TO:<${randomProbe}>\r\n`);
          } else {
            return safeResolve({
              recipient: "inconclusive",
              status: "unknown",
              reason: "Domain accepts mail, but the mailbox was not confirmed",
            });
          }
        } else if (state === "WAIT_CATCHALL") {
          if (code === 250 || code === 251) {
            // Domain accepted random non-existent address -> catch-all detected!
            return safeResolve({
              recipient: "inconclusive",
              status: "unknown",
              reason: "Domain accepts all mail (catch-all), so individual mailbox could not be confirmed",
            });
          } else if (code >= 400 && code < 500) {
            // Greylisted or temporary rate limit
            return safeResolve({
              recipient: "inconclusive",
              status: "unknown",
              reason: "Domain accepts mail, but the mailbox was not confirmed",
            });
          } else {
            // Server properly rejected the random address -> NOT a catch-all domain!
            // Step 2: Now probe the real target email address
            state = "WAIT_RCPT";
            socket.write(`RCPT TO:<${email}>\r\n`);
          }
        } else if (state === "WAIT_RCPT") {
          if (code === 250 || code === 251) {
            return safeResolve({
              recipient: "accepted",
              status: "likely_deliverable",
              reason: "Recipient verification received a positive response",
            });
          } else if (
            code === 550 ||
            code === 551 ||
            code === 553 ||
            line.includes("5.1.1") ||
            (code >= 550 && code <= 559)
          ) {
            return safeResolve({
              recipient: "rejected",
              status: "likely_bounce",
              reason: "Recipient mailbox was rejected by the mail server",
            });
          } else {
            // Greylisted or inconclusive response
            return safeResolve({
              recipient: "inconclusive",
              status: "unknown",
              reason: "Domain accepts mail, but the mailbox was not confirmed",
            });
          }
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Optional HTTPS Verification API (Port 443 — works on Vercel)
// ---------------------------------------------------------------------------

/**
 * Optional HTTPS verification API check.
 * Called if EMAIL_VERIFICATION_API_KEY is configured.
 * @param {string} email
 * @param {object} [options]
 * @returns {Promise<{ recipient: string, status: string, reason: string }|null>}
 */
export async function checkRecipientViaHttps(email, options = {}) {
  const apiKey = options.apiKey || process.env.EMAIL_VERIFICATION_API_KEY;
  if (!apiKey) return null;

  const apiUrl = options.apiUrl || process.env.EMAIL_VERIFICATION_API_URL;
  let endpoint;
  if (apiUrl) {
    endpoint = apiUrl.includes("{email}")
      ? apiUrl.replace("{email}", encodeURIComponent(email))
      : `${apiUrl}${apiUrl.includes("?") ? "&" : "?"}email=${encodeURIComponent(email)}`;
  } else {
    endpoint = `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${encodeURIComponent(apiKey)}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(endpoint, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      return {
        recipient: "inconclusive",
        status: "unknown",
        reason: "Recipient check was inconclusive",
      };
    }

    const data = await res.json();
    const rawStatus = (
      data.result ||
      data.status ||
      data.deliverability ||
      data.data?.status ||
      data.data?.result ||
      ""
    ).toLowerCase();

    if (["deliverable", "valid", "accepted", "safe"].includes(rawStatus)) {
      return {
        recipient: "accepted",
        status: "likely_deliverable",
        reason: "Recipient verification received a positive response",
      };
    }

    if (["undeliverable", "invalid", "rejected", "bounced"].includes(rawStatus)) {
      return {
        recipient: "rejected",
        status: "likely_bounce",
        reason: "Recipient mailbox was rejected by the mail server",
      };
    }

    return {
      recipient: "inconclusive",
      status: "unknown",
      reason: "Recipient check was inconclusive",
    };
  } catch {
    clearTimeout(timer);
    return {
      recipient: "inconclusive",
      status: "unknown",
      reason: "The check timed out, so the result is inconclusive",
    };
  }
}

// ---------------------------------------------------------------------------
// Classification Pipeline
// ---------------------------------------------------------------------------

/**
 * Full classification pipeline for a single email address.
 * @param {string} email
 * @param {{ dnsResolver?: object, recipientVerifier?: Function, smtpProber?: Function, enableSmtp?: boolean, apiKey?: string, apiUrl?: string }} [options]
 * @returns {Promise<{ email: string, status: string, reason: string, checks: object }>}
 */
export async function classifyEmail(email, options = {}) {
  const { dnsResolver, recipientVerifier, smtpProber, enableSmtp } = options;

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

  // Stage 3 — Recipient Verification
  // 1. Custom injected recipient verifier (for tests or programmatic override)
  const verifier = recipientVerifier || _recipientVerifier;
  if (verifier) {
    try {
      const vResult = await verifier(email);
      const vRecipient = typeof vResult === "object" ? vResult.recipient : vResult;
      const vReason = typeof vResult === "object" ? vResult.reason : null;

      if (vRecipient === "accepted") {
        return {
          email,
          status: "likely_deliverable",
          reason: vReason || "Recipient verification received a positive response",
          checks: { syntax: "pass", mx: "found", recipient: "accepted" },
        };
      }
      if (vRecipient === "rejected") {
        return {
          email,
          status: "likely_bounce",
          reason: vReason || "Recipient mailbox does not exist",
          checks: { syntax: "pass", mx: "found", recipient: "rejected" },
        };
      }
      if (vRecipient === "inconclusive") {
        return {
          email,
          status: "unknown",
          reason: vReason || "Recipient check was inconclusive",
          checks: { syntax: "pass", mx: "found", recipient: "inconclusive" },
        };
      }
    } catch {
      return {
        email,
        status: "unknown",
        reason: "Recipient check was inconclusive",
        checks: { syntax: "pass", mx: "found", recipient: "inconclusive" },
      };
    }
  }

  // 2. Optional HTTPS Verification API (if configured in environment)
  if (process.env.EMAIL_VERIFICATION_API_KEY || options.apiKey) {
    const apiResult = await checkRecipientViaHttps(email, options);
    if (apiResult) {
      return {
        email,
        status: apiResult.status,
        reason: apiResult.reason,
        checks: { syntax: "pass", mx: "found", recipient: apiResult.recipient },
      };
    }
  }

  // 3. Direct SMTP probing on Port 25 (with catch-all detection)
  const prober = smtpProber || _smtpProber || probeSmtpRecipient;
  if (mxResult.exchange && enableSmtp !== false) {
    try {
      const smtpResult = await prober(email, mxResult.exchange, options);
      if (smtpResult) {
        return {
          email,
          status: smtpResult.status,
          reason: smtpResult.reason,
          checks: { syntax: "pass", mx: "found", recipient: smtpResult.recipient },
        };
      }
    } catch {
      // Gracefully fall through to conservative default
    }
  }

  // 4. Default conservative fallback (port 25 blocked or disabled)
  return {
    email,
    status: "unknown",
    reason: "Domain accepts mail, but the mailbox was not confirmed",
    checks: { syntax: "pass", mx: "found", recipient: "not_checked" },
  };
}

// ---------------------------------------------------------------------------
// Batch Verification
// ---------------------------------------------------------------------------

const MAX_BATCH = 100;
const DNS_CONCURRENCY = 10;

/**
 * Verify a batch of email addresses.
 * @param {string[]} emails — raw array from the client
 * @param {object} [options]
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

  // Cached resolver wrapper
  const cachedDnsResolver = {
    resolveMx: async (d) => {
      const cached = mxCache.get(d);
      if (!cached) throw Object.assign(new Error("uncached"), { code: "ENODATA" });
      if (cached.mx === "found") return [{ exchange: cached.exchange || ("mx." + d), priority: 10 }];
      if (cached.mx === "none") return [{ exchange: ".", priority: 0 }];
      if (cached.mx === "domain_not_found") {
        const err = new Error("NXDOMAIN");
        err.code = "ENOTFOUND";
        throw err;
      }
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
        smtpProber: options.smtpProber,
        enableSmtp: options.enableSmtp,
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
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
