"""Branded vertical reel (9:16, <=30s, H.264) for today's video_text plan items.

Flow: edge ?pending_videos -> text/hook/queries; Pixabay clip (or photo + Ken Burns);
ffmpeg overlay + music; sendVideo to admin as a draft (approve -> time keyboard);
edge ?register_video stores the file_id. Runs in GitHub Actions (edge has no ffmpeg).
"""
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import textwrap
import time

import requests

BASE = os.environ["SUPABASE_FUNCTION_URL"].rstrip("/") + "/sovchi-webhook"
SECRET = os.environ["WEBHOOK_SECRET"]
PIXABAY = os.environ.get("PIXABAY_API_KEY", "")
TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
ADMIN = os.environ["ADMIN_CHAT_ID"]
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = os.path.join(ROOT, "assets", "fonts", "DejaVuSans-Bold.ttf")
MUSIC_DIR = os.path.join(ROOT, "assets", "music")

# --- keep in sync with isUnsafe / SAFE_QUERIES in supabase/functions/sovchi-webhook/index.ts ---
SAFE_QUERIES = [
    "wedding rings", "henna hands", "cozy home interior", "two cups of tea", "family together",
    "parents and children", "flowers bouquet", "sunset nature", "path in forest", "open door light",
    "old books", "arabic calligraphy", "mosque architecture", "dates and tea", "green park morning",
    "white roses",
]
BLOCKED = [
    "kiss", "kissing", "kisses", "intimate", "intimacy", "romantic", "romance", "lingerie", "bikini",
    "swimsuit", "underwear", "bed", "bedroom", "nightclub", "night club", "party", "dating", "hug",
    "hugging", "embrace", "embracing", "cuddle", "cuddling", "sexy", "sensual", "seductive", "passion",
    "passionate", "lovers", "erotic", "nude", "naked", "topless", "valentine", "honeymoon",
]
BLOCKED_RE = re.compile(r"(?<![a-z])(?:%s)(?![a-z])" % "|".join(BLOCKED), re.I)
COUPLE_RE = re.compile(r"(?<![a-z])couple(?![a-z])", re.I)
COUPLE_RISK = re.compile(r"(?<![a-z])(love|romance|silhouette|sunset|beach|together|embrace)(?![a-z])", re.I)


def is_unsafe(t):
    return bool(BLOCKED_RE.search(t) or (COUPLE_RE.search(t) and COUPLE_RISK.search(t)))


def queries(qs):
    safe = random.sample(SAFE_QUERIES, 4)
    return [q for q in qs if q and not is_unsafe(q)] + safe


def download(url, path):
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    with open(path, "wb") as f:
        f.write(r.content)
    return path


def find_background(qs, tmp, rotate=0):
    """-> ('video'|'photo', path) or (None, None). Vertical video first, then photos.
    `rotate` (>0) picks a different query/clip so 'Boshqa video' yields a new result."""
    if not PIXABAY:
        return None, None
    qlist = queries(qs)
    if rotate and qlist:
        k = rotate % len(qlist)
        qlist = qlist[k:] + qlist[:k]
    for q in qlist:
        r = requests.get("https://pixabay.com/api/videos/", params={
            "key": PIXABAY, "q": q[:100], "safesearch": "true", "per_page": 30}, timeout=30)
        hits = [h for h in r.json().get("hits", []) if not is_unsafe(str(h.get("tags", "")))]
        random.shuffle(hits)

        def vertical(h):
            v = h["videos"].get("medium") or {}
            return 0 if v.get("height", 0) > v.get("width", 1) else 1

        hits.sort(key=vertical)
        pick = hits[:3]
        if rotate and len(hits) > 3:
            s = rotate % len(hits)
            pick = (hits[s:] + hits[:s])[:3]
        for h in pick:
            v = h["videos"].get("medium") or h["videos"].get("small")
            if v and v.get("url") and v.get("size", 0) < 40_000_000:
                return "video", download(v["url"], os.path.join(tmp, "bg.mp4"))
    for q in qlist:
        r = requests.get("https://pixabay.com/api/", params={
            "key": PIXABAY, "q": q[:100], "image_type": "photo", "orientation": "vertical",
            "safesearch": "true", "per_page": 30}, timeout=30)
        hits = [h for h in r.json().get("hits", []) if not is_unsafe(str(h.get("tags", "")))]
        if hits:
            h = random.choice(hits[:20])
            return "photo", download(h.get("largeImageURL") or h["webformatURL"], os.path.join(tmp, "bg.jpg"))
    return None, None


def fp(path):
    """ffmpeg filter-safe path: forward slashes, no drive letter (a Windows-only quirk), single-quoted."""
    return "'" + re.sub(r"^[A-Za-z]:", "", path.replace("\\", "/")) + "'"


def wrapped(path, text, width):
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(textwrap.wrap(text, width)))
    return fp(path)


