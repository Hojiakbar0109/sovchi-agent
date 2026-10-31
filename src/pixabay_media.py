"""Pixabay rasm/video + brend overlay (gradient, hook, badge, logo).

Asosiy kirish: make_media(post, base_path, allow_video) -> (yo'l, 'image'|'video') yoki (None, None).
None qaytsa, chaqiruvchi brend-kartochkaga (media.make_card) qaytadi.
"""
import random
import re
import subprocess
import tempfile
import textwrap
from pathlib import Path

import requests
from PIL import Image, ImageDraw

from common import ROOT, load_config, env
from media import W, H, _font, _hex

PIXABAY_IMG = "https://pixabay.com/api/"
PIXABAY_VID = "https://pixabay.com/api/videos/"
MAX_VIDEO_BYTES = 45 * 1024 * 1024
VW, VH = 1080, 1920  # video 9:16


def _overlay(w, h, hook, theme):
    """Shaffof qatlam: pastdan qora gradient + oq hook + badge + logo + brend nomi.
    Har qanday foto/video ustida o'qiladi."""
    cfg = load_config()["brand"]
    primary = _hex(cfg["colors"]["primary"])
    light = _hex(cfg["colors"]["text_light"])
    ov = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    grad_h = int(h * 0.62)
    for i in range(grad_h):  # pastga qarab quyuqlashadi
        a = int(235 * (i / grad_h) ** 1.3)
        d.line([(0, h - grad_h + i), (w, h - grad_h + i)], fill=(0, 0, 0, a))
    ov.alpha_composite(Image.new("RGBA", (w, 200), (0, 0, 0, 80)), (0, 0))  # badge'lar uchun parda
    d = ImageDraw.Draw(ov)

    def pill(text, font, x, y, right=False):
        tw = d.textlength(text, font=font)
        bx = x - tw - 48 if right else x
        d.rounded_rectangle([bx, y, bx + tw + 48, y + 64], radius=32, fill=primary + (255,))
        d.text((bx + 24, y + 14), text, font=font, fill=light + (255,))

    bf = _font(30)
    if theme:
        pill(theme.upper(), bf, 60, 60)
    pill(f"{cfg['users_label']} foydalanuvchi", bf, w - 60, 60, right=True)

    hf = _font(72)
    lines = textwrap.fill(hook, width=20).split("\n")
    line_h = 92
    y = h - 330 - line_h * len(lines)
    for line in lines:
        d.text((72, y + 3), line, font=hf, fill=(0, 0, 0, 120))  # yengil soya
        d.text((70, y), line, font=hf, fill=(255, 255, 255, 255))
        y += line_h
    d.rounded_rectangle([70, y + 14, 210, y + 26], radius=6, fill=primary + (255,))

    d.text((70, h - 190), cfg["name"], font=_font(48), fill=(255, 255, 255, 255))
    d.text((70, h - 125), cfg["tagline"], font=_font(30, bold=False), fill=(255, 255, 255, 225))

    logo_path = ROOT / cfg.get("logo_file", "")
    if logo_path.is_file():
        try:
            logo = Image.open(logo_path).convert("RGBA")
            lw = 180
            logo = logo.resize((lw, int(logo.height * lw / logo.width)))
            ov.alpha_composite(logo, (w - lw - 60, h - 60 - logo.height))
        except Exception:
            pass
    return ov


def _cover(img, w, h):
    scale = max(w / img.width, h / img.height)
    img = img.resize((int(img.width * scale) + 1, int(img.height * scale) + 1), Image.LANCZOS)
    left, top = (img.width - w) // 2, (img.height - h) // 2
    return img.crop((left, top, left + w, top + h))


def _media_cfg():
    return load_config().get("media", {})


def _blocked_re():
    terms = _media_cfg().get("blocked_terms", [])
    return re.compile(r"\b(?:" + "|".join(re.escape(t) for t in terms) + r")\b", re.I) if terms else None


_COUPLE_RISK = re.compile(r"\b(love|romance|silhouette|sunset|beach|together|embrace)\b", re.I)


def _is_unsafe(text):
    """Teg/so'rov oilaviy brend uchun noto'g'rimi (romantik, yaqinlik, ...)."""
    rx = _blocked_re()
    if rx and rx.search(text):
        return True
    return bool(re.search(r"\bcouple\b", text, re.I) and _COUPLE_RISK.search(text))


def _clean(hits):
    return [h for h in hits if not _is_unsafe(h.get("tags", ""))]


