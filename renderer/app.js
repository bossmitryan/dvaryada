"use strict";
(() => {
const api = window.api;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
function toast(t) { const el = document.createElement("div"); el.className = "toast"; el.textContent = t; document.body.append(el); setTimeout(() => el.remove(), 3200); }
const fmt = s => { if (!isFinite(s)) s = 0; s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = Math.floor(s % 60); return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };

/* ---------- языки ---------- */
const LANGS = [["en", "EN", "английский"], ["ru", "RU", "русский"], ["de", "DE", "немецкий"], ["fr", "FR", "французский"], ["es", "ES", "испанский"], ["it", "IT", "итальянский"], ["ja", "JA", "японский"], ["ko", "KO", "корейский"], ["uk", "UK", "украинский"], ["pt", "PT", "португальский"], ["zh", "ZH", "китайский"]];
const L3 = { eng: "en", rus: "ru", ger: "de", deu: "de", fre: "fr", fra: "fr", spa: "es", ita: "it", jpn: "ja", kor: "ko", ukr: "uk", por: "pt", chi: "zh", zho: "zh", pol: "pl", tur: "tr", und: "" };
const norm = l => { l = String(l || "").toLowerCase(); return L3[l] ?? l.split(/[-_]/)[0]; };
const langFromName = n => { const m = String(n).toLowerCase().match(/[._\-\s\[(](en|eng|english|ru|rus|russian|de|ger|fr|fre|es|spa|it|ita|ja|jpn|ko|kor|uk|ukr)[._\-\s\])]/); if (!m) return ""; const x = m[1]; return ({ english: "en", russian: "ru" })[x] || norm(x); };

/* ---------- настройки вида ---------- */
const DEF_TRACK = (color, edge, size, offset) => ({ on: true, color, size, edge, offset, bg: "shadow", bgOp: 0.55, font: "ui", bold: false, delay: 0 });
const DEFAULTS = { t: [DEF_TRACK("#ffffff", "bottom", 4.6, 4), DEF_TRACK("#f2b233", "bottom", 3.8, 1)], order: [0, 1], hoverPause: true, popPause: true, lang: "русский", rate: 1, vol: 1 };
let S = Object.assign(structuredClone(DEFAULTS), store.get("dr.settings", {}));
S.t = [0, 1].map(i => Object.assign(structuredClone(DEFAULTS.t[i]), (S.t || [])[i] || {}));
const save = () => store.set("dr.settings", S);
let CFG = { osApiKey: "", osUsername: "", osHasPassword: false, subLangs: ["en", "ru"], translator: "google", hasClaudeKey: false };

/* ---------- видео и режимы воспроизведения ---------- */
const video = $("#video"), stage = $("#stage");
let film = null;          // {path, name, info, hash}
let mode = null;          // "direct" | "stream"
let vc = "copy";          // для stream: копировать видео или перекодировать в H.264
let offset = 0, audioN = 0, pendingSeek = null, seekTimer = null;
const tracks = [{ name: "", cues: [], key: null }, { name: "", cues: [], key: null }];

const VID_TYPES = { h264: 'video/mp4; codecs="avc1.640028"', hevc: 'video/mp4; codecs="hvc1.1.6.L120.90"', vp9: 'video/webm; codecs="vp9"', vp8: 'video/webm; codecs="vp8"', av1: 'video/mp4; codecs="av01.0.08M.08"' };
const canVideo = c => !!(VID_TYPES[c] && video.canPlayType(VID_TYPES[c]));
const canAudio = c => ["aac", "mp3", "opus", "vorbis", "flac"].includes(c);
function decideMode(info, n) {
  const containerOk = /mp4|mov|webm|matroska/.test(info.container);
  const a = info.audio[n];
  const vOk = info.video && canVideo(info.video.codec);
  if (vOk && containerOk && (!a || (n === 0 && canAudio(a.codec)))) return { mode: "direct", vc: "copy" };
  return { mode: "stream", vc: vOk ? "copy" : "x264" };
}
const media = {
  get t() { return pendingSeek ?? (offset + (video.currentTime || 0)); },
  set t(v) { seekTo(v); },
  get dur() { return film?.info?.duration || video.duration || 0; },
  get paused() { return video.paused; },
  play() { if (!film) return; video.play().catch(() => {}); },
  pause() { video.pause(); }
};
function streamSrc(ss) {
  const u = new URL(film.info.streamUrl);
  u.searchParams.set("a", audioN); u.searchParams.set("ss", ss.toFixed(3)); u.searchParams.set("vc", vc);
  if (film.info.video) u.searchParams.set("h", film.info.video.height || 0);
  return u.toString();
}
function seekTo(t) {
  if (!film) return;
  t = Math.max(0, Math.min(t, (media.dur || 1) - 0.5));
  if (mode === "direct") { video.currentTime = t; tick(true); return; }
  pendingSeek = t; tick(true);
  clearTimeout(seekTimer);
  seekTimer = setTimeout(() => restartStream(t, !video.paused || wantPlay), 180);
}
let wantPlay = false;
async function restartStream(t, play) {
  $("#buffer").hidden = false;
  const plan = await api.seekPlan(film.path, t, vc === "copy").catch(() => ({ ss: t, offset: t }));
  if (pendingSeek !== null && Math.abs(pendingSeek - t) > 0.01) return; // пришла более новая перемотка
  offset = plan.offset; wantPlay = play;
  video.src = streamSrc(plan.ss);
  if (play) video.play().catch(() => {});
}
function startPlayback(atT = 0, play = false) {
  const d = decideMode(film.info, audioN);
  mode = d.mode; vc = d.vc; offset = 0; pendingSeek = null;
  showMsg("");
  if (mode === "direct") { video.src = film.info.fileUrl; video.addEventListener("loadedmetadata", () => { if (atT) video.currentTime = atT; if (play) video.play().catch(() => {}); }, { once: true }); }
  else { restartStream(atT, play); }
}
video.addEventListener("playing", () => { $("#buffer").hidden = true; pendingSeek = null; wantPlay = false; });
video.addEventListener("canplay", () => { $("#buffer").hidden = true; if (mode === "stream") pendingSeek = null; });
video.addEventListener("waiting", () => { $("#buffer").hidden = false; });
video.addEventListener("error", () => {
  if (!film) return;
  $("#buffer").hidden = true;
  if (mode === "direct") { // встроенный декодер не справился — перепаковываем через ffmpeg
    mode = "stream"; vc = film.info.video && canVideo(film.info.video.codec) ? "copy" : "x264";
    restartStream(media.t, wantPlay); return;
  }
  if (vc === "copy") { vc = "x264"; restartStream(media.t, wantPlay); return; }
  showMsg("Не получилось воспроизвести этот файл даже с перекодированием. Возможно, файл повреждён или ещё не докачан.");
});
video.addEventListener("play", syncPlayIcon); video.addEventListener("pause", syncPlayIcon);
video.addEventListener("ended", syncPlayIcon);
function showMsg(t) { $("#msgText").textContent = t; $("#msg").hidden = !t; }

/* ---------- субтитры на экране ---------- */
const stTop = $("#stackTop"), stBot = $("#stackBottom");
const subEl = [document.createElement("div"), document.createElement("div")];
subEl.forEach((el, i) => { el.className = "sub"; el.dataset.track = i; });
const WORD = /[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu;
let shown = [null, null];
function cueAt(i, t) {
  const cs = tracks[i].cues; if (!cs.length) return null;
  const x = t - S.t[i].delay;
  let lo = 0, hi = cs.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cs[m].s <= x) { k = m; lo = m + 1; } else hi = m - 1; }
  for (let j = k; j >= 0 && j > k - 6; j--) if (cs[j].s <= x && x < cs[j].e) return cs[j];
  return null;
}
function cueHTML(text) {
  let out = "", last = 0;
  text.replace(WORD, (m, off) => { out += esc(text.slice(last, off)) + `<span class="w">${esc(m)}</span>`; last = off + m.length; return m; });
  return out + esc(text.slice(last));
}
function applyStyles() {
  const h = stage.clientHeight || 360;
  [0, 1].forEach(i => {
    const c = S.t[i], el = subEl[i];
    el.style.fontSize = Math.max(12, h * c.size / 100).toFixed(1) + "px";
    el.style.color = c.color;
    el.style.fontWeight = c.bold ? 700 : 500;
    el.style.fontFamily = c.font === "serif" ? '"PT Serif", Georgia, serif' : c.font === "mono" ? "var(--f-mono)" : "var(--f-ui)";
    el.style.marginBottom = el.style.marginTop = "0";
    const offPx = (h * c.offset / 100) + "px";
    if (c.edge === "bottom") el.style.marginBottom = offPx; else el.style.marginTop = offPx;
    if (c.bg === "box") { el.style.background = `rgba(0,0,0,${c.bgOp})`; el.style.textShadow = "none"; }
    else if (c.bg === "shadow") { el.style.background = "transparent"; el.style.textShadow = "0 0 3px #000, 0 0 3px #000, 0 2px 6px rgba(0,0,0,.9)"; }
    else { el.style.background = "transparent"; el.style.textShadow = "none"; }
    el.hidden = !c.on;
  });
  stTop.textContent = ""; stBot.textContent = "";
  S.order.forEach(i => (S.t[i].edge === "top" ? stTop : stBot).append(subEl[i]));
  const r = document.documentElement.style;
  r.setProperty("--t1", S.t[0].color); r.setProperty("--t2", S.t[1].color);
  $("#dot1").style.background = S.t[0].color; $("#dot2").style.background = S.t[1].color;
  $("#chip1 .dot").style.background = S.t[0].color; $("#chip2 .dot").style.background = S.t[1].color;
  $("#chip1").classList.toggle("off", !S.t[0].on); $("#chip2").classList.toggle("off", !S.t[1].on);
}
function updateSubs(force) {
  const t = media.t;
  [0, 1].forEach(i => {
    const c = cueAt(i, t);
    if (!force && c === shown[i]) return;
    if (pop.open && pop.track === i && !media.paused) closePop();
    shown[i] = c; subEl[i].innerHTML = c ? cueHTML(c.text) : "";
  });
  highlightTranscript();
}

/* ---------- транспорт ---------- */
const seek = $("#seek"); let seeking = false;
function syncPlayIcon() { $("#icPlay").innerHTML = video.paused ? '<path d="M7 4v16l13-8Z"/>' : '<path d="M7 4v16M17 4v16"/>'; }
function tick(force) {
  const d = media.dur, t = media.t;
  if (!seeking) seek.value = d ? Math.round(t / d * 1000) : 0;
  $("#tCur").textContent = fmt(t); $("#tDur").textContent = fmt(d);
  updateSubs(force === true);
}
function loop() { tick(); requestAnimationFrame(loop); }
seek.addEventListener("input", () => { seeking = true; $("#tCur").textContent = fmt(seek.value / 1000 * media.dur); });
seek.addEventListener("change", () => { seeking = false; media.t = seek.value / 1000 * media.dur; });
const toggle = () => { if (!film) return; video.paused ? media.play() : media.pause(); };
$("#bPlay").onclick = toggle; video.addEventListener("click", toggle);
video.addEventListener("dblclick", () => toggleFs());
$("#rate").value = String(S.rate); video.playbackRate = S.rate;
video.addEventListener("loadeddata", () => { video.playbackRate = S.rate; video.volume = S.vol; });
$("#rate").onchange = e => { S.rate = +e.target.value; video.playbackRate = S.rate; save(); };
$("#vol").value = S.vol; video.volume = S.vol;
$("#vol").oninput = e => { S.vol = +e.target.value; video.volume = S.vol; save(); };
const toggleFs = async () => { const on = await api.toggleFullscreen().catch(() => false); document.body.classList.toggle("fs", !!on); setTimeout(applyStyles, 150); };
$("#bFs").onclick = toggleFs;
api.onFullscreen?.(on => { document.body.classList.toggle("fs", on); setTimeout(applyStyles, 150); });

function primaryIdx() { return tracks[0].cues.length ? 0 : (tracks[1].cues.length ? 1 : -1); }
function jumpLine(dir) {
  const i = primaryIdx(); if (i < 0) return;
  const cs = tracks[i].cues, t = media.t - S.t[i].delay, cur = cueAt(i, media.t);
  let target;
  if (dir === 0) target = cur || [...cs].reverse().find(c => c.s <= t);
  else if (dir < 0) { const ref = cur ? cur.s : t; target = [...cs].reverse().find(c => c.s < ref - 0.3); }
  else target = cs.find(c => c.s > t + 0.05);
  if (target) { media.t = target.s + S.t[i].delay + 0.01; if (video.paused) { wantPlay = true; media.play(); } }
}
$("#bPrev").onclick = () => jumpLine(-1); $("#bNext").onclick = () => jumpLine(1); $("#bRepeat").onclick = () => jumpLine(0);
const toggleTrack = i => { S.t[i].on = !S.t[i].on; save(); applyStyles(); renderLook(); };
$("#chip1").onclick = () => toggleTrack(0); $("#chip2").onclick = () => toggleTrack(1);

document.addEventListener("keydown", e => {
  if (e.target.closest("input,select,textarea")) return;
  if (!$("#picker").hidden) { if (e.key === "Escape" && film?.pickedOnce) closePicker(); return; }
  const k = e.key.toLowerCase();
  if (k === " ") { e.preventDefault(); toggle(); }
  else if (k === "arrowleft") { e.preventDefault(); media.t = media.t - 5; }
  else if (k === "arrowright") { e.preventDefault(); media.t = media.t + 5; }
  else if (k === "a" || k === "ф") jumpLine(-1);
  else if (k === "d" || k === "в") jumpLine(1);
  else if (k === "s" || k === "ы") jumpLine(0);
  else if (k === "1") toggleTrack(0);
  else if (k === "2") toggleTrack(1);
  else if (k === "f" || k === "а") toggleFs();
  else if ((k === "c" || k === "с") && film) openPicker();
  else if (k === "escape") { if (pop.open) closePop(); else if (document.body.classList.contains("fs")) toggleFs(); }
});

/* ---------- открытие фильма ---------- */
function cleanTitle(name) {
  let s = name.replace(/\.[^.]+$/, "").replace(/[._]+/g, " ");
  const se = s.match(/\bS(\d{1,2})\s?E(\d{1,3})\b/i) || s.match(/\b(\d{1,2})x(\d{2})\b/);
  const yr = s.match(/\b(19[3-9]\d|20[0-4]\d)\b/);
  let cut = s.search(/\b(S\d{1,2}\s?E\d{1,3}|\d{1,2}x\d{2}|19[3-9]\d|20[0-4]\d|1080p|720p|2160p|4k|web[- ]?dl|webrip|bdrip|bluray|hdrip|dvdrip|x26[45]|hevc|h26[45])\b/i);
  if (cut > 0) s = s.slice(0, cut);
  s = s.replace(/[\[\](){}-]+/g, " ").replace(/\s+/g, " ").trim();
  return { title: s, year: yr ? +yr[1] : "", season: se ? +se[1] : "", episode: se ? +se[2] : "" };
}
async function openFilm(p) {
  if (!p) return;
  closePop(); video.pause(); video.removeAttribute("src"); video.load();
  tracks[0] = { name: "", cues: [], key: null }; tracks[1] = { name: "", cues: [], key: null };
  shown = [null, null]; audioN = 0; renderTranscript();
  const name = p.split(/[\\/]/).pop();
  film = { path: p, name, info: null, hash: null, pickedOnce: false };
  $("#welcome").hidden = true; $("#nowName").textContent = name; $("#bSubs").disabled = false;
  resetPicker(name);
  openPicker();
  // всё параллельно: разбор файла, соседние субтитры, хеш и поиск
  const f = film;
  api.openMedia(p).then(info => {
    if (film !== f) return;
    f.info = info;
    pk.emb = info.subs; pk.audio = info.audio;
    audioN = pickDefaultAudio(info.audio);
    pk.audioN = audioN;
    pk.embStatus = "done"; autoPick(); renderPicker();
    startPlayback(0, f.pickedOnce);
    if (info.audio.length) api.syncWarm(p, audioN).catch(() => {});
  }).catch(e => { if (film !== f) return; pk.embStatus = "error"; pk.embErr = e.message; renderPicker(); showMsg("Не удалось открыть файл: " + e.message); });
  api.siblingSubs(p).then(list => { if (film !== f) return; pk.side = list; autoPick(); renderPicker(); }).catch(() => {});
  f.hashP = api.hash(p).catch(() => null);
  runSearch(true);
}
function pickDefaultAudio(list) {
  if (!list.length) return 0;
  const d = list.findIndex(a => a.default);
  return d >= 0 ? d : 0;
}
$("#bOpen").onclick = $("#bOpen2").onclick = async () => { const p = await api.pickVideo().catch(e => toast(e.message)); if (p) openFilm(p); };
$("#bSubs").onclick = $("#bSubs2").onclick = () => { if (film) openPicker(); };
api.onOpenFile(p => openFilm(p));
["dragenter", "dragover"].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); stage.classList.add("drag"); }));
["dragleave", "drop"].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); if (ev === "drop" || e.target === document.documentElement) stage.classList.remove("drag"); }));
document.addEventListener("drop", async e => {
  stage.classList.remove("drag");
  for (const f of e.dataTransfer.files) {
    const p = api.pathOf(f);
    if (/\.(srt|vtt|ass|ssa)$/i.test(f.name)) {
      const data = new Uint8Array(await f.arrayBuffer());
      const slot = !tracks[0].cues.length ? 0 : 1;
      addOwnFile(f.name, data, slot);
    } else if (p) openFilm(p);
  }
});

