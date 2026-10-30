"""Draft yaratish: miya + media + adminga tasdiqqa yuborish."""
import html
import time
from pathlib import Path

from common import load_config, load_queue, save_queue, PENDING
import gemini_brain
import media
import telegram_api


def build_caption(post, brand):
    # Caption matni (HTML uchun xavfsiz qilinadi)
    body = html.escape(post["caption"].strip())
    # Link so'z ortiga yashiriladi (chiroyli ko'rinish uchun)
    link_text = html.escape(f"{brand['name']} — ilovani yuklab olish")
    cta = f'\n\n👉 <a href="{brand["app_link"]}">{link_text}</a>'
    mention = f"\n{brand.get('channel_mention', '')}".rstrip()
    return body + cta + mention


def run():
    cfg = load_config()
    brand = cfg["brand"]

    print("Miya ishlayapti (Gemini)...")
    post = gemini_brain.generate_post()
    print(f"Mavzu: {post['theme']} | Hook: {post['hook']}")

    post_id = str(int(time.time()))
    img_path = PENDING / f"{post_id}.png"

    made = None
    if cfg["gemini"].get("use_ai_image"):
        made = media.make_ai_image(post.get("image_prompt", ""), str(img_path))
    if not made:
        media.make_card(post["hook"], post["theme"], str(img_path))
    print(f"Rasm tayyor: {img_path.name}")

    caption = build_caption(post, brand)

    telegram_api.send_draft_to_admin(str(img_path), caption, post_id)
    print("Draft adminga yuborildi ✓")

    q = load_queue()
    q["posts"].append({
        "id": post_id,
        "status": "pending",
        "caption": caption,
        "image": f"data/pending/{post_id}.png",
        "theme": post["theme"],
        "created": post_id,
    })
    save_queue(q)
    print("Navbatga qo'shildi (status: pending)")


if __name__ == "__main__":
    run()