def _queries(query):
    """Avval Gemini so'rovi (xavfsiz bo'lsa), keyin neytral zaxira so'rovlar."""
    safe = list(_media_cfg().get("safe_queries", []))
    random.shuffle(safe)
    return ([] if _is_unsafe(query) else [query]) + safe[:4]


def _search(url, query, extra_sets):
    """Birinchi xavfsiz natijalar to'plamini qaytaradi (bo'lmasa [])."""
    for q in _queries(query):
        for extra in extra_sets:
            hits = _clean(_pixabay_get(url, q, extra))
            if hits:
                return hits
    return []


def _pixabay_get(url, query, extra):
    r = requests.get(url, params={"key": env("PIXABAY_API_KEY"), "q": query[:100],
                                  "safesearch": "true", "per_page": 30, **extra}, timeout=20)
    r.raise_for_status()
    return r.json().get("hits", [])


def _download(url, out_path, limit=MAX_VIDEO_BYTES):
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        size = 0
        with open(out_path, "wb") as f:
            for chunk in r.iter_content(1 << 16):
                size += len(chunk)
                if size > limit:
                    raise RuntimeError("fayl juda katta")
                f.write(chunk)
    return out_path


def make_photo_post(query, hook, theme, out_path):
    """Pixabay rasmi + brend overlay. Topilmasa/xato bo'lsa None."""
    try:
        hits = _pixabay_get(PIXABAY_IMG, query, {"image_type": "photo", "orientation": "vertical"}) \
            or _pixabay_get(PIXABAY_IMG, query, {"image_type": "photo"})
        if not hits:
            return None
        hit = random.choice(hits[:20])
        src = hit.get("largeImageURL") or hit.get("webformatURL")
        with tempfile.TemporaryDirectory() as td:
            raw = _download(src, Path(td) / "src.jpg", 25 * 1024 * 1024)
            img = _cover(Image.open(raw).convert("RGB"), W, H).convert("RGBA")
        img.alpha_composite(_overlay(W, H, hook, theme))
        img.convert("RGB").save(out_path, "JPEG", quality=90)
        return out_path
    except Exception as e:
        print(f"Pixabay rasm olinmadi (kartochkaga qaytamiz): {e}")
        return None


def make_video_post(query, hook, theme, out_path):
    """Pixabay videosi (tiny/small, <45MB) + brend overlay, 9:16, ffmpeg bilan."""
    try:
        hits = _search(PIXABAY_VID, query, [{}])
        random.shuffle(hits)
        for hit in hits[:6]:
            v = next((hit["videos"][k] for k in ("small", "tiny")
                      if hit["videos"].get(k, {}).get("url")
                      and 0 < hit["videos"][k].get("size", 0) <= MAX_VIDEO_BYTES), None)
            if not v:
                continue
            with tempfile.TemporaryDirectory() as td:
                src, ovp = Path(td) / "src.mp4", Path(td) / "ov.png"
                _download(v["url"], src)
                _overlay(VW, VH, hook, theme).save(ovp)
                cmd = ["ffmpeg", "-y", "-i", str(src), "-i", str(ovp), "-filter_complex",
                       f"[0:v]scale={VW}:{VH}:force_original_aspect_ratio=increase,"
                       f"crop={VW}:{VH},setsar=1[bg];[bg][1:v]overlay=0:0,format=yuv420p[v]",
                       "-map", "[v]", "-an", "-t", "30", "-c:v", "libx264", "-preset", "veryfast",
                       "-crf", "27", "-movflags", "+faststart", str(out_path)]
                subprocess.run(cmd, check=True, capture_output=True, timeout=240)
            out = Path(out_path)
            if out.exists() and out.stat().st_size < MAX_VIDEO_BYTES:
                return out_path
        return None
    except Exception as e:
        print(f"Pixabay video olinmadi (rasmga qaytamiz): {e}")
        return None


def make_media(post, base_path, allow_video=False):
    """(yo'l, 'image'|'video') yoki (None, None). base_path — kengaytmasiz."""
    mcfg = load_config().get("media", {})
    query = post.get("image_query")
    if not (mcfg.get("use_pixabay") and query and env("PIXABAY_API_KEY")):
        return None, None
    hook, theme = post["hook"], post.get("theme", "")
    if allow_video and random.random() < mcfg.get("video_chance", 0):
        out = make_video_post(query, hook, theme, f"{base_path}.mp4")
        if out:
            return out, "video"
    out = make_photo_post(query, hook, theme, f"{base_path}.jpg")
    if out:
        return out, "image"
    return None, None
