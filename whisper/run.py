# Расшифровка речи фильма через faster-whisper (модель уже скачана в кэш Hugging Face).
# Вызов: python run.py <audio.wav> <out.json> <model> <language|auto>
# В stdout пишет строки JSON: {"p": 0.42} — прогресс, {"info": ...} — устройство и язык.
import json
import os
import sys


def say(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load(size):
    from faster_whisper import WhisperModel
    last = None
    # сначала из кэша без интернета, потом с загрузкой
    for offline in ("1", "0"):
        os.environ["HF_HUB_OFFLINE"] = offline
        for device, ctype in (("cuda", "float16"), ("cpu", "int8")):
            try:
                return WhisperModel(size, device=device, compute_type=ctype), device
            except Exception as e:  # нет CUDA или модели в кэше
                last = e
    raise last


def main():
    audio, out, size, lang = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    model, device = load(size)
    say({"info": {"device": device, "model": size}})

    def run(m):
        segs, info = m.transcribe(audio, language=None if lang == "auto" else lang, word_timestamps=True,
                                  vad_filter=True, beam_size=5, condition_on_previous_text=False)
        say({"info": {"language": info.language, "duration": info.duration}})
        res = []
        for s in segs:
            words = [[round(w.start, 2), round(w.end, 2), w.word] for w in (s.words or [])]
            res.append({"s": round(s.start, 2), "e": round(s.end, 2), "text": s.text.strip(), "words": words})
            if info.duration:
                say({"p": round(min(1.0, s.end / info.duration), 3)})
        return res, info

    try:
        res, info = run(model)
    except Exception as e:
        # видеокарта не справилась (не хватает библиотек CUDA) — повторяем на процессоре
        if device != "cuda":
            raise
        say({"info": {"device": "cpu", "fallback": str(e)[:200]}})
        from faster_whisper import WhisperModel
        res, info = run(WhisperModel(size, device="cpu", compute_type="int8"))

    with open(out, "w", encoding="utf-8") as f:
        json.dump({"language": info.language, "duration": info.duration, "segments": res}, f, ensure_ascii=False)
    say({"done": True, "segments": len(res)})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        say({"error": str(e)[:500]})
        sys.exit(1)
