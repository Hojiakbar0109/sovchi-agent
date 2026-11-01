// sovchi.app Telegram content agent — v2 (webhook + monthly plan + scheduled publishing).
// Built on top of the live v19 function. Image rendering lives in render.ts.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { BRAND as RB, randomLayout, renderCard } from "./render.ts";

const BRAND = {
  ...RB,
  usersLabel: "7k+", // NEVER shown in images or post text (only used by the stripUserCount filter)
  appLink:
    "https://play.google.com/store/apps/details?id=uz.sovchi.sovchiapp&pcampaignid=web_share",
  channelMention: "@sovchiapp",
  voice:
    "Issiq, ishonchli, zamonaviy. Jiddiy munosabatlar haqida. Hech qachon followerlardan 'reaksiya bosing' deb so'ramaydi.",
};

const env = (k: string) => Deno.env.get(k) ?? "";
const TOKEN = env("TELEGRAM_BOT_TOKEN");
const ADMIN = env("ADMIN_CHAT_ID");
const CHANNEL = env("CHANNEL_ID");
const GEMINI_KEY = env("GEMINI_API_KEY");
const GEMINI_MODEL = env("GEMINI_MODEL") || "gemini-3.8-flash";
const WEBHOOK_SECRET = env("WEBHOOK_SECRET");
// share of published posts that get a sticker right after them (0..1)
const STICKER_CHANCE = Number(env("STICKER_CHANCE") || "0.8");

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

// ---------- Telegram ----------
async function tg(method: string, params: Record<string, unknown> | FormData) {
  const isForm = params instanceof FormData;
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: isForm ? undefined : { "content-type": "application/json" },
    body: isForm ? params : JSON.stringify(params),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram [${method}]: ${JSON.stringify(data)}`);
  return data.result;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const say = (text: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id: ADMIN, text: text.slice(0, 4000), parse_mode: "HTML", ...extra });

// ---------- Time (Asia/Tashkent = UTC+5, no DST) ----------
const TZ_H = 5;
const WEEKDAYS = ["Yak", "Du", "Se", "Chor", "Pay", "Ju", "Sha"];
function tashkent(d = new Date()) {
  const t = new Date(d.getTime() + TZ_H * 3600_000);
  const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1, day = t.getUTCDate();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return {
    y, m, d: day, hh: t.getUTCHours(), mm: t.getUTCMinutes(), wd: t.getUTCDay(),
    iso: `${y}-${p2(m)}-${p2(day)}`, month: `${y}-${p2(m)}`,
  };
}
const toUtc = (y: number, m: number, d: number, hh: number, mm: number) =>
  new Date(Date.UTC(y, m - 1, d, hh - TZ_H, mm));
const fmtLocal = (iso: string) => {
  const t = tashkent(new Date(iso));
  return `${String(t.d).padStart(2, "0")}.${String(t.m).padStart(2, "0")} ${String(t.hh).padStart(2, "0")}:${String(t.mm).padStart(2, "0")}`;
};

// today at HH:MM Tashkent; already passed -> tomorrow
function nextAt(hh: number, mm: number): Date {
  const n = tashkent();
  let d = toUtc(n.y, n.m, n.d, hh, mm);
  if (d.getTime() <= Date.now() + 30_000) d = new Date(d.getTime() + 86400_000);
  return d;
}

// "HH:MM" | "ertaga HH:MM" | "YYYY-MM-DD HH:MM" (Tashkent) -> Date | null
function parseWhen(text: string): Date | null {
  const t = text.trim().toLowerCase();
  let m: RegExpMatchArray | null;
  const ok = (hh: number, mm: number) => hh >= 0 && hh < 24 && mm >= 0 && mm < 60;
  if ((m = t.match(/^(\d{1,2})[:.](\d{2})$/))) {
    return ok(+m[1], +m[2]) ? nextAt(+m[1], +m[2]) : null;
  }
  if ((m = t.match(/^ertaga\s+(\d{1,2})[:.](\d{2})$/))) {
    if (!ok(+m[1], +m[2])) return null;
    const n = tashkent(new Date(Date.now() + 86400_000));
    return toUtc(n.y, n.m, n.d, +m[1], +m[2]);
  }
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2})[:.](\d{2})$/))) {
    if (!ok(+m[4], +m[5])) return null;
    const d = toUtc(+m[1], +m[2], +m[3], +m[4], +m[5]);
    return d.getTime() > Date.now() ? d : null;
  }
  return null;
}

// ---------- Image policy (modest, family-oriented brand) ----------
const SAFE_QUERIES = [
  "wedding rings", "henna hands", "cozy home interior", "two cups of tea",
  "family together", "parents and children", "flowers bouquet", "sunset nature",
  "path in forest", "open door light", "old books", "arabic calligraphy",
  "mosque architecture", "dates and tea", "green park morning", "white roses",
];
const BLOCKED_TERMS = [
  "kiss", "kissing", "kisses", "intimate", "intimacy", "romantic", "romance", "lingerie",
  "bikini", "swimsuit", "underwear", "bed", "bedroom", "nightclub", "night club", "party",
  "dating", "hug", "hugging", "embrace", "embracing", "cuddle", "cuddling", "sexy",
  "sensual", "seductive", "passion", "passionate", "lovers", "erotic", "nude", "naked",
  "topless", "valentine", "honeymoon",
];
const blockedRe = new RegExp(`(?<![a-z])(?:${BLOCKED_TERMS.join("|")})(?![a-z])`, "i");
const coupleRe = /(?<![a-z])couple(?![a-z])/i;
const coupleRiskRe = /(?<![a-z])(love|romance|silhouette|sunset|beach|together|embrace)(?![a-z])/i;
const isUnsafe = (t: string) => blockedRe.test(t) || (coupleRe.test(t) && coupleRiskRe.test(t));

function queryList(q: string) {
  const safe = [...SAFE_QUERIES].sort(() => Math.random() - 0.5).slice(0, 4);
  return (isUnsafe(q) ? [] : [q]).concat(safe);
}

// ---------- Gemini ----------
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NON_TEXT = ["image", "tts", "audio", "speech", "embedding", "aqa", "vision",
  "imagen", "veo", "live", "native-audio", "dialog"];

let modelCache: string[] | null = null;
async function candidateModels() {
  if (modelCache) return modelCache;
  const order = [GEMINI_MODEL];
  try {
    const r = await fetch(`${GEMINI_API}/models?pageSize=200`, {
      headers: { "x-goog-api-key": GEMINI_KEY },
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json();
    const available: string[] = (data.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m: any) => String(m.name).replace("models/", ""))
      .filter((n: string) => !NON_TEXT.some((bad) => n.toLowerCase().includes(bad)));
    const rank = (n: string) => [
      !n.toLowerCase().includes("flash"),
      n.toLowerCase().includes("lite"),
      n.toLowerCase().includes("pro"),
    ];
    available.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return Number(ra[i]) - Number(rb[i]);
      return a.localeCompare(b);
    });
    for (const n of available) if (!order.includes(n)) order.push(n);
    modelCache = order;
  } catch (e) {
    console.warn("listModels failed:", e);
  }
  return order;
}

type GOpts = { timeout?: number; budget?: number; attempts?: number; models?: number };

async function askModel(model: string, prompt: string, timeout: number) {
  const r = await fetch(`${GEMINI_API}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err: any = new Error(`HTTP ${r.status} ${data?.error?.status ?? ""}`);
    err.status = r.status;
    throw err;
  }
  let text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!text) throw new Error("bo'sh javob");
  text = text.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
  return JSON.parse(text);
}

async function gemini(prompt: string, o: GOpts = {}): Promise<any> {
  const timeout = o.timeout ?? 25_000, attempts = o.attempts ?? 3, maxModels = o.models ?? 4;
  let lastErr: unknown = null;
  const deadline = Date.now() + (o.budget ?? 60_000);
  for (const model of (await candidateModels()).slice(0, maxModels)) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (Date.now() > deadline) throw lastErr ?? new Error("Gemini vaqt chegarasi tugadi");
      try {
        const out = await askModel(model, prompt, timeout);
        console.log(`Model ishlatildi: ${model} (urinish ${attempt})`);
        return out;
      } catch (e: any) {
        lastErr = e;
        console.warn(`Model '${model}' urinish ${attempt}/${attempts}: ${e}`);
        if (e?.status && e.status < 500 && e.status !== 429) break;
        if (attempt < attempts) await sleep(attempt * 1000);
      }
    }
  }
  throw lastErr ?? new Error("Hech qaysi model javob bermadi");
}

// ---------- Post model ----------
type PostType = "text_image" | "question" | "carousel" | "poll" | "video_text";
const POST_TYPES: PostType[] = ["text_image", "question", "carousel", "poll", "video_text"];
const TYPE_LABEL: Record<string, string> = {
  text_image: "matn+rasm", question: "savol", carousel: "karusel", poll: "so'rovnoma", video_text: "video",
};

type Slide = { hook: string; line: string; file_id?: string };
type PollData = {
  question: string; options: string[]; is_quiz?: boolean; correct_option_id?: number; explanation?: string;
};
type Post = {
  post_type: PostType;
  hook: string;
  caption: string;
  theme: string;
  pillar?: string;
  post_format?: string;
  image_query?: string;
  sticker_emoji?: string;
  slides?: Slide[];
  poll?: PollData;
};

// ---------- SMM brain: playbook + history + metrics -> strategy -> write -> editor ----------
async function samplesBlock() {
  const { data } = await db.from("sv_samples").select("text").order("id", { ascending: false }).limit(15);
  if (!data?.length) return "(Hali eski post namunalari yuklanmagan.)";
  return data.reverse().map((p, i) => `${i + 1}. ${p.text.trim()}`).join("\n");
}

async function playbookRow(key: string) {
  const { data } = await db.from("sv_playbook").select("body").eq("key", key).maybeSingle();
  return (data?.body ?? "") as string;
}
let playbookCache: { at: number; body: string } | null = null;
async function playbook() {
  if (playbookCache && Date.now() - playbookCache.at < 60_000) return playbookCache.body;
  playbookCache = { at: Date.now(), body: await playbookRow("main") };
  return playbookCache.body;
}

