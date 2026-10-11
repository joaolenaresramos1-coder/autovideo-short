// Reads a chapter page in a real (headless) browser, for sites that only draw
// the pages with JavaScript. The page is scrolled to the end so lazy images
// load, and every image the browser downloads is kept; the pages are the
// large images shown in the document, in reading order.

import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const MIN_W = 300;
const MIN_H = 200;
const MAX_PAGES = 150;

function chromePath(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  ];
  return candidates.find((p) => p && existsSync(p));
}

export function browserAvailable(): boolean {
  return !!chromePath();
}

export async function browserPages(url: string, timeoutMs = 120_000): Promise<{ name: string; bytes: Uint8Array }[]> {
  const executablePath = chromePath();
  if (!executablePath) return [];
  let browser: Browser | null = null;
  const deadline = Date.now() + timeoutMs;
  try {
    browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"] });
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 1600 },
      locale: "pt-BR",
      extraHTTPHeaders: { "accept-language": "pt-BR,pt;q=0.9,en;q=0.8" },
    });
    const page = await context.newPage();
    const seen = new Map<string, Promise<Uint8Array | null>>();
    page.on("response", (res) => {
      if (res.request().resourceType() !== "image" || !res.ok()) return;
      const u = res.url();
      if (!seen.has(u)) seen.set(u, res.body().then((b) => new Uint8Array(b)).catch(() => null));
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    // Scroll to the end, slowly, until the page stops growing.
    let lastHeight = 0;
    let still = 0;
    while (Date.now() < deadline - 15_000 && still < 4) {
      const h = await page.evaluate(() => {
        window.scrollBy(0, Math.round(window.innerHeight * 0.9));
        return document.documentElement.scrollHeight + window.scrollY;
      });
      still = h === lastHeight ? still + 1 : 0;
      lastHeight = h;
      await page.waitForTimeout(350);
    }
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

    // Large images in document order (top to bottom).
    const inDom = await page.evaluate(
      ({ minW, minH }) => {
        const out: { src: string; top: number }[] = [];
        for (const img of Array.from(document.images)) {
          const src = img.currentSrc || img.src;
          if (!src || src.startsWith("data:")) continue;
          if (img.naturalWidth < minW || img.naturalHeight < minH) continue;
          const r = img.getBoundingClientRect();
          out.push({ src, top: r.top + window.scrollY });
        }
        return out.sort((a, b) => a.top - b.top).map((x) => x.src);
      },
      { minW: MIN_W, minH: MIN_H },
    );

    const pages: { name: string; bytes: Uint8Array }[] = [];
    const used = new Set<string>();
    for (const src of inDom) {
      if (used.has(src) || pages.length >= MAX_PAGES) continue;
      used.add(src);
      let bytes = seen.has(src) ? await seen.get(src)! : null;
      if (!bytes) {
        const r = await context.request.get(src, { headers: { referer: url }, timeout: 30_000 }).catch(() => null);
        bytes = r?.ok() ? new Uint8Array(await r.body()) : null;
      }
      if (!bytes || bytes.length < 5_000) continue;
      const ext = /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.exec(src)?.[1].toLowerCase() ?? "jpg";
      pages.push({ name: `${String(pages.length + 1).padStart(3, "0")}.${ext}`, bytes });
    }
    return pages;
  } finally {
    await browser?.close().catch(() => {});
  }
}
