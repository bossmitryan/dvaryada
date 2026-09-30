// Обновление из открытого репозитория GitHub: сравнить версию, скачать архив, заменить файлы, перезапуститься.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { unzip } = require("./unzip");

const REPO = "bossmitryan/dvaryada";
const BRANCH = "main";
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;
const ZIP = `https://codeload.github.com/${REPO}/zip/refs/heads/${BRANCH}`;
// файлы и папки, которые обновление не трогает
const KEEP = [/^node_modules\//, /^dist\//, /^\.git\//];

const cmp = (a, b) => {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); }
  return 0;
};

async function check(appDir) {
  const local = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8"));
  let r;
  try { r = await fetch(RAW + "package.json?t=" + Date.now(), { cache: "no-store" }); }
  catch (e) { throw new Error("GitHub недоступен: " + e.message); }
  if (r.status === 404) throw new Error("Репозиторий закрыт или не найден. Сделайте его открытым (Settings → Change visibility → Public).");
  if (!r.ok) throw new Error("GitHub ответил " + r.status);
  const remote = JSON.parse(await r.text());
  let notes = "";
  try { const c = await fetch(RAW + "CHANGELOG.md?t=" + Date.now()); if (c.ok) notes = (await c.text()).split(/\n(?=## )/)[1] || ""; } catch {}
  return {
    current: local.version, latest: remote.version, available: cmp(remote.version, local.version) > 0,
    depsChanged: JSON.stringify(remote.dependencies || {}) !== JSON.stringify(local.dependencies || {}) ||
      JSON.stringify(remote.devDependencies || {}) !== JSON.stringify(local.devDependencies || {}),
    notes: notes.trim().slice(0, 1500)
  };
}

function npmInstall(appDir, log) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/", FFMPEG_BINARIES_URL: process.env.FFMPEG_BINARIES_URL || "https://cdn.npmmirror.com/binaries/ffmpeg-static" };
    const p = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund"], { cwd: appDir, env, shell: true, windowsHide: true });
    p.stdout.on("data", d => log && log(String(d)));
    p.stderr.on("data", d => log && log(String(d)));
    p.on("error", reject);
    p.on("close", code => code === 0 ? resolve() : reject(new Error("npm install завершился с кодом " + code)));
  });
}

async function apply(appDir, progress = () => {}) {
  const info = await check(appDir);
  if (!info.available) return { ...info, applied: false };
  progress("Скачиваю версию " + info.latest + "…");
  const r = await fetch(ZIP + "?t=" + Date.now());
  if (!r.ok) throw new Error("Не удалось скачать обновление (" + r.status + ")");
  const files = unzip(Buffer.from(await r.arrayBuffer()));
  if (!files.length) throw new Error("Архив обновления пустой");
  const root = files[0].name.split("/")[0] + "/"; // dvaryada-main/
  // резервная копия изменяемых файлов на случай отката
  const backup = path.join(appDir, ".backup-" + info.current);
  progress("Заменяю файлы…");
  let n = 0;
  for (const f of files) {
    if (!f.name.startsWith(root)) continue;
    const rel = f.name.slice(root.length);
    if (!rel || KEEP.some(re => re.test(rel))) continue;
    const dst = path.join(appDir, ...rel.split("/"));
    if (!dst.startsWith(appDir)) continue; // защита от путей вида ../
    if (fs.existsSync(dst)) {
      const b = path.join(backup, ...rel.split("/"));
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.copyFileSync(dst, b);
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, f.data); n++;
  }
  if (info.depsChanged) { progress("Докачиваю компоненты (npm install)…"); await npmInstall(appDir, s => progress(s.trim().split("\n").pop().slice(0, 120))); }
  return { ...info, applied: true, files: n };
}

module.exports = { check, apply };
