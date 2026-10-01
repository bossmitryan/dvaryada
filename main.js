"use strict";
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu, Tray, net } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const media = require("./lib/media");
const { movieHash } = require("./lib/hash");
const server = require("./lib/server");
const { OpenSubs } = require("./lib/opensubs");
const { SubDL } = require("./lib/subdl");
const tr = require("./lib/translate");
const sync = require("./lib/sync");
const words = require("./lib/words");
const whisper = require("./lib/whisper");
const updater = require("./lib/update");
const library = require("./lib/library");
const { createRemote } = require("./lib/remote");

/* ---------- настройки (userData/settings.json, секреты шифруются средствами ОС) ---------- */
const SETTINGS_FILE = () => path.join(app.getPath("userData"), "settings.json");
const SECRET = ["osPassword", "claudeKey", "osToken", "subdlKey"];
let cfg = {};
function loadCfg() {
  try { cfg = JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8")); } catch { cfg = {}; }
  for (const k of SECRET) if (cfg[k + "_enc"]) {
    try { cfg[k] = safeStorage.decryptString(Buffer.from(cfg[k + "_enc"], "base64")); } catch { cfg[k] = ""; }
  }
  cfg.devices = cfg.devices || [];
  cfg.libraryFolders = cfg.libraryFolders || [];
}
function saveCfg() {
  const out = { ...cfg };
  for (const k of SECRET) {
    delete out[k];
    if (cfg[k] && safeStorage.isEncryptionAvailable()) out[k + "_enc"] = safeStorage.encryptString(cfg[k]).toString("base64");
    else if (cfg[k]) out[k] = cfg[k];
    else delete out[k + "_enc"];
  }
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(out, null, 2));
}
const publicCfg = () => ({
  osApiKey: cfg.osApiKey || "", osUsername: cfg.osUsername || "", osHasPassword: !!cfg.osPassword,
  subLangs: cfg.subLangs || ["en", "ru"], hasSubdlKey: !!cfg.subdlKey, translator: cfg.translator || "google", hasClaudeKey: !!cfg.claudeKey
});

const osub = new OpenSubs(
  () => ({ apiKey: cfg.osApiKey, username: cfg.osUsername, password: cfg.osPassword, token: cfg.osToken, baseUrl: cfg.osBaseUrl, tokenAt: cfg.osTokenAt }),
  p => { if ("token" in p) cfg.osToken = p.token; if ("baseUrl" in p) cfg.osBaseUrl = p.baseUrl; if ("tokenAt" in p) cfg.osTokenAt = p.tokenAt; saveCfg(); }
);
const subdl = new SubDL(() => cfg.subdlKey);