async function adminRulesBlock() {
  const t = (await playbookRow("admin_rules")).trim();
  return t ? `DOIMIY ADMIN QOIDALARI (har postda QATIY bajar, playbookdan ham ustun):\n${t}` : "";
}

const noteBlock = (note?: string) =>
  note
    ? `\nADMIN IZOHI — ENG YUQORI USTUVORLIK. Playbook va qoidalardan ham ustun, so'zma-so'z bajar, aksini qilma:\n"${note}"\n`
    : "";

const USERS_RE = /[^.!?\n]*(?:(?<![a-z\d])\d+\s*k\s*\+|(?<![a-z\d])\d+\s*ming(?![a-z]))[^.!?\n]*[.!?]?\s*/gi;
function stripUserCount(p: Post, note?: string): Post {
  if (note && /7k|ming|foydalanuvchi/i.test(note)) return p;
  const clean = (s: string) => String(s ?? "").replace(USERS_RE, " ").replace(/[ \t]{2,}/g, " ").trim();
  const out: Post = {
    ...p,
    caption: clean(p.caption),
    hook: String(p.hook ?? "").replace(/\s*\d+\s*k\s*\+\s*/i, " ").trim(),
  };
  if (p.slides) out.slides = p.slides.map((s) => ({ hook: clean(s.hook), line: clean(s.line) }));
  return out;
}

async function historyBlock() {
  const { data } = await db.from("sv_posts")
    .select("status, theme, pillar, post_format, post_type, caption")
    .in("status", ["published", "scheduled", "awaiting_time", "pending", "rejected"])
    .order("created_at", { ascending: false }).limit(14);
  if (!data?.length) return "(Hali tarix yo'q.)";
  return data.map((p: any) =>
    `- [${p.status === "rejected" ? "ADMIN RAD ETGAN" : "chiqqan"}] tur=${p.post_type ?? "text_image"} ustun=${p.pillar ?? "?"} format=${p.post_format ?? "?"} ` +
    `mavzu=${p.theme ?? ""} | ${String(p.caption ?? "").replace(/\s+/g, " ").slice(0, 140)}`
  ).join("\n");
}

// What worked: average reactions per pillar / type, strongest hour and weekday (Tashkent time).
async function metricsBlock() {
  const { data } = await db.from("sv_posts")
    .select("pillar, post_type, reaction_count, published_at")
    .not("published_at", "is", null).not("channel_message_id", "is", null)
    .order("published_at", { ascending: false }).limit(80);
  if (!data || data.length < 3) return "(Metrika hali yetarli emas — bir tekis aralashtir.)";
  const avg = (key: (p: any) => string) => {
    const m = new Map<string, { s: number; n: number }>();
    for (const p of data) {
      const k = key(p);
      const e = m.get(k) ?? { s: 0, n: 0 };
      e.s += p.reaction_count ?? 0;
      e.n++;
      m.set(k, e);
    }
    return [...m.entries()].map(([k, v]) => ({ k, avg: v.s / v.n, n: v.n })).sort((a, b) => b.avg - a.avg);
  };
  const fmt = (rows: { k: string; avg: number; n: number }[]) =>
    rows.map((r) => `${r.k}: o'rtacha ${r.avg.toFixed(1)} reaksiya (${r.n} post)`).join("; ");
  const byPillar = avg((p) => p.pillar ?? "?");
  const byType = avg((p) => p.post_type ?? "text_image");
  const byHour = avg((p) => `${String(tashkent(new Date(p.published_at)).hh).padStart(2, "0")}:00`);
  const byDay = avg((p) => WEEKDAYS[tashkent(new Date(p.published_at)).wd]);
  return `Oxirgi ${data.length} post natijalari (reaksiya soni bo'yicha; G'OLIBLARGA og'ish, lekin xilma-xillikni saqla):\n` +
    `- Ustunlar: ${fmt(byPillar)}\n- Turlar: ${fmt(byType)}\n` +
    `- Eng kuchli soat: ${fmt(byHour.slice(0, 3))}\n- Eng kuchli kun: ${fmt(byDay.slice(0, 3))}`;
}

const nowBlock = () =>
  `Bugun (Toshkent): ${
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tashkent", weekday: "long", day: "numeric", month: "long", year: "numeric",
    }).format(new Date())
  }.`;

const POST_JSON = `Javobni FAQAT quyidagi JSON formatida ber, boshqa hech narsa yozma:
{
  "hook": "rasm ustiga chiqadigan sarlavha (max 60 belgi, hook formulalaridan biri, o'ziga xos)",
  "caption": "to'liq post matni, oddiy matn (HTML teg yo'q), emoji bilan, ko'z yugurtirib o'qiladigan",
  "theme": "post mavzusi 1-2 so'zda",
  "pillar": "kontent ustuni nomi (ISHONCH, AMALIY MASLAHAT, MIF VA HAQIQAT, HIKOYA, SAVOL, ILOVA, QADRIYAT yoki MAVSUMIY)",
  "post_format": "format (ro'yxat, mif/haqiqat, mini-hikoya, savol/tanlov, qo'llanma, ilova-imkoniyat, esse)",
  "image_query": "stok-foto qidirish uchun 2-4 ta INGLIZCHA so'z (RASM QOIDASIga qara)",
  "sticker_emoji": "post kayfiyatiga mos stiker topish uchun 1-3 ta emoji, faqat emojilar (masalan: '❤️', '💍', '🤝', '😊', '🤔', '🌹')"
}`;

const CAROUSEL_JSON = `Javobni FAQAT quyidagi JSON formatida ber, boshqa hech narsa yozma:
{
  "caption": "karusel ostidagi qisqa post matni (200-450 belgi), oddiy matn, emoji bilan",
  "theme": "mavzu 1-2 so'zda",
  "pillar": "kontent ustuni nomi (ISHONCH, AMALIY MASLAHAT, MIF VA HAQIQAT, HIKOYA, SAVOL, ILOVA, QADRIYAT yoki MAVSUMIY)",
  "post_format": "karusel",
  "sticker_emoji": "1-3 ta emoji",
  "slides": [ { "hook": "slayd sarlavhasi (max 45 belgi)", "line": "1-2 qisqa gap (max 130 belgi)" } ]
}
slides: 3 dan 5 tagacha element. 1-slayd — diqqat tortuvchi qopqoq (line bo'sh bo'lishi mumkin), oxirgisi — yengil xulosa.`;

const POLL_JSON = `Javobni FAQAT quyidagi JSON formatida ber, boshqa hech narsa yozma:
{
  "question": "so'rovnoma savoli (max 250 belgi, 1 ta emoji mumkin)",
  "options": ["variant 1", "variant 2", "variant 3"],
  "is_quiz": false,
  "correct_index": 0,
  "explanation": "faqat is_quiz=true bo'lsa: nega bu javob to'g'ri (max 180 belgi), aks holda bo'sh",
  "theme": "mavzu 1-2 so'zda",
  "pillar": "kontent ustuni nomi",
  "sticker_emoji": "1-3 ta emoji"
}
options: 2 dan 4 tagacha, har biri max 80 belgi. Haqiqiy fikr/tanlov so'ra; is_quiz faqat aniq to'g'ri javobli savolda.`;

const PLAN_JSON = `Javobni FAQAT quyidagi JSON formatida ber:
{
  "pillar": "tanlangan ustun",
  "post_format": "tanlangan format",
  "audience_pain": "bu post qaysi aniq og'riq/savolga javob beradi (1 gap)",
  "angle": "o'ziga xos burchak: nima yangilik/kutilmagan fikr beradi (1-2 gap)",
  "hook_options": ["hook 1", "hook 2", "hook 3"],
  "cta": "CTA turi (saqlab qo'y / do'stingga yubor / ilovani och / savolga javob yoz)",
  "why": "nega aynan shu hozir (tarix, metrika va mavsumga ko'ra, 1 gap)"
}`;

const RULES = `Qoidalar:
- Faqat o'zbek tilida (lotin).
- Foydalanuvchilar soni ("${BRAND.usersLabel}", "ming foydalanuvchi" va h.k.) haqida postda UMUMAN yozma, agar admin aniq so'ramasa.
- Caption 500-850 belgi (QATIY 900 dan oshmasin; karuselda 200-450). 1-3 ta emoji. Oxirida yengil, har safar boshqacha CTA.
- Followerlardan "reaksiya bosing / like bosing" deb HECH QACHON so'rama.
- MATNDA HAVOLA (URL, https, play.google...) yoki "sovchi.app" so'zini YOZMA — havola alohida qo'shiladi.

RASM QOIDASI (image_query uchun): brend halol, oilaviy niyatli o'zbek/musulmon auditoriyaga mo'ljallangan. Query bosiq, oddiy, hurmatli bo'lsin. Romantik/yaqinlik/sevishganlar (kiss, hug, romantic couple, silhouette couple, intimate, dating, bed, bikini...) MUMKIN EMAS. Odamlar kerak bo'lsa — oila, ota-ona, uzoqdagi bosiq juftlik. Afzal mavzular: ${SAFE_QUERIES.join(", ")}. Shubhali bo'lsa shulardan birini tanla.`;

const TYPE_BRIEF: Record<string, string> = {
  text_image: "Format: oddiy matn + rasm post.",
  question:
    "Format: OCHIQ SAVOL posti. Matn qisqa kirish + bitta aniq ochiq savol; oxirida auditoriyani javobini izohlarda yoki botga/DM ga yozishga chaqir. Baho yoki 'reaksiya bos' deb so'rama.",
  carousel: "Format: KARUSEL (3-5 slayd). Har slayd bitta fikr. Caption qisqa bo'lsin.",
  poll: "Format: SO'ROVNOMA (Telegram poll). Savol va 2-4 variant.",
  video_text: "Format: qisqa brendli video (reel) uchun matn.",
};

const POST_SCHEMA: Record<string, string> = {
  text_image: POST_JSON, question: POST_JSON, video_text: POST_JSON, carousel: CAROUSEL_JSON, poll: POLL_JSON,
};