/* ---------- окно выбора субтитров ---------- */
let pk = null;
function resetPicker(name) {
  const g = cleanTitle(name);
  pk = { q: g, qTouched: false, langs: CFG.subLangs.slice(), emb: [], side: [], own: [], audio: [], audioN: 0,
    embStatus: "loading", src: {}, showOs: false, chosen: [null, null], touched: [false, false], rowStatus: {}, busy: false };
  $("#pkFile").textContent = name;
  $("#qTitle").value = g.title; $("#qYear").value = g.year; $("#qSeason").value = g.season; $("#qEp").value = g.episode;
}
function openPicker() {
  if (!pk) return;
  if (film?.pickedOnce) { pk.chosen = [tracks[0].key, tracks[1].key]; pk.audioN = audioN; }
  $("#picker").hidden = false; renderPicker();
}
function closePicker() { $("#picker").hidden = true; }
["qTitle", "qYear", "qSeason", "qEp"].forEach(id => $("#" + id).addEventListener("input", () => { pk.qTouched = true; }));
$("#qTitle").addEventListener("keydown", e => { if (e.key === "Enter") { pk.sdId = ""; runSearch(false); } });
$("#qGo").onclick = () => { pk.sdId = ""; runSearch(false); };

// Источники в интернете: SubDL (основной, открывается без VPN) и OpenSubtitles (по желанию)
const SOURCES = {
  sd: { name: "SubDL", has: () => CFG.hasSubdlKey, search: q => api.sdSearch(q) },
  os: { name: "OpenSubtitles", has: () => !!CFG.osApiKey, search: q => api.osSearch(q) }
};
const srcState = id => (pk.src[id] = pk.src[id] || { status: "idle", list: [], err: "", code: "" });

