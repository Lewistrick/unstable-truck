#!/usr/bin/env node
//
// Captures a game recording as an mp4 video.
//
// Prerequisites (install once on the machine that runs this):
//   npm install puppeteer          (downloads Chromium ~400 MB)
//   brew install ffmpeg             (or: apt install ffmpeg)
//
// The client must also be compiled (npm run build:client) so dist/ exists.
//
// Usage:
//   node scripts/capture-video.mjs <seed> <nickname> [options]
//
// Options:
//   --difficulty hard|easy     Default: hard
//   --api <url>                API base URL (default: https://lewistrick.com/unstable-truck)
//   --file <path>              Load recording from a JSON file instead of the API
//   --width <px>               Video width (default: 1280)
//   --height <px>              Video height (default: 720)
//   --fps 60|30|20|15          Frames per second (default: 60)
//   -o, --output <path>        Output file (default: <seed>_<nickname>.mp4)
//   --show                     Run with a visible browser window
//
// Examples:
//   node scripts/capture-video.mjs 2026-08-25 Erick
//   node scripts/capture-video.mjs 2026-08-25 Erick --fps 30 -o replay.mp4
//   node scripts/capture-video.mjs 2026-08-25 Erick --api http://localhost:8080

import { execSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const opts = {
  seed: "", nickname: "", difficulty: "hard",
  api: "https://lewistrick.com/unstable-truck",
  file: "", width: 1280, height: 720, fps: 60, output: "", show: false,
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--difficulty")     opts.difficulty = args[++i];
  else if (a === "--api")       opts.api = args[++i];
  else if (a === "--file")      opts.file = args[++i];
  else if (a === "--width")     opts.width = parseInt(args[++i], 10);
  else if (a === "--height")    opts.height = parseInt(args[++i], 10);
  else if (a === "--fps")       opts.fps = parseInt(args[++i], 10);
  else if (a === "-o" || a === "--output") opts.output = args[++i];
  else if (a === "--show")      opts.show = true;
  else if (!opts.seed)          opts.seed = a;
  else if (!opts.nickname)      opts.nickname = a;
}
if (!opts.seed || !opts.nickname) {
  console.error(
    "Usage: capture-video.mjs <seed> <nickname> [options]\n\n" +
    "Options:\n" +
    "  --difficulty hard|easy   (default: hard)\n" +
    "  --api <url>              API base URL\n" +
    "  --file <path>            JSON recording file (skips API fetch)\n" +
    "  --width <px>             Video width (default: 1280)\n" +
    "  --height <px>            Video height (default: 720)\n" +
    "  --fps 60|30|20|15        Frame rate (default: 60)\n" +
    "  -o, --output <path>      Output file\n" +
    "  --show                   Show the browser window",
  );
  process.exit(1);
}
if (!opts.output) opts.output = `${opts.seed}_${opts.nickname}.mp4`;

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

let puppeteer;
try { puppeteer = await import("puppeteer"); }
catch { console.error("puppeteer is required:\n  npm install puppeteer"); process.exit(1); }

try { execSync("ffmpeg -version", { stdio: "ignore" }); }
catch { console.error("ffmpeg must be on PATH:\n  brew install ffmpeg  (or apt install ffmpeg)"); process.exit(1); }

try { await access(path.join(PROJECT_ROOT, "dist", "level", "generate.js")); }
catch { console.error("dist/ not found — build the client first:\n  npm run build:client"); process.exit(1); }

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

let recording;
if (opts.file) {
  recording = JSON.parse(await readFile(opts.file, "utf-8"));
  console.log(`Loaded recording from ${opts.file}`);
} else {
  const url = `${opts.api}/api/scores/${opts.seed}/${encodeURIComponent(opts.nickname)}?difficulty=${opts.difficulty}`;
  console.log(`Fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) { console.error(`API ${res.status}: ${await res.text()}`); process.exit(1); }
  recording = await res.json();
}
console.log(`  ${recording.time.toFixed(2)}s, ${recording.inputLog.length} toggles, stability ${recording.stability}`);

// ---------------------------------------------------------------------------
// Local file server (serves the project root so the capture page can import
// compiled client modules from dist/)
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json",
};

const { server, port } = await new Promise((resolve) => {
  const srv = createServer(async (req, res) => {
    const urlPath = new URL(req.url, "http://localhost").pathname;
    const fp = path.join(PROJECT_ROOT, path.normalize(urlPath));
    if (!fp.startsWith(PROJECT_ROOT)) { res.writeHead(403).end(); return; }
    try {
      const data = await readFile(fp);
      res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  srv.listen(0, "127.0.0.1", () => resolve({ server: srv, port: srv.address().port }));
});

// ---------------------------------------------------------------------------
// FFmpeg
// ---------------------------------------------------------------------------

const stepsPerCapture = Math.max(1, Math.round(60 / opts.fps));
const actualFps = 60 / stepsPerCapture;

const ffmpeg = spawn("ffmpeg", [
  "-y",
  "-f", "image2pipe", "-framerate", String(actualFps), "-i", "pipe:0",
  "-c:v", "libx264", "-preset", "medium", "-crf", "18",
  "-pix_fmt", "yuv420p", "-movflags", "+faststart",
  opts.output,
], { stdio: ["pipe", "ignore", "pipe"] });

let ffmpegErr = "";
ffmpeg.stderr.on("data", (d) => { ffmpegErr += d; });
ffmpeg.stdin.on("error", () => {});

function writeFrame(buf) {
  return new Promise((resolve, reject) => {
    if (ffmpeg.stdin.destroyed) { reject(new Error("FFmpeg pipe closed")); return; }
    if (ffmpeg.stdin.write(buf)) resolve();
    else ffmpeg.stdin.once("drain", resolve);
  });
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

const browser = await puppeteer.default.launch({
  headless: opts.show ? false : "new",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: opts.width, height: opts.height, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${port}/video-capture.html`, { waitUntil: "networkidle0" });
await page.waitForFunction("window.__captureReady === true", { timeout: 15_000 });

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

const info = await page.evaluate((cfg) => window.__captureInit(cfg), {
  seed: opts.seed,
  difficulty: opts.difficulty,
  inputLog: recording.inputLog,
  time: recording.time,
  width: opts.width,
  height: opts.height,
});

const estFrames = Math.ceil((info.totalTicks + 120) / stepsPerCapture);
console.log(`Capturing ~${estFrames} frames at ${actualFps}fps → ${opts.output}`);

const canvasEl = await page.$("#c");
const t0 = Date.now();
let frames = 0;

// Initial frame
await writeFrame(await canvasEl.screenshot({ type: "png" }));
frames++;

let stepsSinceCapture = 0;
let done = false;
while (!done) {
  const state = await page.evaluate(() => window.__captureStep());
  stepsSinceCapture++;
  if (stepsSinceCapture >= stepsPerCapture) {
    stepsSinceCapture = 0;
    await writeFrame(await canvasEl.screenshot({ type: "png" }));
    frames++;
    if (frames % Math.round(actualFps) === 0) {
      const pct = Math.min(100, (state.tick / info.totalTicks) * 100).toFixed(0);
      const rate = (frames / ((Date.now() - t0) / 1000)).toFixed(1);
      process.stdout.write(`\r  ${frames} frames (${pct}%) — ${rate} capture-fps`);
    }
  }
  done = state.done;
}

process.stdout.write("\n");

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

ffmpeg.stdin.end();
const exitCode = await new Promise((resolve) => ffmpeg.on("close", resolve));
await browser.close();
server.close();

if (exitCode !== 0) {
  console.error(`FFmpeg exited ${exitCode}:\n${ffmpegErr.slice(-500)}`);
  process.exit(1);
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`${frames} frames in ${secs}s → ${opts.output}`);
