"""Tasdiqlarni tekshirish: ✅ bosilganini kanalga joylash.
Shu bilan birga: forward qilingan eski postlardan uslub o'rganadi,
forward qilingan stikerlarni kutubxonaga saqlaydi."""
from pathlib import Path

from common import (ROOT, load_config, load_queue, save_queue,
                    get_offset, set_offset, load_json, save_json,
                    SAMPLES_FILE, STICKERS_FILE)
import telegram_api


def _find(q, post_id):
    for p in q["posts"]:
        if p["id"] == post_id:
            return p
    return None


def _learn_from_message(msg):
    """Forward qilingan post matnini namunalarga, stikerni kutubxonaga qo'shadi."""
    changed = False
    # Eski post namunasi (forward qilingan matn)
    text = msg.get("text") or msg.get("caption")
    if text and ("forward_origin" in msg or "forward_from_chat" in msg):
        samples = load_json(SAMPLES_FILE, {"posts": []})
        if not any(s.get("text") == text for s in samples["posts"]):
            samples["posts"].append({"text": text})
            save_json(SAMPLES_FILE, samples)
            changed = True
            print("Yangi uslub namunasi o'rganildi.")
    # Stiker kutubxonasi
    if "sticker" in msg:
        fid = msg["sticker"]["file_id"]
        stk = load_json(STICKERS_FILE, {"stickers": []})
        if fid not in [s for s in stk["stickers"]]:
            stk["stickers"].append(fid)
            save_json(STICKERS_FILE, stk)
            changed = True
            print("Yangi stiker saqlandi.")
    return changed


def run():
    cfg = load_config()
    q = load_queue()
    offset = get_offset()
    updates = telegram_api.get_updates(offset=offset + 1 if offset else 0)

    for u in updates:
        set_offset(u["update_id"])

        # Oddiy xabar — o'rganish uchun
        if "message" in u:
            _learn_from_message(u["message"])

        # Tugma bosilishi — tasdiq / rad
        cq = u.get("callback_query")
        if not cq:
            continue
        data = cq.get("data", "")
        telegram_api.answer_callback(cq["id"])
        msg = cq["message"]
        chat_id = msg["chat"]["id"]
        message_id = msg["message_id"]

        if ":" not in data:
            continue
        action, post_id = data.split(":", 1)
        post = _find(q, post_id)
        if not post or post["status"] != "pending":
            continue

        img = ROOT / post["image"]

        if action == "approve":
            if img.exists():
                telegram_api.post_to_channel(str(img), post["caption"])
            post["status"] = "published"
            telegram_api.edit_caption(chat_id, message_id,
                                      "✅ JOYLANDI\n\n" + post["caption"])
            print(f"Post {post_id} kanalga joylandi.")
        elif action == "reject":
            post["status"] = "rejected"
            telegram_api.edit_caption(chat_id, message_id,
                                      "❌ RAD ETILDI\n\n" + post["caption"])
            if img.exists():
                img.unlink()
            print(f"Post {post_id} rad etildi.")

    save_queue(q)


if __name__ == "__main__":
    run()
