import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { handleApiRequest, json } from "./routes.js";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = join(process.cwd(), "dist");

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  let filePath = normalize(join(PUBLIC_DIR, requested));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  if (!existsSync(filePath) && requested.startsWith("/assets/")) {
    const extension  = extname(requested);
    const stableAsset = extension === ".js" ? "index.js" : extension === ".css" ? "style.css" : null;
    const fallbackPath = stableAsset ? normalize(join(PUBLIC_DIR, "assets", stableAsset)) : null;
    if (fallbackPath?.startsWith(PUBLIC_DIR) && existsSync(fallbackPath)) filePath = fallbackPath;
  }

  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    // SPA fallback
    const indexPath = join(PUBLIC_DIR, "index.html");
    if (existsSync(indexPath)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(await readFile(indexPath));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.writeHead(200, { "content-type": mime[extname(filePath)] || "application/octet-stream" });
  if (req.method === "HEAD") { res.end(); return; }
  res.end(await readFile(filePath));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin":  "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    const handled = await handleApiRequest(req, res, url);
    if (!handled) {
      await serveStatic(req, res);
    }
  } catch (error: any) {
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`[Agent Chess Arena] API and Web UI running on http://localhost:${PORT}`);
});
