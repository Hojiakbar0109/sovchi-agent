// Card renderer v3 for sovchi.app: template-based, safe-zone aware, several fonts.
// Telegram's channel feed crops the top of tall images, so nothing important
// may live in the top ~12% or the bottom ~5% of the card.
// Text always sits directly on the photo (dark veil for readability); no solid red bands.
import { Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";

export const BRAND = {
  name: "sovchi.app",
  tagline: "Jiddiy niyatdagilar uchun",
  primary: 0xc50f13ff,
  background: 0xfdf1ddff,
  dark: 0x1a1a1aff,
  light: 0xfdf1ddff,
};

export const W = 1080;
export const H = 1350;
export const SAFE_TOP = Math.round(H * 0.12) + 10; // 172
export const SAFE_BOTTOM = H - Math.round(H * 0.05) - 14; // 1268
const PAD = 90; // generous side margin: text must not hug the edge
const CORNER_PAD = 70;

type Corner = "tl" | "tr" | "bl" | "br";
// bl/br/bc = bottom left/right/centre, center = middle, tc = upper centre
type Tpl = "bl" | "br" | "bc" | "center" | "tc";
export type Layout = {
  tpl: Tpl; grad: "b" | "s"; acc: "bar" | "side" | "dots"; logo: Corner; num: Corner; font: number;
};

// corners that stay free of the text block for each template
const FREE: Record<Tpl, Corner[]> = {
  bl: ["tl", "tr"],
  br: ["tl", "tr"],
  bc: ["tl", "tr"],
  center: ["tl", "tr", "bl", "br"],
  tc: ["bl", "br"],
};
const TPLS = Object.keys(FREE) as Tpl[];
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

// Display fonts (all cover Latin incl. the apostrophe; Uzbek text is normalised to ASCII ' before drawing).
// `w` = rough glyph width / font size, `k` = size multiplier so fonts look equally big.
const NPM = "https://cdn.jsdelivr.net/npm";
export const FONTS: { name: string; url: string; w: number; k: number }[] = [
  { name: "DejaVu Sans Bold", url: `${NPM}/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans-Bold.ttf`, w: 0.64, k: 1.0 },
  { name: "Playfair Display", url: `${NPM}/@expo-google-fonts/playfair-display@0.4.2/700Bold/PlayfairDisplay_700Bold.ttf`, w: 0.56, k: 1.02 },
  { name: "Montserrat", url: `${NPM}/@expo-google-fonts/montserrat@0.4.2/800ExtraBold/Montserrat_800ExtraBold.ttf`, w: 0.66, k: 0.92 },
  { name: "Lora", url: `${NPM}/@expo-google-fonts/lora@0.4.2/700Bold/Lora_700Bold.ttf`, w: 0.56, k: 1.05 },
  { name: "Roboto Slab", url: `${NPM}/@expo-google-fonts/roboto-slab@0.4.2/700Bold/RobotoSlab_700Bold.ttf`, w: 0.6, k: 1.0 },
  { name: "Raleway", url: `${NPM}/@expo-google-fonts/raleway@0.4.2/800ExtraBold/Raleway_800ExtraBold.ttf`, w: 0.6, k: 1.0 },
  { name: "Abril Fatface", url: `${NPM}/@expo-google-fonts/abril-fatface@0.4.1/400Regular/AbrilFatface_400Regular.ttf`, w: 0.55, k: 1.05 },
  { name: "Oswald", url: `${NPM}/@expo-google-fonts/oswald@0.4.2/600SemiBold/Oswald_600SemiBold.ttf`, w: 0.45, k: 1.22 },
  { name: "Poppins", url: `${NPM}/@expo-google-fonts/poppins@0.4.1/700Bold/Poppins_700Bold.ttf`, w: 0.62, k: 0.96 },
];
const REGULAR_URL = `${NPM}/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf`;

export const layoutToString = (l: Layout) => [l.tpl, l.grad, l.acc, l.logo, l.num, l.font].join(".");

export function parseLayout(s?: string | null): Layout {
  const p = String(s ?? "").split(".");
  if ((p.length === 5 || p.length === 6) && TPLS.includes(p[0] as Tpl)) {
    const f = Number(p[5] ?? 0);
    return {
      tpl: p[0] as Tpl, grad: p[1] as Layout["grad"], acc: p[2] as Layout["acc"],
      logo: p[3] as Corner, num: p[4] as Corner, font: Number.isInteger(f) && f >= 0 && f < FONTS.length ? f : 0,
    };
  }
  return parseLayout(randomLayout());
}

// a fresh template and font; never the same template or font twice in a row when `prev` is given
export function randomLayout(prev?: string | null): string {
  const pp = String(prev ?? "").split(".");
  const tpl = pick(TPLS.filter((t) => t !== pp[0]));
  const free = [...FREE[tpl]].sort(() => Math.random() - 0.5);
  const prevFont = Number(pp[5]);
  const font = pick(FONTS.map((_, i) => i).filter((i) => i !== prevFont));
  return layoutToString({
    tpl,
    grad: pick(["b", "s"]),
    acc: pick(["bar", "side", "dots"]),
    logo: free[0],
    num: free[1] ?? free[0],
    font,
  });
}

// ---------- fonts / logo ----------
const fontCache = new Map<string, Uint8Array>();
async function loadFont(url: string): Promise<Uint8Array> {
  let f = fontCache.get(url);
  if (!f) {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`font HTTP ${r.status}`);
    f = new Uint8Array(await r.arrayBuffer());
    fontCache.set(url, f);
  }
  return f;
}

