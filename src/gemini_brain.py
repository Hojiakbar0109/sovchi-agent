"""Agentning miyasi: Gemini orqali content plan va post matni (caption)."""
import json
import google.generativeai as genai
from google.api_core import exceptions as gexc

from common import ROOT, env, load_config, load_json, load_queue, SAMPLES_FILE


# Matn uchun bo'lmagan modellar (rasm, ovoz, embedding va h.k.) — chetlab o'tiladi
_NON_TEXT = ("image", "tts", "audio", "speech", "embedding", "aqa", "vision",
             "imagen", "veo", "live", "native-audio", "dialog")


def _candidate_models():
    """Sinab ko'riladigan MATN modellari: avval config'dagi, keyin mavjudlari
    (flash → oldin, lite → keyin, pro → oxirida). Model nomi o'zgarsa yoki
    bittasining kunlik limiti tugasa, agent boshqasiga o'tib ketadi."""
    cfg = load_config()
    order = [cfg["gemini"]["text_model"]]
    try:
        available = []
        for m in genai.list_models():
            name = m.name.replace("models/", "")
            if "generateContent" not in getattr(m, "supported_generation_methods", []):
                continue
            low = name.lower()
            if any(bad in low for bad in _NON_TEXT):
                continue
            available.append(name)
        available.sort(key=lambda n: (("flash" not in n.lower()),
                                       ("lite" in n.lower()),
                                       ("pro" in n.lower()), n))
        for n in available:
            if n not in order:
                order.append(n)
    except Exception as e:
        print(f"Model ro'yxatini olishda ogohlantirish: {e}")
    return order


def _complete(prompt):
    """Modellarni navbatma-navbat sinab, birinchi ishlaganidan javob oladi.
    Har qanday xatoda keyingi modelga o'tadi (bittasi ishlamay qolsa to'xtamaydi)."""
    genai.configure(api_key=env("GEMINI_API_KEY", required=True))
    last_err = None
    for name in _candidate_models():
        try:
            resp = genai.GenerativeModel(name).generate_content(prompt)
            if resp and getattr(resp, "text", None):
                print(f"Model ishlatildi: {name}")
                return resp
            print(f"Model '{name}' bo'sh javob berdi, keyingisiga o'tyapman.")
        except Exception as e:
            print(f"Model '{name}' ishlamadi ({type(e).__name__}), keyingisiga o'tyapman.")
            last_err = e
    raise last_err if last_err else RuntimeError("Hech qaysi model javob bermadi")


def _samples_block():
    """Eski postlardan o'rganilgan namunalar (bo'lmasa bo'sh)."""
    samples = load_json(SAMPLES_FILE, {"posts": []}).get("posts", [])
    if not samples:
        return "(Hali eski post namunalari yuklanmagan.)"
    lines = []
    for i, p in enumerate(samples[-15:], 1):
        lines.append(f"{i}. {p.get('text', '').strip()}")
    return "\n".join(lines)


def _playbook():
    f = ROOT / "playbook.md"
    return f.read_text(encoding="utf-8").strip() if f.exists() else ""


def _history_block():
    """Oxirgi postlar (ustun/format/hook) — takrorlanmaslik va ustunlarni almashtirish uchun."""
    posts = load_queue().get("posts", [])[-14:]
    if not posts:
        return "(Hali tarix yo'q.)"
    lines = []
    for p in reversed(posts):
        tag = "ADMIN RAD ETGAN" if p.get("status") == "rejected" else "chiqqan"
        body = " ".join(str(p.get("caption", "")).split())[:140]
        lines.append(f"- [{tag}] ustun={p.get('pillar', '?')} format={p.get('post_format', '?')} "
                     f"mavzu={p.get('theme', '')} | {body}")
    return "\n".join(lines)


def _now_block():
    from datetime import datetime, timedelta, timezone
    d = datetime.now(timezone.utc) + timedelta(hours=5)  # Toshkent = UTC+5 (yozgi vaqt yo'q)
    return f"Bugun (Toshkent): {d.strftime('%A, %d %B %Y')}."


