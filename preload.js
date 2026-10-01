"use strict";
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a).then(r => {
  if (r && r.ok) return r.value;
  const e = new Error((r && r.error) || "Ошибка"); e.code = r && r.code; throw e;
});

contextBridge.exposeInMainWorld("api", {
  pickVideo: () => call("dialog:video"),
  pickSub: () => call("dialog:sub"),
  readFile: p => call("file:read", p),
  pathOf: file => { try { return webUtils.getPathForFile(file); } catch { return ""; } },
  openMedia: p => call("media:open", p),
  hash: p => call("media:hash", p),
  seekPlan: (p, t, copy) => call("media:seekPlan", p, t, copy),
  extractSub: (p, n, codec) => call("media:extractSub", p, n, codec),
  siblingSubs: p => call("media:siblingSubs", p),
  syncWarm: (p, a) => call("sync:warm", p, a),
  syncAudio: (p, a, cues) => call("sync:audio", p, a, cues),
  syncCues: (ref, cues) => call("sync:cues", ref, cues),
  wordTimes: (p, a, cues) => call("words:times", p, a, cues),
  getCfg: () => call("cfg:get"),
  setCfg: patch => call("cfg:set", patch),
  osLogin: () => call("os:login"),
  osGuess: name => call("os:guess", name),
  osSearch: q => call("os:search", q),
  osDownload: id => call("os:download", id),
  sdSearch: q => call("sd:search", q),
  sdDownload: (url, opts) => call("sd:download", url, opts),
  trWord: q => call("tr:word", q),
  trLines: q => call("tr:lines", q),
  saveText: (name, text) => call("save:text", name, text),
  openUrl: url => call("shell:open", url),
  toggleFullscreen: () => call("win:fullscreen"),
  onFullscreen: fn => ipcRenderer.on("fs", (_e, on) => fn(on)),
  updCheck: () => call("upd:check"),
  updApply: () => call("upd:apply"),
  appVersion: () => call("app:version"),
  onUpdProgress: fn => ipcRenderer.on("upd-progress", (_e, m) => fn(m)),
  remoteStatus: () => call("remote:status"),
  remoteEnable: on => call("remote:enable", on),
  remoteAutostart: on => call("remote:autostart", on),
  remotePair: () => call("remote:pair"),
  remoteRemoveDevice: id => call("remote:removeDevice", id),
  libAddFolder: () => call("lib:addFolder"),
  libRemoveFolder: f => call("lib:removeFolder", f),
  library: () => call("lib:list"),
  onRemoteChanged: fn => ipcRenderer.on("remote-changed", () => fn()),
  whisperInfo: force => call("wh:info", force),
  whisperInstall: () => call("wh:install"),
  whisperSetModel: m => call("wh:model", m),
  whisperStart: (p, a, l) => call("wh:start", p, a, l),
  whisperStatus: id => call("wh:status", id),
  whisperResult: id => call("wh:result", id),
  filmGet: p => call("film:get", p),
  filmSave: (p, d) => call("film:save", p, d),
  onOpenFile: fn => ipcRenderer.on("open-file", (_e, p) => fn(p))
});
