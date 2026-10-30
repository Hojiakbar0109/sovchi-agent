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


def generate_post():
    """Bugungi post uchun matn va rasm g'oyasini qaytaradi."""
    cfg = load_config()
    b = cfg["brand"]

    prompt = f"""Sen {b['name']} uchun professional SMM mutaxassisisan.
Bu — o'zbek tilidagi jiddiy tanishuv / nikoh ilovasi. Shiori: "{b['tagline']}".
{b['users_label']} foydalanuvchi, Telegram bot va mobil ilova mavjud.

OVOZ (uslub): {b['voice']}

KANALNING ESKI POSTLARI (shulardan uslub, mavzu va ohangni o'rgan):
{_samples_block()}

VAZIFA: shu uslubda, kanalga yangi BITTA post yoz.
Qoidalar:
- Faqat o'zbek tilida (lotin).
- Qiziqarli, odamni ushlab turadigan "hook" bilan boshlansin.
- Jiddiy munosabat, ishonch, tanishuv mavzusida qiymat bersin.
- "80 ta reaksiya bosing" kabi passiv so'rovlar YO'Q.
- Foydalanuvchi sonini "{b['users_label']}" ko'rinishida yoz.
- Caption 400-700 belgi. 1-3 ta mos emoji. Oxirida yengil CTA (ilovani ochish).
- MATNDA HAVOLA (URL, https, play.google...) yoki "sovchi.app" so'zini YOZMA — havola alohida, chiroyli tugma/so'z ko'rinishida qo'shiladi.

Javobni FAQAT quyidagi JSON formatida ber, boshqa hech narsa yozma:
{{
  "hook": "rasm ustiga chiqadigan qisqa sarlavha (max 60 belgi)",
  "caption": "to'liq post matni (emoji bilan)",
  "theme": "post mavzusi 1-2 so'zda",
  "image_prompt": "AGAR AI rasm yaratilsa, ingliz tilida foto-realistik, premium, {b['name']} uslubidagi rasm uchun prompt (odamsiz yoki noaniq yuzli, matnsiz)"
}}"""

    resp = _complete(prompt)
    text = resp.text.strip()
    # JSON ni tozalash (``` bo'lsa)
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    data = json.loads(text.strip())
    return data


if __name__ == "__main__":
    print(json.dumps(generate_post(), ensure_ascii=False, indent=2))
