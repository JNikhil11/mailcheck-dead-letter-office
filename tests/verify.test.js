import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import handler, {
  checkSyntax,
  checkMx,
  classifyEmail,
  verifyBatch,
  probeSmtpRecipient,
  checkRecipientViaHttps,
  isPrivateOrReservedIP,
  checkRateLimit,
  resetRateLimits,
} from "../api/verify.js";

// ---------------------------------------------------------------------------
// Helpers — Mock DNS Resolvers
// ---------------------------------------------------------------------------

function mxFoundResolver(exchange = "mx.example.com") {
  return {
    resolveMx: async () => [{ exchange, priority: 10 }],
    resolve4: async () => ["93.184.216.34"],
    resolve6: async () => ["2606:2800:220:1:248:1893:25c8:1946"],
  };
}

function nxdomainResolver() {
  return {
    resolveMx: async () => {
      const err = new Error("queryMx ENOTFOUND");
      err.code = "ENOTFOUND";
      throw err;
    },
    resolve4: async () => {
      const err = new Error("ENOTFOUND");
      err.code = "ENOTFOUND";
      throw err;
    },
    resolve6: async () => {
      const err = new Error("ENOTFOUND");
      err.code = "ENOTFOUND";
      throw err;
    },
  };
}

function nullMxResolver(exchange = ".") {
  return {
    resolveMx: async () => [{ exchange, priority: 0 }],
    resolve4: async () => [],
    resolve6: async () => [],
  };
}

function timeoutResolver() {
  return {
    resolveMx: async () => {
      const err = new Error("queryMx ETIMEOUT");
      err.code = "ETIMEOUT";
      throw err;
    },
    resolve4: async () => {
      const err = new Error("ETIMEOUT");
      err.code = "ETIMEOUT";
      throw err;
    },
    resolve6: async () => {
      const err = new Error("ETIMEOUT");
      err.code = "ETIMEOUT";
      throw err;
    },
  };
}

/** In-memory mock SMTP socket for testing without OS network sockets. */
function createMockSmtpSocket(handlerFn) {
  const socket = new EventEmitter();
  socket.write = (data, cb) => {
    process.nextTick(() => {
      socket.emit("clientData", data);
      if (typeof cb === "function") cb();
    });
    return true;
  };
  socket.setTimeout = () => {};
  socket.destroy = () => {};
  socket.end = () => {};

  const peer = {
    write: (msg) => {
      process.nextTick(() => {
        socket.emit("data", Buffer.from(msg));
      });
    },
    end: (msg) => {
      if (msg) peer.write(msg);
      process.nextTick(() => {
        socket.emit("end");
      });
    },
    on: (evt, cb) => {
      if (evt === "data") {
        socket.on("clientData", (d) => cb(Buffer.from(d)));
      } else {
        socket.on(evt, cb);
      }
    },
  };

  process.nextTick(() => {
    handlerFn(peer);
  });

  return socket;
}

