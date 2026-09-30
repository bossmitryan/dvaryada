// Клиент SubDL (subdl.com). Бесплатный ключ: subdl.com -> войти -> Panel -> API.
// Бесплатно: ~2000 запросов и 300 скачиваний в сутки.
"use strict";
const { unzip } = require("./unzip");

const API = "https://api.subdl.com/api/v1/subtitles";
const DL = "https://dl.subdl.com";
const NAME2CODE = { english: "en", russian: "ru", german: "de", french: "fr", spanish: "es", italian: "it", japanese: "ja", korean: "ko", ukrainian: "uk", portuguese: "pt", "brazillian portuguese": "pt", chinese: "zh", "chinese bg code": "zh", polish: "pl", turkish: "tr" };
const SUB_EXT = /\.(srt|vtt|ass|ssa)$/i;

class SubDL {
  constructor(getKey) { this.getKey = getKey; }

  async call(params) {
    const key = this.getKey();
    if (!key) throw Object.assign(new Error("Не указан API-ключ SubDL"), { code: "no_key" });
    const u = new URL(API);
    u.searchParams.set("api_key", key);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    u.searchParams.set("subs_per_page", "30");
    u.searchParams.set("hi", "1");
    u.searchParams.set("releases", "1");
    let r;
    try { r = await fetch(u, { headers: { "User-Agent": "DvaRyada v0.4.0" } }); }
    catch (e) { throw Object.assign(new Error("Нет связи с SubDL: " + e.message), { code: "network" }); }
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.status === false) {
      const msg = (j && (j.error || j.message)) || ("HTTP " + r.status);
      if (/not found|no subtitles|can.?t find|no result/i.test(msg)) return { results: [], subtitles: [] };
      throw Object.assign(new Error("SubDL: " + msg), { code: r.status === 401 || r.status === 403 || /api.?key/i.test(msg) ? "http_401" : "http_" + r.status });
    }
    return j;
  }

  // Поиск в несколько заходов: по имени файла, по названию (+год), по английскому названию, без года.
  // Если под название подходит несколько фильмов — отдаём их список, чтобы выбрать нужный.
  async search({ query, altQuery, fileName, year, season, episode, languages, sdId }) {
    const langs = (languages || []).map(l => l.toUpperCase()).join(",");
    const base = { languages: langs };
    if (season) { base.type = "tv"; base.season_number = season; if (episode) base.episode_number = episode; }
    const tries = [];
    if (sdId) tries.push({ ...base, sd_id: sdId });
    else {
      if (fileName) tries.push({ ...base, file_name: fileName });
      if (query) tries.push({ ...base, film_name: query, year: season ? undefined : year });
      if (altQuery && altQuery.toLowerCase() !== (query || "").toLowerCase()) tries.push({ ...base, film_name: altQuery, year: season ? undefined : year });
    }
    const seen = new Set(), subs = [], films = new Map(), log = [];
    const run = async p => {
      const j = await this.call(p);
      (j.results || []).forEach(f => { if (f.sd_id && !films.has(f.sd_id)) films.set(f.sd_id, { sdId: f.sd_id, name: f.name, year: f.year || (f.first_air_date || "").slice(0, 4), type: f.type }); });
      const film = (j.results || [])[0] || {};
      let n = 0;
      for (const s of j.subtitles || []) {
        if (!s.url || seen.has(s.url)) continue; seen.add(s.url); n++;
        const code = String(s.language || "").toLowerCase() || NAME2CODE[String(s.lang || "").toLowerCase()] || "";
        subs.push({
          source: "subdl", fileId: s.url, fileName: s.name || "",
          lang: code, release: s.release_name || s.name || "",
          downloads: s.download_count || 0, trusted: false, hi: !!s.hi, machine: false,
          hashMatch: !!p.file_name, // совпадение по имени файла — почти наверняка тот же релиз
          fps: parseFloat(s.fps) || 0, uploader: s.author || "",
          title: film.name || "", year: film.year || "", season: s.season, episode: s.episode,
          fullSeason: !!s.full_season, order: subs.length
        });
      }
      log.push(`${p.file_name ? "файл" : p.sd_id ? "фильм" : "«" + p.film_name + "»"}: ${n}`);
      return n;
    };
    for (const p of tries) await run(p).catch(e => { if (e.code === "http_401") throw e; log.push("ошибка: " + e.message); });
    // ничего на нужных языках — пробуем без года
    if (!subs.length && !sdId && year && query) await run({ ...base, film_name: altQuery || query }).catch(() => {});
    return { list: subs, films: [...films.values()].slice(0, 8), log };
  }

  // Скачивание ZIP и выбор файла субтитров (для сезонных архивов — нужной серии)
  async download(url, { episode } = {}) {
    const key = this.getKey();
    const u = new URL(url.startsWith("http") ? url : DL + (url.startsWith("/") ? "" : "/") + url);
    if (key) u.searchParams.set("api_key", key);
    const r = await fetch(u, { headers: { "User-Agent": "DvaRyada v0.3.0" } });
    if (!r.ok) throw new Error("SubDL: не удалось скачать (" + r.status + ")");
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.readUInt32LE(0) !== 0x04034b50) return { data: buf, fileName: u.pathname.split("/").pop() };
    let files = unzip(buf).filter(f => SUB_EXT.test(f.name));
    if (!files.length) throw new Error("В архиве нет файлов субтитров");
    if (episode && files.length > 1) {
      const e = Number(episode);
      const re = new RegExp(`(?:e|x|ep|серия\\s*)0*${e}(?!\\d)`, "i");
      const hit = files.filter(f => re.test(f.name.split(/[\\/]/).pop()));
      if (hit.length) files = hit;
    }
    files.sort((a, b) => (/\.srt$/i.test(b.name) - /\.srt$/i.test(a.name)) || (b.data.length - a.data.length));
    return { data: files[0].data, fileName: files[0].name.split(/[\\/]/).pop() };
  }
}

module.exports = { SubDL };
