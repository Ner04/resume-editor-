#!/usr/bin/env node
/*
 * ResumeFit local AI helper
 * -------------------------
 * Lets the ResumeFit page use an AI agent that is already installed and signed in
 * on this computer: Claude Code, Codex, Kiro, Grok, Gemini CLI or GitHub Copilot,
 * or any other command-line AI you add in bridge/agents.json.
 * No API key is needed: each CLI uses your own login.
 *
 *   node bridge/resumefit-bridge.mjs
 *
 * Then open the address it prints (the app is served from here too), or paste the
 * connection code into ResumeFit → Suggested changes → "Claude Code on my computer".
 *
 * Safety:
 *  - Listens on 127.0.0.1 only, so other devices on your network can't use it.
 *  - Every request needs the connection code, so other websites you visit can't use it.
 *  - The CLI runs in an empty temporary folder. Claude Code runs with its tools
 *    turned off, and Codex runs in its read-only sandbox.
 *  - Your resume is sent only to the AI tool you picked. Nothing is stored.
 *
 * Settings (environment variables, all optional):
 *  RESUMEFIT_PORT      port to listen on (default 8787)
 *  RESUMEFIT_TOKEN     fixed connection code instead of a random one
 *  RESUMEFIT_ORIGINS   comma-separated list of sites allowed to call the helper,
 *                      e.g. https://yourname.github.io (default: any site that has the code)
 *  RESUMEFIT_TIMEOUT   seconds to wait for an answer (default 240)
 *  RESUMEFIT_CLAUDE_BIN / RESUMEFIT_CODEX_BIN     path to the CLI if it isn't on PATH
 *  RESUMEFIT_CLAUDE_ARGS / RESUMEFIT_CODEX_ARGS   JSON array to replace the default arguments
 */
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = 1;
const HOST = "127.0.0.1";
const PORT = Number(process.env.RESUMEFIT_PORT) || 8787;
const TOKEN = process.env.RESUMEFIT_TOKEN || crypto.randomBytes(12).toString("base64url");
const ORIGINS = (process.env.RESUMEFIT_ORIGINS || "").split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
const TIMEOUT_MS = (Number(process.env.RESUMEFIT_TIMEOUT) || 240) * 1000;
const MAX_BODY = 400 * 1024;
const IS_WIN = process.platform === "win32";
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// absolute PATH, because the CLI runs from a temporary folder
const ENV = { ...process.env, NO_COLOR: "1", PATH: (process.env.PATH || "").split(path.delimiter).map(p => (p ? path.resolve(p) : p)).join(path.delimiter) };

const jsonArgs = (name, fallback) => {
  try { const v = JSON.parse(process.env[name] || "null"); return Array.isArray(v) ? v.map(String) : fallback; }
  catch { console.warn(`Ignoring ${name}: it must be a JSON array of strings.`); return fallback; }
};

/*
 * The agents this helper knows. In "args":
 *   {PROMPT}  is replaced by the prompt (otherwise the prompt is sent on stdin)
 *   {OUT}     is replaced by a temporary file the agent writes its answer to
 * Every agent runs in an empty temporary folder, with its tools off or read-only where the CLI allows it.
 * Override any agent with RESUMEFIT_<ID>_BIN and RESUMEFIT_<ID>_ARGS (JSON array), e.g. RESUMEFIT_KIRO_BIN.
 * Add your own in bridge/agents.json (see bridge/agents.example.json).
 */