async function header() {
  return `${await playbook()}

${await adminRulesBlock()}

BREND: ${BRAND.name} — o'zbek tilidagi jiddiy tanishuv / nikoh ilovasi. Shiori: "${BRAND.tagline}". Telegram bot va mobil ilova mavjud.
OVOZ (uslub): ${BRAND.voice}

KANALNING ESKI POSTLARI (uslub va ohangni o'rgan):
${await samplesBlock()}

OXIRGI POSTLAR TARIXI (ustunlar va hooklarni TAKRORLAMA; "ADMIN RAD ETGAN" yo'nalishdan qoch):
${await historyBlock()}

NATIJALAR (metrika):
${await metricsBlock()}

${nowBlock()} Mavsum, hafta kuni va yaqin bayramlarni o'rinli bo'lsagina hisobga ol.`;
}

function trimCaption(p: Post, limit = 880): Post {
  let cap = String(p.caption ?? "").trim();
  if (cap.length > limit) {
    const cut = cap.slice(0, limit);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    cap = end > limit * 0.6 ? cut.slice(0, end + 1) : cut.trimEnd();
  }
  return { ...p, caption: cap };
}

const cut = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

// Raw model JSON -> validated Post of the given type (throws when unusable).
function normalize(type: PostType, raw: any): Post {
  if (type === "poll") {
    const options = (Array.isArray(raw?.options) ? raw.options : [])
      .map((o: unknown) => cut(o, 90)).filter(Boolean).slice(0, 4);
    const question = cut(raw?.question, 280);
    if (!question || options.length < 2) throw new Error("poll: savol yoki variantlar yetarli emas");
    const ci = Number(raw?.correct_index);
    const quiz = !!raw?.is_quiz && Number.isInteger(ci) && ci >= 0 && ci < options.length;
    return {
      post_type: "poll", hook: question, caption: question, theme: cut(raw?.theme, 40),
      pillar: raw?.pillar, post_format: "so'rovnoma", sticker_emoji: raw?.sticker_emoji,
      poll: {
        question, options, is_quiz: quiz, correct_option_id: quiz ? ci : undefined,
        explanation: quiz ? cut(raw?.explanation, 190) || undefined : undefined,
      },
    };
  }
  if (type === "carousel") {
    const slides: Slide[] = (Array.isArray(raw?.slides) ? raw.slides : [])
      .map((s: any) => ({ hook: cut(s?.hook, 70), line: cut(s?.line, 160) }))
      .filter((s: Slide) => s.hook).slice(0, 5);
    if (slides.length < 3 || !raw?.caption) throw new Error("carousel: kamida 3 slayd va caption kerak");
    return {
      post_type: "carousel", hook: slides[0].hook, caption: String(raw.caption), theme: cut(raw?.theme, 40),
      pillar: raw?.pillar, post_format: "karusel", sticker_emoji: raw?.sticker_emoji, slides,
    };
  }
  if (!raw?.hook || !raw?.caption) throw new Error("hook/caption yo'q");
  return {
    post_type: type, hook: String(raw.hook), caption: String(raw.caption), theme: cut(raw.theme, 40),
    pillar: raw.pillar, post_format: raw.post_format, image_query: raw.image_query, sticker_emoji: raw.sticker_emoji,
  };
}

// Stage 2 (write, following the plan) + stage 3 (editor review, best-effort).
async function craft(type: PostType, task: string, plan?: unknown, note?: string): Promise<Post> {
  const head = await header();
  const nb = noteBlock(note);
  const planTxt = plan
    ? `\nSTRATEGIYA REJASI (shunga amal qil, hook_options ichidan eng kuchlisini tanla yoki yaxshila):\n${JSON.stringify(plan, null, 2)}\n`
    : "";
  const schema = POST_SCHEMA[type];
  let draft: Post = normalize(
    type,
    await gemini(`${head}\n\nVAZIFA: ${task}\n${TYPE_BRIEF[type]}\n${nb}${planTxt}\n${RULES}\n\n${schema}`),
  );
  try {
    const final = normalize(
      type,
      await gemini(
        `${head}\n\nVAZIFA: MUHARRIR. Quyidagi draftni SIFAT TEKSHIRUVI bo'yicha qattiq baho ber. Hook kuchsiz yoki umumiy bo'lsa — almashtir. Bo'sh gaplarni olib tashla, qiymatni aniqlashtir, keraksiz so'zlarni qisqartir. Soxta fakt, haqiqiy bo'lmagan va'da yoki romantik ohang bo'lsa — to'g'rila. Formatni (${type}) va uzunlik chegaralarini saqla. Draft yaxshi bo'lsa deyarli o'zgartirma. ADMIN IZOHI yoki REJA bandi bo'lsa, draft unga to'liq amal qilganini tekshir va uni BUZMA.\n${nb}\nVAZIFA TAVSIFI: ${task}\n\nDRAFT:\n${JSON.stringify(draft)}\n\n${RULES}\n\n${schema}`,
      ),
    );
    draft = final;
  } catch (e) {
    console.warn("editor stage skipped:", e);
  }
  const clean = stripUserCount(draft, note);
  return type === "poll" ? clean : trimCaption(clean, type === "carousel" ? 700 : 880);
}

async function generateNew(direction?: string, type: PostType = "text_image"): Promise<Post> {
  const dir = direction ? `\nADMIN YO'NALISHI (hisobga ol): ${direction}` : "";
  let plan: unknown = undefined;
  try {
    plan = await gemini(
      `${await header()}\n\nVAZIFA: STRATEGIYA. Tarix va metrikaga qarab keyingi post uchun eng yaxshi rejani tuz: ustunni (oxirgilardan FARQLI), formatni, auditoriya og'rig'ini va o'ziga xos burchakni tanla.${dir}\nPost turi: ${type}.\n\n${PLAN_JSON}`,
    );
  } catch (e) {
    console.warn("strategy stage skipped:", e);
  }
  return craft(type, "shu uslubda, kanalga yangi BITTA kuchli post yoz." + dir, plan, direction);
}

type PlanItem = {
  id: number; post_date: string; slot_time: string | null; post_type: string; pillar: string | null;
  theme: string | null; core_message: string | null; hook_idea: string | null; cta: string | null;
};

// A plan item fixes the type and WHAT the text says (core_message).
function generateFromItem(it: PlanItem): Promise<Post> {
  const type = (POST_TYPES.includes(it.post_type as PostType) ? it.post_type : "text_image") as PostType;
  const plan = {
    pillar: it.pillar, angle: it.core_message, hook_options: [it.hook_idea].filter(Boolean), cta: it.cta,
    why: "oylik kontent-rejadagi band",
  };
  return craft(
    type,
    `OYLIK REJA BANDI bo'yicha post yoz. Mavzu: "${it.theme}". Ustun: ${it.pillar}. ` +
      `ASOSIY FIKR (core_message) — post matni AYNAN shuni ochib bersin, boshqa mavzuga chalg'ima: "${it.core_message}". ` +
      `Hook g'oyasi: "${it.hook_idea}". CTA: "${it.cta}".`,
    plan,
  );
}

const rewrite = (old: { caption: string; post_type?: string }, comment: string) =>
  craft(
    (POST_TYPES.includes(old.post_type as PostType) ? old.post_type : "text_image") as PostType,
    `quyidagi MAVJUD draftni admin izohiga ko'ra QAYTA yoz.\n\n--- MAVJUD DRAFT ---\n${old.caption}\n--- TUGADI ---\n\nAvval admin izohini bajar; qolgan joyini brend uslubi va playbookka mos saqla.`,
    undefined,
    comment,
  );

const adapt = (source: string) =>
  craft(
    "text_image",
    `quyidagi BOSHQA kanaldagi postdan faqat G'OYA/mavzuni ol va butunlay ${BRAND.name} uchun, o'z uslubimizda qaytadan yoz (ko'chirma qilma).\n\n--- MANBA POST ---\n${source}\n--- TUGADI ---`,
  );

// Admin reply on a draft: rewrite the text, swap only the picture, or both.
async function classifyNote(p: { hook?: string | null; caption: string }, note: string) {
  try {
    const r = await gemini(
      `Admin telegram kanal draftiga izoh yozdi. Izoh nimani o'zgartirishni so'rayotganini aniqla.\n` +
        `- "image": faqat RASM/ko'rinish haqida (rasm, fon, rang, boshqa surat, rasmda nima bo'lsin) — matn o'zgarmasin.\n` +
        `- "text": faqat MATN haqida (qisqartir, ohang, so'z, fakt, CTA).\n- "both": ikkalasi yoki aniq emas.\n\n` +
        `DRAFT HOOK: ${p.hook ?? ""}\nDRAFT MATN: ${p.caption.replace(/<[^>]+>/g, "").slice(0, 500)}\nIZOH: ${note}\n\n` +
        `JSON: {"scope":"text|image|both","image_query":"scope image yoki both bo'lsa: yangi rasm uchun 2-4 INGLIZCHA so'z (bosiq, oilaviy, romantik emas), aks holda bo'sh"}`,
      { timeout: 12_000, budget: 20_000, attempts: 2, models: 2 },
    );
    const scope = ["text", "image", "both"].includes(r?.scope) ? r.scope : "both";
    const q = cut(r?.image_query, 80);
    return { scope: scope as "text" | "image" | "both", image_query: q && !isUnsafe(q) ? q : "" };
  } catch (e) {
    console.warn("classifyNote failed, using both:", e);
    return { scope: "both" as const, image_query: "" };
  }
}

// ---------- Stock photos (Pixabay first, Pexels as backup) ----------
const PIXABAY_KEY = env("PIXABAY_API_KEY");
const PEXELS_KEY = env("PEXELS_API_KEY");

