"""Telegram yangilanishlarini qayta ishlaydi:
- ✅/❌ tugmalari: postni kanalga joylash yoki rad etish
- /new buyrug'i: darhol yangi draft
- draftga REPLY (izoh): izoh asosida postni qayta yozib, yangi draft yuborish
- forward qilingan post: "📚 Namuna" yoki "♻️ Moslash" tanlovi
- stiker: kutubxonaga saqlash
Bot har amalga qisqa javob beradi."""
import random

from common import (ROOT, load_config, load_queue, save_queue,
                    get_offset, set_offset, load_json, save_json,
                    SAMPLES_FILE, STICKERS_FILE, INBOX_FILE)
import telegram_api
import media


def _find(q, post_id):
    for p in q["posts"]:
        if p["id"] == post_id:
            return p
    return None


def _find_by_msg(q, msg_id):
    for p in q["posts"]:
        if p.get("admin_msg_id") == msg_id:
            return p
    return None


# ---------- Stiker ----------
def _save_sticker(file_id):
    stk = load_json(STICKERS_FILE, {"stickers": []})
    if file_id not in stk["stickers"]:
        stk["stickers"].append(file_id)
        save_json(STICKERS_FILE, stk)
        return len(stk["stickers"])
    return None


# ---------- Forward (namuna/moslash) ----------
def _stash_inbox(msg_id, text):
    inbox = load_json(INBOX_FILE, {})
    inbox[str(msg_id)] = text
    save_json(INBOX_FILE, inbox)


def _pop_inbox(msg_id):
    inbox = load_json(INBOX_FILE, {})
    text = inbox.pop(str(msg_id), None)
    save_json(INBOX_FILE, inbox)
    return text


def _add_sample(text):
    samples = load_json(SAMPLES_FILE, {"posts": []})
    if not any(s.get("text") == text for s in samples["posts"]):
        samples["posts"].append({"text": text})
        save_json(SAMPLES_FILE, samples)
        return len(samples["posts"])
    return None


# ---------- Xabarlarni qayta ishlash ----------
def _handle_message(msg):
    import generate  # kech import (aylanma bog'liqlikdan qochish)
    chat_id = msg["chat"]["id"]
    msg_id = msg["message_id"]
    text = msg.get("text") or msg.get("caption") or ""
    is_forward = ("forward_origin" in msg or "forward_from_chat" in msg
                  or "forward_from" in msg or "forward_date" in msg)

    # 1) Stiker
    if "sticker" in msg:
        n = _save_sticker(msg["sticker"]["file_id"])
        if n:
            telegram_api.send_message(chat_id, f"✅ Stiker saqlandi. Kutubxonada: {n} ta.",
                                      reply_to=msg_id)
        else:
            telegram_api.send_message(chat_id, "Bu stiker allaqachon kutubxonada.",
                                      reply_to=msg_id)
        return

    # 2) Buyruqlar
    low = text.strip().lower()
    if low in ("/new", "/yangi"):
        telegram_api.send_message(chat_id, "✍️ Yangi draft tayyorlayapman...", reply_to=msg_id)
        try:
            generate.run()
        except Exception as e:
            telegram_api.send_message(chat_id, f"Xato: {e}")
        return
    if low in ("/help", "/start", "/yordam"):
        telegram_api.send_message(chat_id,
            "Men sovchi.app kontent yordamchisiman 🤖\n\n"
            "• <b>/new</b> — yangi post tayyorlayman\n"
            "• Draftga <b>izoh yozib reply</b> qilsangiz — shu izoh bo'yicha qayta yozaman\n"
            "• Boshqa kanaldan <b>post forward</b> qilsangiz — biznikiga moslayman\n"
            "• <b>Stiker</b> forward qilsangiz — kutubxonaga saqlayman\n"
            "• ✅/❌ tugmalar bilan tasdiqlaysiz yoki rad etasiz", reply_to=msg_id)
        return

    # 3) Draftga reply (izoh) — postni qayta yozish
    reply = msg.get("reply_to_message")
    if reply and text and not is_forward:
        q = load_queue()
        target = _find_by_msg(q, reply["message_id"])
        if target:
            import gemini_brain
            telegram_api.send_message(chat_id, "🔄 Izohingiz bo'yicha qayta yozyapman...",
                                      reply_to=msg_id)
            try:
                new_post = gemini_brain.revise_post(target["caption"], text)
                target["status"] = "revised"
                save_queue(q)
                generate.create_draft(new_post, note="♻️ <b>Izoh bo'yicha qayta yozildi</b>")
            except Exception as e:
                telegram_api.send_message(chat_id, f"Xato: {e}")
            return

    # 4) Forward qilingan post — namuna/moslash tanlovi
    if is_forward and text:
        _stash_inbox(msg_id, text)
        kb = {"inline_keyboard": [[
            {"text": "📚 Namuna sifatida saqlash", "callback_data": f"learn:{msg_id}"},
            {"text": "♻️ Moslash", "callback_data": f"adapt:{msg_id}"},
        ]]}
        telegram_api.send_message(chat_id,
            "Bu postni nima qilay?\n\n📚 <b>Namuna</b> — uslubni o'rganaman\n"
            "♻️ <b>Moslash</b> — sovchi.app uchun yangi post yasayman",
            reply_to=msg_id, reply_markup=kb)
        return