def pick_music(current=None, avoid=False):
    """A track from assets/music. `current` is reused unless `avoid` (then a different one)."""
    if not os.path.isdir(MUSIC_DIR):
        return None
    tracks = [f for f in os.listdir(MUSIC_DIR) if f.lower().endswith((".wav", ".mp3", ".ogg", ".m4a"))]
    if not tracks:
        return None
    if avoid and current in tracks and len(tracks) > 1:
        return random.choice([t for t in tracks if t != current])
    if current in tracks:
        return current
    return random.choice(tracks)


def build(item, tmp, rotate=0, current_music=None, avoid_music=False):
    hook = item["hook"]
    lines = item["lines"][:4]
    outro = item.get("outro") or "Ilovani yuklab oling"
    seg = [("hook", hook, 3.5)] + [("line", ln, 4.0) for ln in lines]
    total = sum(s[2] for s in seg) + 3.0  # + outro
    kind, bg = find_background(item.get("queries", []), tmp, rotate)
    fps = 30
    if kind == "video":
        inputs = ["-stream_loop", "-1", "-i", bg]
        vf0 = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30"
    elif kind == "photo":
        inputs = ["-loop", "1", "-i", bg]
        frames = int(total * fps)
        vf0 = ("scale=2160:3840:force_original_aspect_ratio=increase,crop=2160:3840,"
               "zoompan=z='min(zoom+0.0006,1.25)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
               f"d={frames}:s=1080x1920:fps={fps},setsar=1")
    else:  # nothing found: plain brand background
        inputs = ["-f", "lavfi", "-i", f"color=c=0x1a1a1a:s=1080x1920:r={fps}"]
        vf0 = "setsar=1"

    font = fp(FONT)
    chain = [vf0, "drawbox=x=0:y=0:w=iw:h=ih:color=black@0.42:t=fill"]
    # brand mark inside the safe area (Reels UI covers roughly the top 12% and bottom 20%)
    t_brand = wrapped(os.path.join(tmp, "brand.txt"), "sovchi.app", 30)
    t_tag = wrapped(os.path.join(tmp, "tag.txt"), "Jiddiy niyatdagilar uchun", 40)
    chain.append(f"drawtext=fontfile={font}:textfile={t_brand}:fontcolor=white:fontsize=54:x=70:y=270")
    chain.append(f"drawtext=fontfile={font}:textfile={t_tag}:fontcolor=white@0.85:fontsize=30:x=70:y=340")
    t0 = 0.0
    for i, (name, text, dur) in enumerate(seg):
        size = 84 if name == "hook" else 62
        p = wrapped(os.path.join(tmp, f"s{i}.txt"), text, 17 if name == "hook" else 22)
        chain.append(
            f"drawtext=fontfile={font}:textfile={p}:fontcolor=white:fontsize={size}:line_spacing=18:"
            f"x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.25:boxborderw=28:"
            f"enable='between(t,{t0:.2f},{t0 + dur:.2f})'")
        t0 += dur
    # outro: solid brand red + brand text
    chain.append(f"drawbox=x=0:y=0:w=iw:h=ih:color=0xc50f13@1:t=fill:enable='gte(t,{t0:.2f})'")
    p = wrapped(os.path.join(tmp, "outro.txt"), outro, 22)
    chain.append(f"drawtext=fontfile={font}:textfile={p}:fontcolor=0xfdf1dd:fontsize=64:line_spacing=18:"
                 f"x=(w-text_w)/2:y=(h-text_h)/2-60:enable='gte(t,{t0:.2f})'")
    chain.append(f"drawtext=fontfile={font}:textfile={t_brand}:fontcolor=0xfdf1dd:fontsize=72:"
                 f"x=(w-text_w)/2:y=(h/2)+90:enable='gte(t,{t0:.2f})'")
    chain.append(f"drawtext=fontfile={font}:textfile={t_tag}:fontcolor=0xfdf1dd@0.9:fontsize=34:"
                 f"x=(w-text_w)/2:y=(h/2)+190:enable='gte(t,{t0:.2f})'")
    chain.append("format=yuv420p")

    chosen_music = pick_music(current_music, avoid_music)
    out = os.path.join(tmp, "reel.mp4")
    cmd = ["ffmpeg", "-y", "-loglevel", "error"] + inputs
    if chosen_music:
        cmd += ["-stream_loop", "-1", "-i", os.path.join(MUSIC_DIR, chosen_music)]
    else:
        cmd += ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]
    cmd += [
        "-filter_complex",
        f"[0:v]{','.join(chain)}[v];[1:a]volume=0.22,afade=t=out:st={total - 2:.1f}:d=2[a]",
        "-map", "[v]", "-map", "[a]", "-t", f"{total:.1f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-r", str(fps),
        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out,
    ]
    subprocess.run(cmd, check=True)
    size = os.path.getsize(out)
    if size > 49_000_000 or total > 30:
        raise RuntimeError(f"video limitdan oshdi: {size} bayt, {total}s")
    return out, total, chosen_music


