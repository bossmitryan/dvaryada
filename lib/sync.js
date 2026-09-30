// Автоматическая подгонка субтитров под звук фильма.
// 1) ffmpeg выдаёт звук в полосе голоса (8 кГц, моно); считаем громкость каждые 0.1 с.
// 2) Из громкости вычитаем плавный фон (музыку, шумы) — остаются всплески речи.
// 3) Перебираем сдвиг (±90 с) и растяжение (частоты кадров 23.976/24/25) и ищем,
//    при каком варианте реплики лучше всего совпадают со всплесками речи.
"use strict";
const { spawn } = require("child_process");
const { FFMPEG } = require("./media");

const FPS = 10;                 // 10 отсчётов в секунду
const cache = new Map();        // файл|дорожка -> Promise<Float32Array>

function speechFeature(file, audioN = 0) {
  const key = file + "|" + audioN;
  if (cache.has(key)) return cache.get(key);
  const p = new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, ["-v", "error", "-nostdin", "-i", file, "-map", `0:a:${audioN}`, "-vn", "-ac", "1", "-ar", "8000",
      "-af", "highpass=f=250,lowpass=f=3400", "-f", "s16le", "pipe:1"], { windowsHide: true });
    const FRAME = 8000 / FPS;
    const energy = [];
    let acc = 0, n = 0, rest = null;
    ff.stdout.on("data", chunk => {
      let buf = rest ? Buffer.concat([rest, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const v = buf.readInt16LE(i);
        acc += v * v; n++;
        if (n === FRAME) { energy.push(10 * Math.log10(acc / n + 1)); acc = 0; n = 0; }
      }
      rest = usable < buf.length ? buf.slice(usable) : null;
    });
    let err = "";
    ff.stderr.on("data", d => { err += d; if (err.length > 4000) err = err.slice(-2000); });
    ff.on("error", reject);
    ff.on("close", code => {
      if (code !== 0 && !energy.length) return reject(new Error("ffmpeg: " + err.split("\n").slice(-2).join(" ")));
      resolve(buildFeature(Float32Array.from(energy)));
    });
  });
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}

// громкость минус скользящее среднее за 3 с (убираем фон), затем нормировка
function buildFeature(E) {
  const W = 3 * FPS, N = E.length, F = new Float32Array(N);
  const pre = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) pre[i + 1] = pre[i] + E[i];
  for (let i = 0; i < N; i++) {
    const a = Math.max(0, i - W), b = Math.min(N, i + W + 1);
    F[i] = Math.max(0, E[i] - (pre[b] - pre[a]) / (b - a));
  }
  return normalize(F);
}
function normalize(F) {
  let m = 0; for (const v of F) m += v; m /= F.length || 1;
  let s = 0; for (const v of F) s += (v - m) * (v - m); s = Math.sqrt(s / (F.length || 1)) || 1;
  const out = new Float32Array(F.length);
  for (let i = 0; i < F.length; i++) out[i] = (F[i] - m) / s;
  return out;
}

// Реплики -> признак того же вида (для подгонки одного ряда к другому)
function cuesFeature(cues, lengthSec) {
  const N = Math.ceil(lengthSec * FPS) + 1, F = new Float32Array(N);
  for (const c of cues) for (let i = Math.max(0, Math.floor(c.s * FPS)); i < Math.min(N, Math.ceil(c.e * FPS)); i++) F[i] = 1;
  return normalize(F);
}

const SCALES = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25];

// Главный поиск: какой сдвиг и растяжение дают наибольшее совпадение
function align(F, cues, { maxShift = 90 } = {}) {
  const N = F.length;
  const pre = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) pre[i + 1] = pre[i] + F[i];
  const sum = (a, b) => { a = Math.max(0, Math.min(N, a)); b = Math.max(0, Math.min(N, b)); return b > a ? pre[b] - pre[a] : 0; };
  const K = maxShift * FPS;
  let best = null;
  for (const scale of SCALES) {
    const iv = cues.map(c => [Math.round(c.s * scale * FPS), Math.round(c.e * scale * FPS)]).filter(([a, b]) => b > a);
    const scores = new Float64Array(2 * K + 1);
    for (let k = -K; k <= K; k++) {
      let s = 0;
      for (const [a, b] of iv) s += sum(a + k, b + k);
      scores[k + K] = s;
    }
    let bi = 0; for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
    // уверенность: насколько лучший вариант выделяется среди остальных сдвигов
    const arr = Array.from(scores).sort((x, y) => x - y);
    const med = arr[arr.length >> 1];
    let sd = 0; for (const v of scores) sd += (v - med) * (v - med); sd = Math.sqrt(sd / scores.length) || 1;
    const conf = (scores[bi] - med) / sd;
    if (!best || conf > best.confidence) best = { scale, offset: (bi - K) / FPS, confidence: conf };
  }
  best.confidence = Math.round(best.confidence * 10) / 10;
  best.offset = Math.round(best.offset * 100) / 100;
  return best;
}

async function alignToAudio(file, audioN, cues) {
  const F = await speechFeature(file, audioN);
  return align(F, cues);
}
function alignToCues(refCues, cues) {
  const len = Math.max(...refCues.map(c => c.e), ...cues.map(c => c.e)) + 120;
  return align(cuesFeature(refCues, len), cues);
}

module.exports = { speechFeature, alignToAudio, alignToCues, align, cuesFeature, FPS };