async function fetchBytes(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function pixabayPhoto(query: string): Promise<Uint8Array | null> {
  for (const q of queryList(query)) {
    for (const orientation of ["vertical", "all"]) {
      const r = await fetch(
        `https://pixabay.com/api/?key=${PIXABAY_KEY}&q=${encodeURIComponent(q.slice(0, 100))}&image_type=photo&orientation=${orientation}&safesearch=true&per_page=30`,
        { signal: AbortSignal.timeout(10_000) },
      );
      const hits = ((await r.json()).hits ?? []).filter((h: any) => !isUnsafe(String(h.tags ?? "")));
      if (!hits.length) continue;
      const h = hits[Math.floor(Math.random() * Math.min(hits.length, 20))];
      return await fetchBytes(h.webformatURL);
    }
  }
  return null;
}

async function pexelsPhoto(query: string): Promise<Uint8Array | null> {
  for (const q of queryList(query)) {
    const r = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&orientation=portrait&per_page=15`,
      { headers: { Authorization: PEXELS_KEY }, signal: AbortSignal.timeout(10_000) },
    );
    const photos = ((await r.json()).photos ?? []).filter((p: any) => !isUnsafe(String(p.alt ?? "")));
    if (!photos.length) continue;
    const p = photos[Math.floor(Math.random() * photos.length)];
    return await fetchBytes(p.src.portrait);
  }
  return null;
}

async function pickPhoto(query?: string | null): Promise<Uint8Array | null> {
  if (!query) return null;
  const sources = [PIXABAY_KEY ? pixabayPhoto : null, PEXELS_KEY ? pexelsPhoto : null]
    .filter(Boolean) as ((q: string) => Promise<Uint8Array | null>)[];
  for (const src of sources) {
    try {
      const p = await src(query);
      if (p) return p;
    } catch (e) {
      console.warn("pickPhoto failed:", e);
    }
  }
  return null;
}

// ---------- Stickers ----------
const normEmoji = (s: string) => s.replace(/️/g, "");

async function saveStickerSet(name: string) {
  const set = await tg("getStickerSet", { name });
  const rows = (set.stickers ?? []).slice(0, 200).map((s: any) => ({
    file_id: s.file_id, emoji: s.emoji ?? null, set_name: set.name, is_premium: !!s.premium_animation,
  }));
  if (rows.length) await db.from("sv_stickers").upsert(rows, { onConflict: "file_id" });
  return { title: set.title as string, count: rows.length, premium: rows.filter((r: any) => r.is_premium).length };
}

async function pickSticker(emoji?: string | null): Promise<string | null> {
  const { data } = await db.from("sv_stickers").select("file_id, emoji, is_premium").limit(2000);
  if (!data?.length) return null;
  const wanted = Array.from(normEmoji(emoji ?? "")).filter((c) => c.trim());
  let pool = data.filter((s: any) => s.emoji && wanted.some((c) => normEmoji(s.emoji).includes(c)));
  if (!pool.length) pool = data;
  const premium = pool.filter((s: any) => s.is_premium);
  if (premium.length && Math.random() < 0.5) pool = premium;
  return pool[Math.floor(Math.random() * pool.length)].file_id;
}

// ---------- Admin state (awaiting free-text answers) ----------
async function setState(awaiting: string | null, payload: unknown = null) {
  await db.from("sv_state").upsert({
    chat_id: ADMIN, awaiting, payload, updated_at: new Date().toISOString(),
  });
}
async function getState(): Promise<{ awaiting: string | null; payload: any }> {
  const { data } = await db.from("sv_state").select("awaiting, payload").eq("chat_id", ADMIN).maybeSingle();
  return { awaiting: data?.awaiting ?? null, payload: data?.payload ?? null };
}

// ---------- Drafts ----------
const draftKeyboard = (id: string, type: string) => ({
  inline_keyboard: [
    [
      { text: "✅ Joylash", callback_data: `approve:${id}` },
      { text: "❌ Rad etish", callback_data: `reject:${id}` },
    ],
    ...(type === "poll" || type === "video_text" ? [] : [[{ text: "🔄 Boshqa rasm", callback_data: `img:${id}` }]]),
  ],
});

const buildCaption = (c: string) =>
  `${esc(c.trim())}\n\n👉 <a href="${BRAND.appLink.replace(/&/g, "&amp;")}">${BRAND.name}</a>\n${BRAND.channelMention}`;

const pollText = (p: PollData) =>
  `📊 <b>${esc(p.question)}</b>\n` + p.options.map((o, i) => `${p.is_quiz && p.correct_option_id === i ? "✅" : "▫️"} ${i + 1}. ${esc(o)}`).join("\n") +
  (p.is_quiz ? `\n\n<i>Viktorina${p.explanation ? ": " + esc(p.explanation) : ""}</i>` : "");

// Photo card (stock photo when found, brand card otherwise) with a fresh random layout.
async function renderPostImage(post: { hook: string; theme: string; image_query?: string | null }, prevLayout?: string | null) {
  const photo = await pickPhoto(post.image_query);
  return await renderCard({ hook: post.hook, theme: post.theme, photo, layout: randomLayout(prevLayout) });
}

// Carousel slides: typographic cards from the same renderer, with slide numbers.
async function renderSlides(slides: Slide[], theme: string, prevLayout?: string | null) {
  const layout = randomLayout(prevLayout);
  const out = [];
  for (let i = 0; i < slides.length; i++) {
    out.push(await renderCard({
      hook: slides[i].hook, sub: slides[i].line, theme: i === 0 ? theme : "",
      layout, slide: { n: i + 1, total: slides.length }, darkBg: i % 2 === 1,
    }));
  }
  return out;
}

async function sendAdminGroup(cards: { bytes: Uint8Array; mime: string; ext: string }[]) {
  const form = new FormData();
  form.set("chat_id", ADMIN);
  form.set("media", JSON.stringify(cards.map((_, i) => ({ type: "photo", media: `attach://p${i}` }))));
  cards.forEach((c, i) => form.set(`p${i}`, new Blob([c.bytes], { type: c.mime }), `s${i}.${c.ext}`));
  const msgs = await tg("sendMediaGroup", form);
  return (msgs as any[]).map((m) => m.photo[m.photo.length - 1].file_id as string);
}

const newId = () => String(Date.now()) + Math.floor(Math.random() * 10);

async function sendDraft(post: Post, ctx: { plan_item_id?: number | null } = {}) {
  const id = newId();
  const base: Record<string, unknown> = {
    id, status: "pending", theme: post.theme, hook: post.hook, pillar: post.pillar ?? null,
    post_format: post.post_format ?? null, image_query: post.image_query ?? null,
    sticker_emoji: post.sticker_emoji ?? null, post_type: post.post_type,
    plan_item_id: ctx.plan_item_id ?? null,
  };

  if (post.post_type === "poll" && post.poll) {
    const sent = await say(`${pollText(post.poll)}`, { reply_markup: draftKeyboard(id, "poll") });
    await db.from("sv_posts").insert({ ...base, caption: post.poll.question, poll: post.poll, admin_message_id: sent.message_id });
  } else if (post.post_type === "carousel" && post.slides) {
    const cards = await renderSlides(post.slides, post.theme);
    const fileIds = await sendAdminGroup(cards);
    const caption = buildCaption(post.caption);
    const sent = await say(`🎠 <b>Karusel draft</b> (${cards.length} slayd)\n\n${caption}`, {
      reply_markup: draftKeyboard(id, "carousel"), disable_web_page_preview: true,
    });
    await db.from("sv_posts").insert({
      ...base, caption, layout: cards[0].layout, photo_file_id: fileIds[0],
      media: { slides: post.slides.map((s, i) => ({ ...s, file_id: fileIds[i] })) },
      admin_message_id: sent.message_id,
    });
  } else {
    const image = await renderPostImage(post);
    const caption = buildCaption(post.caption);
    const form = new FormData();
    form.set("chat_id", ADMIN);
    form.set("caption", caption);
    form.set("parse_mode", "HTML");
    form.set("photo", new Blob([image.bytes], { type: image.mime }), `${id}.${image.ext}`);
    form.set("reply_markup", JSON.stringify(draftKeyboard(id, post.post_type)));
    const sent = await tg("sendPhoto", form);
    await db.from("sv_posts").insert({
      ...base, caption, layout: image.layout,
      photo_file_id: sent.photo[sent.photo.length - 1].file_id, admin_message_id: sent.message_id,
    });
  }
  if (ctx.plan_item_id) {
    await db.from("sv_plan_items").update({ status: "draft_sent", post_id: id }).eq("id", ctx.plan_item_id);
  }
  return id;
}

// Edit the admin's draft message into a status line (caption for media drafts, text otherwise).
async function markDraft(p: any, label: string) {
  const common = { chat_id: ADMIN, message_id: p.admin_message_id, reply_markup: { inline_keyboard: [] } };
  const captioned = ["text_image", "question", "video_text"].includes(p.post_type ?? "text_image");
  try {
    if (captioned) {
      await tg("editMessageCaption", { ...common, caption: `${label}\n\n${p.caption}`.slice(0, 1024), parse_mode: "HTML" });
    } else {
      const body = p.post_type === "poll" && p.poll ? pollText(p.poll) : p.caption;
      await tg("editMessageText", { ...common, text: `${label}\n\n${body}`.slice(0, 4000), parse_mode: "HTML" });
    }
  } catch (e) {
    console.warn("markDraft edit failed:", e);
    await tg("editMessageReplyMarkup", common).catch(() => {});
  }
}

// Swap only the picture: same text, new photo and a freshly shuffled template.
async function swapImage(p: any, query?: string | null) {
  const q = query || p.image_query;
  if (p.post_type === "carousel" && p.media?.slides) {
    const slides: Slide[] = p.media.slides;
    const cards = await renderSlides(slides, p.theme ?? "", p.layout);
    const fileIds = await sendAdminGroup(cards);
    await db.from("sv_posts").update({
      layout: cards[0].layout, photo_file_id: fileIds[0],
      media: { slides: slides.map((s, i) => ({ ...s, file_id: fileIds[i] })) },
    }).eq("id", p.id);
    return void await say("🔄 Karusel slaydlari qayta yasaldi (yuqoridagi yangi rasmlar). Tugmalar eski xabarda.");
  }
  const image = await renderPostImage({ hook: p.hook ?? "", theme: p.theme ?? "", image_query: q }, p.layout);
  const form = new FormData();
  form.set("chat_id", ADMIN);
  form.set("message_id", String(p.admin_message_id));
  form.set("media", JSON.stringify({ type: "photo", media: "attach://photo", caption: p.caption, parse_mode: "HTML" }));
  form.set("photo", new Blob([image.bytes], { type: image.mime }), `${p.id}.${image.ext}`);
  form.set("reply_markup", JSON.stringify(draftKeyboard(p.id, p.post_type)));
  const edited = await tg("editMessageMedia", form);
  await db.from("sv_posts").update({
    photo_file_id: edited.photo[edited.photo.length - 1].file_id, layout: image.layout, image_query: q ?? null,
  }).eq("id", p.id);
}

async function onImg(cq: any, id: string) {
  const { data } = await db.from("sv_posts").select("*").eq("id", id).eq("status", "pending").maybeSingle();
  if (!data) return tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Allaqachon ishlangan" });
  if (data.post_type === "poll" || data.post_type === "video_text") {
    return tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Bu turda rasm yo'q" });
  }
  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Yangi rasm qidiryapman 🔄" });
  if (data.post_type !== "carousel" && (!PIXABAY_KEY && !PEXELS_KEY || !data.image_query)) {
    return void await say("⚠️ Rasm manbasi sozlanmagan (PIXABAY_API_KEY yo'q yoki bu draft eski).");
  }
  await swapImage(data);
}

// ---------- Approve -> time -> scheduled -> publish ----------
const SLOTS = ["1000", "1400", "1700", "2000"];

async function askTime(p: any) {
  let hint = "";
  if (p.plan_item_id) {
    const { data: it } = await db.from("sv_plan_items").select("slot_time").eq("id", p.plan_item_id).maybeSingle();
    if (it?.slot_time) hint = String(it.slot_time).slice(0, 5);
  }
  const btn = (t: string) => ({
    text: (hint && t.slice(0, 2) + ":" + t.slice(2) === hint ? "⭐ " : "") + t.slice(0, 2) + ":" + t.slice(2),
    callback_data: `time:${p.id}:${t}`,
  });
  await setState(`time:${p.id}`, { id: p.id });
  await say(
    `⏰ <b>Qachon joylaymiz?</b> (Toshkent vaqti)${hint ? `\nReja bo'yicha taxminiy vaqt: ${hint} ⭐` : ""}`,
    {
      reply_markup: {
        inline_keyboard: [
          SLOTS.slice(0, 2).map(btn), SLOTS.slice(2).map(btn),
          [
            { text: "🚀 Hozir", callback_data: `time:${p.id}:now` },
            { text: "🕐 Boshqa vaqt", callback_data: `time:${p.id}:custom` },
          ],
        ],
      },
    },
  );
}

async function onApprove(cq: any, id: string) {
  const { data } = await db.from("sv_posts").update({ status: "awaiting_time" })
    .eq("id", id).eq("status", "pending").select().maybeSingle();
  if (!data) return tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Allaqachon ishlangan" });
  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Vaqtni tanlang ⏰" });
  await markDraft(data, "⏳ TASDIQLANDI — vaqt tanlanmoqda");
  await askTime(data);
}

async function onTime(cq: any, rest: string) {
  const [id, arg] = rest.split(":");
  const { data: p } = await db.from("sv_posts").select("*").eq("id", id).eq("status", "awaiting_time").maybeSingle();
  if (!p) return tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Allaqachon ishlangan" });

  if (arg === "custom") {
    await setState(`time:${id}`, { id });
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Vaqtni yozing" });
    return void await say("🕐 Vaqtni yozing: <code>15:30</code>, <code>ertaga 09:00</code> yoki <code>2026-11-05 18:00</code> (Toshkent).");
  }
  if (arg === "now") {
    const { data: claimed } = await db.from("sv_posts").update({ status: "publishing" })
      .eq("id", id).eq("status", "awaiting_time").select().maybeSingle();
    if (!claimed) return tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Allaqachon ishlangan" });
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Joylayapman 🚀" });
    await setState(null);
    try {
      await publishPost(claimed);
      await markDraft(claimed, "✅ JOYLANDI");
    } catch (e) {
      await db.from("sv_posts").update({ status: "awaiting_time" }).eq("id", id);
      throw e;
    }
    return void await tg("editMessageReplyMarkup", {
      chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }
  const m = arg?.match(/^(\d{2})(\d{2})$/);
  if (!m) return tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Noto'g'ri vaqt" });
  const when = nextAt(+m[1], +m[2]);
  await scheduleAt(p, when);
  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Rejalandi 🗓" });
  await tg("editMessageText", {
    chat_id: cq.message.chat.id, message_id: cq.message.message_id, parse_mode: "HTML",
    text: `🗓 Rejalandi: <b>${fmtLocal(when.toISOString())}</b> (Toshkent)`,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {});
}

async function scheduleAt(p: any, when: Date) {
  const { data } = await db.from("sv_posts").update({ status: "scheduled", scheduled_at: when.toISOString() })
    .eq("id", p.id).eq("status", "awaiting_time").select().maybeSingle();
  if (!data) return;
  await setState(null);
  await markDraft(p, `🗓 REJALANDI: ${fmtLocal(when.toISOString())}`);
  if (p.plan_item_id) await db.from("sv_plan_items").update({ status: "scheduled" }).eq("id", p.plan_item_id);
}

// ---- publishing: one adapter per destination; Instagram plugs in later ----
// Returns the channel message id (first message of a media group).
async function publishToTelegram(p: any): Promise<number> {
  const type = p.post_type ?? "text_image";
  if (type === "carousel") {
    const slides: Slide[] = p.media?.slides ?? [];
    const msgs = await tg("sendMediaGroup", {
      chat_id: CHANNEL,
      media: slides.map((s, i) => ({
        type: "photo", media: s.file_id,
        ...(i === 0 ? { caption: p.caption, parse_mode: "HTML" } : {}),
      })),
    });
    return msgs[0].message_id;
  }
  if (type === "poll") {
    const poll: PollData = p.poll;
    const m = await tg("sendPoll", {
      chat_id: CHANNEL, question: poll.question, options: poll.options, is_anonymous: true,
      ...(poll.is_quiz && poll.correct_option_id != null
        ? { type: "quiz", correct_option_id: poll.correct_option_id, ...(poll.explanation ? { explanation: poll.explanation } : {}) }
        : {}),
    });
    return m.message_id;
  }
  if (type === "video_text") {
    const m = await tg("sendVideo", {
      chat_id: CHANNEL, video: p.video_file_id, caption: p.caption, parse_mode: "HTML", supports_streaming: true,
    });
    return m.message_id;
  }
  const m = await tg("sendPhoto", { chat_id: CHANNEL, photo: p.photo_file_id, caption: p.caption, parse_mode: "HTML" });
  return m.message_id;
}

// TODO(instagram): implement publishToInstagram(p) (Graph API container -> publish) and set sv_posts.ig_status
// ('queued' | 'published' | 'failed'). It must never block or fail the Telegram publish.
const publishToInstagram: ((p: any) => Promise<void>) | null = null;

async function publishPost(p: any) {
  const messageId = await publishToTelegram(p);
  await db.from("sv_posts").update({
    status: "published", published_at: new Date().toISOString(), channel_message_id: messageId,
  }).eq("id", p.id);
  if (p.plan_item_id) await db.from("sv_plan_items").update({ status: "published" }).eq("id", p.plan_item_id);
  if (publishToInstagram) {
    try { await publishToInstagram(p); } catch (e) { console.warn("instagram failed:", e); }
  }
  // a mood-matching sticker right after the post; a failure must not undo the post
  if (Math.random() < STICKER_CHANCE) {
    try {
      const sid = await pickSticker(p.sticker_emoji);
      if (sid) await tg("sendSticker", { chat_id: CHANNEL, sticker: sid });
    } catch (e) {
      console.warn("sticker failed:", e);
    }
  }
}

async function publishDue() {
  const { data: due } = await db.from("sv_posts").select("*").eq("status", "scheduled")
    .lte("scheduled_at", new Date().toISOString()).order("scheduled_at").limit(10);
  const results: Record<string, string> = {};
  for (const p of due ?? []) {
    const { data: claimed } = await db.from("sv_posts").update({ status: "publishing" })
      .eq("id", p.id).eq("status", "scheduled").select().maybeSingle();
    if (!claimed) continue;
    try {
      await publishPost(claimed);
      results[p.id] = "published";
      await say(`✅ Kanalga joylandi (${TYPE_LABEL[p.post_type] ?? p.post_type}): ${esc(String(p.theme ?? p.hook ?? "").slice(0, 60))}`).catch(() => {});
    } catch (e) {
      await db.from("sv_posts").update({ status: "failed" }).eq("id", p.id);
      results[p.id] = "failed";
      await say(`⚠️ Rejalangan post joylanmadi (${p.id}): ${esc(String(e).slice(0, 300))}`).catch(() => {});
    }
  }
  return { checked: due?.length ?? 0, results };
}

async function onReject(cq: any, id: string) {
  const { data } = await db.from("sv_posts").update({ status: "rejected" })
    .eq("id", id).in("status", ["pending", "awaiting_time"]).select().maybeSingle();
  if (!data) return tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Allaqachon ishlangan" });
  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Rad etildi ❌" });
  if (data.plan_item_id) await db.from("sv_plan_items").update({ status: "rejected" }).eq("id", data.plan_item_id);
  await markDraft(data, "❌ RAD ETILDI");
}

async function onLearn(cq: any, id: string) {
  const { data } = await db.from("sv_forwards").select("text").eq("id", id).maybeSingle();
  if (!data) return tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Topilmadi" });
  await db.from("sv_samples").upsert({ text: data.text }, { onConflict: "text", ignoreDuplicates: true });
  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Namuna saqlandi 📚" });
  await tg("editMessageReplyMarkup", {
    chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] },
  });
  await say("📚 Namuna saqlandi. Keyingi postlar shu uslubdan o'rganadi.");
}

async function onAdapt(cq: any, id: string) {
  const { data } = await db.from("sv_forwards").select("text").eq("id", id).maybeSingle();
  if (!data) return tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Topilmadi" });
  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Moslashtiryapman ✍️" });
  await tg("editMessageReplyMarkup", {
    chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] },
  });
  await sendDraft(await adapt(data.text));
}

// ---------- Monthly content plan ----------
const PLAN_SLOTS = ["10:00", "14:00", "17:00", "20:00"];

const planKeyboard = (month: string) => ({
  inline_keyboard: [[
    { text: "✅ Tasdiqlash", callback_data: `plan_ok:${month}` },
    { text: "✍️ O'zgartirish", callback_data: `plan_edit:${month}` },
  ]],
});

function mondayOf(iso: string) {
  const d = new Date(iso + "T00:00:00Z");
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86400_000).toISOString().slice(0, 10);
}
const shortDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const wdOf = (iso: string) => WEEKDAYS[new Date(iso + "T00:00:00Z").getUTCDay()];