async function runSearch(initial) {
  const f = film; if (!f) return;
  if (initial && CFG.osApiKey) { // распознавание названия через OpenSubtitles, если он доступен
    const g = await api.osGuess(f.name).catch(() => null);
    if (g && !pk.qTouched && film === f) {
      if (g.title) $("#qTitle").value = g.title;
      if (g.year) $("#qYear").value = g.year;
      if (g.season) $("#qSeason").value = g.season;
      if (g.episode) $("#qEp").value = g.episode;
    }
  }
  const q = { query: $("#qTitle").value.trim(), year: $("#qYear").value, season: $("#qSeason").value, episode: $("#qEp").value, languages: pk.langs };
  await Promise.all(Object.entries(SOURCES).map(async ([id, src]) => {
    const st = srcState(id);
    if (!src.has()) { st.status = "nokey"; renderPicker(); return; }
    st.status = "loading"; st.err = ""; renderPicker();
    try {
      const extra = id === "os" ? { moviehash: pk.qTouched ? null : await f.hashP } : { fileName: pk.qTouched ? "" : f.name, sdId: pk.sdId || "" };
      const res = await src.search({ ...q, ...extra });
      if (film !== f) return;
      st.list = Array.isArray(res) ? res : (res.list || []);
      st.films = Array.isArray(res) ? [] : (res.films || []);
      st.log = Array.isArray(res) ? [] : (res.log || []);
      st.status = "done"; autoPick();
    } catch (e) {
      if (film !== f) return;
      st.status = "error"; st.err = e.message; st.code = e.code || "";
    }
    renderPicker();
  }));
}

const candLang = c => (c.kind === "emb" || c.kind === "net") ? norm(c.lang) : langFromName(c.name || "");
function allCands() {
  const out = [];
  pk.emb.forEach(s => out.push({ key: "emb:" + s.n, kind: "emb", lang: s.lang, name: s.title || "", codec: s.codec, text: s.text, forced: s.forced, n: s.n }));
  pk.side.forEach(s => out.push({ key: "side:" + s.path, kind: "side", name: s.name, path: s.path, lang: langFromName(s.name) }));
  pk.own.forEach(s => out.push({ key: "own:" + s.name, kind: "own", name: s.name, lang: langFromName(s.name) }));
  for (const id of Object.keys(SOURCES)) (pk.src[id]?.list || []).forEach(s => out.push({ ...s, key: id + ":" + s.fileId, kind: "net", src: id }));
  return out;
}
function autoPick() {
  const cands = allCands().filter(c => c.kind !== "emb" || c.text);
  [0, 1].forEach(slot => {
    if (pk.touched[slot] || pk.chosen[slot]) return;
    const want = pk.langs[slot]; if (!want) return;
    const other = pk.chosen[1 - slot];
    const m = cands.filter(c => candLang(c) === want && c.key !== other && !c.forced);
    const best = m.find(c => c.kind === "emb") || m.find(c => c.kind === "side") ||
      m.filter(c => c.kind === "net").sort((a, b) => (b.hashMatch - a.hashMatch) || (a.machine - b.machine) || (a.hi - b.hi) || (b.downloads - a.downloads) || ((a.order ?? 0) - (b.order ?? 0)))[0];
    if (best) pk.chosen[slot] = best.key;
  });
}

