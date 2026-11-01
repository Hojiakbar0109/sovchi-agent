// Card renderer v2 for sovchi.app: template-based, safe-zone aware.
// Telegram's channel feed crops the top of tall images, so nothing important
// may live in the top ~12% or the bottom ~5% of the card.
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
const PAD = 70;

type Corner = "tl" | "tr" | "bl" | "br";
type Tpl = "bl" | "br" | "center"; // text always sits on the photo; no solid red bands
export type Layout = { tpl: Tpl; grad: "b" | "s"; acc: "bar" | "side" | "dots"; logo: Corner; num: Corner };

// corners that stay free of the text block for each template
const FREE: Record<Tpl, Corner[]> = {
  bl: ["tl", "tr"],
  br: ["tl", "tr"],
  center: ["tl", "tr", "bl", "br"],
};
const TPLS = Object.keys(FREE) as Tpl[];
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

export const layoutToString = (l: Layout) => [l.tpl, l.grad, l.acc, l.logo, l.num].join(".");

export function parseLayout(s?: string | null): Layout {
  const p = String(s ?? "").split(".");
  if (p.length === 5 && TPLS.includes(p[0] as Tpl)) {
    return { tpl: p[0] as Tpl, grad: p[1] as Layout["grad"], acc: p[2] as Layout["acc"], logo: p[3] as Corner, num: p[4] as Corner };
  }
  return parseLayout(randomLayout());
}

// a fresh template; never the same template twice in a row when `prev` is given
export function randomLayout(prev?: string | null): string {
  const prevTpl = String(prev ?? "").split(".")[0];
  const tpl = pick(TPLS.filter((t) => t !== prevTpl));
  const free = [...FREE[tpl]].sort(() => Math.random() - 0.5);
  return layoutToString({
    tpl,
    grad: pick(["b", "s"]),
    acc: pick(["bar", "side", "dots"]),
    logo: free[0],
    num: free[1] ?? free[0],
  });
}

// ---------- fonts / logo ----------
const fontCache = new Map<string, Uint8Array>();
export async function font(bold: boolean) {
  const url = `https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans${bold ? "-Bold" : ""}.ttf`;
  let f = fontCache.get(url);
  if (!f) {
    f = new Uint8Array(await (await fetch(url)).arrayBuffer());
    fontCache.set(url, f);
  }
  return f;
}

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

// ---------- helpers ----------
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

const hookSize = (len: number) => (len <= 28 ? 88 : len <= 45 ? 78 : len <= 65 ? 68 : 58);

type BlockOpts = { align: "l" | "r" | "c"; color: number; kcolor: number; maxW: number };

async function textBlock(kicker: string, hook: string, sub: string, o: BlockOpts) {
  const bold = await font(true), reg = await font(false);
  const size = hookSize(hook.length);
  const hookLines = wrap(hook, Math.max(8, Math.floor(o.maxW / (size * 0.64))));
  const subLines = sub ? wrap(sub, Math.floor(o.maxW / (40 * 0.6))) : [];
  const rows: { img: Image; y: number }[] = [];
  let y = 0;
  if (kicker) {
    rows.push({ img: Image.renderText(bold, 28, kicker.toUpperCase().slice(0, 40), o.kcolor), y });
    y += 52;
  }
  for (const l of hookLines) {
    rows.push({ img: Image.renderText(bold, size, l, o.color), y });
    y += Math.round(size * 1.22);
  }
  if (subLines.length) {
    y += 22;
    for (const l of subLines) {
      rows.push({ img: Image.renderText(reg, 40, l, o.color), y });
      y += 56;
    }
  }
  const block = new Image(o.maxW, Math.max(y, 1));
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
  const bold = await font(true), reg = await font(false);
  const nm = Image.renderText(bold, 46, BRAND.name, onDark ? 0xffffffff : BRAND.primary);
  const tg = Image.renderText(reg, 24, BRAND.tagline, onDark ? 0xffffffe6 : BRAND.dark);
  const out = new Image(Math.max(nm.width, tg.width), 46 + 12 + 30);
  out.composite(nm, 0, 0);
  out.composite(tg, 0, 58);
  return out;
}