async function sendPlanView(month: string, intro: string) {
  const { data: items } = await db.from("sv_plan_items").select("*").eq("month", month)
    .order("post_date").order("slot_time");
  const rows = (items ?? []) as PlanItem[];
  if (!rows.length) return void await say("Reja bandlari yo'q.");
  const weeks = new Map<string, PlanItem[]>();
  for (const it of rows) {
    const k = mondayOf(it.post_date);
    weeks.set(k, [...(weeks.get(k) ?? []), it]);
  }
  const md: string[] = [`# Kontent-reja ${month}`, ""];
  let wn = 0;
  const chunks: string[] = [];
  for (const [mon, its] of weeks) {
    wn++;
    const endD = new Date(new Date(mon + "T00:00:00Z").getTime() + 6 * 86400_000).toISOString().slice(0, 10);
    let html = `📅 <b>${wn}-hafta (${shortDate(mon)}–${shortDate(endD)})</b>\n`;
    md.push(`## ${wn}-hafta (${shortDate(mon)}–${shortDate(endD)})`, "");
    for (const it of its) {
      const t = (it.slot_time ?? "").slice(0, 5) || "—";
      html += `\n<b>${shortDate(it.post_date)} ${wdOf(it.post_date)}</b> · ${esc(TYPE_LABEL[it.post_type] ?? it.post_type)} · ${esc(it.pillar ?? "")} · ${esc(it.theme ?? "")}\n` +
        `   ↳ ${esc(it.core_message ?? "")} · ~${t}\n`;
      md.push(`- **${shortDate(it.post_date)} ${wdOf(it.post_date)}** · ${TYPE_LABEL[it.post_type] ?? it.post_type} · ${it.pillar ?? ""} · ${it.theme ?? ""} — ${it.core_message ?? ""} · ~${t}` +
        (it.hook_idea ? `\n  - hook: ${it.hook_idea}` : "") + (it.cta ? `\n  - CTA: ${it.cta}` : ""));
    }
    md.push("");
    chunks.push(html);
  }
  await say(intro);
  for (const c of chunks) {
    // a week can still exceed Telegram's limit: split on item boundaries
    let buf = "";
    for (const part of c.split(/\n(?=<b>\d{2}\.\d{2})/)) {
      if ((buf + "\n" + part).length > 3800) { await say(buf); buf = part; } else buf = buf ? buf + "\n" + part : part;
    }
    if (buf) await say(buf);
  }
  const doc = new FormData();
  doc.set("chat_id", ADMIN);
  doc.set("document", new Blob([md.join("\n")], { type: "text/markdown" }), `reja-${month}.md`);
  doc.set("caption", `Oylik reja (${rows.length} band) — to'liq ko'rinish`);
  await tg("sendDocument", doc).catch((e) => console.warn("plan doc failed:", e));
  const sent = await say("Rejani tasdiqlaysizmi?", { reply_markup: planKeyboard(month) });
  await db.from("sv_plan").update({ admin_message_id: sent.message_id }).eq("month", month);
}

