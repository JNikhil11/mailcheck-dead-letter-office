import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = process.env.PORT || 3000;

// MIME type map
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/**
 * Read the full request body as a string.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Create a Vercel-compatible mock res wrapper around the raw Node response.
 */
function createMockRes(raw) {
  let statusCode = 200;
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      raw.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
      raw.end(JSON.stringify(data));
    },
  };
  return res;
}

const server = createServer(async (req, rawRes) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ---------- API route ----------
  if (pathname === "/api/verify" && req.method === "POST") {
    try {
      const bodyStr = await readBody(req);
      let body;
      try {
        body = JSON.parse(bodyStr);
      } catch {
        rawRes.writeHead(400, { "Content-Type": "application/json" });
        rawRes.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      // Lazy-import the handler so changes are picked up without restart
      const { default: handler } = await import("./api/verify.js");
      const mockReq = { method: "POST", body };
      const mockRes = createMockRes(rawRes);
      await handler(mockReq, mockRes);
    } catch (err) {
      console.error("[server] Error handling /api/verify:", err);
      rawRes.writeHead(500, { "Content-Type": "application/json" });
      rawRes.end(JSON.stringify({ error: "Internal server error" }));
    }
    return;
  }

  // Return 405 for non-POST on the API route
  if (pathname === "/api/verify") {
    const { default: handler } = await import("./api/verify.js");
    const mockReq = { method: req.method, body: {} };
    const mockRes = createMockRes(rawRes);
    await handler(mockReq, mockRes);
    return;
  }

  // ---------- Static file serving ----------
  let filePath = pathname === "/" ? "/index.html" : pathname;

  // Security: prevent directory traversal
  const resolved = normalize(join(__dirname, filePath));
  if (!resolved.startsWith(__dirname)) {
    rawRes.writeHead(403);
    rawRes.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(resolved);
    const ext = extname(resolved).toLowerCase();
    const contentType = MIME[ext] || "application/octet-stream";
    rawRes.writeHead(200, { "Content-Type": contentType });
    rawRes.end(data);
  } catch {
    rawRes.writeHead(404, { "Content-Type": "text/plain" });
    rawRes.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`\n  MailCheck dev server running at http://localhost:${PORT}\n`);
});
