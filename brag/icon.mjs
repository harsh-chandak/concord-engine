#!/usr/bin/env node
/**
 * Render the listing icon.
 *
 * The plugin directory takes the icon once — the first time the plugin is
 * saved or submitted — and never again, so it has to be right before the
 * first submission rather than improved afterwards.
 *
 * Constraints from the checklist: square PNG or JPEG, 512 to 2048 px a side,
 * under 2 MB. SVG and WebP are not accepted, which rules out the obvious
 * approach of shipping vector art.
 *
 * The mark: two paths arriving at one gate. The upper one passes, the lower
 * one is stopped. That is the whole product in a shape that still reads at
 * 32 px, which is where a listing icon actually lives.
 */
import puppeteer from "puppeteer-core";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SIZE = 1024;

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html,body { margin:0; padding:0; width:${SIZE}px; height:${SIZE}px; }
  body { background:#0d1117; display:flex; align-items:center; justify-content:center; }
  svg { display:block; }
</style>
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#161b22"/>
      <stop offset="1" stop-color="#0d1117"/>
    </linearGradient>
  </defs>

  <rect width="1024" height="1024" rx="224" fill="url(#bg)"/>
  <rect x="8" y="8" width="1008" height="1008" rx="216" fill="none" stroke="#30363d" stroke-width="16"/>

  <!-- the gate: one bar, everything decides against it -->
  <rect x="596" y="208" width="44" height="608" rx="22" fill="#f0f6fc"/>

  <!-- upper path: agrees, passes through -->
  <path d="M 196 388 H 560" stroke="#3fb950" stroke-width="56" stroke-linecap="round" fill="none"/>
  <path d="M 676 388 H 844" stroke="#3fb950" stroke-width="56" stroke-linecap="round" fill="none"/>
  <path d="M 790 324 L 854 388 L 790 452" stroke="#3fb950" stroke-width="56"
        stroke-linecap="round" stroke-linejoin="round" fill="none"/>

  <!-- lower path: contradicts, stopped at the bar -->
  <path d="M 196 644 H 520" stroke="#f85149" stroke-width="56" stroke-linecap="round" fill="none"/>
  <path d="M 520 572 L 520 716" stroke="#f85149" stroke-width="56" stroke-linecap="round" fill="none"/>
</svg>`;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", "--force-device-scale-factor=1", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: SIZE, height: SIZE, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "networkidle0" });
const buf = await page.screenshot({ type: "png" });
await browser.close();

const out = resolve(HERE, "../.claude-plugin/icon.png");
writeFileSync(out, buf);
console.log(`${SIZE}x${SIZE} png, ${(buf.length / 1024).toFixed(0)} KiB -> ${out}`);
