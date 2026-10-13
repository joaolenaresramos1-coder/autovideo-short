// Checks whether a site can be read by the worker: plain HTTP first, then a
// real Chrome (headed under Xvfb when available). Prints what it found.
//   node worker/probe.ts <url>

import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { extractChapterLinks, extractImageUrls } from "../supabase/functions/_shared/connectors/link.ts";

const url = process.argv[2];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" } }).catch((e) => e as Error);
if (res instanceof Error) console.log("HTTP: erro", res.message);
else {
  const html = await res.text();
  console.log(`HTTP: ${res.status}, ${html.length} bytes, bloqueio: ${/just a moment|cf-chl|challenge-platform/i.test(html) ? "sim (Cloudflare)" : "não"}`);
  console.log(`HTTP: ${extractChapterLinks(html, url).length} links de capítulo, ${extractImageUrls(html, url).length} imagens`);
}

const executablePath = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => p && existsSync(p));
const browser = await chromium.launch({ executablePath, headless: !process.env.DISPLAY, args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"] });
const page = await (await browser.newContext({ userAgent: UA, locale: "pt-BR", viewport: { width: 1280, height: 1600 } })).newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
let title = "";
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(2000);
  title = await page.title();
  if (!/just a moment|um momento|attention required/i.test(title)) break;
}
const html = await page.content();
console.log(`Navegador (${process.env.DISPLAY ? "com tela virtual" : "headless"}): título "${title}"`);
const chapters = extractChapterLinks(html, page.url());
console.log(`Navegador: ${chapters.length} links de capítulo`, chapters.slice(0, 3).map((c) => c.url));
console.log(`Navegador: ${extractImageUrls(html, page.url()).length} imagens na página`);
await browser.close();
