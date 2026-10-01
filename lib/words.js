// Приблизительная разметка слов по времени: внутри каждой реплики ищем, где звучит голос,
// и раскладываем слова по этим отрезкам пропорционально их длине (по слогам).
// Без распознавания речи, но паузы и темп реплики повторяются.
"use strict";
const { spawn } = require("child_process");
const { FFMPEG } = require("./media");

// громкость в полосе голоса с шагом 20 мс (для разметки слов нужна точность выше, чем для подгонки)
const WFPS = 50;
const cache = new Map();
function energy50(file, audioN = 0) {
  const key = file + "|" + audioN;
  if (cache.has(key)) return cache.get(key);
  const p = new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, ["-v", "error", "-nostdin", "-i", file, "-map", `0:a:${audioN}`, "-vn", "-ac", "1", "-ar", "8000",
      "-af", "highpass=f=250,lowpass=f=3400", "-f", "s16le", "pipe:1"], { windowsHide: true });
    const FRAME = 8000 / WFPS, out = [];
    let acc = 0, n = 0, rest = null;
    ff.stdout.on("data", chunk => {
      const buf = rest ? Buffer.concat([rest, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      for (let i = 0; i < usable; i += 2) { const v = buf.readInt16LE(i); acc += v * v; if (++n === FRAME) { out.push(10 * Math.log10(acc / n + 1)); acc = 0; n = 0; } }
      rest = usable < buf.length ? buf.slice(usable) : null;
    });
    ff.on("error", reject);
    ff.on("close", code => code === 0 || out.length ? resolve(Float32Array.from(out)) : reject(new Error("ffmpeg " + code)));
  });
  cache.set(key, p); p.catch(() => cache.delete(key));
  return p;
}

const VOWELS = /[aeiouyáéíóúüàèìòùâêîôûäöëïаеёиоуыэюяіїєaeiouy]/gi;
function weight(w) {
  const v = (String(w).match(VOWELS) || []).length;
  return Math.max(1, v) + Math.min(String(w).length, 12) * 0.08;
}

// cues: [{s, e, words: [...], gaps: [...]}] — время в шкале фильма; gaps[i] — пауза перед словом i (после запятой/точки)
function layout(E, cues) {
  const N = E.length;
  return cues.map(c => {
    const n = (c.words || []).length;
    if (!n) return [];
    const a = Math.max(0, Math.floor((c.s - 0.3) * WFPS)), b = Math.min(N, Math.ceil((c.e + 0.3) * WFPS));
    if (b - a < 5) return c.words.map(() => [c.s, c.e]);
    // порог голоса: шум реплики (20-й перцентиль) + 6 дБ
    const seg = Array.from(E.slice(a, b)).sort((x, y) => x - y);
    const floor = seg[Math.floor(seg.length * 0.2)], peak = seg[Math.floor(seg.length * 0.95)];
    const thr = floor + Math.max(4, Math.min(8, (peak - floor) * 0.35));
    const ca = Math.max(a, Math.floor(c.s * WFPS)), cb = Math.min(b, Math.ceil(c.e * WFPS));
    const voiced = [];
    for (let i = ca; i < cb; i++) voiced.push(E[i] > thr ? 1 : 0);
    // склеиваем провалы короче 60 мс, убираем всплески короче 60 мс
    const fix = (val, len) => { let i = 0; while (i < voiced.length) { if (voiced[i] === val) { let j = i; while (j < voiced.length && voiced[j] === val) j++; if (j - i < len && i > 0 && j < voiced.length) for (let k = i; k < j; k++) voiced[k] = 1 - val; i = j; } else i++; } };
    fix(0, 3); fix(1, 3);
    const runs = []; // начала отрезков речи (индексы)
    for (let i = 0; i < voiced.length; i++) if (voiced[i] && (i === 0 || !voiced[i - 1])) runs.push(i);
    const vCount = voiced.reduce((x, y) => x + y, 0);
    const useAudio = vCount >= Math.max(4, voiced.length * 0.2);
    const ws = c.words.map((w, i) => weight(w) + (c.gaps?.[i] || 0));
    const total = ws.reduce((x, y) => x + y, 0);
    let timeAt;
    if (useAudio) {
      const cum = [0];
      for (let i = 0; i < voiced.length; i++) cum.push(cum[i] + voiced[i]);
      timeAt = frac => {
        const target = Math.max(1e-6, frac * vCount);
        let lo = 0, hi = voiced.length - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m + 1] < target) lo = m + 1; else hi = m; }
        return (ca + lo + Math.min(1, Math.max(0, target - cum[lo]))) / WFPS;
      };
    } else {
      const span = (c.e - c.s) * 0.88;
      timeAt = frac => c.s + frac * span;
    }
    const starts = [];
    let acc = 0;
    for (let i = 0; i < n; i++) { starts.push(timeAt((acc + (c.gaps?.[i] || 0) * 0.5) / total)); acc += ws[i]; }
    const endAll = timeAt(1);
    // начало слова притягиваем к ближайшему началу отрезка речи (паузы между словами), сохраняя порядок
    if (useAudio && runs.length > 1) {
      const rt = runs.map(i => (ca + i) / WFPS);
      let used = -1;
      for (let i = 1; i < n; i++) {
        let best = -1, bd = 0.22;
        for (let r = used + 1; r < rt.length; r++) { const d = Math.abs(rt[r] - starts[i]); if (d < bd) { bd = d; best = r; } }
        if (best >= 0 && rt[best] > starts[i - 1] + 0.06) { starts[i] = rt[best]; used = best; }
      }
    }
    return starts.map((st, i) => {
      const en = i + 1 < n ? starts[i + 1] : endAll;
      return [Math.round(st * 100) / 100, Math.round(Math.max(en, st + 0.08) * 100) / 100];
    });
  });
}

async function wordTimes(file, audioN, cues) {
  const E = await energy50(file, audioN);
  return layout(E, cues);
}

module.exports = { wordTimes, layout, energy50 };
