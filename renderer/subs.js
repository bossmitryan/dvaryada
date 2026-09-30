// Разбор файлов субтитров: SRT, VTT, ASS/SSA. Кодировки: UTF-8/16, Windows-1251.
"use strict";
(function () {
  function decode(buf) {
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u[0] === 0xFF && u[1] === 0xFE) return new TextDecoder("utf-16le").decode(u);
    if (u[0] === 0xFE && u[1] === 0xFF) return new TextDecoder("utf-16be").decode(u);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(u); }
    catch { return new TextDecoder("windows-1251").decode(u); }
  }
  const tsec = s => { const m = s.trim().replace(",", ".").split(":").map(Number); return m.length === 3 ? m[0] * 3600 + m[1] * 60 + m[2] : m[0] * 60 + m[1]; };
  const clean = t => t.replace(/\{\\[^}]*\}/g, "").replace(/<[^>]+>/g, "").replace(/\\N/gi, "\n").replace(/\\h/g, " ").replace(/^﻿/, "").trim();
  function parse(text, name = "") {
    text = String(text).replace(/\r/g, "").replace(/^﻿/, "");
    const cues = [];
    if (/^\s*\[Script Info\]/i.test(text) || /\.(ass|ssa)$/i.test(name)) {
      let cols = null, inEvents = false;
      for (const line of text.split("\n")) {
        if (/^\[Events\]/i.test(line)) { inEvents = true; continue; }
        if (/^\[/.test(line)) { inEvents = false; continue; }
        if (inEvents && /^Format:/i.test(line)) { cols = line.slice(7).split(",").map(s => s.trim().toLowerCase()); continue; }
        if (inEvents && cols && /^Dialogue:/i.test(line)) {
          const parts = line.slice(9).split(","), n = cols.length;
          const f = parts.slice(0, n - 1).concat([parts.slice(n - 1).join(",")]);
          const g = k => f[cols.indexOf(k)] || "";
          const tx = clean(g("text")); if (!tx) continue;
          cues.push({ s: tsec(g("start")), e: tsec(g("end")), text: tx });
        }
      }
    } else {
      for (const block of text.split(/\n\s*\n/)) {
        const lines = block.split("\n"); const i = lines.findIndex(l => l.includes("-->"));
        if (i < 0) continue;
        const m = lines[i].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/); if (!m) continue;
        const tx = clean(lines.slice(i + 1).join("\n")); if (!tx) continue;
        cues.push({ s: tsec(m[1]), e: tsec(m[2]), text: tx });
      }
    }
    cues.sort((a, b) => a.s - b.s);
    // одинаковые реплики подряд (ASS с несколькими слоями) склеиваем
    const out = [];
    for (const c of cues) { const p = out[out.length - 1]; if (p && p.s === c.s && p.e === c.e) { if (p.text !== c.text) p.text += "\n" + c.text; } else out.push(c); }
    out.forEach((c, i) => c.id = i);
    return out;
  }
  window.Subs = { decode, parse };
})();
