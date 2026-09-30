"use strict";
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu, net } = require("electron");
const path = require("path");
const fs = require("fs");
const media = require("./lib/media");
const { movieHash } = require("./lib/hash");
const server = require("./lib/server");
const { OpenSubs } = require("./lib/opensubs");
const { SubDL } = require("./lib/subdl");
const tr = require("./lib/translate");
const sync = require("./lib/sync");

/* ---------- настройки (userData/settings.json, секреты шифруются средствами ОС) ---------- */
const SETTINGS_FILE = () => path.join(app.getPath("userData"), "settings.json");
const SECRET = ["osPassword", "claudeKey", "osToken", "subdlKey"];
let cfg = {};
function loadCfg() {
  try { cfg = JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8")); } catch { cfg = {}; }
  for (const k of SECRET) if (cfg[k + "_enc"]) {
    try { cfg[k] = safeStorage.decryptString(Buffer.from(cfg[k + "_enc"], "base64")); } catch { cfg[k] = ""; }
  }
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

const os = new OpenSubs(
  () => ({ apiKey: cfg.osApiKey, username: cfg.osUsername, password: cfg.osPassword, token: cfg.osToken, baseUrl: cfg.osBaseUrl, tokenAt: cfg.osTokenAt }),
  p => { if ("token" in p) cfg.osToken = p.token; if ("baseUrl" in p) cfg.osBaseUrl = p.baseUrl; if ("tokenAt" in p) cfg.osTokenAt = p.tokenAt; saveCfg(); }
);

const subdl = new SubDL(() => cfg.subdlKey);

/* ---------- окно ---------- */
let win = null, port = 0, pendingOpen = null;
const VIDEO_EXT = /\.(mkv|mp4|m4v|webm|mov|avi|ts|m2ts|wmv|flv)$/i;
const fileFromArgv = argv => argv.slice(1).find(a => VIDEO_EXT.test(a) && fs.existsSync(a)) || null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 880, minWidth: 900, minHeight: 560, backgroundColor: "#0d1113",
    title: "ДваРяда", autoHideMenuBar: true, icon: path.join(__dirname, "icon.ico"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.on("enter-full-screen", () => win.webContents.send("fs", true));
  win.on("leave-full-screen", () => win.webContents.send("fs", false));
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.on("did-finish-load", () => { if (pendingOpen) { win.webContents.send("open-file", pendingOpen); pendingOpen = null; } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on("second-instance", (_e, argv) => {
  const f = fileFromArgv(argv);
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); if (f) win.webContents.send("open-file", f); }
});

app.whenReady().then(async () => {
  // сетевые запросы идут через сетевой стек Chromium: учитываются системный прокси и VPN, как в браузере
  globalThis.fetch = (u, o) => net.fetch(typeof u === "string" ? u : u.toString(), o);
  Menu.setApplicationMenu(null);
  loadCfg();
  ({ port } = await server.start());
  pendingOpen = fileFromArgv(process.argv);
  createWindow();
});
app.on("window-all-closed", () => app.quit());

/* ---------- IPC ---------- */
const wrap = fn => async (_e, ...a) => {
  try { return { ok: true, value: await fn(...a) }; }
  catch (e) { return { ok: false, error: e.message || String(e), code: e.code || "" }; }
};

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
ipcMain.handle("file:read", wrap(async p => ({ name: path.basename(p), data: fs.readFileSync(p) })));

ipcMain.handle("media:open", wrap(async file => {
  const info = await media.probe(file);
  const id = server.register(file);
  return { ...info, name: path.basename(file), fileUrl: `http://127.0.0.1:${port}/file/${id}`, streamUrl: `http://127.0.0.1:${port}/stream/${id}` };
}));
ipcMain.handle("media:hash", wrap(file => movieHash(file)));
ipcMain.handle("sync:warm", wrap(async (file, audioN) => { sync.speechFeature(file, audioN).catch(() => {}); return true; }));
ipcMain.handle("sync:audio", wrap((file, audioN, cues) => sync.alignToAudio(file, audioN, cues)));
ipcMain.handle("sync:cues", wrap(async (ref, cues) => sync.alignToCues(ref, cues)));
ipcMain.handle("media:seekPlan", wrap(async (file, t, copyVideo) => {
  if (t <= 0.3) return { ss: 0, offset: 0 };
  if (!copyVideo) return { ss: t, offset: t };
  const kf = await media.keyframeBefore(file, t);
  // ffmpeg при копировании видео начинает с ключевого кадра примерно на 0.2 c раньше ss
  return kf <= 0.05 ? { ss: 0, offset: 0 } : { ss: kf + 0.25, offset: kf };
}));
ipcMain.handle("media:extractSub", wrap(async (file, n, codec) => {
  const r = await media.extractSub(file, n, codec);
  return r;
}));
// Субтитры, лежащие рядом с фильмом (Film.srt, Film.en.srt, Subs/...)
ipcMain.handle("media:siblingSubs", wrap(async file => {
  const dir = path.dirname(file), stem = path.basename(file, path.extname(file)).toLowerCase();
  const found = [];
  const scan = (d, depth) => {
    let items = []; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory() && depth < 1 && /^(subs?|subtitles|субтитры)$/i.test(it.name)) scan(p, depth + 1);
      else if (it.isFile() && /\.(srt|vtt|ass|ssa)$/i.test(it.name) && (depth > 0 || it.name.toLowerCase().startsWith(stem.slice(0, 8)))) found.push({ path: p, name: it.name });
    }
  };
  scan(dir, 0);
  return found.slice(0, 40);
}));

ipcMain.handle("cfg:get", wrap(async () => publicCfg()));
ipcMain.handle("cfg:set", wrap(async patch => {
  const map = { osApiKey: "osApiKey", osUsername: "osUsername", osPassword: "osPassword", subLangs: "subLangs", translator: "translator", claudeKey: "claudeKey", subdlKey: "subdlKey" };
  for (const [k, v] of Object.entries(patch || {})) if (map[k]) cfg[map[k]] = v;
  if ("osUsername" in patch || "osPassword" in patch || "osApiKey" in patch) { cfg.osToken = ""; cfg.osTokenAt = 0; cfg.osBaseUrl = ""; }
  saveCfg(); return publicCfg();
}));
ipcMain.handle("os:login", wrap(async () => { await os.login(true); return true; }));
ipcMain.handle("os:guess", wrap(name => os.guessit(name)));
ipcMain.handle("os:search", wrap(q => os.search(q)));
ipcMain.handle("os:download", wrap(id => os.download(id)));
ipcMain.handle("sd:search", wrap(async q => {
  let alt = "";
  if (/[\u0400-\u04FF]/.test(q.query || "")) { // название по-русски — ищем ещё и по английскому
    try { alt = (await tr.translateWord({ text: q.query, target: "английский", provider: cfg.translator || "google", apiKey: cfg.claudeKey })).tr || ""; } catch {}
  }
  return subdl.search({ ...q, altQuery: alt });
}));
ipcMain.handle("sd:download", wrap((url, opts) => subdl.download(url, opts)));

ipcMain.handle("tr:word", wrap(q => tr.translateWord({ ...q, provider: cfg.translator || "google", apiKey: cfg.claudeKey })));
ipcMain.handle("tr:lines", wrap(q => tr.translateLines({ ...q, provider: cfg.translator || "google", apiKey: cfg.claudeKey })));

ipcMain.handle("save:text", wrap(async (name, text) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, text); return r.filePath;
}));
ipcMain.handle("shell:open", wrap(async url => { if (/^https?:\/\//.test(url)) await shell.openExternal(url); return true; }));
ipcMain.handle("win:fullscreen", wrap(async () => { win.setFullScreen(!win.isFullScreen()); return win.isFullScreen(); }));