function rowHTML(c) {
  const lg = candLang(c) || "—";
  const st = pk.rowStatus[c.key] || "";
  let title = "", meta = [];
  if (c.kind === "emb") {
    title = c.name || `Дорожка ${c.n + 1}`;
    meta.push(`<span>${esc(c.codec)}</span>`);
    if (c.forced) meta.push(`<span class="badge">только надписи</span>`);
    if (!c.text) meta.push(`<span class="badge warn">картинками — не поддерживается</span>`);
  } else if (c.kind === "side" || c.kind === "own") {
    title = c.name; meta.push(`<span>${c.kind === "side" ? "рядом с фильмом" : "ваш файл"}</span>`);
  } else {
    title = c.release || c.fileName;
    if (c.hashMatch) meta.push(`<span class="badge good">точно под этот файл</span>`);
    if (c.trusted) meta.push(`<span class="badge good">проверенный автор</span>`);
    if (c.machine) meta.push(`<span class="badge warn">машинный перевод</span>`);
    if (c.hi) meta.push(`<span class="badge">для слабослышащих</span>`);
    if (c.fullSeason) meta.push(`<span class="badge">весь сезон</span>`);
    if (c.downloads) meta.push(`<span>↓ ${c.downloads.toLocaleString("ru-RU")}</span>`);
    if (c.fps) meta.push(`<span>${c.fps} fps</span>`);
    if (c.uploader) meta.push(`<span>${esc(c.uploader)}</span>`);
    if (c.title) meta.push(`<span>${esc(c.title)}${c.year ? " (" + c.year + ")" : ""}</span>`);
  }
  const usable = c.kind !== "emb" || c.text;
  const btn = slot => `<button data-slot="${slot}" data-key="${esc(c.key)}" aria-pressed="${pk.chosen[slot] === c.key}" ${usable ? "" : "disabled"}><span class="dot" style="background:${S.t[slot].color}"></span>Ряд ${slot + 1}</button>`;
  const chosen = pk.chosen.includes(c.key);
  return `<div class="row${chosen ? " chosen" : ""}"><span class="lg">${esc(lg)}</span><div class="nm"><b title="${esc(title)}">${esc(title)}</b><div class="meta">${meta.join("")}</div></div><div class="pick2">${st ? `<span class="st">${esc(st)}</span>` : ""}${btn(0)}${btn(1)}</div></div>`;
}
function keyBox(id, msg) {
  if (id === "sd") return `<div class="note-box">${msg}
    <div class="q" style="margin-top:8px">
      <input type="password" class="fldi" id="pkSdKey" placeholder="${CFG.hasSubdlKey ? "ключ сохранён" : "API-ключ SubDL"}" style="flex:1 1 260px">
      <button class="btn sm primary" id="pkSaveSd">Сохранить и искать</button>
    </div>
    <div class="hint" style="margin-top:6px">Ключ бесплатный: войдите на <a href="#" data-url="https://subdl.com/panel/api">subdl.com → Panel → API</a> (можно через Google) и скопируйте ключ. Лимит — сотни скачиваний в сутки.</div></div>`;
  return `<div class="note-box">${msg}
    <div class="q" style="margin-top:8px">
      <input type="text" class="fldi" id="pkKey" placeholder="API-ключ" value="${esc(CFG.osApiKey)}" style="flex:1 1 220px">
      <input type="text" class="fldi" id="pkUser" placeholder="Логин" value="${esc(CFG.osUsername)}" style="width:140px">
      <input type="password" class="fldi" id="pkPass" placeholder="${CFG.osHasPassword ? "пароль сохранён" : "Пароль"}" style="width:140px">
      <button class="btn sm primary" id="pkSaveAcc">Сохранить и искать</button>
    </div>
    <div class="hint" style="margin-top:6px">Необязательно. Если сайт opensubtitles.com у вас открывается: профиль → API consumers → создать ключ.</div></div>`;
}
function renderPicker() {
  if (!pk || $("#picker").hidden) return;
  $("#langs").innerHTML = `<span class="lbl">Языки субтитров:</span>` + LANGS.map(([c, l, n]) => `<button class="lang" data-lang="${c}" aria-pressed="${pk.langs.includes(c)}" title="${n}">${l}${pk.langs.indexOf(c) === 0 ? " · 1" : pk.langs.indexOf(c) === 1 ? " · 2" : ""}</button>`).join("");
  const cands = allCands();
  const group = (title, items, extra = "", spin = false) => `<div class="grp"><h4>${spin ? '<span class="spin"></span>' : ""}${title}</h4>${items}${extra}</div>`;
  let html = "";
  if (pk.audio.length > 1) {
    html += group("Озвучка в файле", `<div class="aud">${pk.audio.map(a => `<button data-audio="${a.n}" aria-pressed="${pk.audioN === a.n}"><b>${esc((norm(a.lang) || "?").toUpperCase())}</b> ${esc(a.title || "")} <span>· ${esc(a.codec)} ${a.channels}ch</span></button>`).join("")}</div>`);
  }
  const emb = cands.filter(c => c.kind === "emb");
  if (pk.embStatus === "loading") html += group("Встроенные в файл", `<div class="hint">Читаю дорожки файла…</div>`, "", true);
  else if (emb.length) html += group("Встроенные в файл", emb.map(rowHTML).join(""));
  const side = cands.filter(c => c.kind === "side" || c.kind === "own");
  if (side.length) html += group("Файлы на диске", side.map(rowHTML).join(""));
  // интернет-источники
  const anyKey = Object.values(SOURCES).some(s => s.has());
  for (const [id, src] of Object.entries(SOURCES)) {
    const st = srcState(id);
    if (st.status === "nokey") {
      if (id === "sd") html += group(src.name, keyBox("sd", "<b>Подключите SubDL,</b> чтобы плеер сам находил субтитры по названию фильма."));
      else if (!anyKey || pk.showOs) html += group(src.name, keyBox("os", "Второй источник, по желанию."));
      continue;
    }
    if (st.status === "loading") { html += group(src.name, `<div class="hint">Ищу…</div>`, "", true); continue; }
    if (st.status === "error") {
      html += group(src.name, st.code === "http_401" || st.code === "http_403" ? keyBox(id, `<span class="err">Ключ не подошёл: ${esc(st.err)}</span>`) : `<div class="err">${esc(st.err)}</div><button class="btn sm" data-retry="1" style="margin-top:6px">Повторить поиск</button>`);
      continue;
    }
    if (st.status !== "done") continue;
    const list = cands.filter(c => c.kind === "net" && c.src === id);
    if ((st.films || []).length > 1 || pk.sdId) {
      html += group(`${src.name} · какой это фильм?`, `<div class="aud">${(st.films || []).map(fm => `<button data-film="${esc(fm.sdId)}" aria-pressed="${String(pk.sdId) === String(fm.sdId)}"><b>${esc(fm.name)}</b> ${fm.year ? "· " + esc(fm.year) : ""}${fm.type === "tv" ? " · сериал" : ""}</button>`).join("")}${pk.sdId ? `<button data-film="">Все варианты</button>` : ""}</div>`);
    }
    if (!list.length) { html += group(src.name, `<div class="hint">Ничего не нашлось на выбранных языках${st.log?.length ? " (искал — " + esc(st.log.join("; ")) + ")" : ""}. Напишите название по-английски, как в оригинале, уберите год и нажмите «Искать», либо добавьте языки.</div>`); continue; }
    const byLang = {};
    list.forEach(c => { const l = norm(c.lang) || "?"; (byLang[l] = byLang[l] || []).push(c); });
    const order = [...pk.langs, ...Object.keys(byLang).filter(l => !pk.langs.includes(l))];
    html += order.filter(l => byLang[l]).map(l => {
      const name = (LANGS.find(x => x[0] === l) || [l, l.toUpperCase(), l])[2];
      const items = byLang[l], ek = id + ":" + l, open = pk.expanded?.[ek];
      const more = items.length > 6 ? `<button class="btn sm" data-more="${ek}" style="margin-top:4px">${open ? "Свернуть" : `Ещё ${items.length - 6}`}</button>` : "";
      return group(`${src.name} · ${esc(name)} · ${items.length}`, (open ? items : items.slice(0, 6)).map(rowHTML).join(""), more);
    }).join("");
  }
  if (anyKey && !CFG.osApiKey && !pk.showOs) html += `<button class="btn sm" id="pkShowOs" style="margin-top:12px">Добавить OpenSubtitles как второй источник</button>`;
  html += `<div class="note-box">Нет второго языка? Выберите только ряд 1, а перевод для ряда 2 сделайте в «Настройки → Перевести ряд 1 → 2».</div>`;
  $("#pkBody").innerHTML = html;
  const label = k => { if (!k) return "не выбран"; const c = cands.find(x => x.key === k) || (tracks.find(t => t.key === k) ? { name: tracks.find(t => t.key === k).name } : null); if (!c) return "выбран"; return `${(candLang(c) || "").toUpperCase()} ${c.release || c.name || c.fileName || ""}`.trim(); };
  $("#pkSum").innerHTML = [0, 1].map(i => `<span><span class="dot" style="background:${S.t[i].color}"></span>Ряд ${i + 1}: ${esc(label(pk.chosen[i]))}</span>`).join("");
  $("#pkOk").disabled = pk.busy;
  $("#pkOk").textContent = pk.busy ? "Загружаю…" : (film?.pickedOnce ? "Применить" : "Смотреть");
}
$("#pkBody").addEventListener("click", async e => {
  const a = e.target.closest("[data-url]"); if (a) { e.preventDefault(); api.openUrl(a.dataset.url); return; }
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.slot) {
    const s = +b.dataset.slot, k = b.dataset.key;
    pk.touched[s] = true;
    pk.chosen[s] = pk.chosen[s] === k ? null : k;
    if (pk.chosen[1 - s] === k) pk.chosen[1 - s] = null;
    renderPicker();
  } else if (b.dataset.audio) { pk.audioN = +b.dataset.audio; renderPicker(); }
  else if (b.dataset.more) { pk.expanded = pk.expanded || {}; pk.expanded[b.dataset.more] = !pk.expanded[b.dataset.more]; renderPicker(); }
  else if (b.dataset.retry) runSearch(false);
  else if (b.dataset.film !== undefined) { pk.sdId = b.dataset.film; pk.touched = [false, false]; pk.chosen = [pk.chosen[0]?.startsWith("sd:") ? null : pk.chosen[0], pk.chosen[1]?.startsWith("sd:") ? null : pk.chosen[1]]; runSearch(false); }
  else if (b.id === "pkShowOs") { pk.showOs = true; renderPicker(); }
  else if (b.id === "pkSaveSd") {
    const k = $("#pkSdKey").value.trim(); if (!k) return;
    CFG = await api.setCfg({ subdlKey: k }); runSearch(false); renderLook();
  }
  else if (b.id === "pkSaveAcc") {
    const patch = { osApiKey: $("#pkKey").value.trim(), osUsername: $("#pkUser").value.trim() };
    if ($("#pkPass").value) patch.osPassword = $("#pkPass").value;
    CFG = await api.setCfg(patch); runSearch(true); renderLook();
  }
});
$("#langs").addEventListener("click", async e => {
  const b = e.target.closest("[data-lang]"); if (!b) return;
  const l = b.dataset.lang;
  pk.langs = pk.langs.includes(l) ? pk.langs.filter(x => x !== l) : [...pk.langs, l];
  CFG = await api.setCfg({ subLangs: pk.langs });
  pk.touched = [!!pk.chosen[0], !!pk.chosen[1]];
  runSearch(false); autoPick(); renderPicker();
});
$("#pkOwn").onclick = async () => {
  const r = await api.pickSub().catch(e => toast(e.message)); if (!r) return;
  const slot = !pk.chosen[0] ? 0 : !pk.chosen[1] ? 1 : 0;
  addOwnFile(r.name, r.data, slot, true);
};
function addOwnFile(name, data, slot, inPicker) {
  const text = Subs.decode(data);
  ownData.set("own:" + name, text);
  if (pk && !pk.own.some(o => o.name === name)) pk.own.push({ name });
  if (inPicker || !$("#picker").hidden) { pk.chosen[slot] = "own:" + name; pk.touched[slot] = true; renderPicker(); }
  else setTrack(slot, "own:" + name, name, Subs.parse(text, name));
}
const ownData = new Map();

