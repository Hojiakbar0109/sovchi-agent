# sovchi-agent

sovchi.app Telegram kanali uchun avtonom kontent agenti.
Gemini (matn) + brend dizayn-kartochka (rasm) + Telegram (tasdiq va joylash) + GitHub Actions (avtomatlashtirish). To'liq bepul.

## Qanday ishlaydi

1. **Draft yaratish** (`src/generate.py`): Gemini eski postlardan uslubni o'rganib, yangi post matni yozadi; `media.py` brend ranglarida dizayn-kartochka yasaydi; draft adminga ✅/❌ tugmalari bilan yuboriladi.
2. **Tasdiq va joylash** (`src/publish.py`): admin ✅ bosgan postlar kanalga joylanadi. Shu bilan birga, botga forward qilingan eski postlardan uslub o'rganiladi, forward qilingan stikerlar saqlanadi.
3. **Avtomatlashtirish** (`.github/workflows/`): GitHub Actions belgilangan vaqtlarda o'zi ishga tushiradi.

## Sozlash (GitHub Secrets)

Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Qayerdan |
|---|---|
| `GEMINI_API_KEY` | aistudio.google.com |
| `TELEGRAM_BOT_TOKEN` | @BotFather |
| `ADMIN_CHAT_ID` | @userinfobot (draft shu yerga keladi) |
| `CHANNEL_ID` | kanal @username yoki -100... raqami |

## Logo

`assets/logo.png` ga brend logongizni qo'ying (shaffof PNG) — kartochkaga avtomatik tushadi.

## Qo'lda sinash

Actions → "Draft yaratish" → "Run workflow" — darhol bitta draft keladi.