// chosen display font; falls back to DejaVu Bold when the CDN has a hiccup
async function displayFont(idx: number) {
  try {
    return { data: await loadFont(FONTS[idx].url), spec: FONTS[idx] };
  } catch (e) {
    console.warn(`font ${FONTS[idx].name} failed, using DejaVu:`, e);
    return { data: await loadFont(FONTS[0].url), spec: FONTS[0] };
  }
}
const regularFont = () => loadFont(REGULAR_URL);

let logoCache: { url: string; bytes: Uint8Array | null } | null = null;
async function logoBytes(): Promise<Uint8Array | null> {
  const url = Deno.env.get("BRAND_LOGO_URL") ?? "";
  if (!url) return null;
  if (logoCache?.url === url) return logoCache.bytes;
  let bytes: Uint8Array | null = null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    console.warn("BRAND_LOGO_URL fetch failed:", e);
  }
  logoCache = { url, bytes };
  return bytes;
}

// ---------- text ----------
// Uzbek apostrophes (oʻ gʻ ‘ ’ ` ´) -> plain ' : present in every font, no missing-glyph boxes
const norm = (s: string) => s.replace(/[ʻʼ‘’`´]/g, "'");

function wrap(text: string, maxChars: number) {
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (cur && (cur + " " + w).length > maxChars) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? cur + " " + w : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

const baseSize = (len: number) => (len <= 28 ? 92 : len <= 45 ? 80 : len <= 65 ? 70 : 60);

type BlockOpts = { align: "l" | "r" | "c"; color: number; kcolor: number; maxW: number; font: number };

async function textBlock(kicker: string, hook: string, sub: string, o: BlockOpts) {
  const { data: bold, spec } = await displayFont(o.font);
  const reg = await regularFont();
  hook = norm(hook);
  sub = norm(sub);
  let size = Math.round(baseSize(hook.length) * spec.k);
  let hookLines: Image[] = [];
  // shrink until every line really fits the column (font widths differ a lot)
  for (let attempt = 0; attempt < 8; attempt++) {
    const chars = Math.max(6, Math.floor(o.maxW / (size * spec.w)));
    hookLines = wrap(hook, chars).map((l) => Image.renderText(bold, size, l, o.color));
    if (hookLines.every((im) => im.width <= o.maxW) || size <= 40) break;
    size = Math.round(size * 0.93);
  }
  const subLines = sub ? wrap(sub, Math.floor(o.maxW / (40 * 0.6))) : [];
  const rows: { img: Image; y: number }[] = [];
  let y = 0;
  if (kicker) {
    rows.push({ img: Image.renderText(bold, 28, norm(kicker).toUpperCase().slice(0, 40), o.kcolor), y });
    y += 54;
  }
  for (const im of hookLines) {
    rows.push({ img: im, y });
    y += Math.round(size * 1.2);
  }
  if (subLines.length) {
    y += 22;
    for (const l of subLines) {
      rows.push({ img: Image.renderText(reg, 40, l, o.color), y });
      y += 56;
    }
  }
  // tall fonts (Oswald...) can draw below the nominal line height: size the block to the real glyph bottoms
  const bottom = rows.reduce((m, r) => Math.max(m, r.y + r.img.height), y);
  const block = new Image(o.maxW, Math.max(bottom, 1));
  for (const r of rows) {
    const w = Math.min(r.img.width, o.maxW);
    const x = o.align === "l" ? 0 : o.align === "r" ? o.maxW - w : Math.floor((o.maxW - w) / 2);
    block.composite(r.img, x, r.y);
  }
  return block;
}

async function logoImage(onDark: boolean): Promise<Image> {
  const bytes = await logoBytes();
  if (bytes) {
    try {
      const img = (await Image.decode(bytes)) as Image;
      return img.resize(Image.RESIZE_AUTO, 76);
    } catch (e) {
      console.warn("logo decode failed, using text logo:", e);
    }
  }
  const bold = await loadFont(FONTS[0].url), reg = await regularFont();
  const nm = Image.renderText(bold, 46, BRAND.name, onDark ? 0xffffffff : BRAND.primary);
  const tg = Image.renderText(reg, 24, BRAND.tagline, onDark ? 0xffffffe6 : BRAND.dark);
  const out = new Image(Math.max(nm.width, tg.width), 46 + 12 + 30);
  out.composite(nm, 0, 0);
  out.composite(tg, 0, 58);
  return out;
}

function cornerXY(c: Corner, w: number, h: number): [number, number] {
  const x = c.endsWith("l") ? CORNER_PAD : W - CORNER_PAD - w;
  const y = c.startsWith("t") ? SAFE_TOP : SAFE_BOTTOM - h;
  return [x, y];
}

// dark veil so white text stays readable on any photo
function veil(img: Image, l: Layout) {
  if (l.tpl === "center") {
    img.composite(new Image(W, H).fill(0x000000a8), 0, 0);
  } else if (l.tpl === "tc") {
    const gh = 820, step = 10;
    for (let i = 0; i < gh; i += step) {
      const a = Math.round(225 * Math.pow(1 - i / gh, 1.2));
      img.composite(new Image(W, step).fill(a), 0, i);
    }
  } else if (l.grad === "s" && (l.tpl === "bl" || l.tpl === "br")) {
    const gw = 820, step = 20;
    for (let i = 0; i < gw; i += step) {
      const a = Math.round(225 * Math.pow(1 - i / gw, 1.4));
      img.composite(new Image(step, H).fill(a), l.tpl === "bl" ? i : W - gw + (gw - i - step), 0);
    }
    img.composite(new Image(W, H).fill(0x00000030), 0, 0);
  } else {
    const gh = 900, step = 10;
    for (let i = 0; i < gh; i += step) {
      const a = Math.round(235 * Math.pow(i / gh, 1.3));
      img.composite(new Image(W, step).fill(a), 0, H - gh + i);
    }
  }
}

export type CardInput = {
  hook: string;
  sub?: string;
  theme?: string;
  photo?: Uint8Array | null;
  layout?: string | null;
  slide?: { n: number; total: number };
  darkBg?: boolean; // photo-less cards on the dark background (carousel variety)
};

// Renders one card. Returns encoded bytes plus the layout string actually used.
export async function renderCard(inp: CardInput) {
  const l = parseLayout(inp.layout);
  let img: Image;
  let onPhoto = false;
  if (inp.photo) {
    try {
      img = (await Image.decode(inp.photo)) as Image;
      img.cover(W, H);
      onPhoto = true;
    } catch (e) {
      console.warn("photo decode failed, plain card:", e);
      img = new Image(W, H).fill(BRAND.background);
    }
  } else {
    img = new Image(W, H).fill(inp.darkBg ? BRAND.dark : BRAND.background);
  }
  const darkSurface = onPhoto || !!inp.darkBg;
  if (onPhoto) veil(img, l);

  const textColor = darkSurface ? 0xffffffff : BRAND.dark;
  const kColor = darkSurface ? 0xffffffd0 : BRAND.primary;
  const accColor = darkSurface ? 0xffffffff : BRAND.primary;
  const centred = l.tpl === "center" || l.tpl === "bc" || l.tpl === "tc";
  const align = l.tpl === "br" ? "r" : centred ? "c" : "l";
  const maxW = centred ? W - 2 * PAD : 800; // side-aligned text gets a narrower column
  const block = await textBlock(inp.theme ?? "", inp.hook, inp.sub ?? "", {
    align, color: textColor, kcolor: kColor, maxW, font: l.font,
  });
  const bh = block.height;

  // x of the text column and y of its top
  const x = l.tpl === "br" ? W - PAD - maxW : centred ? Math.round((W - maxW) / 2) : PAD;
  const y = l.tpl === "tc"
    ? SAFE_TOP + 30
    : l.tpl === "center"
    ? Math.max(SAFE_TOP + 120, Math.round((H - bh) / 2))
    : SAFE_BOTTOM - bh;
  img.composite(block, x, y);

  // small accent (white on photos, red only on plain cream cards)
  if (l.acc === "side") {
    const ax = align === "r" ? x + maxW + 22 : align === "l" ? x - 30 : x - 30;
    img.drawBox(ax + 1, y + 1, 10, bh, accColor);
  } else {
    const ay = l.tpl === "tc" || l.tpl === "center" ? y + bh + 30 : y - 34;
    const dots = l.acc === "dots";
    const w = dots ? 14 + 28 * 2 : 150;
    const ax = align === "r" ? x + maxW - w : align === "l" ? x : Math.round(W / 2 - w / 2);
    if (dots) for (let i = 0; i < 3; i++) img.drawBox(ax + i * 28 + 1, ay + 1, 14, 14, accColor);
    else img.drawBox(ax + 1, ay + 1, w, 12, accColor);
  }

  // logo (text logo by default, image logo when BRAND_LOGO_URL is set)
  const logo = await logoImage(darkSurface);
  const [lx, ly] = cornerXY(l.logo, logo.width, logo.height);
  if (onPhoto) img.composite(new Image(logo.width + 36, logo.height + 24).fill(0x00000070), lx - 18, ly - 12);
  img.composite(logo, lx, ly);

  // slide counter: small dark chip with white text (no red block)
  if (inp.slide) {
    const t = Image.renderText(await loadFont(FONTS[0].url), 34, `${inp.slide.n}/${inp.slide.total}`, 0xffffffff);
    const pw = t.width + 44, ph = 62;
    const [px, py] = cornerXY(l.num === l.logo ? (l.logo === "tl" ? "tr" : "tl") : l.num, pw, ph);
    img.composite(new Image(pw, ph).fill(darkSurface ? 0x000000a0 : 0x1a1a1ad0), px, py);
    img.composite(t, px + 22, py + 10);
  }

  return onPhoto
    ? { bytes: await img.encodeJPEG(88), mime: "image/jpeg", ext: "jpg", layout: layoutToString(l) }
    : { bytes: await img.encode(), mime: "image/png", ext: "png", layout: layoutToString(l) };
}
