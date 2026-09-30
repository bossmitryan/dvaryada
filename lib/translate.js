// Перевод слов и целых дорожек.
//  - "google": бесплатный публичный эндпоинт Google Translate (без ключа), словарные значения
//  - "claude": Claude API с ключом Anthropic — перевод с учётом контекста фразы, пояснения
"use strict";

const LANG_CODES = { "русский": "ru", "украинский": "uk", "английский": "en", "немецкий": "de", "испанский": "es", "французский": "fr", "итальянский": "it", "японский": "ja", "корейский": "ko" };
const POS_RU = { noun: "сущ.", verb: "глаг.", adjective: "прил.", adverb: "нареч.", pronoun: "мест.", preposition: "предл.", conjunction: "союз", interjection: "межд.", abbreviation: "сокр.", phrase: "фраза", article: "артикль", particle: "частица" };

async function googleWord(text, target) {
  const tl = LANG_CODES[target] || "ru";
  const u = new URL("https://translate.googleapis.com/translate_a/single");
  u.search = new URLSearchParams({ client: "gtx", sl: "auto", tl, dj: "1", q: text }).toString();
  ["t", "bd", "rm"].forEach(d => u.searchParams.append("dt", d));
  const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("Google Translate: " + r.status);
  const j = await r.json();
  const tr = (j.sentences || []).map(s => s.trans || "").join("").trim();
  const ipa = (j.sentences || []).map(s => s.src_translit || "").join("").trim();
  const alts = [], poss = [];
  for (const d of j.dict || []) {
    if (d.pos) poss.push(POS_RU[d.pos] || d.pos);
    for (const t of d.terms || []) if (t && t.toLowerCase() !== tr.toLowerCase() && !alts.includes(t)) alts.push(t);
  }
  return { tr, alts: alts.slice(0, 4), pos: poss.slice(0, 2).join(", "), ipa, lemma: "", note: "", src: j.src || "" };
}

// MyMemory — бесплатный переводчик без ключа (доступен там, где Google не открывается)
async function myMemory(text, target, src = "en") {
  const tl = LANG_CODES[target] || "ru";
  const sl = src && src !== "auto" ? src : (/[\u0400-\u04FF]/.test(text) ? "ru" : "en");
  const u = new URL("https://api.mymemory.translated.net/get");
  u.searchParams.set("q", text.slice(0, 480)); u.searchParams.set("langpair", `${sl}|${tl}`);
  const r = await fetch(u);
  if (!r.ok) throw new Error("MyMemory: " + r.status);
  const j = await r.json();
  if (j.quotaFinished) throw new Error("MyMemory: дневной лимит исчерпан");
  const tr = (j.responseData && j.responseData.translatedText) || "";
  const alts = [];
  for (const m of j.matches || []) { const t = (m.translation || "").trim(); if (t && t.toLowerCase() !== tr.toLowerCase() && !alts.some(a => a.toLowerCase() === t.toLowerCase())) alts.push(t); }
  return { tr, alts: alts.slice(0, 4), pos: "", ipa: "", lemma: "", note: "" };
}

// Бесплатный английский словарь: транскрипция и начальная форма, если есть
async function englishIpa(word) {
  if (!/^[a-z'’-]+$/i.test(word)) return "";
  try {
    const r = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word.toLowerCase()));
    if (!r.ok) return "";
    const j = await r.json();
    for (const e of j) { if (e.phonetic) return e.phonetic; for (const p of e.phonetics || []) if (p.text) return p.text; }
  } catch {}
  return "";
}

async function claude(apiKey, prompt, maxTokens = 600) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] })
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error("Claude API: " + ((j && j.error && j.error.message) || r.status));
  return (j.content || []).map(c => c.text || "").join("");
}
function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) { try { return JSON.parse(m[1]); } catch {} }
  const a = text.search(/[\[{]/), b = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1));
  throw new Error("Ответ не в формате JSON");
}

async function translateWord({ provider, apiKey, text, sentence, parallel, target, srcLang }) {
  const errors = [];
  if (provider === "claude" && apiKey) {
    try {
      const prompt = `You are a bilingual dictionary inside a movie player for language learners.
Translate the selected text into ${target} AS IT IS USED in this subtitle line. Reply with ONLY a JSON object:
{"lemma": dictionary form, "ipa": IPA of the selected text or "" for phrases longer than 3 words, "pos": part of speech in ${target} (short), "tr": best translation in this context, "alts": up to 3 other common translations, "note": one or two short sentences in ${target} about meaning/nuance here (idiom, slang, grammar)}
Selected text: ${JSON.stringify(text)}
Subtitle line: ${JSON.stringify(sentence || text)}${parallel ? `\nParallel subtitle line: ${JSON.stringify(parallel)}` : ""}`;
      const r = parseJson(await claude(apiKey, prompt));
      return { tr: String(r.tr || ""), alts: Array.isArray(r.alts) ? r.alts.slice(0, 3) : [], pos: r.pos || "", ipa: r.ipa || "", lemma: r.lemma || "", note: r.note || "", via: "Claude" };
    } catch (e) { errors.push(e.message); }
  }
  try {
    const g = await googleWord(text, target);
    if (!g.ipa && text.split(/\s+/).length === 1) g.ipa = await englishIpa(text);
    return { ...g, via: "Google" };
  } catch (e) { errors.push("Google недоступен"); }
  try {
    const m = await myMemory(text, target, srcLang);
    if (text.split(/\s+/).length === 1) m.ipa = await englishIpa(text);
    return { ...m, via: "MyMemory", note: errors.length && provider === "claude" ? "Claude не ответил: " + errors[0] : "" };
  } catch (e) { errors.push(e.message); }
  throw new Error(errors.join("; "));
}

// Перевод пачки строк (для генерации второй дорожки)
async function googleLines(lines, target) {
  const tl = LANG_CODES[target] || "ru";
  const joined = lines.map(l => l.replace(/\n/g, " ")).join("\n");
  const r = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&dj=1&sl=auto&tl=" + tl, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0" },
    body: "q=" + encodeURIComponent(joined)
  });
  if (!r.ok) throw new Error("Google Translate: " + r.status);
  const j = await r.json();
  const out = (j.sentences || []).map(s => s.trans || "").join("").split("\n");
  return lines.map((_, i) => (out[i] || "").trim());
}

async function translateLines({ provider, apiKey, lines, target, context }) {
  if (provider === "claude" && apiKey) {
    const prompt = `Translate these movie subtitle lines into ${target}. Keep them short and natural like professional subtitles; keep names; translate slang by meaning. Reply with ONLY a JSON array of exactly ${lines.length} strings, same order.
${context && context.length ? `Previous lines for context (do not translate): ${JSON.stringify(context)}\n` : ""}Lines: ${JSON.stringify(lines)}`;
    const arr = parseJson(await claude(apiKey, prompt, 4000));
    return lines.map((_, i) => String((Array.isArray(arr) ? arr[i] : "") || ""));
  }
  try { return await googleLines(lines, target); }
  catch {
    // MyMemory: по строке, с маленьким дневным лимитом — годится только для коротких кусков
    const out = [];
    for (const l of lines) out.push((await myMemory(l.replace(/\n/g, " "), target)).tr);
    return out;
  }
}

module.exports = { translateWord, translateLines, LANG_CODES };
