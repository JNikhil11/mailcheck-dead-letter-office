import net from "node:net";
import dns from "node:dns/promises";
import dnsCb from "node:dns";
import os from "node:os";
import url from "node:url";
import validator from "validator";
const { isEmail } = validator;

// ---------------------------------------------------------------------------
// Constants & Configuration
// ---------------------------------------------------------------------------
export const MAX_BATCH = 100;
export const MAX_EMAIL_LENGTH = 2048;
export const RFC_MAX_EMAIL_LENGTH = 254;
export const RFC_MAX_LOCAL_LENGTH = 64;
export const DNS_TIMEOUT_MS = 2500;
export const API_TIMEOUT_MS = 4000;
export const SMTP_TIMEOUT_MS = 2500;
export const STAGE3_CONCURRENCY = 10;
export const DNS_CONCURRENCY = 10;

// Rate limiting: 20 requests per 60 seconds per IP
export const RATE_LIMIT_WINDOW_MS = 60000;
export const RATE_LIMIT_MAX_REQUESTS = 20;

// In-memory sliding-window IP rate limiter map: IP -> timestamp[]
const ipRateLimitMap = new Map();

/**
 * Reset rate limit tracker (for testing).
 */
export function resetRateLimits() {
  ipRateLimitMap.clear();
}

/**
 * Check if client IP is rate limited.
 * @param {string} ip
 * @param {number} [maxRequests=RATE_LIMIT_MAX_REQUESTS]
 * @param {number} [windowMs=RATE_LIMIT_WINDOW_MS]
 * @returns {{ allowed: boolean, retryAfter?: number }}
 */
export function checkRateLimit(ip, maxRequests = RATE_LIMIT_MAX_REQUESTS, windowMs = RATE_LIMIT_WINDOW_MS) {
  const now = Date.now();
  let timestamps = ipRateLimitMap.get(ip);
  if (!timestamps) {
    timestamps = [];
    ipRateLimitMap.set(ip, timestamps);
  }

  // Remove timestamps outside sliding window
  const windowStart = now - windowMs;
  timestamps = timestamps.filter((t) => t > windowStart);
  ipRateLimitMap.set(ip, timestamps);

  if (timestamps.length >= maxRequests) {
    const oldest = timestamps[0];
    const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return { allowed: false, retryAfter };
  }

  timestamps.push(now);
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// SSRF & Private / Reserved IP Protection
// ---------------------------------------------------------------------------

/**
 * Check if an IP address is private, loopback, link-local, multicast, or reserved.
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateOrReservedIP(ip) {
  if (!ip || typeof ip !== "string") return true;
  const s = ip.trim().toLowerCase();
  if (s === "localhost" || s === "0.0.0.0") return true;

  // Handle IPv4-mapped IPv6 like ::ffff:127.0.0.1
  if (s.startsWith("::ffff:")) {
    const ipv4Part = s.slice(7);
    if (net.isIPv4(ipv4Part)) return isPrivateOrReservedIP(ipv4Part);
  }

  if (net.isIPv4(s)) {
    const parts = s.split(".").map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some(isNaN)) return true;
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8 (current network)
    if (a === 10) return true; // 10.0.0.0/8 (private)
    if (a === 127) return true; // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (private)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 (private)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (carrier-grade NAT)
    if (a >= 224) return true; // 224.0.0.0/4 multicast & 240.0.0.0/4 reserved
    return false;
  }

  if (net.isIPv6(s)) {
    if (s === "::" || s === "::1") return true;
    // fe80::/10 link-local
    if (s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb")) return true;
    // fc00::/7 unique local address (ULA)
    if (s.startsWith("fc") || s.startsWith("fd")) return true;
    // ff00::/8 multicast
    if (s.startsWith("ff")) return true;
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Stage 1 — Syntax Check (with EAI / IDN & RFC 5321 length limits)
// ---------------------------------------------------------------------------

/**
 * Validate email syntax with RFC 5321 length limits and internationalized support.
 * @param {string} email
 * @returns {{ valid: boolean, email: string, domain?: string, rawDomain?: string, hasNonAsciiLocal?: boolean }}
 */
export function checkSyntax(email) {
  if (typeof email !== "string") return { valid: false, email: String(email) };

  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > RFC_MAX_EMAIL_LENGTH) {
    return { valid: false, email: trimmed };
  }

  // Reject emails that contain whitespace
  if (/\s/.test(trimmed)) return { valid: false, email: trimmed };

  // Must contain exactly one @
  const atParts = trimmed.split("@");
  if (atParts.length !== 2) return { valid: false, email: trimmed };

  const [localPart, domainPart] = atParts;
  if (!localPart || !domainPart || localPart.length > RFC_MAX_LOCAL_LENGTH) {
    return { valid: false, email: trimmed };
  }

  // Convert internationalized domain to ASCII punycode (RFC 5890 / IDNA)
  let asciiDomain;
  try {
    asciiDomain = url.domainToASCII(domainPart);
  } catch {
    return { valid: false, email: trimmed };
  }

  if (!asciiDomain) {
    return { valid: false, email: trimmed };
  }

  // Domain labels must not start or end with a hyphen
  const labels = asciiDomain.split(".");
  if (labels.length < 2) return { valid: false, email: trimmed };
  for (const label of labels) {
    if (!label || label.startsWith("-") || label.endsWith("-")) {
      return { valid: false, email: trimmed };
    }
  }

  // Construct normalized email for validator
  const normalizedForValidator = `${localPart}@${asciiDomain}`;

  // Allow UTF-8 local part in validator
  const valid = isEmail(normalizedForValidator, {
    allow_display_name: false,
    allow_utf8_local_part: true,
  });

  const hasNonAsciiLocal = /[^\x00-\x7F]/.test(localPart);

  return {
    valid,
    email: trimmed,
    domain: asciiDomain.toLowerCase(),
    rawDomain: domainPart,
    hasNonAsciiLocal,
  };
}

