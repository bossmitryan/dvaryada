// Локальный HTTP-сервер для <video>:
//  /file/<id>    — отдаёт файл как есть, с поддержкой Range (быстрая перемотка)
//  /stream/<id>  — перепаковка через ffmpeg в fragmented MP4 (нужная аудиодорожка,
//                  звук AC3/DTS -> AAC, видео HEVC и т.п. -> H.264 при необходимости)
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { FFMPEG } = require("./media");

const files = new Map(); // id -> absolute path
const MIME = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo" };

function register(file) {
  for (const [id, p] of files) if (p === file) return id;
  const id = crypto.randomBytes(8).toString("hex");
  files.set(id, file);
  return id;
}

function serveFile(req, res, file) {
  let size;
  try { size = fs.statSync(file).size; } catch { res.writeHead(404); return res.end(); }
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    let start = range[1] === "" ? size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== "" && range[2] !== "" ? Number(range[2]) : size - 1;
    if (start >= size || start < 0) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return res.end(); }
    end = Math.min(end, size - 1);
    res.writeHead(206, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}` });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": size });
    fs.createReadStream(file).pipe(res);
  }
}

function streamArgs(file, { a = 0, ss = 0, vc = "copy", h = 0 }) {
  const args = ["-v", "error", "-nostdin"];
  if (ss > 0) args.push("-ss", String(ss));
  args.push("-i", file, "-map", "0:v:0", "-map", `0:a:${a}?`, "-sn", "-dn");
  if (vc === "copy") args.push("-c:v", "copy");
  else {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p");
    if (h > 1080) args.push("-vf", "scale=-2:1080");
  }
  args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2",
    "-avoid_negative_ts", "make_zero",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4", "pipe:1");
  return args;
}

function serveStream(req, res, file, q) {
  const opts = { a: parseInt(q.get("a") || "0", 10) || 0, ss: parseFloat(q.get("ss") || "0") || 0, vc: q.get("vc") === "x264" ? "x264" : "copy", h: parseInt(q.get("h") || "0", 10) || 0 };
  const ff = spawn(FFMPEG, streamArgs(file, opts), { windowsHide: true });
  res.writeHead(200, { "Content-Type": "video/mp4", "Cache-Control": "no-store" });
  ff.stdout.pipe(res);
  let err = "";
  ff.stderr.on("data", d => { err += d; if (err.length > 8000) err = err.slice(-4000); });
  ff.on("close", code => { if (code && code !== 255) console.error("[stream] ffmpeg", code, err.slice(-500)); res.end(); });
  const kill = () => { try { ff.kill("SIGKILL"); } catch {} };
  req.on("close", kill); res.on("close", kill);
}

// Обработка /file/<id> и /stream/<id>; возвращает false, если адрес не наш
function handle(req, res, u) {
  const m = /^\/(file|stream)\/([0-9a-f]{16})$/.exec(u.pathname);
  if (!m) return false;
  const file = files.get(m[2]);
  if (!file) { res.writeHead(404); res.end(); return true; }
  if (m[1] === "file") serveFile(req, res, file); else serveStream(req, res, file, u.searchParams);
  return true;
}

function start() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (!handle(req, res, u)) { res.writeHead(404); res.end(); }
    });
    srv.listen(0, "127.0.0.1", () => resolve({ port: srv.address().port, server: srv }));
  });
}

module.exports = { start, register, streamArgs, handle, serveFile };
