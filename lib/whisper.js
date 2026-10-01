// Точный режим: расшифровка речи фильма через faster-whisper, который уже стоит на ПК.
// Ищем Python, в котором установлен faster_whisper, запускаем whisper/run.py, результат кэшируем.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const { FFMPEG } = require("./media");

const RUN_PY = path.join(__dirname, "..", "whisper", "run.py");

function execp(bin, args, timeout = 20000) {
  return new Promise(resolve => {
    execFile(bin, args, { timeout, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || (err && err.message) || "") }));
  });
}

// все Python на компьютере, которые удалось найти
async function pythonCandidates() {
  const home = os.homedir(), list = [];
  const add = p => { if (p && !list.some(x => x.toLowerCase() === p.toLowerCase()) && fs.existsSync(p)) list.push(p); };
  const subdirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => path.join(d, x.name)); } catch { return []; } };
  if (process.platform === "win32") {
    const py = await execp("py", ["-0p"]);
    for (const line of py.out.split(/\r?\n/)) { const m = line.match(/([A-Z]:\\.*python\.exe)/i); if (m) add(m[1].trim()); }
    const wh = await execp("where", ["python"]);
    for (const line of wh.out.split(/\r?\n/)) if (/python\.exe$/i.test(line.trim()) && !/WindowsApps/i.test(line)) add(line.trim());
    for (const base of ["Miniconda3", "miniconda3", "Anaconda3", "anaconda3"]) {
      add(path.join(home, base, "python.exe"));
      for (const env of subdirs(path.join(home, base, "envs"))) add(path.join(env, "python.exe"));
    }
    for (const env of subdirs(path.join(home, ".conda", "envs"))) add(path.join(env, "python.exe"));
    for (const d of subdirs(path.join(home, "AppData", "Local", "Programs", "Python"))) add(path.join(d, "python.exe"));
    // виртуальные окружения в папках первого уровня (например, F5-TTS\venv)
    for (const d of subdirs(home).concat(subdirs(path.join(home, "Desktop")), subdirs(path.join(home, "PycharmProjects")))) {
      for (const v of ["venv", ".venv", "env"]) add(path.join(d, v, "Scripts", "python.exe"));
    }
  } else {
    for (const b of ["python3", "python"]) { const r = await execp("which", [b]); if (r.ok) add(r.out.trim()); }
  }
  return list;
}

async function hasFasterWhisper(py) {
  const r = await execp(py, ["-c", "import faster_whisper; print(faster_whisper.__version__)"], 40000);
  return r.ok ? r.out.trim() : null;
}

async function detect(preferred) {
  const tried = [];
  const cands = await pythonCandidates();
  if (preferred && fs.existsSync(preferred)) cands.unshift(preferred);
  for (const py of cands) {
    const v = await hasFasterWhisper(py);
    tried.push(py);
    if (v) return { python: py, version: v, tried };
  }
  return { python: null, version: null, tried, base: cands[0] || null };
}

// модели в кэше Hugging Face (~/.cache/huggingface/hub/models--Systran--faster-whisper-*)
function cachedModels() {
  const hub = path.join(process.env.HF_HOME || path.join(os.homedir(), ".cache", "huggingface"), "hub");
  try {
    return fs.readdirSync(hub).map(n => (n.match(/^models--Systran--faster-whisper-(.+)$/) || [])[1]).filter(Boolean);
  } catch { return []; }
}

// установка faster-whisper в отдельное окружение программы (если на ПК его не нашли)
function install(basePython, envDir, log) {
  return new Promise((resolve, reject) => {
    const run = (bin, args) => new Promise((res, rej) => {
      const p = spawn(bin, args, { windowsHide: true });
      p.stdout.on("data", d => log(String(d).trim().split("\n").pop()));
      p.stderr.on("data", d => log(String(d).trim().split("\n").pop()));
      p.on("error", rej);
      p.on("close", c => c === 0 ? res() : rej(new Error(`${path.basename(bin)} ${args[1] || ""} завершился с кодом ${c}`)));
    });
    const py = process.platform === "win32" ? path.join(envDir, "Scripts", "python.exe") : path.join(envDir, "bin", "python");
    (async () => {
      if (!fs.existsSync(py)) { log("Создаю окружение Python…"); await run(basePython, ["-m", "venv", envDir]); }
      log("Скачиваю faster-whisper (около 100 МБ)…");
      await run(py, ["-m", "pip", "install", "--upgrade", "faster-whisper"]);
      resolve(py);
    })().catch(reject);
  });
}

