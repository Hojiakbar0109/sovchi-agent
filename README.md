# sovchi-agent

sovchi.app Telegram kanali (va Instagram story) uchun avtonom kontent agenti.

## Arxitektura (v2)

- **Supabase Edge Function** — [`supabase/functions/sovchi-webhook`](supabase/functions/sovchi-webhook/index.ts):
  Telegram webhook (admin tugmalari, izohlar, forwardlar), Gemini (reja, matn, rasm tanlash),
  rasm/karusel yasash ([`render.ts`](supabase/functions/sovchi-webhook/render.ts)), kanalga va Instagram story'ga joylash.
  Ma'lumotlar Supabase jadvallarida: `sv_plan`, `sv_plan_items`, `sv_posts`, `sv_state`, `sv_playbook`, ...
- **GitHub Actions** — jadval bo'yicha edge function'ni chaqiradi va ffmpeg kerak bo'lgan ishni bajaradi:

| Workflow | Qachon | Nima qiladi |
|---|---|---|
| `plan.yml` | har oy 25-kuni (+1-kuni zaxira) | keyingi oy kontent-rejasini yaratadi, admin tasdiqlaydi |
| `daily.yml` | har kuni 07:30 | bugungi reja bandlaridan draftlar (har biri alohida so'rovda) + kunlik video (`scripts/make_video.py`) |
| `publish-due.yml` | har 10 daqiqada | vaqti kelgan postlarni joylaydi, yarim qolgan ishlarni tiklaydi; video o'zgartirish buyurtmasi bo'lsa — qayta yasaydi |

Ish jarayoni: reja → admin tasdiqlaydi → har kuni draftlar keladi → ✅ (vaqt tanlanadi) yoki ❌ (boshqa variant) → kanalga joylanadi.

## Sozlash

**GitHub Secrets:** `SUPABASE_FUNCTION_URL`, `WEBHOOK_SECRET`, `PIXABAY_API_KEY`, `TELEGRAM_BOT_TOKEN`, `ADMIN_CHAT_ID`.

**Edge function secrets:** `TELEGRAM_BOT_TOKEN`, `ADMIN_CHAT_ID`, `CHANNEL_ID`, `GEMINI_API_KEY`, `WEBHOOK_SECRET`,
`PIXABAY_API_KEY`, ixtiyoriy: `PEXELS_API_KEY`, `GEMINI_MODEL`, `BRAND_LOGO_URL`, `IG_USER_ID`.

Webhook'ni ulash: `GET <function-url>/sovchi-webhook?setup=<WEBHOOK_SECRET>`.
Tekshirish: `?check=<WEBHOOK_SECRET>&probe=1`.

## Eski versiya

`src/` (Python, `generate.yml` / `publish.yml`) — v1, faqat qo'lda ishga tushadi va endi asosiy oqimda ishlatilmaydi.
