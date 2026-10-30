"""Umumiy yordamchilar: config, holat (state), yo'llar."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PENDING = DATA / "pending"
QUEUE_FILE = DATA / "queue.json"
OFFSET_FILE = DATA / "offset.txt"
SAMPLES_FILE = DATA / "samples.json"      # eski postlardan o'rganilgan uslub namunalari
STICKERS_FILE = DATA / "stickers.json"    # botga forward qilingan stiker file_id'lari

DATA.mkdir(exist_ok=True)
PENDING.mkdir(exist_ok=True)


def load_config():
    with open(ROOT / "config.json", encoding="utf-8") as f:
        return json.load(f)


def env(key, default=None, required=False):
    val = os.environ.get(key, default)
    if required and not val:
        raise RuntimeError(f"Muhit o'zgaruvchisi topilmadi: {key}")
    return val


def load_queue():
    if QUEUE_FILE.exists():
        with open(QUEUE_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {"posts": []}


def save_queue(q):
    with open(QUEUE_FILE, "w", encoding="utf-8") as f:
        json.dump(q, f, ensure_ascii=False, indent=2)


def load_json(path, default):
    if Path(path).exists():
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return default


def save_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def get_offset():
    if OFFSET_FILE.exists():
        return int(OFFSET_FILE.read_text().strip() or "0")
    return 0


def set_offset(val):
    OFFSET_FILE.write_text(str(val))
