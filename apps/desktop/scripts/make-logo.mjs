/** Genera el logotipo de Octus desde el JPG del usuario:
 *  - `src/renderer/src/assets/octus-logo.png`: pulpo blanco con transparencia
 *    (extraído por luminancia con borde suave) para el panel de bienvenida.
 *  - `build/icons/icon-{16..256}.png` + `icon.png` + `icon.ico`: el mismo pulpo
 *    sobre pastilla azul (#2f7fe0) para la barra de tareas y el ejecutable.
 *  Uso: `bun scripts/make-logo.mjs`. Requiere playwright-core (ya en el repo).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const SRC = "C:\\Users\\UserPy\\Downloads\\Pizza Egipto\\Gemini_Generated_Image_7m84hv7m84hv7m84.jpg";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rendererAssets = join(root, "src", "renderer", "src", "assets");
const iconsDir = join(root, "build", "icons");
mkdirSync(rendererAssets, { recursive: true });
mkdirSync(iconsDir, { recursive: true });

const SIZES = [16, 24, 32, 48, 64, 128, 256];

function ico(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  pngs.forEach((png, i) => {
    entries.writeUInt8(png.size >= 256 ? 0 : png.size, i * 16);
    entries.writeUInt8(png.size >= 256 ? 0 : png.size, i * 16 + 1);
    entries.writeUInt8(0, i * 16 + 2);
    entries.writeUInt8(0, i * 16 + 3);
    entries.writeUInt16LE(1, i * 16 + 4);
    entries.writeUInt16LE(32, i * 16 + 6);
    entries.writeUInt32LE(png.data.length, i * 16 + 8);
    entries.writeUInt32LE(offset, i * 16 + 12);
    offset += png.data.length;
  });
  return Buffer.concat([header, entries, ...pngs.map((p) => p.data)]);
}

const browser = await chromium.launch();
try {
  const bytes = readFileSync(SRC);
  console.log(`[make-logo] fuente: ${(bytes.length / 1024).toFixed(1)} KB`);
  const dataUrl = `data:image/jpeg;base64,${bytes.toString("base64")}`;
  const page = await browser.newPage();
  await page.goto("about:blank");
  const result = await page.evaluate(async ({ src, sizes }) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    // Baja a 900px de lado mayor: sobra para icono 256 y logo 512.
    const scale = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const work = document.createElement("canvas");
    work.width = w;
    work.height = h;
    const wctx = work.getContext("2d", { willReadFrequently: true });
    wctx.drawImage(img, 0, 0, w, h);
    const data = wctx.getImageData(0, 0, w, h);
    const px = data.data;
    const lum = (i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    let bgMax = 0;
    const probes = 40;
    for (let k = 0; k < probes; k++) {
      const x = Math.floor((k / probes) * w);
      bgMax = Math.max(bgMax, lum(x * 4), lum(((h - 1) * w + x) * 4));
    }
    for (let k = 0; k < probes; k++) {
      const y = Math.floor((k / probes) * h);
      bgMax = Math.max(bgMax, lum((y * w) * 4), lum((y * w + (w - 1)) * 4));
    }
    let fgMin = 255;
    for (let y = Math.floor(h * 0.3); y < h * 0.6; y += 2) {
      for (let x = Math.floor(w * 0.4); x < w * 0.6; x += 2) {
        fgMin = Math.min(fgMin, lum((y * w + x) * 4));
      }
    }
    const lo = Math.min(230, bgMax + 24);
    const hi = Math.max(lo + 20, Math.min(248, fgMin + 10));
    let minX = w, minY = h, maxX = 0, maxY = 0;
    for (let i = 0; i < px.length; i += 4) {
      const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      let a = (l - lo) / (hi - lo);
      a = Math.max(0, Math.min(1, a));
      a = a * a * (3 - 2 * a);
      px[i] = px[i] + (255 - px[i]) * (1 - a);
      px[i + 1] = px[i + 1] + (255 - px[i + 1]) * (1 - a);
      px[i + 2] = px[i + 2] + (255 - px[i + 2]) * (1 - a);
      px[i + 3] = Math.round(a * 255);
      if (a * 255 > 8) {
        const idx = i / 4;
        const x = idx % w;
        const y = Math.floor(idx / w);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    wctx.putImageData(data, 0, 0);
    const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.08);
    const cx = Math.max(0, minX - pad);
    const cy = Math.max(0, minY - pad);
    const cw = Math.min(w, maxX + pad) - cx;
    const ch = Math.min(h, maxY + pad) - cy;
    const side = Math.max(cw, ch);
    const square = document.createElement("canvas");
    square.width = side;
    square.height = side;
    square.getContext("2d").drawImage(work, cx, cy, cw, ch, Math.floor((side - cw) / 2), Math.floor((side - ch) / 2), cw, ch);
    const png = async (size, bg) => {
      const out = document.createElement("canvas");
      out.width = size;
      out.height = size;
      const octx = out.getContext("2d");
      if (bg) {
        octx.fillStyle = bg;
        octx.beginPath();
        octx.roundRect(0, 0, size, size, size * 0.22);
        octx.fill();
        const inset = Math.round(size * 0.1);
        octx.drawImage(square, inset, inset, size - inset * 2, size - inset * 2);
      } else {
        octx.drawImage(square, 0, 0, size, size);
      }
      const blob = await new Promise((resolve) => out.toBlob(resolve, "image/png"));
      const buf = await blob.arrayBuffer();
      let binary = "";
      const view = new Uint8Array(buf);
      for (let i = 0; i < view.length; i += 8192) {
        binary += String.fromCharCode.apply(null, view.subarray(i, i + 8192));
      }
      return btoa(binary);
    };
    return {
      info: { w, h, bgMax: Math.round(bgMax), fgMin: Math.round(fgMin), lo: Math.round(lo), hi: Math.round(hi), minX, minY, maxX, maxY },
      logo: await png(512, null),
      icons: Object.fromEntries(await Promise.all(sizes.map(async (s) => [s, await png(s, "#2f7fe0")]))),
    };
  }, { src: dataUrl, sizes: SIZES });
  console.log(`[make-logo] ${result.info.w}x${result.info.h} bgMax=${result.info.bgMax} fgMin=${result.info.fgMin} bbox=${result.info.minX},${result.info.minY}-${result.info.maxX},${result.info.maxY}`);
  await page.close();
  writeFileSync(join(rendererAssets, "octus-logo.png"), Buffer.from(result.logo, "base64"));
  console.log("[make-logo] src/renderer/src/assets/octus-logo.png");
  const pngs = SIZES.map((size) => {
    const data = Buffer.from(result.icons[String(size)], "base64");
    writeFileSync(join(iconsDir, `icon-${size}.png`), data);
    return { size, data };
  });
  const png256 = pngs.find((p) => p.size === 256) ?? pngs[pngs.length - 1];
  writeFileSync(join(iconsDir, "icon.png"), png256.data);
  writeFileSync(join(iconsDir, "icon.ico"), ico(pngs));
  console.log(`[make-logo] build/icons: ${SIZES.length} PNG + icon.png + icon.ico`);
} finally {
  await browser.close();
}
