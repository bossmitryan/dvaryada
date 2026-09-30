// Работа с видеофайлом через ffprobe/ffmpeg: список дорожек, извлечение
// встроенных субтитров, поиск ключевого кадра для перемотки.
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");

function binPath(mod) {
  let p;
  try {
    const m = require(mod);
    p = typeof m === "string" ? m : m.path;
  } catch { p = null; }
  if (!p) return mod === "ffmpeg-static" ? "ffmpeg" : "ffprobe"; // системный, если пакета нет
  // в собранном приложении бинарники лежат рядом с app.asar, в app.asar.unpacked
  return p.replace("app.asar" + require("path").sep, "app.asar.unpacked" + require("path").sep);
}
const FFMPEG = process.env.DVARYADA_FFMPEG || binPath("ffmpeg-static");
const FFPROBE = process.env.DVARYADA_FFPROBE || binPath("ffprobe-static");

function run(bin, args, { maxBytes = 64 * 1024 * 1024, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    const out = []; let size = 0; let err = "";
    let timer = timeoutMs ? setTimeout(() => { p.kill("SIGKILL"); reject(new Error("timeout")); }, timeoutMs) : null;
    p.stdout.on("data", d => { size += d.length; if (size <= maxBytes) out.push(d); });
    p.stderr.on("data", d => { err += d.toString(); if (err.length > 20000) err = err.slice(-10000); });
    p.on("error", e => { if (timer) clearTimeout(timer); reject(e); });
    p.on("close", code => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${bin} exited ${code}: ${err.split("\n").slice(-4).join(" ")}`));
    });
  });
}

const TEXT_SUBS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"]);

async function probe(file) {
  const buf = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeoutMs: 30000 });
  const j = JSON.parse(buf.toString("utf8"));
  const streams = j.streams || [];
  const tag = (s, k) => (s.tags && (s.tags[k] || s.tags[k.toUpperCase()])) || "";
  let ai = 0, si = 0;
  const audio = [], subs = [];
  let video = null;
  for (const s of streams) {
    if (s.codec_type === "video" && !video && !(s.disposition && s.disposition.attached_pic)) {
      video = { codec: s.codec_name, profile: s.profile || "", width: s.width, height: s.height, pixfmt: s.pix_fmt || "" };
    } else if (s.codec_type === "audio") {
      audio.push({ n: ai++, index: s.index, codec: s.codec_name, channels: s.channels || 2,
        lang: tag(s, "language"), title: tag(s, "title"), default: !!(s.disposition && s.disposition.default) });
    } else if (s.codec_type === "subtitle") {
      subs.push({ n: si++, index: s.index, codec: s.codec_name, lang: tag(s, "language"), title: tag(s, "title"),
        text: TEXT_SUBS.has(s.codec_name), forced: !!(s.disposition && s.disposition.forced) });
    }
  }
  const st = fs.statSync(file);
  return {
    file, size: st.size,
    duration: parseFloat(j.format && j.format.duration) || 0,
    container: (j.format && j.format.format_name) || "",
    title: (j.format && j.format.tags && (j.format.tags.title || j.format.tags.TITLE)) || "",
    video, audio, subs
  };
}

// Встроенные текстовые субтитры -> строка SRT или ASS
async function extractSub(file, n, codec) {
  const fmt = (codec === "ass" || codec === "ssa") ? "ass" : "srt";
  const buf = await run(FFMPEG, ["-v", "error", "-nostdin", "-i", file, "-map", `0:s:${n}`, "-f", fmt, "pipe:1"], { timeoutMs: 900000 });
  return { text: buf.toString("utf8"), format: fmt };
}

// Ближайший ключевой кадр не позже t (нужен для перемотки без перекодирования видео)
async function keyframeBefore(file, t) {
  if (t <= 0.5) return 0;
  const from = Math.max(0, t - 12);
  try {
    const buf = await run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
      "-show_entries", "frame=best_effort_timestamp_time,pts_time", "-of", "csv=p=0",
      "-read_intervals", `${from.toFixed(3)}%${(t + 0.05).toFixed(3)}`, file], { timeoutMs: 15000 });
    let best = null;
    for (const line of buf.toString().split(/\r?\n/)) {
      const v = line.split(",").map(parseFloat).find(x => isFinite(x));
      if (v !== undefined && v <= t + 0.001 && (best === null || v > best)) best = v;
    }
    return best === null ? t : best;
  } catch { return t; }
}

module.exports = { FFMPEG, FFPROBE, run, probe, extractSub, keyframeBefore };
