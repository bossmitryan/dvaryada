// Веб-версия плеера (планшет): тот же интерфейс, но вместо моста Electron — запросы к ПК по сети.
"use strict";
(function () {
  const qs = new URLSearchParams(location.search);
  let key = "";
  try { key = qs.get("k") || localStorage.getItem("dr.key") || ""; if (qs.get("k")) localStorage.setItem("dr.key", key); } catch { key = qs.get("k") || ""; }
  if (qs.get("k")) history.replaceState(null, "", location.pathname);

  const b64 = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  const dec = v => {
    if (!v || typeof v !== "object") return v;
    if (v.__b64 !== undefined) return b64(v.__b64);
    if (Array.isArray(v)) return v.map(dec);
    const o = {}; for (const [k, x] of Object.entries(v)) o[k] = dec(x); return o;
  };
  let unpairedShown = false;
  function showUnpaired() {
    if (unpairedShown) return; unpairedShown = true;
    const d = document.createElement("div"); d.className = "modal";
    d.innerHTML = `<div class="dlg" style="padding:22px;max-width:460px;gap:10px"><h2 style="margin:0;font-family:var(--f-display);font-weight:500;font-size:17px">Планшет не привязан к ПК</h2><p style="margin:0;color:var(--muted)">На ПК откройте «Настройки → Планшет → Привязать планшет» и отсканируйте QR-код из приложения.</p>${window.DvaRyadaApp ? '<button class="btn primary" id="rescan">Сканировать QR</button>' : ""}</div>`;
    document.body.append(d);
    d.querySelector("#rescan")?.addEventListener("click", () => window.DvaRyadaApp.scan());
  }
  async function call(name, ...args) {
    let r;
    try { r = await fetch("/api/" + name, { method: "POST", headers: { "Content-Type": "application/json", "X-Key": key }, body: JSON.stringify({ args }) }); }
    catch { const e = new Error("Нет связи с ПК. Он включён и в той же сети?"); e.code = "network"; throw e; }
    const j = await r.json().catch(() => null);
    if (!j) throw new Error("ПК ответил непонятно (" + r.status + ")");
    if (!j.ok) { const e = new Error(j.error || "Ошибка"); e.code = j.code || ""; if (j.code === "unpaired") showUnpaired(); throw e; }
    return dec(j.value);
  }
  const withKey = u => u ? location.origin + u + (u.includes("?") ? "&" : "?") + "k=" + encodeURIComponent(key) : u;

  function pickLocalSub() {
    return new Promise(resolve => {
      const inp = document.createElement("input"); inp.type = "file"; inp.accept = ".srt,.vtt,.ass,.ssa,.txt";
      inp.onchange = async () => { const f = inp.files[0]; if (!f) return resolve(null); resolve({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }); };
      inp.click();
    });
  }

  window.api = {
    isRemote: true,
    pickVideo: async () => { window.dispatchEvent(new Event("dr-library")); return null; },
    pickSub: pickLocalSub,
    readFile: p => call("readFile", p),
    pathOf: () => "",
    openMedia: async p => { const r = await call("openMedia", p); r.fileUrl = withKey(r.fileUrl); r.streamUrl = withKey(r.streamUrl); return r; },
    hash: p => call("hash", p),
    seekPlan: (p, t, c) => call("seekPlan", p, t, c),
    extractSub: (p, n, c) => call("extractSub", p, n, c),
    siblingSubs: p => call("siblingSubs", p),
    syncWarm: (p, a) => call("syncWarm", p, a),
    syncAudio: (p, a, c) => call("syncAudio", p, a, c),
    syncCues: (r, c) => call("syncCues", r, c),
    wordTimes: (p, a, c) => call("wordTimes", p, a, c),
    getCfg: () => call("getCfg"),
    setCfg: patch => call("setCfg", patch),
    osLogin: async () => { throw new Error("Вход настраивается на ПК"); },
    osGuess: n => call("osGuess", n),
    osSearch: q => call("osSearch", q),
    osDownload: id => call("osDownload", id),
    sdSearch: q => call("sdSearch", q),
    sdDownload: (u, o) => call("sdDownload", u, o),
    trWord: q => call("trWord", q),
    trLines: q => call("trLines", q),
    saveText: async () => null,
    openUrl: async url => { if (window.DvaRyadaApp && window.DvaRyadaApp.openUrl) window.DvaRyadaApp.openUrl(url); else window.open(url, "_blank"); return true; },
    toggleFullscreen: async () => {
      try {
        if (document.fullscreenElement) { await document.exitFullscreen(); return false; }
        await document.documentElement.requestFullscreen(); return true;
      } catch { return !!document.fullscreenElement; }
    },
    onFullscreen: fn => document.addEventListener("fullscreenchange", () => fn(!!document.fullscreenElement)),
    onOpenFile: () => {},
    updCheck: async () => ({ current: "", latest: "", available: false, notes: "" }),
    updApply: async () => { throw new Error("Обновляется с ПК"); },
    appVersion: () => call("appVersion"),
    onUpdProgress: () => {},
    library: () => call("library"),
    whisperInfo: () => call("whisperInfo"),
    whisperStart: (p, a, l) => call("whisperStart", p, a, l),
    whisperStatus: id => call("whisperStatus", id),
    whisperResult: id => call("whisperResult", id),
    thumbUrl: id => withKey("/thumb/" + id),
    apkUrl: () => location.origin + "/apk",
    nativeVersion: () => (window.DvaRyadaApp && window.DvaRyadaApp.version) ? window.DvaRyadaApp.version() : ""
  };
})();