// ---------------------------------------------------------------------------
// Stage 2 — DNS / MX Check & RFC 7505 Null MX Support
// ---------------------------------------------------------------------------

/**
 * Race a promise against a timeout.
 * @param {Promise<any>} promise
 * @param {number} ms
 * @returns {Promise<any>}
 */
export function withTimeout(promise, ms) {
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

/**
 * Check MX (or implicit A/AAAA fallback) for a domain.
 * @param {string} domain
 * @param {object} [dnsResolver=dns] — injectable for testing
 * @returns {Promise<{ mx: string, exchange?: string, mxHosts?: string[], reason?: string, records?: object[] }>}
 */
export async function checkMx(domain, dnsResolver = dns) {
  let asciiDomain;
  try {
    asciiDomain = url.domainToASCII(domain).toLowerCase().trim();
  } catch {
    asciiDomain = domain.toLowerCase().trim();
  }

  try {
    const mxRecords = await withTimeout(
      dnsResolver.resolveMx(asciiDomain),
      DNS_TIMEOUT_MS,
    );

    // RFC 7505 Null MX Check:
    // A domain that does not accept email publishes a single Null MX record with exchange "." or ""
    if (
      Array.isArray(mxRecords) &&
      mxRecords.length === 1 &&
      (!mxRecords[0].exchange || mxRecords[0].exchange === "." || mxRecords[0].exchange === "")
    ) {
      return {
        mx: "none",
        reason: "Domain has no usable mail route",
      };
    }

    // Check if all records are null MX
    const isAllNull =
      Array.isArray(mxRecords) &&
      mxRecords.length > 0 &&
      mxRecords.every((r) => !r.exchange || r.exchange === "." || r.exchange === "");

    if (isAllNull) {
      return {
        mx: "none",
        reason: "Domain has no usable mail route",
      };
    }

    // Check for usable MX records
    const usable = Array.isArray(mxRecords)
      ? mxRecords.filter((r) => r.exchange && r.exchange !== "." && r.exchange !== "")
      : [];

    if (usable.length > 0) {
      usable.sort((a, b) => (a.priority || 0) - (b.priority || 0));
      const mxHosts = usable.map((r) => r.exchange);
      return {
        mx: "found",
        exchange: mxHosts[0],
        mxHosts,
        records: usable,
      };
    }

    return {
      mx: "none",
      reason: "Domain has no usable mail route",
    };
  } catch (err) {
    // ENODATA / NO_DATA / ENOTFOUND (on MX query specifically): try RFC 5321 A / AAAA fallback
    if (err.code === "ENODATA" || err.code === "NO_DATA") {
      return await fallbackToAddressRecords(asciiDomain, dnsResolver);
    }

    if (err.code === "ENOTFOUND") {
      // Domain itself does not exist in DNS
      return { mx: "domain_not_found", reason: "Domain cannot be resolved" };
    }

    // Transient resolver errors / timeouts: ETIMEOUT, ESERVFAIL, EREFUSED, EAI_AGAIN, TIMEOUT
    if (
      err.code === "ETIMEOUT" ||
      err.code === "ESERVFAIL" ||
      err.code === "EREFUSED" ||
      err.code === "EAI_AGAIN" ||
      err.code === "TIMEOUT" ||
      err.message === "DNS_TIMEOUT"
    ) {
      return {
        mx: "error",
        reason: "The check timed out, so the result is inconclusive",
      };
    }

    // Any other error -> treat as transient inconclusive error
    return {
      mx: "error",
      reason: "The check timed out, so the result is inconclusive",
    };
  }
}

/**
 * RFC 5321 fallback: if no MX records exist (ENODATA), query A and AAAA in parallel.
 * @param {string} domain
 * @param {object} dnsResolver
 * @returns {Promise<{ mx: string, exchange?: string, mxHosts?: string[], reason?: string }>}
 */
export async function fallbackToAddressRecords(domain, dnsResolver) {
  const [res4, res6] = await Promise.allSettled([
    withTimeout(dnsResolver.resolve4(domain), DNS_TIMEOUT_MS),
    withTimeout(dnsResolver.resolve6(domain), DNS_TIMEOUT_MS),
  ]);

  const has4 = res4.status === "fulfilled" && Array.isArray(res4.value) && res4.value.length > 0;
  const has6 = res6.status === "fulfilled" && Array.isArray(res6.value) && res6.value.length > 0;

  if (has4 || has6) {
    return { mx: "found", exchange: domain, mxHosts: [domain] };
  }

  // Definitive absence: either fulfilled with empty array or rejected with ENODATA / ENOTFOUND
  const isDefinitiveNoRecord = (r) => {
    if (r.status === "fulfilled") {
      return !r.value || r.value.length === 0;
    }
    const code = r.reason?.code;
    return code === "ENODATA" || code === "ENOTFOUND" || code === "NO_DATA";
  };

  const bothDefinitiveNo = isDefinitiveNoRecord(res4) && isDefinitiveNoRecord(res6);

  if (bothDefinitiveNo) {
    return { mx: "none", reason: "Domain has no usable mail route" };
  }

  // If neither returned addresses and at least one had a timeout or transient error:
  return { mx: "error", reason: "The check timed out, so the result is inconclusive" };
}

// ---------------------------------------------------------------------------
// Stage 3 — Recipient Verification Engine
// ---------------------------------------------------------------------------

/**
 * Helper to extract a complete single or multiline SMTP response.
 */
function extractSmtpResponse(buffer) {
  const lines = buffer.split(/\r?\n/);
  if (lines.length < 2) return null;

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
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
 * Determine if an SMTP response line indicates an explicit nonexistent mailbox.
 * Strictly narrows 5xx rejections: only 550, 551, 553 with 5.1.1/user unknown wording,
 * excluding policy, reputation, spam, or relay rejections.
 * @param {number} code
 * @param {string} line
 * @returns {boolean}
 */
export function isExplicitMailboxNotFound(code, line) {
  const lower = (line || "").toLowerCase();

  // If message matches policy / reputation / spam / block / relay / quota -> NOT a mailbox rejection!
  if (
    lower.includes("5.7.") ||
    lower.includes("spam") ||
    lower.includes("policy") ||
    lower.includes("blocked") ||
    lower.includes("blacklisted") ||
    lower.includes("reputation") ||
    lower.includes("prohibited") ||
    lower.includes("access denied") ||
    lower.includes("relay") ||
    lower.includes("quota") ||
    lower.includes("too many") ||
    code === 554 ||
    code === 552
  ) {
    return false;
  }

  // Explicit non-existent mailbox codes: 550, 551, 553
  if (code === 550 || code === 551 || code === 553) {
    // Check for explicit enhanced status codes or phrasing
    if (
      lower.includes("5.1.1") ||
      lower.includes("5.1.0") ||
      lower.includes("5.1.2") ||
      lower.includes("5.1.3") ||
      lower.includes("user unknown") ||
      lower.includes("no such user") ||
      lower.includes("does not exist") ||
      lower.includes("mailbox unavailable") ||
      lower.includes("unknown recipient") ||
      lower.includes("recipient not found") ||
      lower.includes("invalid recipient")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Perform a lightweight non-sending SMTP probe on port 25.
 * Strictly sends only EHLO, MAIL FROM, and RCPT TO.
 * NEVER sends DATA or any email body. Always sends QUIT and closes socket immediately.
 * 
 * @param {string} email - Email address to verify
 * @param {string} mxHost - Resolved MX hostname
 * @param {object} [options]
 * @returns {Promise<{ recipient: string, status: string, reason: string }>}
 */
export async function probeSmtpRecipient(email, mxHost, options = {}) {
  const port = options.port || 25;
  const timeoutMs = options.timeout || SMTP_TIMEOUT_MS;
  const domain = email.split("@")[1];
  const randomProbe = `nonexistent-probe-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@${domain}`;

  // Configurable HELO/EHLO domain and MAIL FROM
  const heloDomain =
    options.heloDomain ||
    process.env.SMTP_HELO_DOMAIN ||
    (typeof os.hostname === "function" ? os.hostname() : "") ||
    "mailcheck.org";

  const mailFrom = options.mailFrom !== undefined ? options.mailFrom : (process.env.SMTP_MAIL_FROM || "");

  // SSRF Protection: verify resolved IP is public before connecting
  if (typeof options.socketFactory !== "function") {
    try {
      const resolvedAddress = await new Promise((resolve, reject) => {
        dnsCb.lookup(mxHost, (err, address) => {
          if (err) return reject(err);
          resolve(address);
        });
      });
      if (isPrivateOrReservedIP(resolvedAddress)) {
        return {
          recipient: "inconclusive",
          status: "unknown",
          reason: "Domain accepts mail, but the mailbox was not confirmed",
        };
      }
    } catch {
      return {
        recipient: "not_checked",
        status: "unknown",
        reason: "Domain accepts mail, but the mailbox was not confirmed",
      };
    }
  }

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
          socket.on("error", () => {});
          socket.destroy();
        }
        resolve(result);
      }
    }

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
      if (typeof options.socketFactory === "function") {
        socket = options.socketFactory({ host: mxHost, port });
      } else {
        socket = net.createConnection({
          host: mxHost,
          port,
          lookup: (hostname, opt, cb) => {
            dnsCb.lookup(hostname, opt, (err, address, family) => {
              if (err) return cb(err);
              if (isPrivateOrReservedIP(address)) {
                return cb(new Error("BLOCKED_PRIVATE_IP"));
              }
              cb(null, address, family);
            });
          },
        });
      }
    } catch {
      return safeResolve({
        recipient: "not_checked",
        status: "unknown",
        reason: "Domain accepts mail, but the mailbox was not confirmed",
      });
    }

    socket.setTimeout(timeoutMs);

    socket.on("error", (err) => {
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
            socket.write(`EHLO ${heloDomain}\r\n`);
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
            socket.write(`MAIL FROM:<${mailFrom}>\r\n`);
          } else if (code >= 500 && code < 600) {
            state = "WAIT_HELO";
            socket.write(`HELO ${heloDomain}\r\n`);
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
            socket.write(`MAIL FROM:<${mailFrom}>\r\n`);
          } else {
            return safeResolve({
              recipient: "inconclusive",
              status: "unknown",
              reason: "Domain accepts mail, but the mailbox was not confirmed",
            });
          }
        } else if (state === "WAIT_MAIL") {
          if (code === 250) {
            // Check catch-all cache first
            if (options.catchAllCache && options.catchAllCache.get(domain) === "catch_all") {
              return safeResolve({
                recipient: "inconclusive",
                status: "unknown",
                reason: "Domain accepts all mail (catch-all), so individual mailbox could not be confirmed",
              });
            }
            if (options.catchAllCache && options.catchAllCache.get(domain) === "ambiguous") {
              return safeResolve({
                recipient: "inconclusive",
                status: "unknown",
                reason: "Domain accepts mail, but the mailbox was not confirmed",
              });
            }

            // Probe randomized non-existent address for catch-all check
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
            // Server accepted random address -> Catch-all domain detected!
            if (options.catchAllCache) options.catchAllCache.set(domain, "catch_all");
            return safeResolve({
              recipient: "inconclusive",
              status: "unknown",
              reason: "Domain accepts all mail (catch-all), so individual mailbox could not be confirmed",
            });
          } else if (code >= 400 && code < 500) {
            // Greylisted or temporary rate limit
            if (options.catchAllCache) options.catchAllCache.set(domain, "ambiguous");
            return safeResolve({
              recipient: "inconclusive",
              status: "unknown",
              reason: "Domain accepts mail, but the mailbox was not confirmed",
            });
          } else if (!isExplicitMailboxNotFound(code, line)) {
            // Random probe received policy block or ambiguous 5xx -> do NOT probe real address
            if (options.catchAllCache) options.catchAllCache.set(domain, "ambiguous");
            return safeResolve({
              recipient: "inconclusive",
              status: "unknown",
              reason: "Domain accepts mail, but the mailbox was not confirmed",
            });
          } else {
            // Server explicitly rejected random address -> Domain is NOT catch-all!
            if (options.catchAllCache) options.catchAllCache.set(domain, "not_catch_all");
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
          } else if (isExplicitMailboxNotFound(code, line)) {
            return safeResolve({
              recipient: "rejected",
              status: "likely_bounce",
              reason: "Recipient mailbox was rejected by the mail server",
            });
          } else {
            // Policy block, quota, greylisting, or ambiguous 5xx
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

/**
 * Optional External Verification API (Port 443 — works in serverless environments).
 * Sends API key via Authorization header, keeps timeout active during JSON parsing,
 * and handles failures gracefully.
 * @param {string} email
 * @param {object} [options]
 * @returns {Promise<{ recipient: string, status: string, reason: string }|null>}
 */
export async function checkRecipientViaHttps(email, options = {}) {
  const env = options.env || process.env;
  const apiKey = options.apiKey || env.EMAIL_VERIFICATION_API_KEY;
  if (!apiKey) return null;

  const apiUrl = options.apiUrl || env.EMAIL_VERIFICATION_API_URL;
  let endpoint;
  let useAuthHeader = true;

  if (apiUrl) {
    if (apiUrl.includes("{email}")) {
      endpoint = apiUrl.replace("{email}", encodeURIComponent(email));
      if (endpoint.includes("{key}")) {
        endpoint = endpoint.replace("{key}", encodeURIComponent(apiKey));
        useAuthHeader = false;
      }
    } else {
      endpoint = `${apiUrl}${apiUrl.includes("?") ? "&" : "?"}email=${encodeURIComponent(email)}`;
    }
  } else {
    // Default: Emailable API over HTTPS Port 443
    endpoint = `https://api.emailable.com/v1/verify?email=${encodeURIComponent(email)}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const headers = { Accept: "application/json" };
    if (useAuthHeader) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const fetchImpl = options.fetchFn || fetch;
    const res = await fetchImpl(endpoint, {
      signal: controller.signal,
      headers,
    });

    if (!res.ok) {
      return {
        recipient: "inconclusive",
        status: "unknown",
        reason: "Domain accepts mail, but the mailbox was not confirmed",
      };
    }

    const data = await res.json();
    const rawState = (
      data.state ||
      data.result ||
      data.status ||
      data.deliverability ||
      data.data?.status ||
      data.data?.result ||
      ""
    ).toLowerCase();

    if (["deliverable", "valid", "accepted", "safe"].includes(rawState)) {
      return {
        recipient: "accepted",
        status: "likely_deliverable",
        reason: "Recipient verification received a positive response",
      };
    }

    if (["undeliverable", "invalid", "rejected", "bounced"].includes(rawState)) {
      return {
        recipient: "rejected",
        status: "likely_bounce",
        reason: "Recipient mailbox was rejected by the mail server",
      };
    }

    return {
      recipient: "inconclusive",
      status: "unknown",
      reason: "Domain accepts mail, but the mailbox was not confirmed",
    };
  } catch {
    return {
      recipient: "inconclusive",
      status: "unknown",
      reason: "Domain accepts mail, but the mailbox was not confirmed",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Single Email Classification Pipeline
// ---------------------------------------------------------------------------

/**
 * Full classification pipeline for a single email address.
 * @param {string} email
 * @param {object} [options]
 * @returns {Promise<{ email: string, status: string, reason: string, checks: object }>}
 */
export async function classifyEmail(email, options = {}) {
  const env = options.env || process.env;
  const { dnsResolver, recipientVerifier, smtpProber, apiKey, apiUrl, catchAllCache } = options;

  // Stage 1 — Syntax Check
  const syntaxResult = checkSyntax(email);
  if (!syntaxResult.valid) {
    return {
      email,
      status: "likely_bounce",
      reason: "Invalid email format",
      checks: { syntax: "fail", mx: "not_checked", recipient: "not_checked" },
    };
  }

  // Stage 2 — DNS / MX Check
  const domain = syntaxResult.domain || email.split("@")[1];
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

  // If local part has non-ASCII characters and no external verifier is configured:
  // Return unknown as standard SMTP servers without SMTPUTF8 cannot verify it
  if (syntaxResult.hasNonAsciiLocal && !recipientVerifier && !apiKey && !env.EMAIL_VERIFICATION_API_KEY) {
    return {
      email,
      status: "unknown",
      reason: "Domain accepts mail, but the mailbox was not confirmed",
      checks: { syntax: "pass", mx: "found", recipient: "not_checked" },
    };
  }

  // Stage 3 — Recipient Verification

  // 1. Dependency-injected recipient verifier (for unit tests)
  if (typeof recipientVerifier === "function") {
    try {
      const vResult = await recipientVerifier(email, mxResult.exchange);
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
      return {
        email,
        status: "unknown",
        reason: vReason || "Recipient check was inconclusive",
        checks: { syntax: "pass", mx: "found", recipient: "inconclusive" },
      };
    } catch {
      return {
        email,
        status: "unknown",
        reason: "Recipient check was inconclusive",
        checks: { syntax: "pass", mx: "found", recipient: "inconclusive" },
      };
    }
  }

  // 2. External HTTPS Verification API
  if (env.EMAIL_VERIFICATION_API_KEY || apiKey) {
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

  // 3. Direct SMTP Port 25 Probing (disabled by default in serverless / when blocked)
  const isSmtpExplicitlyEnabled = options.enableSmtp === true || env.ENABLE_SMTP_PROBE === "true";
  const isVercel = Boolean(env.VERCEL);
  const shouldAttemptSmtp = isSmtpExplicitlyEnabled && !isVercel;

  if (shouldAttemptSmtp) {
    const prober = smtpProber || probeSmtpRecipient;
    const mxHosts = mxResult.mxHosts || (mxResult.exchange ? [mxResult.exchange] : []);

    // Multi-MX fallback: try primary MX, then fallback to secondary if connection fails
    for (let i = 0; i < Math.min(mxHosts.length, 2); i++) {
      const host = mxHosts[i];
      try {
        const smtpResult = await prober(email, host, {
          timeout: SMTP_TIMEOUT_MS,
          catchAllCache,
          ...options,
        });

        if (smtpResult && smtpResult.recipient !== "not_checked") {
          return {
            email,
            status: smtpResult.status,
            reason: smtpResult.reason,
            checks: { syntax: "pass", mx: "found", recipient: smtpResult.recipient },
          };
        }
      } catch {
        // Try next MX host if available
      }
    }
  }

  // Default honest verdict when recipient was not confirmed
  return {
    email,
    status: "unknown",
    reason: "Domain accepts mail, but the mailbox was not confirmed",
    checks: { syntax: "pass", mx: "found", recipient: "not_checked" },
  };
}

// ---------------------------------------------------------------------------
// Concurrency Runner
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

  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Batch Verification
// ---------------------------------------------------------------------------

/**
 * Verify a batch of email addresses.
 * @param {string[]} emails — raw array from client
 * @param {object} [options] — injectable dependencies
 * @returns {Promise<{ results: object[], summary: object } | { error: string }>}
 */
export async function verifyBatch(emails, options = {}) {
  if (!Array.isArray(emails) || emails.length === 0) {
    return { error: "emails must be a non-empty array" };
  }

  // Validate all items are strings and enforce max string length
  for (let i = 0; i < emails.length; i++) {
    const item = emails[i];
    if (typeof item !== "string") {
      return { error: "Every item in emails must be a string" };
    }
    if (item.length > MAX_EMAIL_LENGTH) {
      return { error: `Email string exceeds maximum length of ${MAX_EMAIL_LENGTH} characters` };
    }
  }

  // Filter empty strings
  const trimmed = emails.map((e) => e.trim()).filter((e) => e.length > 0);
  if (trimmed.length === 0) {
    return { error: "emails must be a non-empty array" };
  }

  if (trimmed.length > MAX_BATCH) {
    return { error: `Batch size exceeds the maximum of ${MAX_BATCH}` };
  }

  // Deduplicate case-insensitively, preserving original casing of first appearance
  const seenLower = new Set();
  const unique = [];
  for (const item of trimmed) {
    const lower = item.toLowerCase();
    if (!seenLower.has(lower)) {
      seenLower.add(lower);
      unique.push(item);
    }
  }

  // Pre-cache MX results per domain with bounded concurrency
  const validDomains = [
    ...new Set(
      unique
        .map((e) => checkSyntax(e))
        .filter((s) => s.valid && s.domain)
        .map((s) => s.domain),
    ),
  ];

  const mxCache = new Map();
  const dnsResolver = options.dnsResolver;

  await runWithConcurrency(DNS_CONCURRENCY, validDomains, async (domain) => {
    const result = await checkMx(domain, dnsResolver);
    mxCache.set(domain, result);
  });

  // Cached resolver wrapper to avoid redundant DNS lookups for same domain
  const cachedDnsResolver = {
    resolveMx: async (d) => {
      let asciiD;
      try {
        asciiD = url.domainToASCII(d).toLowerCase().trim();
      } catch {
        asciiD = d.toLowerCase().trim();
      }

      const cached = mxCache.get(asciiD);
      if (!cached) {
        if (dnsResolver && typeof dnsResolver.resolveMx === "function") {
          return dnsResolver.resolveMx(asciiD);
        }
        throw Object.assign(new Error("uncached"), { code: "ENODATA" });
      }

      if (cached.mx === "found") {
        return cached.records || [{ exchange: cached.exchange, priority: 10 }];
      }
      if (cached.mx === "none") {
        return [{ exchange: ".", priority: 0 }];
      }
      if (cached.mx === "domain_not_found") {
        const err = new Error("NXDOMAIN");
        err.code = "ENOTFOUND";
        throw err;
      }
      const err = new Error("DNS_TIMEOUT");
      err.code = "ETIMEOUT";
      throw err;
    },
    resolve4: async (d) => {
      if (dnsResolver && typeof dnsResolver.resolve4 === "function") {
        return dnsResolver.resolve4(d);
      }
      return [];
    },
    resolve6: async (d) => {
      if (dnsResolver && typeof dnsResolver.resolve6 === "function") {
        return dnsResolver.resolve6(d);
      }
      return [];
    },
  };

  const catchAllCache = new Map();

  // Bounded concurrency Stage 3 classification (max 10 concurrent checks)
  const results = await runWithConcurrency(STAGE3_CONCURRENCY, unique, async (email) => {
    return await classifyEmail(email, {
      ...options,
      dnsResolver: cachedDnsResolver,
      catchAllCache,
    });
  });

  // Build summary counts
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
// Vercel Serverless Handler (default export)
// ---------------------------------------------------------------------------

/**
 * Extract client IP address from request headers or socket.
 * @param {object} req
 * @returns {string}
 */
export function getClientIp(req) {
  const xForwardedFor = req.headers && req.headers["x-forwarded-for"];
  if (xForwardedFor) {
    const first = xForwardedFor.split(",")[0].trim();
    if (first) return first;
  }
  const xRealIp = req.headers && req.headers["x-real-ip"];
  if (xRealIp) return xRealIp.trim();
  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return "127.0.0.1";
}

/**
 * Vercel-compatible serverless handler.
 * POST /api/verify  →  { emails: [...] }
 */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Client IP rate limiting
    const clientIp = getClientIp(req);
    const rateLimit = checkRateLimit(clientIp);
    if (!rateLimit.allowed) {
      if (typeof res.setHeader === "function") {
        res.setHeader("Retry-After", String(rateLimit.retryAfter || 60));
      }
      return res.status(429).json({
        error: "Too many verification requests. Please wait a minute and try again.",
      });
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

    // Validate that every element in emails is strictly a string
    for (let i = 0; i < body.emails.length; i++) {
      const item = body.emails[i];
      if (typeof item !== "string") {
        return res.status(400).json({ error: "Every item in emails must be a string" });
      }
      if (item.length > MAX_EMAIL_LENGTH) {
        return res.status(400).json({ error: `Email string exceeds maximum length of ${MAX_EMAIL_LENGTH} characters` });
      }
    }

    const result = await verifyBatch(body.emails);

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error("[api/verify] Unexpected error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
