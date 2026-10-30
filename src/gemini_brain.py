"""Agentning miyasi: Gemini orqali content plan va post matni (caption)."""
import json
import google.generativeai as genai

from common import env, load_config, load_json, SAMPLES_FILE


def _model():
    genai.configure(api_key=env("GEMINI_API_KEY", required=True))
    cfg = load_config()
    return genai.GenerativeModel(cfg["gemini"]["text_model"])


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

Javobni FAQAT quyidagi JSON formatida ber, boshqa hech narsa yozma:
{{
  "hook": "rasm ustiga chiqadigan qisqa sarlavha (max 60 belgi)",
  "caption": "to'liq post matni (emoji bilan)",
  "theme": "post mavzusi 1-2 so'zda",
  "image_prompt": "AGAR AI rasm yaratilsa, ingliz tilida foto-realistik, premium, {b['name']} uslubidagi rasm uchun prompt (odamsiz yoki noaniq yuzli, matnsiz)"
}}"""

    resp = _model().generate_content(prompt)
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