// Gemini builds the month in weekly chunks (one big call outlives the edge runtime and dies silently).
// Each chunk is saved as soon as it arrives, so a partial plan survives; `comment` re-plans after the admin's remark.
async function generatePlan(month: string, opts: { comment?: string; force?: boolean } = {}) {
  const { data: existing } = await db.from("sv_plan").select("*").eq("month", month).maybeSingle();
  if (existing?.status === "active" && !opts.force) {
    return void await say(`ℹ️ ${month} rejasi allaqachon tasdiqlangan va faol. Qayta yaratish: ?generate_plan=...&force=1`);
  }
  const [y, mo] = month.split("-").map(Number);
  const today = tashkent().iso;
  const days: string[] = [];
  for (let d = 1; d <= new Date(Date.UTC(y, mo, 0)).getUTCDate(); d++) {
    const iso = `${month}-${String(d).padStart(2, "0")}`;
    if (iso >= today) days.push(iso);
  }
  if (!days.length) return void await say(`⚠️ ${month} oyida rejalanadigan kun qolmagan.`);

  await say(`⏳ <b>${month}</b> oylik reja tuzilyapti, 1-2 daqiqa...`);

  // the previous plan is the context for an admin remark; read it BEFORE it is cleared
  let previous = "";
  if (opts.comment) {
    const { data: prev } = await db.from("sv_plan_items")
      .select("post_date, slot_time, post_type, pillar, theme, core_message, hook_idea, cta")
      .eq("month", month).eq("status", "planned").order("post_date");
    previous = `\nAVVALGI REJA (admin shuni o'zgartirishni so'radi):\n${JSON.stringify(prev)}\n\nADMIN IZOHI — ENG YUQORI USTUVORLIK, rejani shunga moslab QAYTA tuz:\n"${opts.comment}"\n`;
  }

  await db.from("sv_plan").upsert({ month, status: "pending", summary: "", approved_at: null });
  await db.from("sv_plan_items").delete().eq("month", month).eq("status", "planned");

  const head = await header(); // db lookups once, shared by every chunk
  const chunks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) chunks.push(days.slice(i, i + 7));

  let total = 0;
  let summary = "";
  const failed: string[] = [];

  const runChunk = async (chunk: string[], idx: number) => {
    const label = `${idx + 1}-bo'lak (${shortDate(chunk[0])}–${shortDate(chunk[chunk.length - 1])})`;
    try {
      const prompt = `${head}

VAZIFA: OYLIK KONTENT-REJANING BIR BO'LAGI. ${month} oyi uchun sovchi.app Telegram kanali taqvimi: ${idx + 1}/${chunks.length}-bo'lak (hafta).
Faqat shu kunlar uchun (hafta kuni bilan): ${chunk.map((d) => `${d} ${wdOf(d)}`).join(", ")}

TALABLAR:
- Odatda kuniga 1 post (shu bo'lakda ${Math.max(4, chunk.length - 1)}-${chunk.length + 1} band), ba'zi kunlar bo'sh qolishi yoki 2 post bo'lishi mumkin.
- Turlar: text_image (asosiy), question (ochiq savol), carousel (3-5 slayd), poll (so'rovnoma), video_text (qisqa brendli video). Shu bo'lakda taxminan: 1 video_text, 1 carousel, 1 poll, 1 question, qolgani text_image.
- Ustunlarni (ISHONCH, AMALIY MASLAHAT, MIF VA HAQIQAT, HIKOYA, SAVOL, ILOVA, QADRIYAT, MAVSUMIY) aralashtir; ketma-ket bir xil ustun/turni qo'yma. METRIKADAGI g'oliblarga og'ish. Boshqa haftalar ham alohida tuziladi, shuning uchun mavzularni o'ziga xos tanla (umumiy "ishonch haqida" emas).
- O'zbekiston mavsumiyligi va bayramlarini hisobga ol (to'y mavsumi, ob-havo, bayramlar, hafta kuni: juma — alohida ohang) — faqat aniq bilganingni yoz.
- slot_time: ${PLAN_SLOTS.join(" / ")} dan biri (METRIKADAGI eng kuchli soatga og'ish).
- Har band MAJBURIY maydonlari: date (YYYY-MM-DD), slot_time, post_type, pillar, theme, core_message (post MATNI aynan nima deydi / qaysi burchak — 1-2 aniq gap, eng muhim maydon), hook_idea, cta.
- Foydalanuvchilar sonini hech qayerda tilga olma. Followerlardan reaksiya so'rama.
${previous}
JSON:
{"summary":"oy strategiyasi 1-2 gapda","items":[{"date":"YYYY-MM-DD","slot_time":"HH:MM","post_type":"text_image|question|carousel|poll|video_text","pillar":"...","theme":"...","core_message":"...","hook_idea":"...","cta":"..."}]}`;

      const raw = await gemini(prompt, { timeout: 80_000, budget: 100_000, attempts: 1, models: 2 });
      const allowed = new Set(chunk);
      const valid = (Array.isArray(raw?.items) ? raw.items : []).filter((it: any) =>
        allowed.has(String(it?.date)) && POST_TYPES.includes(it.post_type) &&
        it.pillar && it.theme && it.core_message && it.hook_idea && it.cta
      );
      if (!valid.length) throw new Error("yaroqli band yo'q");
      const rows = valid.map((it: any) => ({
        month, post_date: it.date,
        slot_time: /^\d{2}:\d{2}$/.test(String(it.slot_time)) ? it.slot_time : "14:00",
        post_type: it.post_type, pillar: cut(it.pillar, 40), theme: cut(it.theme, 80),
        core_message: cut(it.core_message, 400), hook_idea: cut(it.hook_idea, 160), cta: cut(it.cta, 120),
      }));
      const { error } = await db.from("sv_plan_items").insert(rows); // saved immediately
      if (error) throw error;
      total += rows.length;
      if (!summary && raw?.summary) summary = String(raw.summary).slice(0, 1500);
    } catch (e) {
      console.warn(`plan chunk ${label} failed:`, e);
      failed.push(`${label}: ${String(e).slice(0, 120)}`);
    }
  };

  // chunks are independent: run them side by side so the whole plan fits the runtime limit
  await Promise.all(chunks.map((c, i) => runChunk(c, i)));

  if (total < 5) {
    await db.from("sv_plan").update({ summary: `FAILED: ${failed.join(" | ")}`.slice(0, 1500) }).eq("month", month);
    return void await say(
      `⚠️ ${month} rejasi to'liq tuzilmadi: atigi ${total} band.\n${esc(failed.join("\n"))}\nQayta urinish: ?generate_plan=...&force=1`,
    );
  }
  await db.from("sv_plan").update({ summary }).eq("month", month);
  const note = failed.length ? `\n\n⚠️ ${failed.length} ta bo'lak yasalmadi:\n${esc(failed.join("\n"))}` : "";
  await sendPlanView(month, `🗓 <b>${month} oyi uchun kontent-reja tayyor</b> (${total} band)\n\n${esc(summary)}${note}`);
}

