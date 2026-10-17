#!/usr/bin/env node
/**
 * The refusal, as a still sized for a portfolio card.
 *
 * A screenshot of the full terminal does not survive the trip: at 420px of
 * card the 13.5px body text renders at 4.7px, and ~9px is the floor for
 * reading. That is a pixel problem, not a file-size one, so no amount of
 * re-encoding a GIF fixes it.
 *
 * So this re-typesets the SAME captured text at a width a card can hold.
 * The characters come from brag/session.js verbatim — the only change is
 * where lines wrap, which is what any terminal does in a narrower window.
 * Rendered at 2x for retina.
 */
import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(HERE, "session.js"), "utf8");
const session = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf(";")));

const cmd = session.filter((s) => s.kind === "cmd").slice(-3, -2)[0];
const refusal = session.filter((s) => s.kind === "out" && s.code)[0];
if (!refusal) throw new Error("no failing output in the recorded session");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const paint = (l) =>
  /^refused/.test(l) ? `<span class="rd">${esc(l)}</span>`
  : /^\s*(because|yours):/.test(l) ? `<span class="dim">${esc(l)}</span>`
  : esc(l);

const W = 880; // 2x a 440px card slot
const html = `<!doctype html><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${W}px;background:#010409;font-family:ui-monospace,"SF Mono",Menlo,monospace}
  .term{margin:16px;background:#0d1117;border:1px solid #30363d;border-radius:14px;overflow:hidden}
  .bar{height:44px;background:#161b22;border-bottom:1px solid #30363d;display:flex;align-items:center;padding:0 18px;gap:10px}
  .dot{width:13px;height:13px;border-radius:50%}
  .title{color:#6e7681;font-size:18px;margin-left:12px}
  .body{padding:22px 26px;font-size:25px;line-height:1.5;color:#c9d1d9;white-space:pre-wrap;word-break:break-word}
  .cmd{color:#58a6ff} .dimline{color:#6e7681} .rd{color:#f85149} .dim{color:#8b949e}
  .bad{background:#f8514918;border-left:5px solid #f85149;padding:14px 0 14px 21px;margin:12px -26px 0 -26px}
</style>
<div class="term">
  <div class="bar"><div class="dot" style="background:#ff5f56"></div><div class="dot" style="background:#ffbd2e"></div><div class="dot" style="background:#27c93f"></div><div class="title">claude code — concord-engine</div></div>
  <div class="body"><span class="dimline">$ </span><span class="cmd">${esc((cmd?.text ?? "").replace(/ --kind.*/, " ..."))}</span>
<div class="bad">${(() => {
  // The first four lines carry the whole claim: what was refused, what is in
  // force, why, and what was proposed instead. The resolution block below
  // them is useful in a terminal and noise in a card. Elided, and marked —
  // the same convention the recording uses.
  const lines = refusal.text.split("\n");
  const keep = lines.slice(0, 4).map(paint);
  const hidden = lines.length - 4;
  return [...keep, `<span class="dim">  … ${hidden} more lines</span>`].join("\n");
})()}</div></div>
</div>`;

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new", args: ["--no-sandbox", "--force-device-scale-factor=1", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: 100, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "networkidle0" });
const h = await page.evaluate(() => document.querySelector(".term").getBoundingClientRect().bottom + 16);
await page.setViewport({ width: W, height: Math.ceil(h), deviceScaleFactor: 1 });
const buf = await page.screenshot({ type: "png" });
await browser.close();
const out = resolve(HERE, "../assets/refusal-card.png");
writeFileSync(out, buf);
console.log(`${W}x${Math.ceil(h)}, ${(buf.length / 1024).toFixed(0)} KiB -> assets/refusal-card.png`);