def kb_for(vid):
    # label (Instagram story) + approve/reject + change clip/music
    return {"inline_keyboard": [
        [{"text": "📸 Instagram story + kanal", "callback_data": f"iginfo:{vid}"}],
        [{"text": "✅ Joylash", "callback_data": f"approve:{vid}"},
         {"text": "❌ Rad etish", "callback_data": f"reject:{vid}"}],
        [{"text": "🎬 Boshqa video", "callback_data": f"vid_clip:{vid}"},
         {"text": "🎵 Boshqa musiqa", "callback_data": f"vid_music:{vid}"}],
    ]}


def media_spec(item, music, clip_rotate=0):
    return {
        "hook": item["hook"], "lines": item["lines"], "outro": item.get("outro"),
        "caption_plain": item.get("caption_plain", ""), "caption_html": item["caption_html"],
        "queries": item.get("queries", []), "music": music, "clip_rotate": clip_rotate,
    }


def send_draft(item, path, duration, music):
    vid = str(int(time.time() * 1000)) + str(random.randint(0, 9))
    with open(path, "rb") as f:
        r = requests.post(f"https://api.telegram.org/bot{TOKEN}/sendVideo", data={
            "chat_id": ADMIN, "caption": item["caption_html"], "parse_mode": "HTML",
            "supports_streaming": "true", "width": 1080, "height": 1920, "duration": int(duration),
            "reply_markup": json.dumps(kb_for(vid))}, files={"video": ("reel.mp4", f, "video/mp4")}, timeout=300)
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"sendVideo: {data}")
    m = data["result"]
    reg = requests.post(BASE, params={"register_video": SECRET}, json={
        "id": vid, "plan_item_id": item["plan_item_id"], "caption": item["caption_html"],
        "file_id": m["video"]["file_id"], "admin_message_id": m["message_id"],
        "sticker_emoji": item.get("sticker_emoji"), "media": media_spec(item, music)}, timeout=60)
    reg.raise_for_status()
    print("registered", reg.json())


# Rebuild: replace the video in the SAME admin draft message (editMessageMedia).
def edit_draft(job, path, duration):
    vid = job["id"]
    media_obj = {
        "type": "video", "media": "attach://v", "caption": job["caption_html"], "parse_mode": "HTML",
        "supports_streaming": True, "width": 1080, "height": 1920, "duration": int(duration),
    }
    with open(path, "rb") as f:
        r = requests.post(f"https://api.telegram.org/bot{TOKEN}/editMessageMedia", data={
            "chat_id": ADMIN, "message_id": job["admin_message_id"],
            "media": json.dumps(media_obj), "reply_markup": json.dumps(kb_for(vid))},
            files={"v": ("reel.mp4", f, "video/mp4")}, timeout=300)
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"editMessageMedia: {data}")
    return data["result"]["video"]["file_id"]


def run_pending():
    r = requests.get(BASE, params={"pending_videos": SECRET}, timeout=170)
    r.raise_for_status()
    items = r.json().get("items", [])
    print(f"{len(items)} ta video band")
    failed = 0
    for it in items:
        try:
            with tempfile.TemporaryDirectory() as tmp:
                path, dur, music = build(it, tmp)
                send_draft(it, path, dur, music)
        except Exception as e:  # keep going with the other items
            failed += 1
            print("video xato:", e, file=sys.stderr)
            requests.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage", data={
                "chat_id": ADMIN, "text": f"⚠️ Video yasab bo'lmadi ({it.get('theme')}): {str(e)[:300]}"})
    sys.exit(1 if failed else 0)


# Process admin-requested changes (clip / music / text): rebuild and edit the existing draft.
def run_jobs():
    r = requests.get(BASE, params={"video_jobs": SECRET}, timeout=170)
    r.raise_for_status()
    jobs = r.json().get("items", [])
    print(f"{len(jobs)} ta qayta yasash buyurtmasi")
    failed = 0
    for job in jobs:
        try:
            change = job.get("change", "clip")
            rotate = int(job.get("clip_rotate") or 0) if change == "clip" else 0
            with tempfile.TemporaryDirectory() as tmp:
                path, dur, music = build(
                    job, tmp, rotate=rotate,
                    current_music=job.get("music"), avoid_music=(change == "music"))
                file_id = edit_draft(job, path, dur)
            reg = requests.post(BASE, params={"register_video": SECRET}, json={
                "id": job["id"], "plan_item_id": job.get("plan_item_id"), "caption": job["caption_html"],
                "file_id": file_id, "admin_message_id": job["admin_message_id"],
                "sticker_emoji": job.get("sticker_emoji"),
                "media": media_spec(job, music, rotate)}, timeout=60)
            reg.raise_for_status()
            requests.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage", data={
                "chat_id": ADMIN, "text": "✅ Video yangilandi — yuqoridagi draftni tekshiring."})
        except Exception as e:
            failed += 1
            print("rebuild xato:", e, file=sys.stderr)
            requests.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage", data={
                "chat_id": ADMIN, "text": f"⚠️ Videoni yangilab bo'lmadi: {str(e)[:300]}"})
    sys.exit(1 if failed else 0)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "pending"
    run_jobs() if mode == "jobs" else run_pending()


if __name__ == "__main__":
    main()