async function onPlanOk(cq: any, month: string) {
  const { data } = await db.from("sv_plan").update({ status: "active", approved_at: new Date().toISOString() })
    .eq("month", month).neq("status", "active").select().maybeSingle();
  if (!data) return tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Allaqachon faol yoki topilmadi" });
  await setState(null);
  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Reja tasdiqlandi ✅" });
  await tg("editMessageText", {
    chat_id: cq.message.chat.id, message_id: cq.message.message_id,
    text: `✅ ${month} rejasi tasdiqlandi. Har kuni ertalab bugungi draftlar yuboriladi.`,
  }).catch(() => {});
}

async function onPlanEdit(cq: any, month: string) {
  await setState(`plan_comment:${month}`, { month });
  await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Izohingizni yozing ✍️" });
  await say("✍️ Reja bo'yicha izohingizni yozing (masalan: <i>haftasiga 2 ta video bo'lsin, juma kunlari savol qo'y</i>). Men rejani shunga moslab qayta yuboraman.");
}

// ---------- Daily drafts from the active plan ----------
async function runToday() {
  const t = tashkent();
  const { data: plan } = await db.from("sv_plan").select("*").eq("month", t.month).maybeSingle();
  if (!plan) {
    return void await say(`📅 ${t.month} oyi uchun kontent-reja topilmadi, shuning uchun bugungi draftlar yaratilmadi. Reja yaratish: generate_plan workflow.`);
  }
  if (plan.status !== "active") {
    return void await say(
      `⏸ ${t.month} oylik rejasi hali <b>tasdiqlanmagan</b>, shuning uchun bugungi postlar yaratilmadi (ko'r-ko'rona joylamayman). Iltimos, rejani tasdiqlang:`,
      { reply_markup: planKeyboard(t.month) },
    );
  }
  const { data: items } = await db.from("sv_plan_items").select("*").eq("month", t.month)
    .eq("post_date", t.iso).eq("status", "planned").neq("post_type", "video_text").order("slot_time");
  let ok = 0;
  for (const it of (items ?? []) as PlanItem[]) {
    const { data: claimed } = await db.from("sv_plan_items").update({ status: "drafting" })
      .eq("id", it.id).eq("status", "planned").select().maybeSingle();
    if (!claimed) continue;
    try {
      await sendDraft(await generateFromItem(it), { plan_item_id: it.id });
      ok++;
    } catch (e) {
      await db.from("sv_plan_items").update({ status: "planned" }).eq("id", it.id);
      await say(`⚠️ Reja bandini yasab bo'lmadi (${esc(it.theme ?? "")}): ${esc(String(e).slice(0, 250))}`).catch(() => {});
    }
  }
  return ok;
}

// ---------- Video support (ffmpeg runs in GitHub Actions) ----------
async function pendingVideos() {
  const t = tashkent();
  const { data: plan } = await db.from("sv_plan").select("status").eq("month", t.month).maybeSingle();
  if (plan?.status !== "active") return { items: [], note: "plan not active" };
  const { data: items } = await db.from("sv_plan_items").select("*").eq("month", t.month)
    .eq("post_date", t.iso).eq("post_type", "video_text").eq("status", "planned").order("slot_time").limit(2);
  const out = [];
  for (const it of (items ?? []) as PlanItem[]) {
    try {
      const raw = await gemini(
        `${await header()}\n\nVAZIFA: 20-25 soniyalik brendli vertikal VIDEO (reel) uchun matn. Mavzu: "${it.theme}". Ustun: ${it.pillar}. ` +
          `ASOSIY FIKR: "${it.core_message}". Hook g'oyasi: "${it.hook_idea}". CTA: "${it.cta}".\n${RULES}\n\n` +
          `JSON: {"hook":"1-kadr sarlavhasi (max 45 belgi)","lines":["2-4 ta qisqa kadr matni, har biri max 70 belgi"],"outro":"yakuniy qisqa chaqiriq (max 40 belgi)","caption":"video ostidagi matn (200-450 belgi, oddiy matn)","image_query":"vertikal klip/foto qidirish uchun 2-4 INGLIZCHA so'z","queries":["2-3 ta zaxira INGLIZCHA qidiruv"],"sticker_emoji":"1-3 emoji"}`,
        { timeout: 40_000, budget: 80_000 },
      );
      const lines = (Array.isArray(raw?.lines) ? raw.lines : []).map((l: unknown) => cut(l, 90)).filter(Boolean).slice(0, 4);
      if (!raw?.hook || lines.length < 2 || !raw?.caption) throw new Error("video matni to'liq emas");
      const clean = stripUserCount({
        post_type: "video_text", hook: cut(raw.hook, 70), caption: String(raw.caption), theme: it.theme ?? "",
        slides: lines.map((l: string) => ({ hook: l, line: "" })),
      });
      const queries = [raw.image_query, ...(Array.isArray(raw.queries) ? raw.queries : [])]
        .map((q) => cut(q, 80)).filter((q) => q && !isUnsafe(q));
      out.push({
        plan_item_id: it.id, hook: clean.hook, lines: clean.slides!.map((s) => s.hook), outro: cut(raw.outro, 60),
        caption_html: buildCaption(trimCaption(clean).caption), caption_plain: trimCaption(clean).caption,
        queries, theme: it.theme, pillar: it.pillar, sticker_emoji: raw.sticker_emoji ?? null,
      });
    } catch (e) {
      console.warn("pendingVideos item failed:", e);
    }
  }
  return { items: out };
}

async function registerVideo(b: any) {
  const id = String(b.id ?? newId());
  if (!b.file_id || !b.caption) throw new Error("file_id va caption kerak");
  let theme: string | null = null, pillar: string | null = null;
  if (b.plan_item_id) {
    const { data: it } = await db.from("sv_plan_items").select("theme, pillar").eq("id", b.plan_item_id).maybeSingle();
    theme = it?.theme ?? null;
    pillar = it?.pillar ?? null;
  }
  const { error } = await db.from("sv_posts").upsert({
    id, status: "pending", caption: String(b.caption), theme, pillar, post_type: "video_text", post_format: "video",
    video_file_id: String(b.file_id), admin_message_id: b.admin_message_id ?? null,
    plan_item_id: b.plan_item_id ?? null, sticker_emoji: b.sticker_emoji ?? null,
  });
  if (error) throw error;
  if (b.plan_item_id) {
    await db.from("sv_plan_items").update({ status: "draft_sent", post_id: id }).eq("id", b.plan_item_id);
  }
  return { ok: true, id };
}

// ---------- Metrics: channel reactions ----------
function isChannelChat(chat: any) {
  const c = String(CHANNEL).toLowerCase();
  return String(chat?.id) === CHANNEL || (chat?.username && ("@" + chat.username).toLowerCase() === c);
}
const reactionKey = (r: any) => String(r?.emoji ?? r?.custom_emoji_id ?? r?.type ?? "?");

async function onReactionCount(u: any) {
  const r = u.message_reaction_count;
  if (!isChannelChat(r.chat)) return;
  const reactions = (r.reactions ?? []).map((x: any) => ({ emoji: reactionKey(x.type), count: x.total_count }));
  const total = reactions.reduce((s: number, x: any) => s + x.count, 0);
  await db.from("sv_posts").update({ reaction_count: total, reactions }).eq("channel_message_id", r.message_id);
}

// per-user reaction updates (when Telegram sends them): adjust the stored breakdown incrementally
async function onReaction(u: any) {
  const r = u.message_reaction;
  if (!isChannelChat(r.chat)) return;
  const { data } = await db.from("sv_posts").select("id, reactions").eq("channel_message_id", r.message_id).maybeSingle();
  if (!data) return;
  const m = new Map<string, number>((data.reactions ?? []).map((x: any) => [x.emoji, x.count]));
  for (const o of r.old_reaction ?? []) m.set(reactionKey(o), Math.max(0, (m.get(reactionKey(o)) ?? 0) - 1));
  for (const n of r.new_reaction ?? []) m.set(reactionKey(n), (m.get(reactionKey(n)) ?? 0) + 1);
  const reactions = [...m.entries()].filter(([, c]) => c > 0).map(([emoji, count]) => ({ emoji, count }));
  await db.from("sv_posts").update({
    reactions, reaction_count: reactions.reduce((s, x) => s + x.count, 0),
  }).eq("id", data.id);
}

// TODO(discussion): auto-reply to comments in the channel's linked discussion group.
// Messages from that group arrive here as non-admin `message` updates (is_automatic_forward marks the mirrored post).
async function onDiscussionMessage(_msg: any) {
  // intentionally empty
}

// ---------- Update routing ----------
const TYPE_ALIASES: Record<string, PostType> = {
  text: "text_image", matn: "text_image", text_image: "text_image", question: "question", savol: "question",
  carousel: "carousel", karusel: "carousel", poll: "poll", sorovnoma: "poll", "so'rovnoma": "poll",
};