/** Helper to create mock HTTP response object for testing handler. */
function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    setHeader(key, value) {
      res.headers[key.toLowerCase()] = value;
      return res;
    },
    json(data) {
      res.body = data;
      return res;
    },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("MailCheck — Verification & Security Test Suite", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  // 1. Syntax Validation & RFC Limits
  describe("1 — Syntax validation & RFC 5321 length limits", () => {
    it("rejects non-email strings", () => {
      assert.equal(checkSyntax("plainaddress").valid, false);
      assert.equal(checkSyntax("@missinglocal.com").valid, false);
      assert.equal(checkSyntax("user@").valid, false);
      assert.equal(checkSyntax("").valid, false);
      assert.equal(checkSyntax("user name@example.com").valid, false);
    });

    it("rejects addresses longer than 254 characters", () => {
      const longLocal = "a".repeat(60);
      const longDomain = "b".repeat(50) + "." + "c".repeat(50) + "." + "d".repeat(50) + "." + "e".repeat(50) + ".com";
      const email = `${longLocal}@${longDomain}`;
      assert.ok(email.length > 254);
      assert.equal(checkSyntax(email).valid, false);
    });

    it("rejects local-part longer than 64 characters", () => {
      const email = `${"a".repeat(65)}@example.com`;
      assert.equal(checkSyntax(email).valid, false);
    });

    it("accepts valid syntax and returns likely_bounce on malformed strings in classifyEmail", async () => {
      const result = await classifyEmail("not-an-email");
      assert.equal(result.status, "likely_bounce");
      assert.equal(result.reason, "Invalid email format");
      assert.equal(result.checks.syntax, "fail");
    });
  });

  // 2. Internationalized Email (EAI / IDN)
  describe("2 — Internationalized email (EAI / IDN)", () => {
    it("passes syntax check for internationalized domain (IDN) via punycode", () => {
      const result = checkSyntax("user@münchen.de");
      assert.equal(result.valid, true);
      assert.equal(result.domain, "xn--mnchen-3ya.de");
    });

    it("passes syntax check for UTF-8 local part and flags hasNonAsciiLocal", () => {
      const result = checkSyntax("üser@example.com");
      assert.equal(result.valid, true);
      assert.equal(result.hasNonAsciiLocal, true);
    });

    it("classifies UTF-8 local part as unknown if no UTF-8 verifier is configured", async () => {
      const result = await classifyEmail("üser@example.com", {
        dnsResolver: mxFoundResolver(),
      });
      assert.equal(result.status, "unknown");
      assert.equal(result.checks.recipient, "not_checked");
    });
  });

  // 3. DNS / MX Checks & RFC 7505
  describe("3 — Domain mail routing & RFC 7505 Null MX", () => {
    it("returns likely_deliverable or unknown when MX is found and SMTP is disabled", async () => {
      const result = await classifyEmail("valid@example.com", {
        dnsResolver: mxFoundResolver(),
        enableSmtp: false,
      });
      assert.equal(result.status, "unknown");
      assert.equal(result.checks.mx, "found");
      assert.equal(result.checks.recipient, "not_checked");
      assert.equal(result.reason, "Domain accepts mail, but the mailbox was not confirmed");
    });

    it("returns likely_bounce when domain has NXDOMAIN (ENOTFOUND)", async () => {
      const result = await classifyEmail("user@nonexistent-domain.xyz", {
        dnsResolver: nxdomainResolver(),
      });
      assert.equal(result.status, "likely_bounce");
      assert.equal(result.checks.mx, "domain_not_found");
      assert.equal(result.reason, "Domain cannot be resolved");
    });

    it("detects RFC 7505 Null MX record (exchange = '.') as mx: none", async () => {
      const result = await classifyEmail("user@nullmx.com", {
        dnsResolver: nullMxResolver("."),
      });
      assert.equal(result.status, "likely_bounce");
      assert.equal(result.checks.mx, "none");
      assert.equal(result.reason, "Domain has no usable mail route");
    });

    it("detects RFC 7505 Null MX record (exchange = '') as mx: none", async () => {
      const result = await classifyEmail("user@nullmx.org", {
        dnsResolver: nullMxResolver(""),
      });
      assert.equal(result.status, "likely_bounce");
      assert.equal(result.checks.mx, "none");
    });

    it("returns unknown (mx: error) on transient DNS timeout, NEVER likely_bounce", async () => {
      const result = await classifyEmail("user@timeout.com", {
        dnsResolver: timeoutResolver(),
      });
      assert.equal(result.status, "unknown");
      assert.equal(result.checks.mx, "error");
      assert.equal(result.reason, "The check timed out, so the result is inconclusive");
    });
  });

  // 4. RFC 5321 Parallel A / AAAA Fallback
  describe("4 — RFC 5321 A / AAAA Fallback on ENODATA", () => {
    it("falls back to A record when resolveMx returns ENODATA", async () => {
      const resolver = {
        resolveMx: async () => {
          const err = new Error("ENODATA");
          err.code = "ENODATA";
          throw err;
        },
        resolve4: async () => ["93.184.216.34"],
        resolve6: async () => [],
      };

      const result = await checkMx("implicit-mx.com", resolver);
      assert.equal(result.mx, "found");
      assert.equal(result.exchange, "implicit-mx.com");
    });

    it("falls back to AAAA record when resolveMx returns ENODATA", async () => {
      const resolver = {
        resolveMx: async () => {
          const err = new Error("ENODATA");
          err.code = "ENODATA";
          throw err;
        },
        resolve4: async () => [],
        resolve6: async () => ["2606:2800:220:1:248:1893:25c8:1946"],
      };

      const result = await checkMx("ipv6-only.com", resolver);
      assert.equal(result.mx, "found");
      assert.equal(result.exchange, "ipv6-only.com");
    });

    it("returns mx: none when resolveMx is ENODATA and both A and AAAA return empty/ENODATA", async () => {
      const resolver = {
        resolveMx: async () => {
          const err = new Error("ENODATA");
          err.code = "ENODATA";
          throw err;
        },
        resolve4: async () => [],
        resolve6: async () => [],
      };

      const result = await checkMx("no-mail.com", resolver);
      assert.equal(result.mx, "none");
      assert.equal(result.reason, "Domain has no usable mail route");
    });

    it("returns mx: error (unknown) when resolveMx is ENODATA and A/AAAA times out or ESERVFAIL", async () => {
      const resolver = {
        resolveMx: async () => {
          const err = new Error("ENODATA");
          err.code = "ENODATA";
          throw err;
        },
        resolve4: async () => {
          const err = new Error("ETIMEOUT");
          err.code = "ETIMEOUT";
          throw err;
        },
        resolve6: async () => [],
      };

      const result = await checkMx("failing-dns.com", resolver);
      assert.equal(result.mx, "error");
      assert.equal(result.reason, "The check timed out, so the result is inconclusive");
    });
  });

  // 5. SSRF Protection Helper & Private IP Blocking
  describe("5 — SSRF Protection & Private IP Blocking", () => {
    it("blocks IPv4 loopback, private, link-local, and reserved ranges", () => {
      assert.equal(isPrivateOrReservedIP("127.0.0.1"), true);
      assert.equal(isPrivateOrReservedIP("10.0.0.1"), true);
      assert.equal(isPrivateOrReservedIP("172.16.5.4"), true);
      assert.equal(isPrivateOrReservedIP("192.168.1.1"), true);
      assert.equal(isPrivateOrReservedIP("169.254.169.254"), true);
      assert.equal(isPrivateOrReservedIP("0.0.0.0"), true);
      assert.equal(isPrivateOrReservedIP("100.64.0.1"), true);
      assert.equal(isPrivateOrReservedIP("224.0.0.1"), true);
      assert.equal(isPrivateOrReservedIP("localhost"), true);
    });

    it("blocks IPv6 loopback, ULA, and link-local ranges", () => {
      assert.equal(isPrivateOrReservedIP("::1"), true);
      assert.equal(isPrivateOrReservedIP("::"), true);
      assert.equal(isPrivateOrReservedIP("fe80::1"), true);
      assert.equal(isPrivateOrReservedIP("fc00::1"), true);
      assert.equal(isPrivateOrReservedIP("::ffff:127.0.0.1"), true);
      assert.equal(isPrivateOrReservedIP("::ffff:192.168.0.1"), true);
    });

    it("permits legitimate public IP addresses", () => {
      assert.equal(isPrivateOrReservedIP("93.184.216.34"), false);
      assert.equal(isPrivateOrReservedIP("8.8.8.8"), false);
      assert.equal(isPrivateOrReservedIP("1.1.1.1"), false);
      assert.equal(isPrivateOrReservedIP("2606:2800:220:1:248:1893:25c8:1946"), false);
    });
  });

  // 6. Direct SMTP Probing & Narrow 5xx Classification
  describe("6 — SMTP Probing & Narrow 5xx Classification", () => {
    it("returns accepted and likely_deliverable on non-catchall 250 response", async () => {
      const socketFactory = () =>
        createMockSmtpSocket((peer) => {
          peer.write("220 mx.example.com ESMTP\r\n");
          peer.on("data", (chunk) => {
            const str = chunk.toString();
            if (str.startsWith("EHLO")) peer.write("250-mx.example.com\r\n250 HELP\r\n");
            else if (str.startsWith("MAIL FROM")) peer.write("250 2.1.0 Ok\r\n");
            else if (str.startsWith("RCPT TO:<nonexistent-probe")) peer.write("550 5.1.1 User unknown\r\n");
            else if (str.startsWith("RCPT TO:<valid@example.com>")) peer.write("250 2.1.5 Recipient Ok\r\n");
            else if (str.startsWith("QUIT")) peer.end("221 Bye\r\n");
          });
        });

      const result = await probeSmtpRecipient("valid@example.com", "mx.example.com", {
        socketFactory,
        timeout: 2000,
      });

      assert.equal(result.recipient, "accepted");
      assert.equal(result.status, "likely_deliverable");
      assert.equal(result.reason, "Recipient verification received a positive response");
    });

    it("returns rejected and likely_bounce on explicit 550 5.1.1 user unknown response", async () => {
      const socketFactory = () =>
        createMockSmtpSocket((peer) => {
          peer.write("220 mx.example.com ESMTP\r\n");
          peer.on("data", (chunk) => {
            const str = chunk.toString();
            if (str.startsWith("EHLO")) peer.write("250-mx.example.com\r\n250 HELP\r\n");
            else if (str.startsWith("MAIL FROM")) peer.write("250 2.1.0 Ok\r\n");
            else if (str.startsWith("RCPT TO:<nonexistent-probe")) peer.write("550 5.1.1 User unknown\r\n");
            else if (str.startsWith("RCPT TO:<nobody@example.com>")) peer.write("550 5.1.1 User does not exist\r\n");
            else if (str.startsWith("QUIT")) peer.end("221 Bye\r\n");
          });
        });

      const result = await probeSmtpRecipient("nobody@example.com", "mx.example.com", {
        socketFactory,
        timeout: 2000,
      });

      assert.equal(result.recipient, "rejected");
      assert.equal(result.status, "likely_bounce");
      assert.equal(result.reason, "Recipient mailbox was rejected by the mail server");
    });

    it("returns inconclusive and unknown on policy / spam block (554 5.7.1), NEVER likely_bounce", async () => {
      const socketFactory = () =>
        createMockSmtpSocket((peer) => {
          peer.write("220 mx.example.com ESMTP\r\n");
          peer.on("data", (chunk) => {
            const str = chunk.toString();
            if (str.startsWith("EHLO")) peer.write("250-mx.example.com\r\n250 HELP\r\n");
            else if (str.startsWith("MAIL FROM")) peer.write("250 2.1.0 Ok\r\n");
            else if (str.startsWith("RCPT TO:<nonexistent-probe")) peer.write("550 5.1.1 User unknown\r\n");
            else if (str.startsWith("RCPT TO:<user@example.com>")) peer.write("554 5.7.1 Service unavailable; Client host blocked\r\n");
            else if (str.startsWith("QUIT")) peer.end("221 Bye\r\n");
          });
        });

      const result = await probeSmtpRecipient("user@example.com", "mx.example.com", {
        socketFactory,
        timeout: 2000,
      });

      assert.equal(result.recipient, "inconclusive");
      assert.equal(result.status, "unknown");
      assert.equal(result.reason, "Domain accepts mail, but the mailbox was not confirmed");
    });

    it("detects catch-all domain when server accepts random address and returns inconclusive", async () => {
      const socketFactory = () =>
        createMockSmtpSocket((peer) => {
          peer.write("220 mx.example.com ESMTP\r\n");
          peer.on("data", (chunk) => {
            const str = chunk.toString();
            if (str.startsWith("EHLO")) peer.write("250-mx.example.com\r\n250 HELP\r\n");
            else if (str.startsWith("MAIL FROM")) peer.write("250 2.1.0 Ok\r\n");
            else if (str.startsWith("RCPT TO")) peer.write("250 2.1.5 Recipient Ok\r\n");
            else if (str.startsWith("QUIT")) peer.end("221 Bye\r\n");
          });
        });

      const result = await probeSmtpRecipient("alice@catchall.com", "mx.example.com", {
        socketFactory,
        timeout: 2000,
      });

      assert.equal(result.recipient, "inconclusive");
      assert.equal(result.status, "unknown");
      assert.match(result.reason, /catch-all/i);
    });
  });

  // 7. External HTTPS Verification API
  describe("7 — External HTTPS Verification API", () => {
    it("returns deliverable when external API returns deliverable state", async () => {
      const mockFetch = async () => {
        return {
          ok: true,
          json: async () => ({ state: "deliverable" }),
        };
      };

      const result = await checkRecipientViaHttps("test@example.com", {
        apiKey: "test-key",
        fetchFn: mockFetch,
      });

      assert.equal(result.recipient, "accepted");
      assert.equal(result.status, "likely_deliverable");
    });

    it("returns rejected when external API returns undeliverable state", async () => {
      const mockFetch = async () => {
        return {
          ok: true,
          json: async () => ({ state: "undeliverable" }),
        };
      };

      const result = await checkRecipientViaHttps("bounced@example.com", {
        apiKey: "test-key",
        fetchFn: mockFetch,
      });

      assert.equal(result.recipient, "rejected");
      assert.equal(result.status, "likely_bounce");
    });

    it("falls back to inconclusive / unknown if external API errors or times out", async () => {
      const mockFetch = async () => {
        return {
          ok: false,
          status: 500,
        };
      };

      const result = await checkRecipientViaHttps("error@example.com", {
        apiKey: "test-key",
        fetchFn: mockFetch,
      });

      assert.equal(result.recipient, "inconclusive");
      assert.equal(result.status, "unknown");
    });
  });

  // 8. Dependency Injection Verification in classifyEmail
  describe("8 — Dependency Injection in classifyEmail", () => {
    it("uses injected recipientVerifier for positive confirmation", async () => {
      const result = await classifyEmail("injected@example.com", {
        dnsResolver: mxFoundResolver(),
        recipientVerifier: async () => ({ recipient: "accepted" }),
      });

      assert.equal(result.status, "likely_deliverable");
      assert.equal(result.checks.recipient, "accepted");
    });

    it("uses injected recipientVerifier for negative rejection", async () => {
      const result = await classifyEmail("injected-bad@example.com", {
        dnsResolver: mxFoundResolver(),
        recipientVerifier: async () => ({ recipient: "rejected" }),
      });

      assert.equal(result.status, "likely_bounce");
      assert.equal(result.checks.recipient, "rejected");
    });
  });

  // 9. Batch Size Limits & Deduplication
  describe("9 — Batch size limit & case-insensitive deduplication", () => {
    it("rejects batches with more than 100 emails", async () => {
      const emails = Array.from({ length: 101 }, (_, i) => `user${i}@example.com`);
      const result = await verifyBatch(emails);
      assert.ok(result.error);
      assert.match(result.error, /maximum/i);
    });

    it("accepts batches with exactly 100 emails", async () => {
      const emails = Array.from({ length: 100 }, (_, i) => `user${i}@example.com`);
      const result = await verifyBatch(emails, {
        dnsResolver: mxFoundResolver(),
        enableSmtp: false,
      });
      assert.ok(!result.error);
      assert.equal(result.results.length, 100);
      assert.equal(result.summary.total, 100);
    });

    it("deduplicates case-insensitively (Bob@Example.org and bob@example.org)", async () => {
      const emails = ["Bob@Example.org", "bob@example.org", "BOB@EXAMPLE.ORG", "alice@example.org"];
      const result = await verifyBatch(emails, {
        dnsResolver: mxFoundResolver(),
        enableSmtp: false,
      });
      assert.ok(!result.error);
      assert.equal(result.results.length, 2);
      assert.equal(result.summary.total, 2);
    });
  });

  // 10. Rate Limiter
  describe("10 — In-memory IP rate limiter", () => {
    it("allows requests under the rate limit threshold", () => {
      const ip = "198.51.100.1";
      for (let i = 0; i < 5; i++) {
        const res = checkRateLimit(ip, 10, 60000);
        assert.equal(res.allowed, true);
      }
    });

    it("blocks requests that exceed the rate limit threshold", () => {
      const ip = "198.51.100.2";
      for (let i = 0; i < 5; i++) {
        checkRateLimit(ip, 5, 60000);
      }
      const blocked = checkRateLimit(ip, 5, 60000);
      assert.equal(blocked.allowed, false);
      assert.ok(blocked.retryAfter > 0);
    });
  });

  // 11. Security: XSS Payloads & Input Validation
  describe("11 — Security & Input Validation", () => {
    it("rejects XSS payload in email as invalid syntax (likely_bounce)", async () => {
      const xss = "<script>alert(1)</script>@example.com";
      const result = await classifyEmail(xss);
      assert.equal(result.status, "likely_bounce");
      assert.equal(result.checks.syntax, "fail");
    });

    it("handler rejects non-string items with HTTP 400", async () => {
      const req = {
        method: "POST",
        body: { emails: ["alice@example.com", 123, null] },
        headers: {},
      };
      const res = createMockRes();

      await handler(req, res);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /string/i);
    });

    it("handler rejects non-POST requests with HTTP 405", async () => {
      const req = { method: "GET", body: {} };
      const res = createMockRes();

      await handler(req, res);
      assert.equal(res.statusCode, 405);
    });

    it("handler returns HTTP 429 when IP rate limit is exceeded", async () => {
      const ip = "203.0.113.50";
      // Exceed rate limit for this IP
      for (let i = 0; i < 20; i++) {
        checkRateLimit(ip, 20, 60000);
      }

      const req = {
        method: "POST",
        body: { emails: ["user@example.com"] },
        headers: { "x-forwarded-for": ip },
      };
      const res = createMockRes();

      await handler(req, res);
      assert.equal(res.statusCode, 429);
      assert.match(res.body.error, /too many/i);
      assert.ok(res.headers["retry-after"]);
    });
  });
});
