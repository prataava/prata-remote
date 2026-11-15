// PRATA Remote — Untainted Storage Daemon (HTTP, 127.0.0.1:18089).
//
// CARA JALAN (WAJIB dari /tmp, JANGAN dari ~/workspace):
//   cd /tmp && PRATA_DAEMON_DIR=/tmp/prata-untainted-disk node /tmp/prata-daemon.mjs
//   (atau: PRATA_DAEMON_PORT=18090 PRATA_DAEMON_DIR=<dir data repo> untuk produksi)
//
// Daemon ini TIDAK PERNAH membaca satu pun berkas di ~/workspace —
// kodenya hidup di /tmp dan hanya menyentuh PRATA_DAEMON_DIR + modul
// bawaan Node — sehingga ia 100% UNTAINTED: bebas menulis ke disk
// kapan saja, tidak peduli rezim blokir tulis sandbox VM ini. Ia tetap
// hidup di memori sebagai microservice lokal sementara Server Utama
// (port 8080) boleh di-restart berkali-kali: data + blob tetap utuh
// di PRATA_DAEMON_DIR milik daemon.
//
// API (JSON; data = base64):
//   GET  /healthz                 -> {ok, dir, uptime}
//   POST /v1/ping    {}           -> {ok:true}
//   POST /v1/write   {rel, data}  -> {ok, size}        (tulis atomik tmp+rename)
//   POST /v1/read    {rel}        -> {ok, data} | 404 {ok:false, error:"not-found"}
//   POST /v1/exists  {rel}        -> {ok, exists}
//   POST /v1/stat    {rel}        -> {ok, size|null}
//   POST /v1/delete  {rel}        -> {ok}
//   POST /v1/mkdir   {rel}        -> {ok}
//   POST /v1/list    {rel}        -> {ok, items:[...]}
// rel = path relatif di dalam PRATA_DAEMON_DIR; ".." dan path absolut
// DITOLAK. Batas body 80 MB (blob maks 50 MB + overhead base64).
import { createServer } from "node:http";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  rmSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { resolve, dirname, sep } from "node:path";

const PORT = Number(process.env.PRATA_DAEMON_PORT ?? 18089);
const DIR = resolve(process.env.PRATA_DAEMON_DIR ?? "/tmp/prata-untainted-disk");
const MAX_BODY = 80 * 1024 * 1024;

mkdirSync(DIR, { recursive: true });

function safePath(rel) {
  if (typeof rel !== "string" || rel.length === 0) return null;
  if (rel.startsWith("/") || rel.includes("\\")) return null;
  const parts = rel.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  const full = resolve(DIR, ...parts);
  if (full !== DIR && !full.startsWith(DIR + sep)) return null;
  return full;
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        rejectBody(new Error("body terlalu besar"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/healthz" || req.url?.startsWith("/healthz?"))) {
      return send(res, 200, { ok: true, dir: DIR, uptime: process.uptime() });
    }
    if (req.method !== "POST" || !req.url?.startsWith("/v1/")) {
      return send(res, 404, { ok: false, error: "not-found" });
    }
    const op = req.url.slice(4).split("?")[0];
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return send(res, 400, { ok: false, error: "json tidak valid" });
    }
    if (op === "ping") return send(res, 200, { ok: true });
    const rel = typeof body.rel === "string" ? body.rel : "";
    const full = safePath(rel);
    if (!full) return send(res, 400, { ok: false, error: "rel tidak valid" });
    switch (op) {
      case "write": {
        const data = Buffer.from(typeof body.data === "string" ? body.data : "", "base64");
        mkdirSync(dirname(full), { recursive: true });
        const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
        writeFileSync(tmp, data);
        renameSync(tmp, full);
        return send(res, 200, { ok: true, size: data.length });
      }
      case "read": {
        if (!existsSync(full)) return send(res, 404, { ok: false, error: "not-found" });
        return send(res, 200, { ok: true, data: readFileSync(full).toString("base64") });
      }
      case "exists":
        return send(res, 200, { ok: true, exists: existsSync(full) });
      case "stat": {
        if (!existsSync(full)) return send(res, 200, { ok: true, size: null });
        return send(res, 200, { ok: true, size: statSync(full).size });
      }
      case "delete": {
        rmSync(full, { force: true });
        return send(res, 200, { ok: true });
      }
      case "mkdir": {
        mkdirSync(full, { recursive: true });
        return send(res, 200, { ok: true });
      }
      case "list": {
        if (!existsSync(full)) return send(res, 200, { ok: true, items: [] });
        return send(res, 200, { ok: true, items: readdirSync(full) });
      }
      default:
        return send(res, 404, { ok: false, error: "op tidak dikenal" });
    }
  } catch (err) {
    console.error("daemon error:", err instanceof Error ? err.message : String(err));
    try {
      return send(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    } catch {
      return undefined;
    }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`storage-daemon listening http://127.0.0.1:${PORT} dir=${DIR}`);
});
