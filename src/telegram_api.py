"""Telegram Bot API bilan ishlash: draft yuborish, tasdiqni o'qish, kanalga joylash."""
import requests

from common import env

API = "https://api.telegram.org/bot{token}/{method}"


def _call(method, **params):
    token = env("TELEGRAM_BOT_TOKEN", required=True)
    url = API.format(token=token, method=method)
    files = params.pop("_files", None)
    r = requests.post(url, data=params, files=files, timeout=60)
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"Telegram xato [{method}]: {data}")
    return data["result"]


def send_draft_to_admin(image_path, caption, post_id):
    """Rasm + matnni adminga ✅/❌ tugmalari bilan yuboradi."""
    admin = env("ADMIN_CHAT_ID", required=True)
    keyboard = {
        "inline_keyboard": [[
            {"text": "✅ Joylash", "callback_data": f"approve:{post_id}"},
            {"text": "❌ Rad etish", "callback_data": f"reject:{post_id}"},
        ]]
    }
    import json as _json
    with open(image_path, "rb") as f:
        return _call(
            "sendPhoto",
            chat_id=admin,
            caption=caption,
            reply_markup=_json.dumps(keyboard),
            _files={"photo": f},
        )


def post_to_channel(image_path, caption):
    """Tasdiqlangan postni kanalga joylaydi."""
    channel = env("CHANNEL_ID", required=True)
    with open(image_path, "rb") as f:
        return _call("sendPhoto", chat_id=channel, caption=caption,
                     _files={"photo": f})


def send_sticker_to_channel(file_id):
    channel = env("CHANNEL_ID", required=True)
    return _call("sendSticker", chat_id=channel, sticker=file_id)


def get_updates(offset=0):
    return _call("getUpdates", offset=offset, timeout=0,
                 allowed_updates='["callback_query","message"]')


def answer_callback(callback_id, text="Qabul qilindi ✓"):
    try:
        _call("answerCallbackQuery", callback_query_id=callback_id, text=text)
    except Exception:
        pass


def edit_caption(chat_id, message_id, caption):
    try:
        _call("editMessageCaption", chat_id=chat_id, message_id=message_id,
              caption=caption)
    except Exception:
        pass