// Кэш скачанных субтитров, чтобы не тратить лимит OpenSubtitles повторно
function cacheGet(id) { const c = store.get("dr.oscache", {}); return c[id]?.text || null; }
function cachePut(id, text) {
  const c = store.get("dr.oscache", {}); c[id] = { text, at: Date.now() };
  const keys = Object.keys(c).sort((a, b) => c[b].at - c[a].at); keys.slice(25).forEach(k => delete c[k]);
  store.set("dr.oscache", c);
}
async function loadCandidate(key) {
  const c = allCands().find(x => x.key === key);
  if (!c) { const t = tracks.find(t => t.key === key); if (t) return { name: t.name, cues: t.cues }; throw new Error("Субтитры не найдены"); }
  if (c.kind === "emb") {
    pk.rowStatus[key] = "извлекаю…"; renderPicker();
    const r = await api.extractSub(film.path, c.n, c.codec);
    return { lang: candLang(c), name: `${(candLang(c) || "").toUpperCase()} · из файла${c.name ? " · " + c.name : ""}`, cues: Subs.parse(r.text, "x." + r.format) };
  }
  if (c.kind === "side") { const r = await api.readFile(c.path); const t = Subs.decode(r.data); return { lang: candLang(c), name: c.name, cues: Subs.parse(t, c.name) }; }
  if (c.kind === "own") { const t = ownData.get(key); return { lang: candLang(c), name: c.name, cues: Subs.parse(t, c.name) }; }
  // интернет: SubDL или OpenSubtitles (скачанное кэшируется, чтобы не тратить лимит)
  let text = cacheGet(key);
  if (!text) {
    pk.rowStatus[key] = "скачиваю…"; renderPicker();
    const r = c.src === "sd" ? await api.sdDownload(c.fileId, { episode: $("#qEp").value }) : await api.osDownload(c.fileId);
    text = Subs.decode(r.data);
    if (r.fileName) c.fileName = r.fileName;
    cachePut(key, text);
    if (typeof r.remaining === "number") toast(`OpenSubtitles: осталось скачиваний сегодня — ${r.remaining}`);
  }
  return { lang: candLang(c), name: `${(candLang(c) || "").toUpperCase()} · ${c.release || c.fileName}`, cues: Subs.parse(text, /\.(ass|ssa)$/i.test(c.fileName || "") ? c.fileName : "x.srt") };
}
function setTrack(slot, key, name, cues, lang = "") {
  tracks[slot] = { key, name, cues, lang };
  syncState[slot] = "";
  S.t[slot].delay = 0; save();
  shown = [null, null]; renderTranscript(); renderLook(); tick(true);
}
$("#pkOk").onclick = async () => {
  if (!film || pk.busy) return;
  pk.busy = true; renderPicker();
  let failed = false;
  const prevKeys = [tracks[0].key, tracks[1].key];
  for (const slot of [0, 1]) {
    const key = pk.chosen[slot];
    if (key === tracks[slot].key) continue;
    if (!key) { setTrack(slot, null, "", []); continue; }
    try {
      const r = await loadCandidate(key);
      if (!r.cues.length) throw new Error("в файле нет реплик");
      setTrack(slot, key, r.name, r.cues, r.lang);
      pk.rowStatus[key] = "";
    } catch (e) {
      failed = true;
      pk.rowStatus[key] = "ошибка";
      if (e.code === "no_login") { srcState("os").status = "nokey"; pk.showOs = true; toast("Для скачивания с OpenSubtitles нужен логин и пароль"); }
      else toast(`Ряд ${slot + 1}: ${e.message}`);
    }
  }
  pk.busy = false;
  if (failed) { renderPicker(); return; }
  // озвучка
  const first = !film.pickedOnce;
  if (film.info && pk.audioN !== audioN) {
    const t = media.t, playing = !video.paused;
    audioN = pk.audioN; startPlayback(t, playing || first);
  } else if (first && film.info) { wantPlay = true; media.play(); }
  film.pickedOnce = true;
  // скачанные и внешние субтитры сразу подгоняем под голоса (встроенные обычно и так точные)
  for (const slot of [1, 0]) {
    const k = tracks[slot].key;
    if (k && k !== prevKeys[slot] && !k.startsWith("emb:") && !k.startsWith("ai:")) autoSync(slot, true);
  }
  closePicker();
};

/* ---------- подгонка субтитров под голоса ---------- */
const syncState = ["", ""];
const FPS_NAMES = [[25 / 23.976, "23.976 → 25 кадр/с"], [23.976 / 25, "25 → 23.976 кадр/с"], [24 / 23.976, "23.976 → 24 кадр/с"], [23.976 / 24, "24 → 23.976 кадр/с"], [25 / 24, "24 → 25 кадр/с"], [24 / 25, "25 → 24 кадр/с"]];
function describeSync(r) {
  const sh = `сдвиг ${r.offset >= 0 ? "+" : "−"}${Math.abs(r.offset).toFixed(1)} с`;
  const f = FPS_NAMES.find(([v]) => Math.abs(v - r.scale) < 1e-6);
  return f ? `${sh}, скорость ${f[1]}` : sh;
}
const plain = cs => cs.map(c => ({ s: c.s, e: c.e }));
function applySync(slot, r, silent) {
  const tr = tracks[slot];
  tr.orig = tr.orig || tr.cues.map(c => ({ ...c }));
  tr.cues = tr.orig.map((c, i) => ({ ...c, s: c.s * r.scale, e: c.e * r.scale, id: i }));
  tr.sync = r; S.t[slot].delay = r.offset; save();
  syncState[slot] = "Подогнано: " + describeSync(r);
  shown = [null, null]; renderTranscript(); renderLook(); tick(true);
  if (!silent) toast(`Ряд ${slot + 1}: ${describeSync(r)}`);
}
function resetSync(slot) {
  const tr = tracks[slot]; if (!tr.orig) return;
  tr.cues = tr.orig.map((c, i) => ({ ...c, id: i })); tr.orig = null; tr.sync = null;
  S.t[slot].delay = 0; save(); syncState[slot] = "";
  shown = [null, null]; renderTranscript(); renderLook(); tick(true);
}
// Встроенные в файл субтитры считаем точными: второй ряд подгоняем к ним, иначе — к звуку
async function autoSync(slot, quiet) {
  const tr = tracks[slot]; if (!tr.cues.length || !film?.info) return;
  const src = tr.orig || tr.cues;
  const other = tracks[1 - slot];
  const ref = other.cues.length && other.key?.startsWith("emb:") ? other.cues.map(c => ({ s: c.s + S.t[1 - slot].delay, e: c.e + S.t[1 - slot].delay })) : null;
  syncState[slot] = ref ? "Подгоняю к ряду " + (2 - slot) + "…" : "Слушаю звук фильма и подгоняю… (первый раз до минуты)"; renderLook();
  try {
    const r = ref ? await api.syncCues(ref, plain(src)) : (film.info.audio.length ? await api.syncAudio(film.path, audioN, plain(src)) : null);
    if (tracks[slot] !== tr) return;
    if (!r) { syncState[slot] = "В файле нет звука — подгонка недоступна"; renderLook(); return; }
    if (r.confidence < 4) {
      syncState[slot] = `Не получилось уверенно подогнать (оценка ${r.confidence}). Нажмите «По реплике».`;
      if (!quiet) toast(syncState[slot]); renderLook(); return;
    }
    if (Math.abs(r.offset) < 0.25 && r.scale === 1) { syncState[slot] = "Уже совпадают со звуком"; if (!quiet) toast(`Ряд ${slot + 1}: уже совпадает`); renderLook(); return; }
    applySync(slot, r);
  } catch (e) { syncState[slot] = "Ошибка подгонки: " + e.message; renderLook(); }
}
// Ручная подгонка: пользователь показывает, какая реплика звучит прямо сейчас
function pickLineNow(slot) {
  const tr = tracks[slot]; if (!tr.cues.length || !film) return;
  const wasPlaying = !video.paused; media.pause();
  const now = media.t, x = now - S.t[slot].delay;
  let near = tr.cues.filter(c => Math.abs(c.s - x) < 60);
  near.sort((a, b) => Math.abs(a.s - x) - Math.abs(b.s - x)); near = near.slice(0, 12).sort((a, b) => a.s - b.s);
  if (!near.length) near = tr.cues.slice(0, 12);
  document.querySelector(".linepick")?.remove();
  const el = document.createElement("div"); el.className = "pop linepick";
  el.style.left = "50%"; el.style.top = "12px"; el.style.transform = "translateX(-50%)"; el.style.width = "min(560px, calc(100% - 20px))";
  el.innerHTML = `<button class="x" aria-label="Закрыть">×</button><div class="head"><span class="word" style="font-size:15px">Какую фразу ряда ${slot + 1} сейчас произнесли?</span></div>
    <div class="hint" style="margin:4px 0 8px">Нажмите на неё — ряд сдвинется так, чтобы она начиналась в ${fmt(now)}.</div>
    <div class="tl" style="max-height:320px;overflow:auto">${near.map(c => `<div class="cue" data-s="${c.s}"><span class="tc">${fmt(c.s + S.t[slot].delay)}</span><div class="a" style="color:var(--fg)">${esc(c.text)}</div></div>`).join("")}</div>`;
  player.append(el);
  const close = () => { el.remove(); if (wasPlaying) media.play(); };
  el.querySelector(".x").onclick = close;
  el.addEventListener("click", e => {
    const r = e.target.closest(".cue"); if (!r) return;
    S.t[slot].delay = Math.round((now - parseFloat(r.dataset.s)) * 100) / 100; save();
    syncState[slot] = `Подогнано по реплике: сдвиг ${S.t[slot].delay >= 0 ? "+" : "−"}${Math.abs(S.t[slot].delay).toFixed(1)} с`;
    shown = [null, null]; renderTranscript(); renderLook(); tick(true); toast(`Ряд ${slot + 1}: ${syncState[slot]}`); close();
  });
}

