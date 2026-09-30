// Клиент OpenSubtitles.com REST API v1.
// Нужен собственный бесплатный API-ключ: opensubtitles.com -> профиль -> API consumers.
"use strict";

const UA = "DvaRyada v0.2.0";

class OpenSubs {
  constructor(get, set) {
    this.get = get;   // () => {apiKey, username, password, token, baseUrl, tokenAt}
    this.set = set;   // (patch) => void
  }
  base() { return "https://" + (this.get().baseUrl || "api.opensubtitles.com") + "/api/v1"; }
  headers(auth) {
    const c = this.get();
    const h = { "Api-Key": c.apiKey || "", "User-Agent": UA, "Accept": "application/json", "Content-Type": "application/json" };
    if (auth && c.token) h.Authorization = "Bearer " + c.token;
    return h;
  }
  async req(method, path, { body, auth = false, query } = {}) {
    if (!this.get().apiKey) throw Object.assign(new Error("Не указан API-ключ OpenSubtitles"), { code: "no_key" });
    const url = new URL(this.base() + path);
    if (query) Object.entries(query).sort(([a], [b]) => a.localeCompare(b))
      .forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v).toLowerCase()); });
    let r;
    try {
      r = await fetch(url, { method, headers: this.headers(auth), body: body ? JSON.stringify(body) : undefined, redirect: "follow" });
    } catch (e) { throw Object.assign(new Error("Нет связи с OpenSubtitles: " + e.message), { code: "network" }); }
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch {}
    if (!r.ok) {
      const msg = (j && (j.message || (j.errors && j.errors.join("; ")))) || text.slice(0, 200) || r.statusText;
      throw Object.assign(new Error(msg), { code: "http_" + r.status, status: r.status, data: j });
    }
    return j;
  }

  async login(force = false) {
    const c = this.get();
    if (!force && c.token && c.tokenAt && Date.now() - c.tokenAt < 20 * 3600 * 1000) return c.token;
    if (!c.username || !c.password) throw Object.assign(new Error("Для скачивания войдите в аккаунт OpenSubtitles"), { code: "no_login" });
    this.set({ baseUrl: "" });
    const j = await this.req("POST", "/login", { body: { username: c.username, password: c.password } });
    this.set({ token: j.token, baseUrl: j.base_url || "", tokenAt: Date.now() });
    return j.token;
  }

  // Разбор имени файла (название, год, сезон, серия)
  async guessit(filename) {
    try { return await this.req("GET", "/utilities/guessit", { query: { filename } }); }
    catch { return null; }
  }

  // Поиск: сначала по хешу файла, потом по названию; результаты объединяются
  async search({ query, year, season, episode, moviehash, languages }) {
    const langs = (languages || []).join(",");
    const base = { languages: langs, order_by: "download_count", order_direction: "desc" };
    const tasks = [];
    if (moviehash) tasks.push(this.req("GET", "/subtitles", { query: { ...base, moviehash } }).catch(() => null));
    if (query) tasks.push(this.req("GET", "/subtitles", {
      query: { ...base, query, year: season ? undefined : year, season_number: season, episode_number: episode }
    }));
    const pages = await Promise.all(tasks);
    const seen = new Set(), out = [];
    for (const p of pages) for (const d of (p && p.data) || []) {
      const a = d.attributes || {}; const f = (a.files || [])[0];
      if (!f || seen.has(f.file_id)) continue; seen.add(f.file_id);
      const fd = a.feature_details || {};
      out.push({
        source: "os", fileId: f.file_id, fileName: f.file_name || a.release || "",
        lang: a.language || "", release: a.release || f.file_name || "",
        downloads: a.download_count || 0, rating: a.ratings || 0,
        trusted: !!a.from_trusted, hi: !!a.hearing_impaired,
        machine: !!(a.machine_translated || a.ai_translated), hashMatch: !!a.moviehash_match,
        fps: a.fps || 0, uploader: (a.uploader && a.uploader.name) || "",
        title: fd.movie_name || fd.title || "", year: fd.year || "", imdb: fd.imdb_id || ""
      });
    }
    out.sort((x, y) => (y.hashMatch - x.hashMatch) || (y.trusted - x.trusted) || (y.downloads - x.downloads));
    return out;
  }

  // Скачивание: POST /download -> временная ссылка -> содержимое файла
  async download(fileId) {
    let j;
    try { j = await this.req("POST", "/download", { auth: true, body: { file_id: fileId, sub_format: "srt" } }); }
    catch (e) {
      if (e.status === 401 || e.code === "no_login") {
        await this.login(true);
        j = await this.req("POST", "/download", { auth: true, body: { file_id: fileId, sub_format: "srt" } });
      } else if (e.status === 406) {
        throw Object.assign(new Error("Лимит скачиваний на сегодня исчерпан" + (e.data && e.data.reset_time ? ` (сброс через ${e.data.reset_time})` : "")), { code: "quota" });
      } else throw e;
    }
    if (!j || !j.link) throw new Error("OpenSubtitles не дал ссылку на файл");
    const r = await fetch(j.link, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error("Не удалось скачать файл субтитров (" + r.status + ")");
    const buf = Buffer.from(await r.arrayBuffer());
    return { data: buf, fileName: j.file_name || "", remaining: j.remaining, resetTime: j.reset_time };
  }
}

module.exports = { OpenSubs };