# ---------- Tugma bosilishini qayta ishlash ----------
def _handle_callback(cq, q, cfg):
    import generate
    data = cq.get("data", "")
    telegram_api.answer_callback(cq["id"])
    msg = cq["message"]
    chat_id = msg["chat"]["id"]
    message_id = msg["message_id"]
    if ":" not in data:
        return
    action, ref = data.split(":", 1)

    # Namuna sifatida saqlash
    if action == "learn":
        text = _pop_inbox(ref)
        if text:
            n = _add_sample(text)
            telegram_api.edit_caption(chat_id, message_id,
                f"📚 Namuna saqlandi (jami: {n} ta)." if n else "Bu namuna allaqachon bor.")
        return

    # Boshqa postni moslash
    if action == "adapt":
        text = _pop_inbox(ref)
        if text:
            import gemini_brain
            telegram_api.edit_caption(chat_id, message_id, "♻️ Moslayapman...")
            try:
                new_post = gemini_brain.adapt_post(text)
                generate.create_draft(new_post, note="♻️ <b>Boshqa postdan moslandi</b>")
            except Exception as e:
                telegram_api.send_message(chat_id, f"Xato: {e}")
        return

    # Tasdiq / rad
    post = _find(q, ref)
    if not post or post["status"] != "pending":
        return
    img = ROOT / post["image"]
    if action == "approve":
        if post.get("kind") == "video" and post.get("file_id"):
            telegram_api.post_to_channel("", post["caption"], kind="video", file_id=post["file_id"])
        elif img.exists():
            telegram_api.post_to_channel(str(img), post["caption"])
            # Ixtiyoriy: postdan keyin stiker (kutubxona bo'lsa)
            media_cfg = cfg.get("media", {})
            if media_cfg.get("stickers_enabled") and \
               random.random() < media_cfg.get("sticker_chance", 0):
                sid = media.pick_sticker()
                if sid:
                    telegram_api.send_sticker_to_channel(sid)
        post["status"] = "published"
        telegram_api.edit_caption(chat_id, message_id, "✅ JOYLANDI\n\n" + post["caption"])
        save_queue(q)
        print(f"Post {ref} kanalga joylandi.")
    elif action == "reject":
        post["status"] = "rejected"
        telegram_api.edit_caption(chat_id, message_id, "❌ RAD ETILDI\n\n" + post["caption"])
        if img.exists():
            img.unlink()
        save_queue(q)
        print(f"Post {ref} rad etildi.")


def run():
    cfg = load_config()
    offset = get_offset()
    updates = telegram_api.get_updates(offset=offset + 1 if offset else 0)

    for u in updates:
        set_offset(u["update_id"])
        q = load_queue()
        try:
            if "message" in u:
                _handle_message(u["message"])
            if "callback_query" in u:
                _handle_callback(u["callback_query"], q, cfg)
        except Exception as e:
            print(f"Update qayta ishlashda xato: {e}")


if __name__ == "__main__":
    run()