/* ---------- текст фильма ---------- */
const tl = $("#tl"); let tlRows = [], tlActive = -1;
function renderTranscript() {
  const p = primaryIdx(); tlRows = []; tlActive = -1;
  if (p < 0) { tl.innerHTML = `<div class="empty"><b>Субтитров пока нет.</b><br>${film ? "Нажмите «Сменить» внизу плеера или клавишу C." : "Откройте фильм — плеер предложит субтитры."}</div>`; return; }
  const q = 1 - p, sec = tracks[q].cues; let j = 0;
  tl.innerHTML = tracks[p].cues.map((c, idx) => {
    while (j < sec.length && sec[j].e + S.t[q].delay <= c.s + S.t[p].delay) j++;
    let b = ""; const cand = sec[j];
    if (cand && cand.s + S.t[q].delay < c.e + S.t[p].delay) b = cand.text;
    return `<div class="cue" data-i="${idx}"><span class="tc">${fmt(c.s + S.t[p].delay)}</span><div><div class="${p === 0 ? "a" : "b"}">${esc(c.text)}</div>${b ? `<div class="${p === 0 ? "b" : "a"}">${esc(b)}</div>` : ""}</div></div>`;
  }).join("");
  tlRows = [...tl.children];
}
tl.addEventListener("click", e => {
  const r = e.target.closest(".cue"); if (!r || !film) return; const p = primaryIdx();
  media.t = tracks[p].cues[+r.dataset.i].s + S.t[p].delay + 0.01; if (video.paused) { wantPlay = true; media.play(); }
});
function highlightTranscript() {
  const p = primaryIdx(); if (p < 0) return;
  const c = shown[p]; const idx = c ? c.id : -1;
  if (idx === tlActive) return;
  tlRows[tlActive]?.classList.remove("act"); tlActive = idx;
  const row = tlRows[idx]; if (!row) return; row.classList.add("act");
  const pane = $("#pText"); if (pane.hidden) return;
  pane.scrollTo({ top: row.offsetTop - pane.clientHeight / 2 + row.clientHeight / 2, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

/* ---------- вкладки ---------- */
document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => {
  document.querySelectorAll(".tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
  $("#pText").hidden = b.dataset.tab !== "text"; $("#pLook").hidden = b.dataset.tab !== "look"; $("#pDict").hidden = b.dataset.tab !== "dict";
});

/* ---------- перевод слова ---------- */
const player = $("#player");
const pop = { el: null, open: false, track: -1, resume: false, seq: 0 };
const hover = { paused: false };
function closePop() {
  if (!pop.open) return;
  pop.seq++; pop.el?.remove(); pop.open = false;
  subEl.forEach(el => el.querySelectorAll(".w.pick").forEach(w => w.classList.remove("pick")));
  if (pop.resume) media.play(); pop.resume = false;
}
function extLinks(q) {
  const L = encodeURIComponent(q);
  return `<a href="#" data-url="https://translate.yandex.ru/?text=${L}">Яндекс</a> · <a href="#" data-url="https://translate.google.com/?sl=auto&tl=ru&text=${L}">Google</a> · <a href="#" data-url="https://www.multitran.com/m.exe?s=${L}&l1=1&l2=2">Мультитран</a>`;
}
async function openPop(query, track, rect) {
  const wasPlaying = !video.paused;
  if (pop.open) { const r = pop.resume; pop.resume = false; closePop(); pop.resume = r; } else pop.resume = wasPlaying && S.popPause;
  if (S.popPause || hover.paused) media.pause();
  if (hover.paused) { pop.resume = true; hover.paused = false; }
  const cue = shown[track], other = shown[1 - track];
  const sentence = cue?.text || query;
  const el = document.createElement("div"); el.className = "pop"; el.setAttribute("role", "dialog");
  el.innerHTML = `<button class="x" aria-label="Закрыть">×</button><div class="head"><span class="word">${esc(query)}</span></div><div class="body"><div class="think"><span class="spin"></span>Перевожу…</div></div>`;
  player.append(el); pop.el = el; pop.open = true; pop.track = track;
  const seq = ++pop.seq;
  el.querySelector(".x").onclick = closePop;
  el.addEventListener("click", e => { const a = e.target.closest("[data-url]"); if (a) { e.preventDefault(); api.openUrl(a.dataset.url); } });
  const pr = player.getBoundingClientRect(); const w = el.offsetWidth;
  let x = rect.left - pr.left + rect.width / 2 - w / 2; x = Math.max(10, Math.min(x, pr.width - w - 10));
  el.style.left = x + "px";
  const place = () => { let y = rect.top - pr.top - el.offsetHeight - 10; if (y < 8) y = rect.bottom - pr.top + 10; el.style.top = Math.max(8, y) + "px"; };
  place();
  const body = el.querySelector(".body");
  const entry = { word: query, tr: "", ctx: sentence, t: media.t, film: film?.name || "" };
  try {
    const r = await api.trWord({ text: query, sentence, parallel: other?.text || "", target: S.lang, srcLang: tracks[track].lang || "" });
    if (seq !== pop.seq) return;
    entry.tr = r.tr;
    const alts = (r.alts || []).filter(Boolean).slice(0, 4);
    el.querySelector(".head").innerHTML = `<span class="word">${esc(query)}</span>${r.ipa ? `<span class="ipa">[${esc(String(r.ipa).replace(/^[\/\[]|[\/\]]$/g, ""))}]</span>` : ""}${r.pos ? `<span class="pos">${esc(r.pos)}</span>` : ""}`;
    body.innerHTML = `<div class="tr">${esc(r.tr)}</div>${alts.length ? `<div class="alts">${alts.map(esc).join(", ")}</div>` : ""}${r.lemma && r.lemma.toLowerCase() !== query.toLowerCase() ? `<div class="alts">начальная форма: <b>${esc(r.lemma)}</b></div>` : ""}${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}<div class="row"><button class="btn sm primary" data-add>В словарь</button><span class="hint">${extLinks(query)}${r.via ? " · перевод: " + esc(r.via) : ""}</span></div>`;
    body.querySelector("[data-add]").onclick = e => { addWord(entry); e.target.textContent = "Добавлено ✓"; e.target.disabled = true; };
    place();
  } catch (e) {
    if (seq !== pop.seq) return;
    body.innerHTML = `<div class="hint" style="color:var(--warn)">Не получилось перевести: ${esc(e.message)}</div><div class="hint" style="margin-top:6px">${extLinks(query)}</div>`;
    place();
  }
}
stage.addEventListener("mouseup", e => {
  const sub = e.target.closest(".sub"); if (!sub) return;
  const sel = window.getSelection(); const txt = sel && String(sel).trim();
  if (txt && txt.length > 1 && sub.contains(sel.anchorNode)) {
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    sub.querySelectorAll(".w").forEach(w => { if (sel.containsNode(w, true)) w.classList.add("pick"); });
    sel.removeAllRanges();
    openPop(txt.replace(/\s+/g, " ").slice(0, 160), +sub.dataset.track, rect); return;
  }
  const w = e.target.closest(".w"); if (!w) return;
  sub.querySelectorAll(".w.pick").forEach(x => x.classList.remove("pick"));
  w.classList.add("pick");
  openPop(w.textContent, +sub.dataset.track, w.getBoundingClientRect());
});
document.addEventListener("mousedown", e => { if (pop.open && !e.target.closest(".pop") && !e.target.closest(".sub")) closePop(); });
subEl.forEach(el => {
  el.addEventListener("mouseenter", () => { if (S.hoverPause && !video.paused) { hover.paused = true; media.pause(); } });
  el.addEventListener("mouseleave", () => { if (hover.paused && !pop.open) { hover.paused = false; media.play(); } });
});

/* ---------- словарь ---------- */
let dict = store.get("dr.dict", []);
function addWord(en) { if (!dict.some(d => d.word.toLowerCase() === en.word.toLowerCase() && d.ctx === en.ctx)) { dict.unshift({ ...en, at: Date.now() }); store.set("dr.dict", dict); renderDict(); } toast("Добавлено в словарь"); }
function renderDict() {
  $("#dictN").textContent = dict.length;
  const box = $("#dict");
  if (!dict.length) { box.innerHTML = `<div class="empty"><b>Словарь пуст.</b><br>Нажмите на слово в субтитрах, затем «В словарь».</div>`; return; }
  box.innerHTML = dict.map((d, i) => `<div class="de"><span class="w1">${esc(d.word)}</span><button aria-label="Удалить" data-del="${i}">×</button><span class="w2">${esc(d.tr || "—")}</span><span class="cx">${esc(d.ctx || "")}</span><button class="jump" data-jump="${i}">${esc(d.film || "")} · ${fmt(d.t)}</button></div>`).join("");
}
$("#dict").addEventListener("click", e => {
  const del = e.target.closest("[data-del]"); if (del) { dict.splice(+del.dataset.del, 1); store.set("dr.dict", dict); renderDict(); return; }
  const j = e.target.closest("[data-jump]"); if (j && film && dict[+j.dataset.jump].film === film.name) media.t = dict[+j.dataset.jump].t - 0.5;
});
const csv = () => "word;translation;context;film;time\n" + dict.map(d => [d.word, d.tr, d.ctx, d.film, fmt(d.t)].map(v => `"${String(v || "").replace(/"/g, '""').replace(/\n/g, " ")}"`).join(";")).join("\n");
$("#bExport").onclick = async () => { if (!dict.length) return toast("Словарь пуст"); try { const p = await api.saveText("slovar.csv", "﻿" + csv()); if (p) toast("Сохранено: " + p); } catch (e) { toast(e.message); } };
$("#bCopy").onclick = async () => { const t = dict.map(d => `${d.word} — ${d.tr}`).join("\n"); try { await navigator.clipboard.writeText(t); toast("Скопировано"); } catch { toast("Буфер обмена недоступен"); } };

/* ---------- панель настроек ---------- */
const COLORS = ["#ffffff", "#f2b233", "#ffe766", "#8fe3c6", "#8cc8ff", "#ff9eb5"];
let aiJob = null;
function trackSec(i) {
  const c = S.t[i], tr = tracks[i];
  const f = (label, inner, val = "") => `<label class="fld"><span>${label}</span>${inner}<span class="v">${val}</span></label>`;
  return `<div class="sec">
    <h3><span class="dot" style="background:${c.color}"></span>Ряд ${i + 1}</h3>
    <div class="file">${tr.cues.length ? `${esc(tr.name)} · ${tr.cues.length} реплик` : "Субтитры не выбраны"}</div>
    <label class="chk"><input type="checkbox" id="on${i}" ${c.on ? "checked" : ""}> Показывать</label>
    ${f("Размер", `<input type="range" id="size${i}" min="2.5" max="9" step="0.1" value="${c.size}">`, c.size.toFixed(1))}
    <div class="fld"><span>Цвет</span><div class="sw">${COLORS.map(x => `<button style="background:${x}" data-col="${i}" data-v="${x}" aria-pressed="${x === c.color}" aria-label="Цвет ${x}"></button>`).join("")}<input type="color" id="col${i}" value="${c.color}" aria-label="Свой цвет"></div><span></span></div>
    <div class="fld"><span>Шрифт</span><select class="sel" id="font${i}"><option value="ui"${c.font === "ui" ? " selected" : ""}>Гротеск</option><option value="serif"${c.font === "serif" ? " selected" : ""}>С засечками</option><option value="mono"${c.font === "mono" ? " selected" : ""}>Моноширинный</option></select><label class="chk"><input type="checkbox" id="bold${i}" ${c.bold ? "checked" : ""}>Жирный</label></div>
    <div class="fld"><span>Фон</span><div class="seg">${[["none", "Нет"], ["shadow", "Тень"], ["box", "Плашка"]].map(([v, l]) => `<button data-bg="${i}" data-v="${v}" aria-pressed="${c.bg === v}">${l}</button>`).join("")}</div><span></span></div>
    ${c.bg === "box" ? f("Плотность", `<input type="range" id="op${i}" min="0.1" max="1" step="0.05" value="${c.bgOp}">`, Math.round(c.bgOp * 100) + "%") : ""}
    <div class="fld"><span>Положение</span><div class="seg">${[["bottom", "Снизу"], ["top", "Сверху"]].map(([v, l]) => `<button data-edge="${i}" data-v="${v}" aria-pressed="${c.edge === v}">${l}</button>`).join("")}</div><span></span></div>
    ${f("Отступ", `<input type="range" id="off${i}" min="0" max="45" step="0.5" value="${c.offset}">`, c.offset + "%")}
    <div class="fld"><span>Сдвиг</span><div class="nudge"><button data-nd="${i}" data-v="-0.5">−½</button><button data-nd="${i}" data-v="-0.1">−</button><button data-nd="${i}" data-v="0.1">+</button><button data-nd="${i}" data-v="0.5">+½</button><button data-nd="${i}" data-v="0" title="Сбросить">0</button></div><span class="v">${(c.delay > 0 ? "+" : "") + c.delay.toFixed(1)} с</span></div>
    ${tr.cues.length ? `<div class="fld"><span>Подгонка</span><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm" data-sync="${i}" title="Сравнить реплики с речью в фильме">Под голоса</button><button class="btn sm" data-lineat="${i}" title="Показать, какая фраза звучит сейчас">По реплике</button>${tr.orig || c.delay ? `<button class="btn sm" data-unsync="${i}">Сбросить</button>` : ""}</div><span></span></div>` : ""}
    ${syncState[i] ? `<div class="hint">${esc(syncState[i])}</div>` : ""}
  </div>`;
}
function renderLook() {
  const p = $("#pLook"); const sc = p.scrollTop;
  const canAI = tracks.some(t => t.cues.length);
  p.innerHTML = trackSec(0) + trackSec(1) + `
  <div class="sec">
    <h3>Порядок и поведение</h3>
    <button class="btn sm" id="swap">Поменять ряды местами у края</button>
    <label class="chk"><input type="checkbox" id="hp" ${S.hoverPause ? "checked" : ""}> Пауза, когда курсор над субтитрами</label>
    <label class="chk"><input type="checkbox" id="pp" ${S.popPause ? "checked" : ""}> Пауза на время перевода слова</label>
    <div class="fld"><span>Переводить на</span><select class="sel" id="lang">${["русский", "украинский", "английский", "немецкий", "испанский"].map(l => `<option${l === S.lang ? " selected" : ""}>${l}</option>`).join("")}</select><span></span></div>
  </div>
  <div class="sec">
    <h3>Переводчик</h3>
    <div class="seg"><button data-trp="google" aria-pressed="${CFG.translator !== "claude"}">Бесплатно</button><button data-trp="claude" aria-pressed="${CFG.translator === "claude"}">Claude · с учётом фразы</button></div>
    ${CFG.translator === "claude" ? `<div class="q"><input type="password" class="fldi" id="clKey" placeholder="${CFG.hasClaudeKey ? "ключ сохранён" : "API-ключ Anthropic (sk-ant-…)"}" style="flex:1"><button class="btn sm" id="clSave">Сохранить</button></div><div class="hint">Ключ создаётся на <a href="#" data-url="https://console.anthropic.com/settings/keys">console.anthropic.com</a>, запросы оплачиваются там же. Без ключа работает Google.</div>` : `<div class="hint">Бесплатно: Google, а если он недоступен — MyMemory. Claude объясняет смысл слова именно в этой фразе: идиомы, сленг, грамматику.</div>`}
  </div>
  <div class="sec">
    <h3>SubDL · поиск субтитров</h3>
    <div class="q"><input type="password" class="fldi" id="sdKey" placeholder="${CFG.hasSubdlKey ? "ключ сохранён" : "API-ключ SubDL"}" style="flex:1"><button class="btn sm" id="sdSave">Сохранить</button></div>
    <div class="hint">Бесплатный ключ: <a href="#" data-url="https://subdl.com/panel/api">subdl.com → Panel → API</a>.</div>
  </div>
  <div class="sec">
    <h3>OpenSubtitles · по желанию</h3>
    <div class="q"><input type="text" class="fldi" id="osKey" placeholder="API-ключ" value="${esc(CFG.osApiKey)}" style="flex:1 1 100%"></div>
    <div class="q"><input type="text" class="fldi" id="osUser" placeholder="Логин" value="${esc(CFG.osUsername)}" style="flex:1"><input type="password" class="fldi" id="osPass" placeholder="${CFG.osHasPassword ? "пароль сохранён" : "Пароль"}" style="flex:1"></div>
    <div class="q"><button class="btn sm" id="osSave">Сохранить</button><button class="btn sm" id="osCheck">Проверить вход</button></div>
    <div class="hint">Ключ бесплатный: <a href="#" data-url="https://www.opensubtitles.com/ru/consumers">opensubtitles.com → API consumers</a>. Пароль хранится зашифрованным средствами Windows.</div>
  </div>
  <div class="sec">
    <h3>Перевести ряд 1 → 2</h3>
    <div class="hint">Если нужного языка нет, переводчик сделает второй ряд с теми же таймингами.</div>
    <div class="fld"><span>Язык</span><select class="sel" id="aiLang">${["русский", "английский", "украинский", "немецкий", "испанский", "французский"].map(l => `<option${l === S.lang ? " selected" : ""}>${l}</option>`).join("")}</select><span></span></div>
    <div class="toolbar" style="margin:0"><button class="btn sm primary" id="aiGo" ${canAI && !aiJob ? "" : "disabled"}>${aiJob ? "Перевожу…" : "Перевести"}</button>${aiJob ? `<button class="btn sm" id="aiStop">Стоп</button>` : ""}</div>
    ${aiJob ? `<div class="bar"><i id="aiBar" style="width:${aiJob.pct}%"></i></div><div class="hint" id="aiTxt">${aiJob.done} из ${aiJob.total}</div>` : ""}
  </div>
  <div class="sec">
    <h3>Клавиши</h3>
    <div class="keys"><kbd>Пробел</kbd><span>пуск / пауза</span><kbd>← →</kbd><span>±5 секунд</span><kbd>A / D</kbd><span>предыдущая / следующая фраза</span><kbd>S</kbd><span>повторить фразу</span><kbd>1 / 2</kbd><span>скрыть / показать ряд</span><kbd>C</kbd><span>сменить субтитры и озвучку</span><kbd>F</kbd><span>во весь экран</span></div>
  </div>
  <button class="btn sm" id="reset">Сбросить оформление</button>`;
  p.scrollTop = sc;
}
const pl = $("#pLook");
const upd = (fn, rerender = true) => { fn(); save(); applyStyles(); if (rerender) renderLook(); };
pl.addEventListener("input", e => {
  const m = e.target.id.match(/^(size|off|op|col)(\d)$/); if (!m) return;
  const i = +m[2], v = e.target.value, c = S.t[i];
  if (m[1] === "size") c.size = +v; if (m[1] === "off") c.offset = +v; if (m[1] === "op") c.bgOp = +v; if (m[1] === "col") c.color = v;
  save(); applyStyles();
  const out = e.target.closest(".fld")?.querySelector(".v");
  if (out) out.textContent = m[1] === "size" ? c.size.toFixed(1) : m[1] === "off" ? c.offset + "%" : m[1] === "op" ? Math.round(c.bgOp * 100) + "%" : "";
});
pl.addEventListener("change", e => {
  const id = e.target.id; let m;
  if ((m = id.match(/^on(\d)$/))) upd(() => S.t[+m[1]].on = e.target.checked);
  else if ((m = id.match(/^bold(\d)$/))) upd(() => S.t[+m[1]].bold = e.target.checked, false);
  else if ((m = id.match(/^font(\d)$/))) upd(() => S.t[+m[1]].font = e.target.value, false);
  else if ((m = id.match(/^col(\d)$/))) renderLook();
  else if (id === "hp") upd(() => S.hoverPause = e.target.checked, false);
  else if (id === "pp") upd(() => S.popPause = e.target.checked, false);
  else if (id === "lang") upd(() => S.lang = e.target.value, false);
});
pl.addEventListener("click", async e => {
  const a = e.target.closest("[data-url]"); if (a) { e.preventDefault(); api.openUrl(a.dataset.url); return; }
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.sync) autoSync(+b.dataset.sync, false);
  else if (b.dataset.lineat) pickLineNow(+b.dataset.lineat);
  else if (b.dataset.unsync) { if (tracks[+b.dataset.unsync].orig) resetSync(+b.dataset.unsync); else { S.t[+b.dataset.unsync].delay = 0; save(); syncState[+b.dataset.unsync] = ""; shown = [null, null]; renderTranscript(); renderLook(); tick(true); } }
  else if (b.dataset.col) upd(() => S.t[+b.dataset.col].color = b.dataset.v);
  else if (b.dataset.bg) upd(() => S.t[+b.dataset.bg].bg = b.dataset.v);
  else if (b.dataset.edge) upd(() => S.t[+b.dataset.edge].edge = b.dataset.v);
  else if (b.dataset.nd) { const i = +b.dataset.nd, v = +b.dataset.v; upd(() => S.t[i].delay = v === 0 ? 0 : Math.round((S.t[i].delay + v) * 10) / 10); shown = [null, null]; renderTranscript(); }
  else if (b.dataset.trp) { CFG = await api.setCfg({ translator: b.dataset.trp }); renderLook(); }
  else if (b.id === "clSave") { const k = $("#clKey").value.trim(); if (k) { CFG = await api.setCfg({ claudeKey: k }); toast("Ключ Claude сохранён"); renderLook(); } }
  else if (b.id === "sdSave") { const k = $("#sdKey").value.trim(); if (k) { CFG = await api.setCfg({ subdlKey: k }); toast("Ключ SubDL сохранён"); renderLook(); } }
  else if (b.id === "osSave" || b.id === "osCheck") {
    const patch = { osApiKey: $("#osKey").value.trim(), osUsername: $("#osUser").value.trim() };
    if ($("#osPass").value) patch.osPassword = $("#osPass").value;
    CFG = await api.setCfg(patch);
    if (b.id === "osCheck") { try { await api.osLogin(); toast("Вход в OpenSubtitles выполнен"); } catch (err) { toast("Не удалось войти: " + err.message); } }
    else toast("Сохранено");
    renderLook();
  }
  else if (b.id === "swap") upd(() => S.order.reverse());
  else if (b.id === "reset") upd(() => { const keep = { hoverPause: S.hoverPause, popPause: S.popPause, lang: S.lang, rate: S.rate, vol: S.vol }; S = Object.assign(structuredClone(DEFAULTS), keep); });
  else if (b.id === "aiGo") translateTrack();
  else if (b.id === "aiStop" && aiJob) aiJob.stop = true;
});

async function translateTrack() {
  const src = tracks[0].cues.length ? 0 : 1, dst = 1 - src;
  const cues = tracks[src].cues, lang = $("#aiLang").value;
  const b = pl.querySelector("#aiGo");
  if (tracks[dst].cues.length && !tracks[dst].ai && !b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = `Заменить ряд ${dst + 1}? Нажмите ещё раз`; return; }
  const out = cues.map(c => ({ s: c.s, e: c.e, text: "" }));
  const key = "ai:" + Date.now();
  tracks[dst] = { key, name: `Перевод (${lang})`, cues: out, ai: true }; S.t[dst].delay = S.t[src].delay;
  const B = CFG.translator === "claude" ? 40 : 60;
  aiJob = { done: 0, total: cues.length, pct: 0, stop: false }; renderLook();
  try {
    for (let k = 0; k < cues.length && !aiJob.stop; k += B) {
      const chunk = cues.slice(k, k + B);
      const context = cues.slice(Math.max(0, k - 3), k).map(c => c.text.replace(/\n/g, " "));
      const arr = await api.trLines({ lines: chunk.map(c => c.text.replace(/\n/g, " ")), target: lang, context });
      chunk.forEach((c, j) => { out[k + j].text = arr[j] || ""; });
      aiJob.done = Math.min(cues.length, k + B); aiJob.pct = Math.round(aiJob.done / cues.length * 100);
      const bar = $("#aiBar"), tx = $("#aiTxt"); if (bar) bar.style.width = aiJob.pct + "%"; if (tx) tx.textContent = `${aiJob.done} из ${aiJob.total}`;
      tracks[dst].cues = out.filter(c => c.text).map((c, i) => ({ ...c, id: i }));
      shown[dst] = null; renderTranscript();
    }
    toast(aiJob.stop ? "Перевод остановлен — готовая часть сохранена" : "Перевод ряда готов");
  } catch (e) { toast("Перевод прерван: " + e.message); }
  tracks[dst].cues = out.filter(c => c.text).map((c, i) => ({ ...c, id: i }));
  aiJob = null; shown = [null, null]; renderTranscript(); renderLook(); save(); applyStyles();
}

/* ---------- запуск ---------- */
(async () => {
  try { CFG = await api.getCfg(); } catch {}
  $("#welcomeHint").innerHTML = (CFG.hasSubdlKey || CFG.osApiKey) ? "" : `Чтобы субтитры находились сами, добавьте бесплатный ключ SubDL — плеер попросит его при открытии фильма.`;
  new ResizeObserver(applyStyles).observe(stage);
  applyStyles(); renderTranscript(); renderLook(); renderDict(); syncPlayIcon(); loop();
})();
})();
