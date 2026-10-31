"""Agentning miyasi: Gemini orqali content plan va post matni (caption)."""
import json
import google.generativeai as genai
from google.api_core import exceptions as gexc

from common import env, load_config, load_json, SAMPLES_FILE


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


def _rules(b):
    return f"""Qoidalar:
- Faqat o'zbek tilida (lotin).
- Qiziqarli, odamni ushlab turadigan "hook" bilan boshlansin.
- Jiddiy munosabat, ishonch, tanishuv mavzusida qiymat bersin.
- "80 ta reaksiya bosing" kabi passiv so'rovlar YO'Q.
- Foydalanuvchi sonini "{b['users_label']}" ko'rinishida yoz.
- Caption 400-700 belgi. 1-3 ta mos emoji. Oxirida yengil CTA (ilovani ochish).
- MATNDA HAVOLA (URL, https, play.google...) yoki "sovchi.app" so'zini YOZMA — havola alohida, chiroyli tugma/so'z ko'rinishida qo'shiladi."""


def _json_format(b):
    return """Javobni FAQAT quyidagi JSON formatida ber, boshqa hech narsa yozma:
{{
  "hook": "rasm ustiga chiqadigan qisqa sarlavha (max 60 belgi)",
  "caption": "to'liq post matni (emoji bilan)",
  "theme": "post mavzusi 1-2 so'zda",
  "image_query": "stok rasm/video qidirish uchun 2-4 ta INGLIZCHA so'z. FAQAT bosiq, oddiy, hurmatli, oilaviy mavzu (pastdagi RASM QOIDASIga qara)",
  "image_prompt": "AGAR AI rasm yaratilsa, ingliz tilida foto-realistik, premium, uslubdagi rasm uchun prompt (odamsiz yoki noaniq yuzli, matnsiz)"
}}""".replace("{{", "{").replace("}}", "}")


def _header(b):
    return f"""Sen {b['name']} uchun professional SMM mutaxassisisan.
Bu — o'zbek tilidagi jiddiy tanishuv / nikoh ilovasi. Shiori: "{b['tagline']}".
{b['users_label']} foydalanuvchi, Telegram bot va mobil ilova mavjud.

OVOZ (uslub): {b['voice']}

KANALNING ESKI POSTLARI (shulardan uslub, mavzu va ohangni o'rgan):
{_samples_block()}"""


def _image_rules():
    safe = ", ".join(load_config().get("media", {}).get("safe_queries", []))
    return ("RASM QOIDASI (image_query uchun): brend halol, oilaviy niyatli o'zbek/musulmon auditoriyaga mo'ljallangan. "
            "Query bosiq, oddiy, hurmatli bo'lsin. Romantik/yaqinlik/sevishganlar (kiss, hug, romantic couple, "
            "silhouette couple, intimate, dating, bed, bikini...) MUMKIN EMAS. Odamlar kerak bo'lsa — oila, ota-ona, "
            "uzoqdagi bosiq juftlik. Afzal mavzular: " + safe + ". Shubhali bo'lsa shulardan birini tanla.")


def _ask(task):
    """Umumiy so'rov: header + vazifa + qoidalar + JSON format."""
    cfg = load_config()
    b = cfg["brand"]
    prompt = f"{_header(b)}\n\n{task}\n{_rules(b)}\n\n{_json_format(b)}"
    resp = _complete(prompt)
    text = resp.text.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    return json.loads(text.strip())


def generate_post(extra=None):
    """Yangi post yaratadi. extra — qo'shimcha mavzu/yo'nalish (ixtiyoriy)."""
    task = "VAZIFA: shu uslubda, kanalga yangi BITTA post yoz."
    if extra:
        task += f"\nQo'shimcha yo'nalish: {extra}"
    return _ask(task)


def revise_post(current_caption, comment):
    """Mavjud postni admin izohi asosida qayta yozadi."""
    task = (f"VAZIFA: quyidagi MAVJUD postni admin izohi asosida QAYTA yoz.\n\n"
            f"--- MAVJUD POST ---\n{current_caption}\n--- TUGADI ---\n\n"
            f"ADMIN IZOHI (shunga amal qil): {comment}\n\n"
            f"Izohga mos ravishda postni yaxshila, lekin brend uslubini saqla.")
    return _ask(task)


def adapt_post(source_text):
    """Boshqa kanaldan olingan postni sovchi.app brendi va uslubiga moslaydi."""
    task = (f"VAZIFA: quyidagi BOSHQA kanaldagi postdan G'OYA olib, uni butunlay "
            f"sovchi.app uchun qaytadan yoz. Matnni ko'chirma — faqat g'oya/mavzuni "
            f"ol va o'z uslubimizda, o'z brendimiz uchun yangi post qil.\n\n"
            f"--- MANBA POST ---\n{source_text}\n--- TUGADI ---")
    return _ask(task)


if __name__ == "__main__":
    print(json.dumps(generate_post(), ensure_ascii=False, indent=2))
