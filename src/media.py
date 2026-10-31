"""Media: brend uslubidagi dizayn-kartochka (asosiy) + ixtiyoriy AI rasm."""
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from common import ROOT, load_config

W, H = 1080, 1350  # portret, Instagram/Telegram uchun qulay

FONT_CANDIDATES_BOLD = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]
FONT_CANDIDATES_REG = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]


def _hex(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _font(size, bold=True):
    for p in (FONT_CANDIDATES_BOLD if bold else FONT_CANDIDATES_REG):
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def make_card(hook, theme, out_path):
    cfg = load_config()["brand"]
    bg = _hex(cfg["colors"]["background"])
    primary = _hex(cfg["colors"]["primary"])
    dark = _hex(cfg["colors"]["text_dark"])
    light = _hex(cfg["colors"]["text_light"])

    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)

    # Yuqori qizil aksent chiziq
    d.rectangle([0, 0, W, 18], fill=primary)

    # Yuqori o'ngda "7k+ foydalanuvchi" badge
    badge = f"{cfg['users_label']} foydalanuvchi"
    bf = _font(34, bold=True)
    bw = d.textlength(badge, font=bf)
    pad = 24
    d.rounded_rectangle([W - bw - pad * 2 - 60, 60, W - 60, 60 + 64],
                        radius=32, fill=primary)
    d.text((W - bw - pad - 60, 60 + 14), badge, font=bf, fill=light)

    # Mavzu kicheri (yuqori chap)
    if theme:
        kf = _font(30, bold=True)
        d.text((60, 78), theme.upper(), font=kf, fill=primary)

    # Markazda katta hook matni
    hf = _font(72, bold=True)
    wrapped = textwrap.fill(hook, width=18)
    lines = wrapped.split("\n")
    line_h = 92
    block_h = line_h * len(lines)
    y = (H - block_h) // 2 - 40
    for line in lines:
        lw = d.textlength(line, font=hf)
        d.text(((W - lw) / 2, y), line, font=hf, fill=dark)
        y += line_h

    # Hook ostida qisqa qizil chiziq
    d.rounded_rectangle([(W - 160) / 2, y + 24, (W + 160) / 2, y + 36],
                        radius=6, fill=primary)

    # Pastda brend nomi + shior
    nf = _font(56, bold=True)
    nm = cfg["name"]
    nw = d.textlength(nm, font=nf)
    d.text(((W - nw) / 2, H - 230), nm, font=nf, fill=primary)

    tf = _font(34, bold=False)
    tg = cfg["tagline"]
    tw = d.textlength(tg, font=tf)
    d.text(((W - tw) / 2, H - 160), tg, font=tf, fill=dark)

    # Agar logo fayli bor bo'lsa — pastki o'ngga qo'yish
    logo_path = ROOT / cfg.get("logo_file", "")
    if logo_path.exists():
        try:
            logo = Image.open(logo_path).convert("RGBA")
            lw2 = 220
            lh2 = int(logo.height * (lw2 / logo.width))
            logo = logo.resize((lw2, lh2))
            img.paste(logo, ((W - lw2) // 2, H - 110), logo)
        except Exception:
            pass

    # Pastki qizil chiziq
    d.rectangle([0, H - 18, W, H], fill=primary)

    img.save(out_path, "PNG")
    return out_path


def pick_sticker():
    """Kutubxonadan tasodifiy stiker file_id qaytaradi (bo'lmasa None)."""
    import random
    from common import load_json, STICKERS_FILE
    stickers = load_json(STICKERS_FILE, {"stickers": []}).get("stickers", [])
    return random.choice(stickers) if stickers else None


def make_ai_image(image_prompt, out_path):
    """Gemini orqali AI rasm (ixtiyoriy). Xato bo'lsa None qaytaradi."""
    try:
        import google.generativeai as genai
        from common import env
        cfg = load_config()
        genai.configure(api_key=env("GEMINI_API_KEY", required=True))
        model = genai.GenerativeModel(cfg["gemini"]["image_model"])
        resp = model.generate_content(image_prompt)
        for part in resp.candidates[0].content.parts:
            if getattr(part, "inline_data", None):
                with open(out_path, "wb") as f:
                    f.write(part.inline_data.data)
                return out_path
    except Exception as e:
        print(f"AI rasm yaratilmadi (kartochkaga qaytamiz): {e}")
    return None


if __name__ == "__main__":
    make_card("AI sizga eng mos insonni qanday topadi?", "tanishuv",
              str(ROOT / "output" / "test_card.png"))
    print("Test kartochka: output/test_card.png")