async function onMessage(msg: any) {
  const text: string | undefined = msg.text ?? msg.caption;

  if (msg.sticker) {
    const s = msg.sticker;
    if (s.set_name) {
      const r = await saveStickerSet(s.set_name);
      return void await say(
        `🎭 "${esc(r.title)}" to'plami saqlandi: ${r.count} ta stiker` + (r.premium ? `, shundan ${r.premium} tasi premium ⭐` : "") + ".",
      );
    }
    await db.from("sv_stickers").upsert({
      file_id: s.file_id, emoji: s.emoji ?? null, set_name: null, is_premium: !!s.premium_animation,
    }, { onConflict: "file_id" });
    return void await say("🎭 Stiker kutubxonaga saqlandi.");
  }

  const cmd = text?.trim().split(/\s|@/)[0];

  if (cmd === "/pack") {
    const arg = text!.trim().split(/\s+/)[1] ?? "";
    const name = arg.replace(/^.*addstickers\//, "").replace(/[?#].*$/, "");
    if (!name) return void await say("Ishlatish: /pack <to'plam nomi yoki t.me/addstickers/... havolasi>");
    try {
      const r = await saveStickerSet(name);
      return void await say(
        `🎭 "${esc(r.title)}" to'plami saqlandi: ${r.count} ta stiker` + (r.premium ? `, shundan ${r.premium} tasi premium ⭐` : "") + ".",
      );
    } catch (e) {
      return void await say(`⚠️ To'plam topilmadi: ${esc(String(e).slice(0, 200))}`);
    }
  }

  if (cmd === "/stickers") {
    const { data } = await db.from("sv_stickers").select("set_name, is_premium").limit(2000);
    const sets = new Set((data ?? []).map((s: any) => s.set_name).filter(Boolean));
    const prem = (data ?? []).filter((s: any) => s.is_premium).length;
    return void await say(`🎭 Kutubxona: ${data?.length ?? 0} ta stiker (${prem} ta premium), ${sets.size} ta to'plam.`);
  }

  if (cmd === "/qoida") {
    const rule = text!.trim().replace(/^\S+\s*/, "").trim();
    if (!rule) return void await say("Ishlatish: /qoida <doimiy qoida>, masalan: /qoida Postda 'ilova' so'zini 2 martadan ko'p ishlatma");
    const cur = (await playbookRow("admin_rules")).trim();
    await db.from("sv_playbook").upsert({
      key: "admin_rules", body: (cur ? cur + "\n" : "") + "- " + rule, updated_at: new Date().toISOString(),
    });
    return void await say(`📌 Doimiy qoida qo'shildi: ${esc(rule)}\nBundan keyingi barcha postlarda amal qilinadi.`);
  }
  if (cmd === "/qoidalar") {
    const cur = (await playbookRow("admin_rules")).trim();
    return void await say(cur ? `📌 Doimiy qoidalar:\n${esc(cur)}\n\nBarchasini o'chirish: /qoida_tozala` : "Doimiy qoidalar yo'q.");
  }
  if (cmd === "/qoida_tozala") {
    await db.from("sv_playbook").upsert({ key: "admin_rules", body: "", updated_at: new Date().toISOString() });
    return void await say("🗑 Barcha doimiy qoidalar o'chirildi.");
  }

  // /reja — show this month's plan (with approve buttons while it is still pending)
  if (cmd === "/reja") {
    const month = tashkent().month;
    const { data: plan } = await db.from("sv_plan").select("status").eq("month", month).maybeSingle();
    if (!plan) return void await say("Bu oy uchun reja hali yo'q (har oyning 1-kuni avtomatik yaratiladi).");
    return void await sendPlanView(month, `🗓 ${month} rejasi — holati: <b>${esc(plan.status)}</b>`);
  }

  // /new [text|question|carousel|poll] [yo'nalish]
  if (cmd === "/new") {
    let direction = text!.trim().replace(/^\S+\s*/, "").trim();
    let type: PostType = "text_image";
    const first = direction.split(/\s+/)[0]?.toLowerCase();
    if (first && TYPE_ALIASES[first]) {
      type = TYPE_ALIASES[first];
      direction = direction.slice(first.length).trim();
    }
    await say("⏳ Strategiya tuzilyapti, post yozilyapti...");
    return void await sendDraft(await generateNew(direction || undefined, type));
  }

  // reply to a draft = smart edit
  const replied = msg.reply_to_message?.message_id;
  if (replied && text) {
    const { data: old } = await db.from("sv_posts").select("*")
      .eq("admin_message_id", replied).eq("status", "pending").maybeSingle();
    if (old) {
      if (old.post_type === "video_text") {
        return void await say("🎬 Video draftini matn orqali o'zgartirib bo'lmaydi — rad eting, yangisi yasaladi.");
      }
      const canImage = old.post_type !== "poll";
      const cls = canImage ? await classifyNote(old, text) : { scope: "text" as const, image_query: "" };
      if (cls.scope === "image") {
        await say("🖼 Faqat rasmni almashtiryapman (matn o'zgarmaydi)...");
        return void await swapImage(old, cls.image_query || null);
      }
      await db.from("sv_posts").update({ status: "replaced" }).eq("id", old.id);
      await say(cls.scope === "text" ? "✍️ Matnni izohga ko'ra qayta yozyapman..." : "✍️ Matn va rasmni izohga ko'ra qayta yasayapman...");
      return void await sendDraft(await rewrite(old, text), { plan_item_id: old.plan_item_id });
    }
  }

  // free-text answers the bot is waiting for (custom time / plan remark)
  if (text && !text.startsWith("/")) {
    const st = await getState();
    if (st.awaiting?.startsWith("time:")) {
      const id = st.awaiting.slice(5);
      const when = parseWhen(text);
      if (!when) {
        return void await say("⚠️ Vaqtni tushunmadim. Namuna: <code>15:30</code>, <code>ertaga 09:00</code>, <code>2026-11-05 18:00</code>");
      }
      const { data: p } = await db.from("sv_posts").select("*").eq("id", id).eq("status", "awaiting_time").maybeSingle();
      await setState(null);
      if (!p) return void await say("Bu post allaqachon ishlangan.");
      await scheduleAt(p, when);
      return void await say(`🗓 Rejalandi: <b>${fmtLocal(when.toISOString())}</b> (Toshkent)`);
    }
    if (st.awaiting?.startsWith("plan_comment:")) {
      const month = st.awaiting.slice("plan_comment:".length);
      await setState(null);
      await say("✍️ Rejani izohga moslab qayta tuzyapman...");
      return void await generatePlan(month, { comment: text, force: true });
    }
  }

  if (text && (msg.forward_origin || msg.forward_from_chat)) {
    const id = String(Date.now());
    await db.from("sv_forwards").insert({ id, text });
    return void await say("Bu postni nima qilay?", {
      reply_to_message_id: msg.message_id,
      reply_markup: {
        inline_keyboard: [[
          { text: "📚 Namuna", callback_data: `learn:${id}` },
          { text: "✍️ Moslash", callback_data: `adapt:${id}` },
        ]],
      },
    });
  }
}

async function handle(u: any) {
  const { error } = await db.from("sv_updates").insert({ update_id: u.update_id });
  if (error) return; // duplicate delivery

  try {
    if (u.message_reaction_count) return void await onReactionCount(u);
    if (u.message_reaction) return void await onReaction(u);
    if (u.callback_query) {
      const cq = u.callback_query;
      if (String(cq.from?.id) !== ADMIN) return;
      const [action, id] = String(cq.data ?? "").split(/:(.+)/);
      if (!id) return;
      if (action === "approve") await onApprove(cq, id);
      else if (action === "time") await onTime(cq, id);
      else if (action === "reject") await onReject(cq, id);
      else if (action === "img") await onImg(cq, id);
      else if (action === "learn") await onLearn(cq, id);
      else if (action === "adapt") await onAdapt(cq, id);
      else if (action === "plan_ok") await onPlanOk(cq, id);
      else if (action === "plan_edit") await onPlanEdit(cq, id);
    } else if (u.message) {
      if (String(u.message.chat?.id) !== ADMIN) return void await onDiscussionMessage(u.message);
      await onMessage(u.message);
    }
  } catch (e) {
    console.error(e);
    await say(`⚠️ Xato: ${esc(String(e).slice(0, 300))}`).catch(() => {});
  }
}

// run in the background, report failures to the admin
// @ts-ignore EdgeRuntime is provided by Supabase
const background = (label: string, p: Promise<unknown>) => EdgeRuntime.waitUntil(
  p.catch(async (e) => {
    console.error(label, e);
    await say(`⚠️ ${label} xatosi: ${esc(String(e).slice(0, 300))}`).catch(() => {});
  }),
);

// ---------- HTTP entry ----------
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const has = (k: string) => !!WEBHOOK_SECRET && url.searchParams.get(k) === WEBHOOK_SECRET;

  if (req.method === "GET" && has("check")) {
    const out: Record<string, unknown> = {
      CHANNEL_ID_value: CHANNEL, pixabay_key_set: !!PIXABAY_KEY, pexels_key_set: !!PEXELS_KEY,
      brand_logo_url_set: !!env("BRAND_LOGO_URL"), version: "v2",
    };
    try {
      const me = await tg("getMe", {});
      out.bot = { id: me.id, username: me.username };
      try {
        const m = await tg("getChatMember", { chat_id: CHANNEL, user_id: me.id });
        out.member = { status: m.status, can_post_messages: m.can_post_messages };
      } catch (e) {
        out.member_error = String(e);
      }
    } catch (e) {
      out.bot_error = String(e);
    }
    try {
      const c = await tg("getChat", { chat_id: CHANNEL });
      out.chat = { id: c.id, type: c.type, title: c.title, username: c.username };
    } catch (e) {
      out.chat_error = String(e);
    }
    return Response.json(out);
  }

  if (has("setup")) {
    const res = await tg("setWebhook", {
      url: `${env("SUPABASE_URL")}/functions/v1/sovchi-webhook`,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query", "message_reaction_count", "message_reaction"],
      drop_pending_updates: false,
    });
    return Response.json({ setWebhook: res });
  }

  if (has("generate_plan")) {
    const month = url.searchParams.get("month") || tashkent().month;
    background("Oylik reja", generatePlan(month, { force: url.searchParams.get("force") === "1" }));
    return Response.json({ started: "generate_plan", month });
  }
  if (has("generate_today")) {
    background("Kunlik draftlar", runToday());
    return Response.json({ started: "generate_today", date: tashkent().iso });
  }
  if (has("publish_due")) {
    return Response.json(await publishDue());
  }
  if (has("pending_videos")) {
    return Response.json(await pendingVideos());
  }
  if (has("register_video") && req.method === "POST") {
    try {
      return Response.json(await registerVideo(await req.json()));
    } catch (e) {
      return Response.json({ ok: false, error: String(e) }, { status: 400 });
    }
  }

  if (req.method === "GET") return new Response("ok");

  if (!WEBHOOK_SECRET || req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await req.json();
  // @ts-ignore EdgeRuntime is provided by Supabase
  EdgeRuntime.waitUntil(handle(update));
  return new Response("ok");
});