/* ---------- задания расшифровки ---------- */
const jobs = new Map(); // id -> {state, p, msg, error, result}
function keyOf(file, audioN, model, lang) {
  const st = fs.statSync(file);
  return crypto.createHash("sha1").update([file.toLowerCase(), st.size, st.mtimeMs, audioN, model, lang].join("|")).digest("hex").slice(0, 20);
}

function start({ python, file, audioN = 0, model = "medium", lang = "auto", cacheDir }) {
  const id = keyOf(file, audioN, model, lang);
  const out = path.join(cacheDir, id + ".json");
  if (jobs.has(id) && jobs.get(id).state === "running") return id;
  if (fs.existsSync(out)) { jobs.set(id, { state: "done", p: 1, msg: "Готово", out }); return id; }
  const job = { state: "running", p: 0, msg: "Готовлю звук…", out };
  jobs.set(id, job);
  fs.mkdirSync(cacheDir, { recursive: true });
  const wav = path.join(os.tmpdir(), "dvaryada-" + id + ".wav");
  const ff = spawn(FFMPEG, ["-v", "error", "-nostdin", "-y", "-i", file, "-map", `0:a:${audioN}`, "-vn", "-ac", "1", "-ar", "16000", wav], { windowsHide: true });
  ff.on("error", e => Object.assign(job, { state: "error", error: "ffmpeg: " + e.message }));
  ff.on("close", code => {
    if (code !== 0) return Object.assign(job, { state: "error", error: "Не удалось достать звук из фильма" });
    job.msg = "Загружаю модель распознавания…";
    const p = spawn(python, [RUN_PY, wav, out, model, lang], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
    let rest = "", errText = "";
    p.stdout.on("data", d => {
      const lines = (rest + d).split("\n"); rest = lines.pop();
      for (const l of lines) {
        let j; try { j = JSON.parse(l); } catch { continue; }
        if (j.p !== undefined) { job.p = j.p; job.msg = `Распознаю речь… ${Math.round(j.p * 100)}%`; }
        if (j.info) { if (j.info.device) job.device = j.info.device; if (j.info.language) job.language = j.info.language; job.msg = `Распознаю речь${job.device ? " (" + (job.device === "cuda" ? "видеокарта" : "процессор") + ")" : ""}…`; }
        if (j.error) job.error = j.error;
      }
    });
    p.stderr.on("data", d => { errText += d; if (errText.length > 4000) errText = errText.slice(-2000); });
    p.on("error", e => Object.assign(job, { state: "error", error: e.message }));
    p.on("close", c => {
      try { fs.unlinkSync(wav); } catch {}
      if (c === 0 && fs.existsSync(out)) Object.assign(job, { state: "done", p: 1, msg: "Готово" });
      else Object.assign(job, { state: "error", error: job.error || errText.split("\n").filter(Boolean).slice(-2).join(" ") || "Whisper завершился с ошибкой" });
    });
  });
  return id;
}

function status(id) {
  const j = jobs.get(id);
  if (!j) return { state: "none" };
  return { state: j.state, p: j.p, msg: j.msg, error: j.error, device: j.device, language: j.language };
}

// Расшифровку -> реплики (не длиннее ~6 с и ~84 символов, по границам предложений) + время каждого слова
function toCues(tr) {
  const cues = [], wt = [];
  for (const seg of tr.segments || []) {
    const words = (seg.words && seg.words.length) ? seg.words : [[seg.s, seg.e, seg.text]];
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      const text = cur.map(w => w[2]).join("").replace(/\s+/g, " ").trim();
      if (!text) { cur = []; return; }
      cues.push({ s: cur[0][0], e: cur[cur.length - 1][1] + 0.15, text: wrap(text) });
      wt.push(cur.filter(w => /[\p{L}\p{N}]/u.test(w[2])).map(w => [w[0], w[1]]));
      cur = [];
    };
    for (const w of words) {
      cur.push(w);
      const len = cur.map(x => x[2]).join("").trim().length, dur = w[1] - cur[0][0];
      if ((/[.!?…]["»]?$/.test(String(w[2]).trim()) && len > 12) || len > 84 || dur > 6) flush();
    }
    flush();
  }
  cues.forEach((c, i) => c.id = i);
  return { cues, wt, language: tr.language };
}
// перенос на две строки примерно посередине
function wrap(t) {
  if (t.length <= 42) return t;
  const mid = t.length / 2;
  let best = -1;
  for (let i = 0; i < t.length; i++) if (t[i] === " " && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return best > 0 ? t.slice(0, best) + "\n" + t.slice(best + 1) : t;
}

function result(id) {
  const j = jobs.get(id);
  if (!j || j.state !== "done") throw new Error("Расшифровка ещё не готова");
  return toCues(JSON.parse(fs.readFileSync(j.out, "utf8")));
}

module.exports = { detect, cachedModels, install, start, status, result, toCues };
