import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  checkSyntax,
  checkMx,
  classifyEmail,
  verifyBatch,
  probeSmtpRecipient,
  checkRecipientViaHttps,
  setRecipientVerifier,
  clearRecipientVerifier,
  setSmtpProber,
  clearSmtpProber,
} from "../api/verify.js";

// ---------------------------------------------------------------------------
// Helpers — mock DNS resolvers
// ---------------------------------------------------------------------------

/** Returns a resolver that provides valid MX records. */
function mxFoundResolver() {
  return {
    resolveMx: async () => [{ exchange: "mx.example.com", priority: 10 }],
    resolve4: async () => ["93.184.216.34"],
    resolve6: async () => ["2606:2800:220:1:248:1893:25c8:1946"],
  };
}

/** Returns a resolver that throws ENOTFOUND (NXDOMAIN). */
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

/** Returns a resolver that returns null MX (RFC 7505). */
function nullMxResolver() {
  return {
    resolveMx: async () => [{ exchange: ".", priority: 0 }],
    resolve4: async () => [],
    resolve6: async () => [],
  };
}

/** Returns a resolver that throws ETIMEOUT. */
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

/** Helper to create in-memory mock SMTP server for testing. */
function createMockSmtpServer(handler) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      handler(socket);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MailCheck — verify API", () => {
  afterEach(() => {
    clearRecipientVerifier();
    clearSmtpProber();
  });

  // 1. Malformed syntax
  describe("1 — Malformed syntax", () => {
    it("checkSyntax rejects non-email strings", () => {
      const result = checkSyntax("not-an-email");
      assert.equal(result.valid, false);
    });

    it("classifyEmail returns likely_bounce with syntax fail", async () => {
      const result = await classifyEmail("not-an-email");
      assert.equal(result.status, "likely_bounce");
      assert.equal(result.checks.syntax, "fail");
      assert.equal(result.checks.mx, "not_checked");
      assert.equal(result.checks.recipient, "not_checked");
    });
  });

  // 2. Valid syntax + MX found + recipient unconfirmed (port 25 blocked / fallback)
  describe("2 — Valid syntax, MX found, recipient unconfirmed", () => {
    it("returns unknown with mx found and recipient not_checked", async () => {
      const result = await classifyEmail("alice@example.com", {
        dnsResolver: mxFoundResolver(),
        enableSmtp: false, // Port 25 simulated as blocked/disabled
      });
      assert.equal(result.status, "unknown");
      assert.equal(result.checks.syntax, "pass");
      assert.equal(result.checks.mx, "found");
      assert.equal(result.checks.recipient, "not_checked");
      assert.equal(
        result.reason,
        "Domain accepts mail, but the mailbox was not confirmed",
      );
    });
  });

  // 3. Confirmed nonexistent domain (NXDOMAIN)
  describe("3 — Nonexistent domain (NXDOMAIN)", () => {
    it("returns likely_bounce with mx domain_not_found", async () => {
      const result = await classifyEmail("user@this-domain-does-not-exist.invalid", {
        dnsResolver: nxdomainResolver(),
      });
      assert.equal(result.status, "likely_bounce");
      assert.equal(result.checks.mx, "domain_not_found");
      assert.equal(result.reason, "Domain cannot be resolved");
    });
  });

  // 4. Domain with no mail route (null MX — RFC 7505)
  describe("4 — Null MX (no mail route)", () => {
    it("returns likely_bounce with mx none", async () => {
      const result = await classifyEmail("user@null-mx.example.com", {
        dnsResolver: nullMxResolver(),
      });
      assert.equal(result.status, "likely_bounce");
      assert.equal(result.checks.mx, "none");
      assert.equal(result.reason, "Domain has no usable mail route");
    });
  });

  // 5. Transient DNS timeout / error
  describe("5 — Transient DNS timeout", () => {
    it("returns unknown (NOT likely_bounce) with mx error", async () => {
      const result = await classifyEmail("user@slow-dns.example.com", {
        dnsResolver: timeoutResolver(),
      });
      assert.equal(result.status, "unknown");
      assert.equal(result.checks.mx, "error");
      assert.notEqual(result.status, "likely_bounce");
    });
  });

  // 6. Recipient verifier positive
  describe("6 — Recipient verifier positive", () => {
    it("returns likely_deliverable when verifier says accepted", async () => {
      const result = await classifyEmail("alice@example.com", {
        dnsResolver: mxFoundResolver(),
        recipientVerifier: async () => "accepted",
      });
      assert.equal(result.status, "likely_deliverable");
      assert.equal(result.checks.recipient, "accepted");
      assert.equal(
        result.reason,
        "Recipient verification received a positive response",
      );
    });
  });

  // 7. Recipient verifier negative
  describe("7 — Recipient verifier negative", () => {
    it("returns likely_bounce when verifier says rejected", async () => {
      const result = await classifyEmail("nobody@example.com", {
        dnsResolver: mxFoundResolver(),
        recipientVerifier: async () => "rejected",
      });
      assert.equal(result.status, "likely_bounce");
      assert.equal(result.checks.recipient, "rejected");
      assert.equal(result.reason, "Recipient mailbox does not exist");
    });
  });

  // 8. Batch size limit
  describe("8 — Batch size limit", () => {
    it("rejects batches with more than 100 emails", async () => {
      const emails = Array.from({ length: 101 }, (_, i) => `user${i}@test.com`);
      const result = await verifyBatch(emails);
      assert.ok(result.error);
      assert.match(result.error, /maximum/i);
    });

    it("accepts batches with exactly 100 emails", async () => {
      const emails = Array.from({ length: 100 }, (_, i) => `user${i}@test.com`);
      const result = await verifyBatch(emails, {
        dnsResolver: mxFoundResolver(),
        enableSmtp: false,
      });
      assert.ok(!result.error, "should not return an error");
      assert.ok(result.results);
      assert.equal(result.results.length, 100);
    });
  });

  // 9. Duplicate collapsing & count math
  describe("9 — Duplicate collapsing", () => {
    it("deduplicates emails and returns one result per unique email", async () => {
      const emails = ["a@b.com", "a@b.com", "c@d.com"];
      const result = await verifyBatch(emails, {
        dnsResolver: mxFoundResolver(),
        enableSmtp: false,
      });
      assert.ok(!result.error);
      assert.equal(result.results.length, 2);
      assert.equal(result.summary.total, 2);
    });
  });

  // 10. XSS payload
  describe("10 — XSS payload in email", () => {
    it("rejects XSS payloads via syntax check (likely_bounce)", async () => {
      const xss = "<script>alert(1)</script>@example.com";
      const syntaxResult = checkSyntax(xss);
      assert.equal(syntaxResult.valid, false);

      const classified = await classifyEmail(xss);
      assert.equal(classified.status, "likely_bounce");
      assert.equal(classified.email, xss);
    });
  });

  // 11. Direct SMTP Probing — Port 25 Blocked / Fallback
  describe("11 — SMTP Probing: Port 25 Blocked / Fallback", () => {
    it("falls back to not_checked when port is unreachable or connection refused", async () => {
      // Connect to non-listening port on localhost
      const result = await probeSmtpRecipient("test@example.com", "127.0.0.1", {
        port: 1, // port 1 connection refused
        timeout: 500,
      });
      assert.equal(result.recipient, "not_checked");
      assert.equal(result.status, "unknown");
      assert.equal(
        result.reason,
        "Domain accepts mail, but the mailbox was not confirmed",
      );
    });
  });

  // 12. Direct SMTP Probing — Catch-all Domain Detection
  describe("12 — SMTP Probing: Catch-all Domain Detection", () => {
    it("returns inconclusive when server accepts random nonexistent probe", async () => {
      const mock = await createMockSmtpServer((socket) => {
        socket.write("220 mock.mailcheck.local ESMTP\r\n");
        socket.on("data", (chunk) => {
          const str = chunk.toString();
          if (str.startsWith("EHLO")) socket.write("250-mock.mailcheck.local\r\n250 HELP\r\n");
          else if (str.startsWith("MAIL FROM")) socket.write("250 2.1.0 Ok\r\n");
          else if (str.startsWith("RCPT TO")) socket.write("250 2.1.5 Recipient Ok\r\n"); // Accepts catch-all!
          else if (str.startsWith("QUIT")) socket.end("221 Bye\r\n");
        });
      });

      const result = await probeSmtpRecipient("alice@catchall-domain.com", "127.0.0.1", {
        port: mock.port,
        timeout: 2000,
      });
      mock.server.close();

      assert.equal(result.recipient, "inconclusive");
      assert.equal(result.status, "unknown");
      assert.equal(
        result.reason,
        "Domain accepts all mail (catch-all), so individual mailbox could not be confirmed",
      );
    });
  });

  // 13. Direct SMTP Probing — Real Address Accepted (Not Catch-all)
  describe("13 — SMTP Probing: Real Address Accepted", () => {
    it("returns accepted and likely_deliverable when catch-all is rejected and target is accepted", async () => {
      const mock = await createMockSmtpServer((socket) => {
        socket.write("220 mock.mailcheck.local ESMTP\r\n");
        socket.on("data", (chunk) => {
          const str = chunk.toString();
          if (str.startsWith("EHLO")) socket.write("250-mock.mailcheck.local\r\n250 HELP\r\n");
          else if (str.startsWith("MAIL FROM")) socket.write("250 2.1.0 Ok\r\n");
          else if (str.startsWith("RCPT TO:<nonexistent-probe")) socket.write("550 5.1.1 User unknown\r\n");
          else if (str.startsWith("RCPT TO:<valid@domain.com>")) socket.write("250 2.1.5 Recipient Ok\r\n");
          else if (str.startsWith("QUIT")) socket.end("221 Bye\r\n");
        });
      });

      const result = await probeSmtpRecipient("valid@domain.com", "127.0.0.1", {
        port: mock.port,
        timeout: 2000,
      });
      mock.server.close();

      assert.equal(result.recipient, "accepted");
      assert.equal(result.status, "likely_deliverable");
      assert.equal(
        result.reason,
        "Recipient verification received a positive response",
      );
    });
  });

  // 14. Direct SMTP Probing — Real Address Rejected (550)
  describe("14 — SMTP Probing: Real Address Rejected (550)", () => {
    it("returns rejected and likely_bounce when target address is rejected with 550", async () => {
      const mock = await createMockSmtpServer((socket) => {
        socket.write("220 mock.mailcheck.local ESMTP\r\n");
        socket.on("data", (chunk) => {
          const str = chunk.toString();
          if (str.startsWith("EHLO")) socket.write("250-mock.mailcheck.local\r\n250 HELP\r\n");
          else if (str.startsWith("MAIL FROM")) socket.write("250 2.1.0 Ok\r\n");
          else if (str.startsWith("RCPT TO:<nonexistent-probe")) socket.write("550 5.1.1 User unknown\r\n");
          else if (str.startsWith("RCPT TO:<nobody@domain.com>")) socket.write("550 5.1.1 User does not exist\r\n");
          else if (str.startsWith("QUIT")) socket.end("221 Bye\r\n");
        });
      });

      const result = await probeSmtpRecipient("nobody@domain.com", "127.0.0.1", {
        port: mock.port,
        timeout: 2000,
      });
      mock.server.close();

      assert.equal(result.recipient, "rejected");
      assert.equal(result.status, "likely_bounce");
      assert.equal(
        result.reason,
        "Recipient mailbox was rejected by the mail server",
      );
    });
  });

  // 15. Direct SMTP Probing — Greylisting (4xx response)
  describe("15 — SMTP Probing: Greylisting (4xx response)", () => {
    it("returns inconclusive when server responds with 450 greylisting", async () => {
      const mock = await createMockSmtpServer((socket) => {
        socket.write("220 mock.mailcheck.local ESMTP\r\n");
        socket.on("data", (chunk) => {
          const str = chunk.toString();
          if (str.startsWith("EHLO")) socket.write("250-mock.mailcheck.local\r\n250 HELP\r\n");
          else if (str.startsWith("MAIL FROM")) socket.write("250 2.1.0 Ok\r\n");
          else if (str.startsWith("RCPT TO")) socket.write("450 4.2.0 Mailbox temporarily unavailable\r\n");
          else if (str.startsWith("QUIT")) socket.end("221 Bye\r\n");
        });
      });

      const result = await probeSmtpRecipient("user@greylisted.com", "127.0.0.1", {
        port: mock.port,
        timeout: 2000,
      });
      mock.server.close();

      assert.equal(result.recipient, "inconclusive");
      assert.equal(result.status, "unknown");
    });
  });

  // 16. Module-level setSmtpProber injection
  describe("16 — Module-level setSmtpProber injection", () => {
    it("uses injected SMTP prober in classifyEmail", async () => {
      setSmtpProber(async (email, host) => {
        return {
          recipient: "accepted",
          status: "likely_deliverable",
          reason: "Recipient verification received a positive response",
        };
      });

      const result = await classifyEmail("probed@example.com", {
        dnsResolver: mxFoundResolver(),
      });
      assert.equal(result.status, "likely_deliverable");
      assert.equal(result.checks.recipient, "accepted");
    });
  });
});
