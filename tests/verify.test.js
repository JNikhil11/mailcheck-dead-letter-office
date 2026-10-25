import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkSyntax,
  checkMx,
  classifyEmail,
  verifyBatch,
  setRecipientVerifier,
  clearRecipientVerifier,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MailCheck — verify API", () => {
  afterEach(() => {
    clearRecipientVerifier();
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

  // 2. Valid syntax + MX found + recipient unconfirmed
  describe("2 — Valid syntax, MX found, recipient unconfirmed", () => {
    it("returns unknown with mx found and recipient not_checked", async () => {
      const result = await classifyEmail("alice@example.com", {
        dnsResolver: mxFoundResolver(),
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
      // Use a mock resolver so we don't hit real DNS
      const result = await verifyBatch(emails, {
        dnsResolver: mxFoundResolver(),
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
      });
      assert.ok(!result.error);
      // Should have 2 unique results
      assert.equal(result.results.length, 2);
      // Summary total should equal the number of unique emails
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
      // The email string should be preserved as-is (not sanitised or executed)
      assert.equal(classified.email, xss);
    });
  });
});