const BUILT_IN = [
  { id: "claude", label: "Claude Code", bin: "claude",
    args: ["-p", "--output-format", "text", "--disallowedTools", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task"] },
  { id: "codex", label: "Codex", bin: "codex",
    args: ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "-o", "{OUT}", "-"] },
  // Kiro CLI headless mode: no --trust-tools, so it can't run tools
  { id: "kiro", label: "Kiro", bin: "kiro-cli", args: ["chat", "--no-interactive"] },
  // Grok Build CLI: without --always-approve it can't run tools on its own
  { id: "grok", label: "Grok", bin: "grok", args: ["-p", "{PROMPT}", "--output-format", "plain", "--no-auto-update"] },
  // Gemini CLI: the prompt arrives on stdin, -p adds the final instruction
  { id: "gemini", label: "Gemini CLI", bin: "gemini", args: ["-p", "Follow the instructions in the text above. Reply with the JSON only."] },
  // GitHub Copilot CLI: tools need permission, which isn't given; -s prints only the answer
  { id: "copilot", label: "GitHub Copilot", bin: "copilot", args: ["-p", "{PROMPT}", "-s"] }
];

function loadCustomAgents() {
  const file = process.env.RESUMEFIT_AGENTS || path.join(path.dirname(fileURLToPath(import.meta.url)), "agents.json");
  if (!fs.existsSync(file)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf8")).agents || [];
    return list.filter(a => a && /^[a-z0-9_-]{1,30}$/i.test(a.id) && typeof a.bin === "string" && Array.isArray(a.args))
      .map(a => ({ id: a.id.toLowerCase(), label: String(a.label || a.id), bin: a.bin, args: a.args.map(String), custom: true }));
  } catch (e) { console.warn(`Couldn't read ${file}: ${e.message}`); return []; }
}
const PROVIDERS = {};
for (const a of [...BUILT_IN, ...loadCustomAgents()]) {
  const key = a.id.toUpperCase().replace(/-/g, "_");
  PROVIDERS[a.id] = { ...a, bin: process.env[`RESUMEFIT_${key}_BIN`] || a.bin, args: jsonArgs(`RESUMEFIT_${key}_ARGS`, a.args), pinned: !!process.env[`RESUMEFIT_${key}_BIN`] };
}

const quoteWin = a => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
function tryVersion(bin) {
  try {
    const r = spawnSync(bin, ["--version"], { env: ENV, shell: IS_WIN, timeout: 20000, encoding: "utf8", windowsHide: true });
    return r.status === 0 ? ((r.stdout || r.stderr || "").trim().split("\n")[0] || "installed") : null;
  } catch { return null; }
}
// Places these CLIs are commonly installed when they aren't on this terminal's PATH
function candidates(id, name) {
  const home = os.homedir(), out = [];
  if (IS_WIN) {
    const ad = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    out.push(path.join(ad, "npm", name + ".cmd"), path.join(home, ".local", "bin", name + ".exe"));
    return out;
  }
  const dirs = [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"), path.join(home, ".volta", "bin"), path.join(home, ".yarn", "bin"), path.join(home, "Library", "pnpm")];
  if (id === "claude") dirs.push(path.join(home, ".claude", "local"));
  try { // every Node version installed with nvm
    const nvm = path.join(process.env.NVM_DIR || path.join(home, ".nvm"), "versions", "node");
    for (const v of fs.readdirSync(nvm)) dirs.push(path.join(nvm, v, "bin"));
  } catch {}
  for (const d of dirs) out.push(path.join(d, name));
  if (id === "codex") out.push("/Applications/Codex.app/Contents/Resources/codex", "/Applications/Codex.app/Contents/MacOS/codex");
  // ask the login shell, which loads ~/.zshrc or ~/.bashrc
  try {
    const sh = process.env.SHELL || "/bin/zsh";
    const r = spawnSync(sh, ["-lic", `command -v ${name}`], { timeout: 8000, encoding: "utf8" });
    const hit = (r.stdout || "").trim().split("\n").pop();
    if (hit && hit.startsWith("/")) out.unshift(hit);
  } catch {}
  return out;
}
function detect(id, p) {
  const direct = tryVersion(p.bin);
  if (direct) return direct;
  if (p.pinned || path.isAbsolute(p.bin)) return null; // the user chose a path; don't guess
  for (const c of candidates(id, path.basename(p.bin))) {
    if (!fs.existsSync(c)) continue;
    const v = tryVersion(c);
    if (v) { p.bin = c; return v + "  (" + c + ")"; }
  }
  return null;
}
const found = {};
for (const [id, p] of Object.entries(PROVIDERS)) found[id] = detect(id, p);

let busy = false;
function runCli(id, prompt) {
  const p = PROVIDERS[id];
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resumefit-"));
    const out = path.join(dir, "answer.txt");
    const viaArg = p.args.some(a => a.includes("{PROMPT}"));
    let args = p.args.map(a => a.replace("{OUT}", out).replace("{PROMPT}", prompt));
    let bin = p.bin, shell = IS_WIN;
    if (IS_WIN && viaArg) {
      // cmd.exe can't pass a long multi-line prompt, so run the .exe directly
      const exe = (spawnSync("where", [p.bin], { encoding: "utf8" }).stdout || "").split(/\r?\n/).find(l => /\.exe$/i.test(l.trim()));
      if (!exe) { fs.rmSync(dir, { recursive: true, force: true }); return reject(Object.assign(new Error(`${p.label} takes the prompt as an argument, which doesn't work through a Windows .cmd launcher. Use WSL, or an agent that reads stdin (Claude Code, Codex, Kiro, Gemini CLI).`), { code: "cli_failed" })); }
      bin = exe.trim(); shell = false;
    } else if (IS_WIN) args = args.map(quoteWin);
    const child = spawn(bin, args, { cwd: dir, shell, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: ENV });
    let stdout = "", stderr = "", done = false;
    const cap = (s, d) => (s.length > 2e6 ? s : s + d);
    child.stdout.on("data", d => { stdout = cap(stdout, d.toString()); });
    child.stderr.on("data", d => { stderr = cap(stderr, d.toString()); });
    const finish = (err, text) => {
      if (done) return; done = true; clearTimeout(timer);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      err ? reject(err) : resolve(text);
    };
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} finish(Object.assign(new Error("timed out"), { code: "timeout" })); }, TIMEOUT_MS);
    child.on("error", e => finish(Object.assign(new Error(`${p.label} could not start: ${e.message}`), { code: "cli_failed" })));
    child.on("close", code => {
      let text = "";
      try { if (fs.existsSync(out)) text = fs.readFileSync(out, "utf8"); } catch {}
      if (!text.trim()) text = stdout;
      text = text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, ""); // strip terminal colours
      if (code !== 0 && !text.trim()) {
        const why = (stderr || stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300) || `exit code ${code}`;
        return finish(Object.assign(new Error(why), { code: "cli_failed" }));
      }
      finish(null, text.trim());
    });
    child.stdin.on("error", () => {});
    child.stdin.end(viaArg ? "" : prompt);
  });
}