function cornerXY(c: Corner, w: number, h: number): [number, number] {
  const x = c.endsWith("l") ? PAD : W - PAD - w;
  const y = c.startsWith("t") ? SAFE_TOP : SAFE_BOTTOM - h;
  return [x, y];
}

function veil(img: Image, l: Layout) {
  if (l.tpl === "center") {
    img.composite(new Image(W, H).fill(0x000000a8), 0, 0);
  } else if (l.tpl === "bl" || l.tpl === "br") {
    if (l.grad === "b") {
      const gh = 900, step = 10;
      for (let i = 0; i < gh; i += step) {
        const a = Math.round(235 * Math.pow(i / gh, 1.3));
        img.composite(new Image(W, step).fill(a), 0, H - gh + i); // 0x000000AA
      }
    } else {
      const gw = 820, step = 20;
      for (let i = 0; i < gw; i += step) {
        const a = Math.round(225 * Math.pow(1 - i / gw, 1.4));
        img.composite(new Image(step, H).fill(a), l.tpl === "bl" ? i : W - gw + (gw - i - step), 0);
      }
      img.composite(new Image(W, H).fill(0x00000030), 0, 0);
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
  const align = l.tpl === "br" ? "r" : l.tpl === "center" ? "c" : "l";
  const maxW = W - 2 * PAD;
  const block = await textBlock(inp.theme ?? "", inp.hook, inp.sub ?? "", { align, color: textColor, kcolor: kColor, maxW });
  const bh = block.height;

  if (l.tpl === "bl" || l.tpl === "br") {
    const y = SAFE_BOTTOM - bh;
    img.composite(block, PAD, y);
    const right = l.tpl === "br";
    if (l.acc === "bar") img.drawBox(right ? W - PAD - 150 + 1 : PAD + 1, y - 34 + 1, 150, 12, accColor);
    else if (l.acc === "side") img.drawBox(right ? W - PAD + 22 : PAD - 30, y + 1, 10, bh, accColor);
    else for (let i = 0; i < 3; i++) img.drawBox((right ? W - PAD - 14 - i * 28 : PAD + i * 28) + 1, y - 34 + 1, 14, 14, accColor);
  } else if (l.tpl === "center") {
    const y = Math.max(SAFE_TOP + 120, Math.round((H - bh) / 2));
    img.composite(block, PAD, y);
    if (l.acc === "side") img.drawBox(PAD - 30, y + 1, 10, bh, accColor);
    else if (l.acc === "dots") for (let i = 0; i < 3; i++) img.drawBox(W / 2 - 42 + i * 28 + 1, y + bh + 30 + 1, 14, 14, accColor);
    else img.drawBox(W / 2 - 75 + 1, y + bh + 30 + 1, 150, 12, accColor);
  }

  // logo (text logo by default, image logo when BRAND_LOGO_URL is set)
  const logo = await logoImage(darkSurface);
  const [lx, ly] = cornerXY(l.logo, logo.width, logo.height);
  if (onPhoto) img.composite(new Image(logo.width + 36, logo.height + 24).fill(0x00000070), lx - 18, ly - 12);
  img.composite(logo, lx, ly);

  // slide counter, always visible
  if (inp.slide) {
    const t = Image.renderText(await font(true), 34, `${inp.slide.n}/${inp.slide.total}`, BRAND.light);
    const pw = t.width + 44, ph = 62;
    const [px, py] = cornerXY(l.num === l.logo ? (l.logo === "tl" ? "tr" : "tl") : l.num, pw, ph);
    img.drawBox(px + 1, py + 1, pw, ph, BRAND.primary);
    img.composite(t, px + 22, py + 10);
  }

  return onPhoto
    ? { bytes: await img.encodeJPEG(88), mime: "image/jpeg", ext: "jpg", layout: layoutToString(l) }
    : { bytes: await img.encode(), mime: "image/png", ext: "png", layout: layoutToString(l) };
}
