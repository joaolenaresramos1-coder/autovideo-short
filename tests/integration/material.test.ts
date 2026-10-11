// Turning uploads and JavaScript-drawn chapter pages into page images,
// with the real tools the worker uses (ffmpeg, pdftoppm, 7z, Chrome).

import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, imageSize } from "../../worker/ffmpeg.ts";
import { expandUpload } from "../../worker/files.ts";
import { browserAvailable, browserPages } from "../../worker/browser.ts";

async function page(dir: string, name: string, size = "800x1200", src = "testsrc2"): Promise<string> {
  const f = join(dir, name);
  const r = await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `${src}=s=${size}`, "-frames:v", "1", f]);
  expect(r.stderr).toBe("");
  return f;
}

/** Minimal PDF with one JPEG per page (DCTDecode), written by hand. */
async function jpegPdf(file: string, jpegs: { path: string; w: number; h: number }[]) {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (b: Buffer | string) => {
    const buf = typeof b === "string" ? Buffer.from(b, "latin1") : b;
    parts.push(buf);
    len += buf.length;
  };
  const n = jpegs.length;
  const obj = (id: number, body: () => void) => {
    offsets[id] = len;
    push(`${id} 0 obj\n`);
    body();
    push("\nendobj\n");
  };
  push("%PDF-1.4\n");
  obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${jpegs.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}] >>`));
  for (let i = 0; i < n; i++) {
    const { path, w, h } = jpegs[i];
    const data = await readFile(path);
    const [pg, img, content] = [3 + i * 3, 4 + i * 3, 5 + i * 3];
    obj(pg, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /I ${img} 0 R >> >> /Contents ${content} 0 R >>`));
    obj(img, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${data.length} >>\nstream\n`);
      push(data);
      push("\nendstream");
    });
    const draw = `q ${w} 0 0 ${h} 0 0 cm /I Do Q`;
    obj(content, () => push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
  }
  const xref = len;
  const total = 3 + n * 3;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let id = 1; id < total; id++) push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  await writeFile(file, Buffer.concat(parts));
}

async function has(cmd: string): Promise<boolean> {
  return (await run("sh", ["-c", `command -v ${cmd}`])).code === 0;
}

describe("uploaded material", () => {
  it("PDF becomes one image per page, in order", async () => {
    if (!(await has("pdftoppm"))) return;
    const dir = await mkdtemp(join(tmpdir(), "mat-"));
    const a = await page(dir, "a.jpg");
    const b = await page(dir, "b.jpg", "800x1200", "mandelbrot");
    const pdf = join(dir, "cap.pdf");
    await jpegPdf(pdf, [{ path: a, w: 800, h: 1200 }, { path: b, w: 800, h: 1200 }]);
    const pages = await expandUpload(pdf, "pdf", join(dir, "out"), 150);
    expect(pages).toHaveLength(2);
    expect((await imageSize(pages[0])).height).toBeGreaterThan(300);
  });

  it("ZIP/CBZ is unpacked in natural order, skipping junk; odd formats are converted", async () => {
    if (!(await has("7z"))) return;
    const dir = await mkdtemp(join(tmpdir(), "mat-"));
    const inner = join(dir, "in");
    await run("mkdir", ["-p", join(inner, "__MACOSX")]);
    await page(inner, "p10.jpg");
    await page(inner, "p2.bmp");
    await page(inner, "p1.png");
    await run("sh", ["-c", `echo x > ${join(inner, "leia.txt")} && echo y > ${join(inner, "__MACOSX", "._p1.png")}`]);
    const cbz = join(dir, "cap.cbz");
    expect((await run("7z", ["a", "-tzip", cbz, `${inner}/*`])).code).toBe(0);
    const pages = await expandUpload(cbz, "archive", join(dir, "out"), 150);
    expect(pages.map((p) => p.split("/").pop())).toEqual(["p1.png", "p2.bmp", "p10.jpg"]);

    const gif = await page(dir, "solto.gif");
    expect(await expandUpload(gif, "image", dir, 150)).toEqual([gif]);
    const avif = join(dir, "solto.avif");
    if ((await run("ffmpeg", ["-v", "error", "-y", "-i", gif, avif])).code === 0) {
      const conv = await expandUpload(avif, "image", dir, 150);
      expect(conv[0]).toMatch(/\.png$/);
    }
  });
});

describe("chapter drawn by JavaScript", () => {
  it("opens the page in a browser and collects the pages in reading order", async () => {
    if (!browserAvailable()) return;
    const dir = await mkdtemp(join(tmpdir(), "js-"));
    const imgs = [await page(dir, "1.jpg", "700x1000"), await page(dir, "2.jpg", "700x1000", "mandelbrot"), await page(dir, "3.jpg", "700x1000", "rgbtestsrc")];
    await page(dir, "logo.jpg", "120x60");
    const html = `<!doctype html><body><img src="/img/logo.jpg"><div id=r></div><script>
      // pages arrive later and load lazily, like real readers
      setTimeout(() => {
        const r = document.getElementById("r");
        for (const n of [1, 2, 3]) {
          const i = document.createElement("img");
          i.loading = "lazy"; i.style.display = "block"; i.style.height = "1400px";
          i.src = "/img/" + n + ".jpg"; r.appendChild(i);
        }
      }, 300);
    </script></body>`;
    let referer = "";
    const server = createServer(async (req, res) => {
      if (req.url === "/cap-1") return res.end(html);
      const m = /^\/img\/(\w+\.jpg)$/.exec(req.url ?? "");
      if (!m) return res.writeHead(404).end();
      referer = req.headers.referer ?? referer;
      res.setHeader("content-type", "image/jpeg");
      res.end(await readFile(join(dir, m[1])));
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    try {
      const pages = await browserPages(`http://127.0.0.1:${port}/cap-1`, 60_000);
      expect(pages.map((p) => p.name)).toEqual(["001.jpg", "002.jpg", "003.jpg"]);
      const expected = await Promise.all(imgs.map((f) => readFile(f)));
      pages.forEach((p, i) => expect(Buffer.from(p.bytes).equals(expected[i])).toBe(true));
      expect(referer).toContain(`127.0.0.1:${port}`);
    } finally {
      server.close();
    }
  });
});