function tokenOk(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  if (!m) return false;
  const a = Buffer.from(m[1].trim()), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && (!ORIGINS.length || ORIGINS.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Private-Network", "true"); // lets https pages reach this local helper in Chrome
  res.setHeader("Access-Control-Max-Age", "600");
}
function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png" };
function serveApp(req, res) {
  const url = new URL(req.url, "http://x");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  if (!/^\/(index\.html|favicon\.ico|src\/[\w.-]+\.(js|css)|assets\/[\w.\/-]+\.(png|svg|ico|css|js))$/.test(rel) || rel.includes("..")) return false;
  const file = path.join(APP_ROOT, rel);
  if (!file.startsWith(APP_ROOT) || !fs.existsSync(file)) return false;
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer((req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const route = new URL(req.url, "http://x").pathname;

  if (req.method === "GET" && route === "/health") {
    if (!tokenOk(req)) return send(res, 401, { error: "bad_token", message: "Connection code missing or wrong." });
    return send(res, 200, { ok: true, app: "resumefit-bridge", version: VERSION, providers: Object.fromEntries(Object.keys(PROVIDERS).map(id => [id, !!found[id]])),
      agents: Object.values(PROVIDERS).map(p => ({ id: p.id, label: p.label, found: !!found[p.id] })) });
  }

  if (req.method === "POST" && route === "/suggest") {
    if (!tokenOk(req)) return send(res, 401, { error: "bad_token", message: "Connection code missing or wrong." });
    if (ORIGINS.length && req.headers.origin && !ORIGINS.includes(req.headers.origin)) return send(res, 403, { error: "origin", message: "This site isn't allowed. Add it to RESUMEFIT_ORIGINS." });
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > MAX_BODY) { req.destroy(); } else chunks.push(c); });
    req.on("end", async () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(res, 400, { error: "bad_request", message: "Body must be JSON." }); }
      const id = body && body.provider;
      if (!PROVIDERS[id]) return send(res, 400, { error: "bad_request", message: `provider must be one of: ${Object.keys(PROVIDERS).join(", ")}.` });
      if (!found[id]) return send(res, 400, { error: "not_installed", message: `${PROVIDERS[id].label} isn't installed or isn't on PATH.` });
      if (typeof body.prompt !== "string" || !body.prompt.trim()) return send(res, 400, { error: "bad_request", message: "prompt is empty." });
      if (busy) return send(res, 429, { error: "busy", message: "Already working on a request." });
      busy = true;
      const started = Date.now();
      console.log(`→ ${PROVIDERS[id].label}: writing suggestions…`);
      try {
        const text = await runCli(id, body.prompt);
        console.log(`✓ done in ${Math.round((Date.now() - started) / 1000)}s`);
        send(res, 200, { text });
      } catch (e) {
        console.log(`✗ ${e.message}`);
        send(res, e.code === "timeout" ? 504 : 502, { error: e.code || "cli_failed", message: e.message });
      } finally { busy = false; }
    });
    return;
  }

  if (req.method === "GET" && serveApp(req, res)) return;
  send(res, 404, { error: "not_found" });
});

server.on("error", e => {
  if (e.code === "EADDRINUSE") console.error(`Port ${PORT} is already in use. Stop the other program, or run with RESUMEFIT_PORT=8788.`);
  else console.error(e.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const hasApp = fs.existsSync(path.join(APP_ROOT, "index.html"));
  const w = Math.max(...Object.values(PROVIDERS).map(p => p.label.length)) + 3;
  const rows = Object.values(PROVIDERS).map(p => `  ${p.label.padEnd(w)}${found[p.id] ? "✓ " + found[p.id] : "✗ not found"}`).join("\n");
  const ok = Object.values(PROVIDERS).filter(p => found[p.id]);
  console.log(`
ResumeFit local AI helper is running.

${rows}

  Connection code:  ${TOKEN}
${hasApp ? `
  Open ResumeFit already connected:
  http://${HOST}:${PORT}/#bridge=${TOKEN}
` : ""}
Using ResumeFit from another address (for example GitHub Pages)? Pick
"${ok[0] ? ok[0].label : "Claude Code"} on my computer" in the AI menu under Suggested changes,
then paste the connection code. Keep this window open. Press Ctrl+C to stop.
`);
  if (!ok.length) console.log("No AI agent was found. Install one (Claude Code, Codex, Kiro, Grok, Gemini CLI or GitHub Copilot), sign in once in a terminal, then restart this helper.\n");
  console.log(`Installed an agent but it shows "not found"? Start the helper with its path, e.g.
  RESUMEFIT_KIRO_BIN="$(which kiro-cli)" node bridge/resumefit-bridge.mjs
Other AI command-line tools can be added in bridge/agents.json (see bridge/agents.example.json).
`);
});