/* ---------- общие действия: их вызывает и окно ПК, и планшет ---------- */
let port = 0;
const H = {
  async openMedia(file) {
    const info = await media.probe(file);
    const id = server.register(file);
    return { ...info, name: path.basename(file), fileUrl: `http://127.0.0.1:${port}/file/${id}`, streamUrl: `http://127.0.0.1:${port}/stream/${id}`, fileRel: `/file/${id}`, streamRel: `/stream/${id}` };
  },
  hash: file => movieHash(file),
  async syncWarm(file, audioN) { sync.speechFeature(file, audioN).catch(() => {}); return true; },
  syncAudio: (file, audioN, cues) => sync.alignToAudio(file, audioN, cues),
  async syncCues(ref, cues) { return sync.alignToCues(ref, cues); },
  wordTimes: (file, audioN, cues) => words.wordTimes(file, audioN, cues),
  async seekPlan(file, t, copyVideo) {
    if (t <= 0.3) return { ss: 0, offset: 0 };
    if (!copyVideo) return { ss: t, offset: t };
    const kf = await media.keyframeBefore(file, t);
    // ffmpeg при копировании видео начинает с ключевого кадра примерно на 0.2 c раньше ss
    return kf <= 0.05 ? { ss: 0, offset: 0 } : { ss: kf + 0.25, offset: kf };
  },
  extractSub: (file, n, codec) => media.extractSub(file, n, codec),
  // Субтитры, лежащие рядом с фильмом (Film.srt, Film.en.srt, Subs/...)
  async siblingSubs(file) {
    const dir = path.dirname(file), stem = path.basename(file, path.extname(file)).toLowerCase();
    // если в папке несколько фильмов — берём только субтитры с похожим именем (иначе предложим чужие)
    const key = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const ep = (stem.match(/s\d{1,2}\s?e\d{1,3}/i) || [""])[0].replace(/\s/g, "").toLowerCase();
    let videos = 0; try { videos = fs.readdirSync(dir).filter(n => /\.(mkv|mp4|m4v|webm|mov|avi|ts|m2ts|wmv)$/i.test(n)).length; } catch {}
    const like = name => {
      const n = key(name);
      if (ep) return n.includes(ep);
      return n.startsWith(key(stem).slice(0, 6));
    };
    const found = [];
    const scan = (d, depth) => {
      let items = []; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        const p = path.join(d, it.name);
        if (it.isDirectory() && depth < 1 && /^(subs?|subtitles|субтитры)$/i.test(it.name)) scan(p, depth + 1);
        else if (it.isFile() && /\.(srt|vtt|ass|ssa)$/i.test(it.name) && ((depth > 0 && videos <= 1) || like(it.name))) found.push({ path: p, name: it.name });
      }
    };
    scan(dir, 0);
    return found.slice(0, 40);
  },
  async readFile(p) { return { name: path.basename(p), data: fs.readFileSync(p) }; },
  async getCfg() { return publicCfg(); },
  async setCfg(patch) {
    const allowed = ["osApiKey", "osUsername", "osPassword", "subLangs", "translator", "claudeKey", "subdlKey"];
    for (const [k, v] of Object.entries(patch || {})) if (allowed.includes(k)) cfg[k] = v;
    if ("osUsername" in patch || "osPassword" in patch || "osApiKey" in patch) { cfg.osToken = ""; cfg.osTokenAt = 0; cfg.osBaseUrl = ""; }
    saveCfg(); return publicCfg();
  },
  async osLogin() { await osub.login(true); return true; },
  osGuess: name => osub.guessit(name),
  osSearch: q => osub.search(q),
  osDownload: id => osub.download(id),
  async sdSearch(q) {
    let alt = "";
    if (/[Ѐ-ӿ]/.test(q.query || "")) { // название по-русски — ищем ещё и по английскому
      try { alt = (await tr.translateWord({ text: q.query, target: "английский", provider: cfg.translator || "google", apiKey: cfg.claudeKey })).tr || ""; } catch {}
    }
    return subdl.search({ ...q, altQuery: alt });
  },
  sdDownload: (url, opts) => subdl.download(url, opts),
  trWord: q => tr.translateWord({ ...q, provider: cfg.translator || "google", apiKey: cfg.claudeKey }),
  trLines: q => tr.translateLines({ ...q, provider: cfg.translator || "google", apiKey: cfg.claudeKey }),
  async appVersion() { return require("./package.json").version; },
  // распознавание речи (faster-whisper на этом ПК)
  async whisperInfo(force) {
    if (!whisperState || force) {
      const d = await whisper.detect(cfg.whisperPython);
      whisperState = { python: d.python, version: d.version, base: d.base, models: whisper.cachedModels() };
      if (d.python && d.python !== cfg.whisperPython) { cfg.whisperPython = d.python; saveCfg(); }
    }
    return { ...whisperState, model: cfg.whisperModel || (whisperState.models.includes("medium") ? "medium" : "small"), installing: whisperInstalling };
  },
  async whisperInstall() {
    const info = await H.whisperInfo();
    if (info.python) return info;
    if (!info.base) throw new Error("На ПК не найден Python. Установите его с python.org и нажмите «Найти снова».");
    whisperInstalling = "Начинаю…";
    try {
      const py = await whisper.install(info.base, path.join(app.getPath("userData"), "whisper-env"), m => { whisperInstalling = m; });
      cfg.whisperPython = py; saveCfg();
    } finally { whisperInstalling = ""; }
    return H.whisperInfo(true);
  },
  async whisperSetModel(m) { cfg.whisperModel = m; saveCfg(); return H.whisperInfo(); },
  async whisperStart(file, audioN, lang) {
    const info = await H.whisperInfo();
    if (!info.python) throw Object.assign(new Error("Whisper не найден на ПК"), { code: "no_whisper" });
    return whisper.start({ python: info.python, file, audioN, model: info.model, lang: lang || "auto", cacheDir: path.join(app.getPath("userData"), "transcripts") });
  },
  async whisperStatus(id) { return whisper.status(id); },
  // память субтитров для каждого фильма
  async filmGet(file) {
    const f = filmFile(file);
    try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
  },
  async filmSave(file, data) {
    const f = filmFile(file);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (!data) { try { fs.unlinkSync(f); } catch {} return true; }
    fs.writeFileSync(f, JSON.stringify({ ...data, file: path.basename(file), savedAt: Date.now() }));
    return true;
  },
  async whisperResult(id) { return whisper.result(id); },
  async library() {
    lastScan = library.scan(cfg.libraryFolders);
    return lastScan.map(({ path: p, ...x }) => ({ ...x, path: p }));
  }
};
let lastScan = [];
const filmFile = file => path.join(app.getPath("userData"), "films", library.idOf(path.resolve(file)) + ".json");
let whisperState = null, whisperInstalling = "";

