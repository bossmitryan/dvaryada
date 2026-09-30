// Домашний сервер для планшета: веб-версия плеера, API, видео, превью, установка APK.
// Все запросы, кроме /ping, /pair, /apk и файлов интерфейса, требуют ключ устройства (?k=… или заголовок X-Key).
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const media = require("./server");

const PORT = 8787;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json" };

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (!/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      // адаптеры VPN и виртуальных машин — в конец списка
      const virt = /vpn|virtual|vbox|vmware|hyper-v|wsl|tap|tun|wireguard|zerotier|tailscale|radmin|hamachi/i.test(name);
      out.push({ ip: a.address, name, virt });
    }
  }
  out.sort((x, y) => (x.virt - y.virt) || (x.ip.startsWith("192.168.") ? -1 : 1));
  return out.map(x => x.ip);
}

// Buffer внутри ответа -> base64, чтобы пройти через JSON
function encode(v) {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { __b64: Buffer.from(v).toString("base64") };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = encode(x); return o; }
  return v;
}

function createRemote({ handlers, getDevices, addDevice, touchDevice, rendererDir, apk, thumb, deviceName }) {
  let pairing = null; // { code, until }
  let server = null;

  const keyOf = (req, u) => u.searchParams.get("k") || req.headers["x-key"] || "";
  const deviceBy = key => key && getDevices().find(d => d.token === key);

  function send(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  }
  function readBody(req, limit = 8 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const parts = []; let n = 0;
      req.on("data", d => { n += d.length; if (n > limit) { reject(new Error("too large")); req.destroy(); } else parts.push(d); });
      req.on("end", () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {}); } catch (e) { reject(e); } });
      req.on("error", reject);
    });
  }
  function serveStatic(res, rel) {
    let safe = path.normalize(rel || ".").replace(/^(\.\.[\\/])+/, "");
    if (safe === "." || safe === path.sep) safe = "index.html";
    const f = path.join(rendererDir, safe);
    if (!f.startsWith(rendererDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    let data = fs.readFileSync(f);
    if (path.basename(f) === "index.html") {
      // в веб-версии вместо моста Electron подключаем remote-api.js
      data = Buffer.from(data.toString("utf8")
        .replace('<script src="subs.js"></script>', '<script src="remote-api.js"></script>\n<script src="subs.js"></script>')
        .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ""));
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  }

  async function onRequest(req, res) {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    try {
      if (p === "/ping") return send(res, 200, { ok: true, app: "dvaryada", name: deviceName(), version: require("../package.json").version });
      if (p === "/" ) { res.writeHead(302, { Location: "/app/" + (u.search || "") }); return res.end(); }
      if (p === "/app" || p.startsWith("/app/")) return serveStatic(res, decodeURIComponent(p.replace(/^\/app\/?/, "")));
      if (p === "/apk") {
        const f = await apk();
        if (!f) return send(res, 503, { ok: false, error: "APK ещё не собран или GitHub недоступен" });
        res.writeHead(200, { "Content-Type": "application/vnd.android.package-archive", "Content-Disposition": 'attachment; filename="DvaRyada.apk"', "Content-Length": fs.statSync(f).size });
        return fs.createReadStream(f).pipe(res);
      }
      if (p === "/pair" && req.method === "POST") {
        const b = await readBody(req);
        if (!pairing || Date.now() > pairing.until || String(b.code) !== pairing.code) return send(res, 403, { ok: false, error: "Код устарел или неверный. Откройте QR на ПК заново." });
        const token = crypto.randomBytes(24).toString("hex");
        addDevice({ id: crypto.randomBytes(6).toString("hex"), name: String(b.name || "Планшет").slice(0, 60), token, created: Date.now() });
        pairing = null;
        return send(res, 200, { ok: true, token, name: deviceName() });
      }
      // дальше — только для привязанных устройств
      const dev = deviceBy(keyOf(req, u));
      if (!dev) return send(res, 401, { ok: false, error: "Устройство не привязано к этому ПК", code: "unpaired" });
      touchDevice(dev.id);
      if (media.handle(req, res, u)) return;
      let m;
      if ((m = /^\/thumb\/([0-9a-f]{16})$/.exec(p))) {
        const f = await thumb(m[1]);
        if (!f) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" });
        return fs.createReadStream(f).pipe(res);
      }
      if ((m = /^\/api\/([A-Za-z]+)$/.exec(p)) && req.method === "POST") {
        const fn = handlers[m[1]];
        if (!fn) return send(res, 404, { ok: false, error: "Неизвестный вызов " + m[1] });
        const b = await readBody(req);
        try { send(res, 200, { ok: true, value: encode(await fn(...(b.args || []))) }); }
        catch (e) { send(res, 200, { ok: false, error: e.message || String(e), code: e.code || "" }); }
        return;
      }
      res.writeHead(404); res.end();
    } catch (e) {
      if (!res.headersSent) send(res, 500, { ok: false, error: e.message });
    }
  }

  return {
    start() {
      return new Promise((resolve, reject) => {
        if (server) return resolve(PORT);
        server = http.createServer(onRequest);
        server.on("error", e => { server = null; reject(e.code === "EADDRINUSE" ? new Error(`Порт ${PORT} занят другой программой`) : e); });
        server.listen(PORT, "0.0.0.0", () => resolve(PORT));
      });
    },
    stop() { if (server) { server.close(); server = null; } },
    running: () => !!server,
    newPairing() {
      pairing = { code: String(crypto.randomInt(100000, 1000000)), until: Date.now() + 10 * 60 * 1000 };
      return { ...pairing, hosts: lanAddresses(), port: PORT };
    },
    addresses: lanAddresses,
    PORT
  };
}

module.exports = { createRemote, lanAddresses };