def _header(b):
    return f"""{_playbook()}

BREND: {b['name']} — o'zbek tilidagi jiddiy tanishuv / nikoh ilovasi. Shiori: "{b['tagline']}".
{b['users_label']} foydalanuvchi, Telegram bot va mobil ilova mavjud.
OVOZ (uslub): {b['voice']}

KANALNING ESKI POSTLARI (uslub va ohangni o'rgan):
{_samples_block()}

OXIRGI POSTLAR TARIXI (ustunlar va hooklarni TAKRORLAMA; "ADMIN RAD ETGAN" yo'nalishdan qoch):
{_history_block()}

{_now_block()} Mavsum, hafta kuni va yaqin bayramlarni o'rinli bo'lsagina hisobga ol."""


def _rules(b):
    return f"""Qoidalar:
- Faqat o'zbek tilida (lotin).
- Foydalanuvchi sonini "{b['users_label']}" ko'rinishida yoz (faqat o'rinli joyda).
- Caption 500-850 belgi (QATIY 900 dan oshmasin). 1-3 ta emoji. Oxirida yengil, har safar boshqacha CTA.
- MATNDA HAVOLA (URL, https, play.google...) yoki "sovchi.app" so'zini YOZMA — havola alohida qo'shiladi."""


def _image_rules():
    safe = ", ".join(load_config().get("media", {}).get("safe_queries", []))
    return ("RASM QOIDASI (image_query uchun): brend halol, oilaviy niyatli o'zbek/musulmon auditoriyaga mo'ljallangan. "
            "Query bosiq, oddiy, hurmatli bo'lsin. Romantik/yaqinlik/sevishganlar (kiss, hug, romantic couple, "
            "silhouette couple, intimate, dating, bed, bikini...) MUMKIN EMAS. Odamlar kerak bo'lsa — oila, ota-ona, "
            "uzoqdagi bosiq juftlik. Afzal mavzular: " + safe + ". Shubhali bo'lsa shulardan birini tanla.")


POST_JSON = """Javobni FAQAT quyidagi JSON formatida ber, boshqa hech narsa yozma:
{
  "hook": "rasm ustiga chiqadigan sarlavha (max 60 belgi, hook formulalaridan biri, o'ziga xos)",
  "caption": "to'liq post matni (emoji bilan, ko'z yugurtirib o'qiladigan)",
  "theme": "post mavzusi 1-2 so'zda",
  "pillar": "kontent ustuni nomi (ISHONCH, AMALIY MASLAHAT, MIF VA HAQIQAT, HIKOYA, SAVOL, ILOVA, QADRIYAT yoki MAVSUMIY)",
  "post_format": "format (ro'yxat, mif/haqiqat, mini-hikoya, savol/tanlov, qo'llanma, ilova-imkoniyat, esse)",
  "image_query": "stok rasm/video qidirish uchun 2-4 ta INGLIZCHA so'z (RASM QOIDASIga qara)",
  "image_prompt": "AGAR AI rasm yaratilsa: ingliz tilida foto-realistik prompt (odamsiz yoki noaniq yuzli, matnsiz)"
}"""

PLAN_JSON = """Javobni FAQAT quyidagi JSON formatida ber:
{
  "pillar": "tanlangan ustun",
  "post_format": "tanlangan format",
  "audience_pain": "bu post qaysi aniq og'riq/savolga javob beradi (1 gap)",
  "angle": "o'ziga xos burchak: nima yangilik/kutilmagan fikr beradi (1-2 gap)",
  "hook_options": ["hook 1", "hook 2", "hook 3"],
  "cta": "CTA turi (saqlab qo'y / do'stingga yubor / ilovani och / savolga javob yoz)",
  "why": "nega aynan shu hozir (tarix va mavsumga ko'ra, 1 gap)"
}"""


def _json_call(prompt):
    resp = _complete(prompt)
    text = resp.text.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    return json.loads(text.strip())


