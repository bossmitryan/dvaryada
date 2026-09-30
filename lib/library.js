// Библиотека фильмов для планшета: папки с видео на ПК, превью-кадры.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { FFMPEG } = require("./media");

const VIDEO_EXT = /\.(mkv|mp4|m4v|webm|mov|avi|ts|m2ts|wmv|flv)$/i;
const MIN_MB = Number(process.env.DVARYADA_MIN_MB || 50);
const idOf = p => crypto.createHash("sha1").update(p.toLowerCase()).digest("hex").slice(0, 16);

function clean(name) {
  let s = name.replace(/\.[^.]+$/, "").replace(/[._]+/g, " ");
  const yr = s.match(/\b(19[3-9]\d|20[0-4]\d)\b/);
  const se = s.match(/\bS(\d{1,2})\s?E(\d{1,3})\b/i);
  const cut = s.search(/\b(S\d{1,2}\s?E\d{1,3}|19[3-9]\d|20[0-4]\d|1080p|720p|2160p|4k|web[- ]?dl|webrip|bdrip|bluray|hdrip|dvdrip|x26[45]|hevc|h26[45])\b/i);
  if (cut > 0) s = s.slice(0, cut);
  s = s.replace(/[\[\](){}-]+/g, " ").replace(/\s+/g, " ").trim();
  return { title: s || name, year: yr ? +yr[1] : "", season: se ? +se[1] : "", episode: se ? +se[2] : "" };
}

// Рекурсивный обход (до 4 уровней), пропускаем «сэмплы» и мелкие файлы
function scan(folders) {
  const items = [];
  const walk = (dir, root, depth) => {
    let list = []; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of list) {
      if (it.name.startsWith(".") || it.name.startsWith("$")) continue;
      const p = path.join(dir, it.name);
      if (it.isDirectory()) { if (depth < 4) walk(p, root, depth + 1); continue; }
      if (!VIDEO_EXT.test(it.name) || /\bsample\b/i.test(it.name)) continue;
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.size < MIN_MB * 1024 * 1024) continue;
      const rel = path.relative(root, dir);
      items.push({ id: idOf(p), path: p, name: it.name, folder: rel.split(path.sep)[0] || "", size: st.size, mtime: st.mtimeMs, ...clean(it.name) });
    }
  };
  for (const f of folders || []) walk(f, f, 0);
  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}

function inside(file, folders) {
  const f = path.resolve(file).toLowerCase();
  return (folders || []).some(d => f.startsWith(path.resolve(d).toLowerCase() + path.sep));
}

// Превью-кадр: кэш в папке настроек
const pending = new Map();
function thumb(file, cacheDir) {
  const out = path.join(cacheDir, idOf(file) + ".jpg");
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (pending.has(out)) return pending.get(out);
  fs.mkdirSync(cacheDir, { recursive: true });
  const grab = ss => new Promise(res => {
    const p = spawn(FFMPEG, ["-v", "error", "-nostdin", "-ss", String(ss), "-i", file, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "6", "-y", out], { windowsHide: true });
    p.on("close", code => res(code === 0 && fs.existsSync(out)));
    p.on("error", () => res(false));
  });
  const job = (async () => { if (!(await grab(420))) if (!(await grab(30))) await grab(0); return fs.existsSync(out) ? out : null; })();
  pending.set(out, job); job.finally(() => pending.delete(out));
  return job;
}

module.exports = { scan, inside, thumb, idOf, VIDEO_EXT };
