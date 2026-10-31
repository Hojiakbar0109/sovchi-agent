"""Draft yaratish: miya + media + adminga tasdiqqa yuborish."""
import html
import time
from pathlib import Path

from common import load_config, load_queue, save_queue, PENDING
import gemini_brain
import media
import pixabay_media
import telegram_api


def build_caption(post, brand):
    # Caption matni (HTML uchun xavfsiz qilinadi)
    body = html.escape(post["caption"].strip())
    # Link so'z ortiga yashiriladi (chiroyli ko'rinish uchun)
    link_text = html.escape(f"{brand['name']} — ilovani yuklab olish")
    cta = f'\n\n👉 <a href="{brand["app_link"]}">{link_text}</a>'
    mention = f"\n{brand.get('channel_mention', '')}".rstrip()
    return body + cta + mention


def create_draft(post, note="", allow_video=False):
    """Post lug'atidan rasm yasab, adminга tasdiqqa yuboradi va navbatga qo'shadi.
    post: {hook, caption, theme, image_prompt}. note: adminga qo'shimcha izoh."""
    cfg = load_config()
    brand = cfg["brand"]

    post_id = str(int(time.time()))
    # 1) Pixabay rasm/video + brend overlay; 2) AI rasm (ixtiyoriy); 3) brend-kartochka
    made, kind = pixabay_media.make_media(post, str(PENDING / post_id), allow_video=allow_video)
    if not made:
        img_path = PENDING / f"{post_id}.png"
        if cfg["gemini"].get("use_ai_image"):
            made = media.make_ai_image(post.get("image_prompt", ""), str(img_path))
        if not made:
            media.make_card(post["hook"], post["theme"], str(img_path))
        made, kind = str(img_path), "image"
    img_path = Path(made)
    print(f"Media tayyor ({kind}): {img_path.name}")

    caption = build_caption(post, brand)

    res = telegram_api.send_draft_to_admin(str(img_path), caption, post_id, note=note, kind=kind)
    admin_msg_id = res.get("message_id") if isinstance(res, dict) else None
    file_id = None
    if kind == "video" and isinstance(res, dict):
        file_id = (res.get("video") or {}).get("file_id")
        img_path.unlink(missing_ok=True)  # katta fayl repoga tushmasin: file_id yetarli
    print("Draft adminga yuborildi ✓")

    q = load_queue()
    q["posts"].append({
        "id": post_id,
        "status": "pending",
        "caption": caption,
        "image": f"data/pending/{img_path.name}",
        "kind": kind,
        "file_id": file_id,
        "theme": post.get("theme", ""),
        "pillar": post.get("pillar", ""),
        "post_format": post.get("post_format", ""),
        "created": post_id,
        "admin_msg_id": admin_msg_id,
    })
    save_queue(q)
    print("Navbatga qo'shildi (status: pending)")
    return post_id


def run(extra=None):
    print("Miya ishlayapti (Gemini)...")
    post = gemini_brain.generate_post(extra=extra)
    print(f"Mavzu: {post['theme']} | Hook: {post['hook']}")
    create_draft(post, allow_video=True)


if __name__ == "__main__":
    run()