def _trim_caption(post, limit=880):
    """Telegram caption chegarasi (1024) — havola qo'shilgach sig'sin."""
    cap = post.get("caption", "").strip()
    if len(cap) > limit:
        cut = cap[:limit]
        end = max(cut.rfind(". "), cut.rfind("\n"), cut.rfind("! "), cut.rfind("? "))
        cap = cut[:end + 1] if end > limit * 0.6 else cut.rstrip()
    post["caption"] = cap
    return post


def _write(task, plan=None):
    """2-bosqich: reja (bo'lsa) asosida postni yozadi, keyin 3-bosqich — muharrir tekshiruvi."""
    b = load_config()["brand"]
    plan_txt = ""
    if plan:
        plan_txt = ("\nSTRATEGIYA REJASI (shunga amal qil, hook_options ichidan eng kuchlisini tanla yoki yaxshila):\n"
                    + json.dumps(plan, ensure_ascii=False, indent=2) + "\n")
    draft = _json_call(f"{_header(b)}\n\nVAZIFA: {task}\n{plan_txt}\n{_rules(b)}\n{_image_rules()}\n\n{POST_JSON}")
    try:
        review = (f"{_header(b)}\n\nVAZIFA: MUHARRIR. Quyidagi draftni SIFAT TEKSHIRUVI bo'yicha qattiq baho ber. "
                  f"Hook kuchsiz yoki umumiy bo'lsa — almashtir. Bo'sh gaplarni olib tashla, qiymatni aniqlashtir, "
                  f"keraksiz so'zlarni qisqartir. Soxta fakt, haqiqiy bo'lmagan va'da yoki romantik ohang bo'lsa — to'g'rila. "
                  f"Draft yaxshi bo'lsa deyarli o'zgartirma.\n\nDRAFT:\n{json.dumps(draft, ensure_ascii=False)}\n\n"
                  f"{_rules(b)}\n{_image_rules()}\n\n{POST_JSON}")
        final = _json_call(review)
        if final.get("hook") and final.get("caption"):
            draft = final
    except Exception as e:
        print(f"Muharrir bosqichi o'tkazib yuborildi: {type(e).__name__}")
    return _trim_caption(draft)


def generate_post(extra=None):
    """3 bosqich: strategiya -> yozish -> muharrir. extra — admin yo'nalishi (ixtiyoriy)."""
    b = load_config()["brand"]
    direction = f"\nADMIN YO'NALISHI (hisobga ol): {extra}" if extra else ""
    plan = None
    try:
        plan = _json_call(f"{_header(b)}\n\nVAZIFA: STRATEGIYA. Tarixga qarab keyingi post uchun eng yaxshi "
                          f"rejani tuz: ustunni (oxirgilardan FARQLI), formatni, auditoriya og'rig'ini va "
                          f"o'ziga xos burchakni tanla.{direction}\n\n{PLAN_JSON}")
        print(f"Reja: {plan.get('pillar')} / {plan.get('post_format')} — {plan.get('angle')}")
    except Exception as e:
        print(f"Strategiya bosqichi o'tkazib yuborildi: {type(e).__name__}")
    return _write("shu uslubda, kanalga yangi BITTA kuchli post yoz." + direction, plan)


def revise_post(current_caption, comment):
    """Mavjud postni admin izohi asosida qayta yozadi."""
    return _write(f"quyidagi MAVJUD postni admin izohi asosida QAYTA yoz.\n\n--- MAVJUD POST ---\n"
                  f"{current_caption}\n--- TUGADI ---\n\nADMIN IZOHI (shunga amal qil): {comment}\n\n"
                  f"Izohga mos ravishda yaxshila, lekin brend uslubi va playbook qoidalarini saqla.")


def adapt_post(source_text):
    """Boshqa kanaldan olingan postdan g'oya olib, sovchi.app uchun yangidan yozadi."""
    return _write(f"quyidagi BOSHQA kanaldagi postdan faqat G'OYA/mavzuni ol va butunlay sovchi.app uchun, "
                  f"o'z uslubimizda qaytadan yoz (ko'chirma qilma).\n\n--- MANBA POST ---\n{source_text}\n--- TUGADI ---")


if __name__ == "__main__":
    print(json.dumps(generate_post(), ensure_ascii=False, indent=2))
