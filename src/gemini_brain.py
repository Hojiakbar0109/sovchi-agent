"""Agentning miyasi: Gemini orqali content plan va post matni (caption)."""
import json
import google.generativeai as genai
from google.api_core import exceptions as gexc

from common import env, load_config, load_json, SAMPLES_FILE


def _candidate_models():
    """Sinab ko'riladigan modellar ro'yxati: avval config'dagi, keyin
    mavjud modellardan (flash — avval, pro — oxirida). Shu tufayli model nomi
    o'zgarsa yoki bittasining kunlik limiti tugasa, agent to'xtamaydi."""
    cfg = load_config()
    primary = cfg["gemini"]["text_model"]
    order = [primary]
    try:
        available = []
        for m in genai.list_models():
            if "generateContent" in getattr(m, "supported_generation_methods", []):
                available.append(m.name.replace("models/", ""))
        # flash-larni oldinга, pro-larni oxirga qo'yish
        available.sort(key=lambda n: (("flash" not in n), ("pro" in n), n))
        for n in available:
            if n not in order:
                order.append(n)
    except Exception as e:
        print(f"Model ro'yxatini olishda ogohlantirish: {e}")
    return order


def _complete(prompt):
    """Modellarni navbatma-navbat sinab, birinchi ishlaganidan javob oladi."""
    genai.configure(api_key=env("GEMINI_API_KEY", required=True))
    last_err = None
    for name in _candidate_models():
        try:
            resp = genai.GenerativeModel(name).generate_content(prompt)
            print(f"Model ishlatildi: {name}")
            return resp
        except (gexc.NotFound, gexc.ResourceExhausted, gexc.PermissionDenied) as e:
            print(f"Model '{name}' ishlamadi ({type(e).__name__}), keyingisiga o'tyapman.")
            last_err = e
            continue
    raise last_err if last_err else RuntimeError("Hech qaysi model ishlamadi")


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
