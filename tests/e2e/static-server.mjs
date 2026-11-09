/**
 * E2E 用：dist を localhost から配信する（パスキーは file:// では使えないため：ADR-0012）。
 * `/` は kotono-cms.html を返す（GitHub Pages への配置と同じ）。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const DIST = resolve(import.meta.dirname, "../../dist");
const PORT = Number(process.env["E2E_PORT"] ?? 4319);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const name = path === "/" || path === "/index.html" ? "kotono-cms.html" : path.slice(1);
  const file = resolve(DIST, name);
  if (!file.startsWith(DIST + "/")) {
    res.writeHead(404).end();
    return;
  }
  readFile(file)
    .then((b) => {
      res.writeHead(200, {
        "content-type": TYPES[extname(name)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(b);
    })
    .catch(() => res.writeHead(404).end());
}).listen(PORT, "127.0.0.1");