/* ---------- то же для планшета, но только внутри папок библиотеки ---------- */
const inLib = f => library.inside(f, cfg.libraryFolders);
const needLib = f => { if (!inLib(f)) throw new Error("Файл вне папок библиотеки"); return f; };
const remoteHandlers = {
  library: H.library,
  async openMedia(file) { const r = await H.openMedia(needLib(file)); return { ...r, fileUrl: r.fileRel, streamUrl: r.streamRel }; },
  hash: f => H.hash(needLib(f)),
  syncWarm: (f, a) => H.syncWarm(needLib(f), a),
  syncAudio: (f, a, c) => H.syncAudio(needLib(f), a, c),
  syncCues: H.syncCues,
  wordTimes: (f, a, c) => H.wordTimes(needLib(f), a, c),
  seekPlan: (f, t, c) => H.seekPlan(needLib(f), t, c),
  extractSub: (f, n, c) => H.extractSub(needLib(f), n, c),
  siblingSubs: f => H.siblingSubs(needLib(f)),
  readFile: p => { if (!/\.(srt|vtt|ass|ssa)$/i.test(p)) throw new Error("Можно читать только субтитры"); return H.readFile(needLib(p)); },
  getCfg: H.getCfg,
  setCfg: patch => H.setCfg({ subLangs: patch && patch.subLangs ? patch.subLangs : cfg.subLangs }),
  osGuess: H.osGuess, osSearch: H.osSearch, osDownload: H.osDownload,
  sdSearch: H.sdSearch, sdDownload: H.sdDownload,
  trWord: H.trWord, trLines: H.trLines,
  appVersion: H.appVersion,
  whisperInfo: () => H.whisperInfo(),
  whisperStart: (f, a, l) => H.whisperStart(needLib(f), a, l),
  whisperStatus: H.whisperStatus,
  filmGet: f => H.filmGet(needLib(f)),
  filmSave: (f, d) => H.filmSave(needLib(f), d),
  whisperResult: H.whisperResult
};

/* ---------- APK для планшета: собирается на GitHub, ПК держит копию и раздаёт по сети ---------- */
const APK_URL = "https://github.com/bossmitryan/dvaryada/releases/download/android-latest/DvaRyada.apk";
async function apkFile() {
  // 1) APK, который приезжает вместе с обновлением программы (папка android-dist)
  const bundled = path.join(__dirname, "android-dist", "DvaRyada.apk");
  if (fs.existsSync(bundled) && fs.statSync(bundled).size > 100000) return bundled;
  // 2) скачанная копия или загрузка с GitHub
  const f = path.join(app.getPath("userData"), "DvaRyada.apk");
  const fresh = fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < 30 * 60 * 1000;
  if (fresh) return f;
  try {
    const r = await fetch(APK_URL);
    if (!r.ok) throw new Error(String(r.status));
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 100000) throw new Error("too small");
    fs.writeFileSync(f, buf);
  } catch (e) { console.error("[apk]", e.message); }
  return fs.existsSync(f) ? f : null;
}

const remote = createRemote({
  handlers: remoteHandlers,
  getDevices: () => cfg.devices,
  addDevice: d => { cfg.devices.push(d); saveCfg(); win && win.webContents.send("remote-changed"); },
  touchDevice: id => { const d = cfg.devices.find(x => x.id === id); if (d && Date.now() - (d.seen || 0) > 60000) { d.seen = Date.now(); saveCfg(); } },
  rendererDir: path.join(__dirname, "renderer"),
  apk: apkFile,
  thumb: id => { const it = lastScan.find(x => x.id === id); return it ? library.thumb(it.path, path.join(app.getPath("userData"), "thumbs")) : null; },
  deviceName: () => os.hostname()
});

/* ---------- окно и трей ---------- */
let win = null, tray = null, pendingOpen = null, quitting = false;
const VIDEO_EXT = /\.(mkv|mp4|m4v|webm|mov|avi|ts|m2ts|wmv|flv)$/i;
const fileFromArgv = argv => argv.slice(1).find(a => VIDEO_EXT.test(a) && fs.existsSync(a)) || null;
const startHidden = process.argv.includes("--hidden");

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 880, minWidth: 900, minHeight: 560, backgroundColor: "#0d1113", show: !startHidden,
    title: "ДваРяда", autoHideMenuBar: true, icon: path.join(__dirname, "icon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.on("enter-full-screen", () => win.webContents.send("fs", true));
  win.on("leave-full-screen", () => win.webContents.send("fs", false));
  // пока включена раздача на планшет — закрытие окна прячет его в трей
  win.on("close", e => { if (!quitting && cfg.remoteEnabled) { e.preventDefault(); win.hide(); } });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.on("did-finish-load", () => { if (pendingOpen) { win.webContents.send("open-file", pendingOpen); pendingOpen = null; } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
}
function showWin() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
function updateTray() {
  if (cfg.remoteEnabled && !tray) {
    tray = new Tray(path.join(__dirname, "icon.ico"));
    tray.setToolTip("ДваРяда — раздаёт фильмы на планшет");
    tray.setContextMenu(Menu.buildFromTemplate([{ label: "Открыть", click: showWin }, { type: "separator" }, { label: "Выход", click: () => { quitting = true; app.quit(); } }]));
    tray.on("click", showWin);
  } else if (!cfg.remoteEnabled && tray) { tray.destroy(); tray = null; }
}
function setAutostart(on) {
  try { app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: app.isPackaged ? ["--hidden"] : [__dirname, "--hidden"] }); } catch {}
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on("second-instance", (_e, argv) => {
  const f = fileFromArgv(argv);
  showWin(); if (f && win) win.webContents.send("open-file", f);
});
app.on("before-quit", () => { quitting = true; });

app.whenReady().then(async () => {
  // сетевые запросы идут через сетевой стек Chromium: учитываются системный прокси и VPN, как в браузере
  globalThis.fetch = (u, o) => net.fetch(typeof u === "string" ? u : u.toString(), o);
  Menu.setApplicationMenu(null);
  loadCfg();
  ({ port } = await server.start());
  pendingOpen = fileFromArgv(process.argv);
  createWindow();
  if (cfg.remoteEnabled) { remote.start().catch(e => console.error("[remote]", e.message)); updateTray(); }
});
app.on("window-all-closed", () => { if (!cfg.remoteEnabled) app.quit(); });

/* ---------- IPC ---------- */
const wrap = fn => async (_e, ...a) => {
  try { return { ok: true, value: await fn(...a) }; }
  catch (e) { return { ok: false, error: e.message || String(e), code: e.code || "" }; }
};
const CHANNELS = {
  "media:open": "openMedia", "media:hash": "hash", "sync:warm": "syncWarm", "sync:audio": "syncAudio", "sync:cues": "syncCues", "words:times": "wordTimes",
  "media:seekPlan": "seekPlan", "media:extractSub": "extractSub", "media:siblingSubs": "siblingSubs", "file:read": "readFile",
  "cfg:get": "getCfg", "cfg:set": "setCfg", "os:login": "osLogin", "os:guess": "osGuess", "os:search": "osSearch", "os:download": "osDownload",
  "sd:search": "sdSearch", "sd:download": "sdDownload", "tr:word": "trWord", "tr:lines": "trLines", "app:version": "appVersion", "wh:info": "whisperInfo", "wh:install": "whisperInstall", "wh:model": "whisperSetModel", "wh:start": "whisperStart", "wh:status": "whisperStatus", "wh:result": "whisperResult", "film:get": "filmGet", "film:save": "filmSave"
};
for (const [ch, name] of Object.entries(CHANNELS)) ipcMain.handle(ch, wrap(H[name]));

ipcMain.handle("dialog:video", wrap(async () => {
  const r = await dialog.showOpenDialog(win, { title: "Открыть фильм", properties: ["openFile"], filters: [{ name: "Видео", extensions: ["mkv", "mp4", "m4v", "webm", "mov", "avi", "ts", "m2ts", "wmv"] }, { name: "Все файлы", extensions: ["*"] }] });
  return r.canceled ? null : r.filePaths[0];
}));
ipcMain.handle("dialog:sub", wrap(async () => {
  const r = await dialog.showOpenDialog(win, { title: "Открыть субтитры", properties: ["openFile"], filters: [{ name: "Субтитры", extensions: ["srt", "vtt", "ass", "ssa", "txt"] }] });
  if (r.canceled) return null;
  const p = r.filePaths[0];
  return { name: path.basename(p), data: fs.readFileSync(p) };
}));
ipcMain.handle("save:text", wrap(async (name, text) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, text); return r.filePath;
}));
ipcMain.handle("upd:check", wrap(async () => {
  if (app.isPackaged) throw new Error("Эта сборка обновляется заново через build.bat");
  return updater.check(__dirname);
}));
ipcMain.handle("upd:apply", wrap(async () => {
  if (app.isPackaged) throw new Error("Эта сборка обновляется заново через build.bat");
  const r = await updater.apply(__dirname, msg => win && win.webContents.send("upd-progress", msg));
  if (r.applied) setTimeout(() => { quitting = true; app.relaunch(); app.exit(0); }, 800);
  return r;
}));
ipcMain.handle("shell:open", wrap(async url => { if (/^https?:\/\//.test(url)) await shell.openExternal(url); return true; }));
ipcMain.handle("win:fullscreen", wrap(async () => { win.setFullScreen(!win.isFullScreen()); return win.isFullScreen(); }));

// раздача на планшет
const remoteStatus = () => ({
  enabled: !!cfg.remoteEnabled, running: remote.running(), port: remote.PORT, addresses: remote.addresses(),
  folders: cfg.libraryFolders, devices: cfg.devices.map(({ token, ...d }) => d), autostart: !!cfg.autostart
});
ipcMain.handle("remote:status", wrap(async () => remoteStatus()));
ipcMain.handle("remote:enable", wrap(async on => {
  cfg.remoteEnabled = !!on; saveCfg();
  if (on) await remote.start(); else remote.stop();
  updateTray(); return remoteStatus();
}));
ipcMain.handle("remote:autostart", wrap(async on => { cfg.autostart = !!on; saveCfg(); setAutostart(!!on); return remoteStatus(); }));
ipcMain.handle("remote:pair", wrap(async () => {
  const QR = require("qrcode");
  const p = remote.newPairing();
  const pairText = `dvaryada://pair?h=${p.hosts.join(",")}&p=${p.port}&c=${p.code}&n=${encodeURIComponent(os.hostname())}`;
  const apkText = p.hosts[0] ? `http://${p.hosts[0]}:${p.port}/apk` : "";
  return {
    code: p.code, hosts: p.hosts, port: p.port, until: p.until, apkUrl: apkText,
    pairQr: await QR.toDataURL(pairText, { margin: 1, width: 280, errorCorrectionLevel: "M" }),
    apkQr: apkText ? await QR.toDataURL(apkText, { margin: 1, width: 220 }) : ""
  };
}));
ipcMain.handle("remote:removeDevice", wrap(async id => { cfg.devices = cfg.devices.filter(d => d.id !== id); saveCfg(); return remoteStatus(); }));
ipcMain.handle("lib:addFolder", wrap(async () => {
  const r = await dialog.showOpenDialog(win, { title: "Папка с фильмами", properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths[0]) return remoteStatus();
  if (!cfg.libraryFolders.includes(r.filePaths[0])) cfg.libraryFolders.push(r.filePaths[0]);
  saveCfg(); return remoteStatus();
}));
ipcMain.handle("lib:removeFolder", wrap(async f => { cfg.libraryFolders = cfg.libraryFolders.filter(x => x !== f); saveCfg(); return remoteStatus(); }));
ipcMain.handle("lib:list", wrap(() => H.library()));
