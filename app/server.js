const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { exec, spawn } = require("child_process");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

// HTTP client (follows redirects). Pure Node so we never shell out to curl,
// whose quoting/availability differs across hosts and broke this on Windows.
function httpRequest(url, opts = {}) {
  const { method = "GET", headers = {}, body = null, maxRedirects = 5, maxBytes = 10_000_000, timeout = 20000, binary = false } = opts;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(u, { method, headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        const downgrade = res.statusCode === 303;
        return resolve(httpRequest(next, {
          method: downgrade ? "GET" : method,
          headers, body: downgrade ? null : body,
          maxRedirects: maxRedirects - 1, maxBytes, timeout, binary,
        }));
      }
      const chunks = [];
      let bytes = 0, truncated = false;
      res.on("data", (c) => {
        bytes += c.length;
        if (!truncated && bytes <= maxBytes) chunks.push(c);
        else truncated = true;
      });
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: binary ? buf : buf.toString() });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => req.destroy(new Error("request timeout")));
    if (body) req.write(body);
    req.end();
  });
}

const PORT = process.env.PORT || 3000;
const ROOT = path.resolve(__dirname, "..");
const IS_WIN = process.platform === "win32";
const ADMIN_MODE = fs.existsSync(path.join(ROOT, "admin"));
// DO-owned interview station (admin marker present, aggressive host scrub allowed)
// vs candidate BYOD (no marker — only ShellPort's own footprint may be removed).
const MACHINE_TYPE = ADMIN_MODE ? "do" : "byod";
// Managed (DO station, candidate-facing) exposes a password-gated admin panel;
// candidate (BYOD) never does.
const VIEW_MODE = ADMIN_MODE ? "managed" : "candidate";

// Admin-set appearance preset, inherited by candidate/managed screens.
const APPEARANCE_FILE = path.join(ROOT, ".appearance.json");
const APPEARANCE_DEFAULTS = { theme: "system", accent: "cerulean", font: "sans" };
const APPEARANCE_ENUMS = {
  theme: ["system", "light", "dark"],
  accent: ["cerulean", "foam", "kelp", "tentacle", "violet", "mono"],
  font: ["sans", "grotesk", "editorial"],
};
function loadAppearance() {
  try {
    const raw = JSON.parse(fs.readFileSync(APPEARANCE_FILE, "utf8"));
    const out = {};
    for (const k of Object.keys(APPEARANCE_DEFAULTS)) {
      out[k] = APPEARANCE_ENUMS[k].includes(raw[k]) ? raw[k] : APPEARANCE_DEFAULTS[k];
    }
    return out;
  } catch (_) {
    return { ...APPEARANCE_DEFAULTS };
  }
}

let state = {
  status: "initializing",
  steps: [],
  config: {},
  ides: [],
  question: null,
  questionHtml: null,
  questionPdf: null,
  questionLoading: false,
  questionVisible: true,
  questionError: null,
  timer: null,
  snapshot: null,
  adminMode: ADMIN_MODE,
  machineType: MACHINE_TYPE,
  mode: VIEW_MODE,
  adminAvailable: ADMIN_MODE,
  appearance: loadAppearance(),
  enabledEditors: [],
  terminalEnabled: true,
  validationLocked: false,
  eventComplete: null,
  error: null,
};

const clients = new Set();

// Read-only build/reset log. Every operation line is captured here so the log
// view can replay history on open and stream live after. level ∈ ok|info|warn|err|step.
const buildLog = [];
const BUILD_LOG_MAX = 600;
function recordLog(level, msg) {
  buildLog.push({ ts: Date.now(), level, msg });
  if (buildLog.length > BUILD_LOG_MAX) buildLog.shift();
}
function stepLevel(status) {
  if (status === "warning") return "warn";
  if (status === "error") return "err";
  return "step";
}

function broadcast(msg) {
  if (msg.type === "log") recordLog("info", msg.line);
  else if (msg.type === "step") recordLog(stepLevel(msg.status), msg.label);
  else if (msg.type === "clear_steps") buildLog.length = 0;
  const data = JSON.stringify(msg);
  clients.forEach((ws) => { try { ws.send(data); } catch (_) {} });
}

function updateStatus(status) {
  state.status = status;
  broadcast({ type: "status", status });
}

function addStep(id, label, status) {
  const existing = state.steps.find((s) => s.id === id);
  if (existing) { existing.label = label; existing.status = status; }
  else { state.steps.push({ id, label, status }); }
  broadcast({ type: "step", id, label, status });
}

let progressTarget = 0;
let progressCurrent = 0;
let progressPhase = "setup";
let progressTimer = null;

function setTarget(pct, phase) {
  progressTarget = Math.min(pct, 100);
  progressPhase = phase || progressPhase;
  if (!progressTimer) {
    progressTimer = setInterval(() => {
      if (progressCurrent < progressTarget) {
        const gap = progressTarget - progressCurrent;
        progressCurrent += Math.max(Math.ceil(gap * 0.2), 1);
        if (progressCurrent > progressTarget) progressCurrent = progressTarget;
      }
      broadcast({ type: "progress", pct: progressCurrent, phase: progressPhase });
      if (progressCurrent >= 100) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
    }, 500);
  }
}

function resetProgress(phase) {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  progressTarget = 0;
  progressCurrent = 0;
  progressPhase = phase || "setup";
  broadcast({ type: "progress", pct: 0, phase: progressPhase });
}

// .env loader
function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  const config = {
    ENABLE_TIMER: "false", TIMEOUT_ACTION: "NOTIFY",
    TIME_LIMIT_MINUTES: "60", INACTIVITY_TIMEOUT_MINUTES: "10",
    ENABLE_TELEMETRY: "false",
    PROJECT_NAME: "",
    QUESTIONS_URL: "",
    QUESTION_ROW: "",
    QUESTION_TAB: "",
    QUESTION_WEBHOOK: "",
    MACHINE_LABEL: "",
    ENABLED_EDITORS: "",
    TERMINAL_ACCESS: "true",
    QUESTION_DELIVERY: "auto",
  };
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
      line = line.trim();
      if (!line || line.startsWith("#")) return;
      const [k, ...rest] = line.split("=");
      if (!k) return;
      let val = rest.join("=").trim();
      if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
        // Double-quoted: unescape what the config writer emitted.
        val = val.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      } else {
        val = val.replace(/^'|'$/g, "");
      }
      config[k.trim()] = val;
    });
  }
  state.config = config;
  return config;
}

// Derive the wire-facing editor/terminal fields from config + detected IDEs.
// ENABLED_EDITORS is a comma list of allowed local editors; empty = all detected.
function deriveEditorAccess() {
  const local = state.ides.filter((i) => i.kind === "local").map((i) => i.name);
  const allow = (state.config.ENABLED_EDITORS || "").split(",").map((s) => s.trim()).filter(Boolean);
  state.enabledEditors = allow.length ? local.filter((n) => allow.includes(n)) : local;
  state.terminalEnabled = (state.config.TERMINAL_ACCESS || "true") !== "false";
}

// Shell exec with streaming and build progress parsing
function run(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = IS_WIN
      ? spawn("powershell", ["-NoProfile", "-Command", cmd], { cwd: opts.cwd || ROOT, shell: false })
      : spawn("bash", ["-c", cmd], { cwd: opts.cwd || ROOT });
    let stdout = "", stderr = "";
    let buildTicks = 0;
    proc.stdout.on("data", (d) => {
      const line = d.toString();
      stdout += line;
      if (opts.stream) broadcast({ type: "log", line: line.trimEnd() });
      if (opts.trackBuild) {
        buildTicks++;
        const buildPct = Math.min(Math.floor(buildTicks * 2), 95);
        setTarget(opts.baseProgress + Math.floor(buildPct / 100 * opts.weight), progressPhase);
      }
    });
    proc.stderr.on("data", (d) => {
      const line = d.toString();
      stderr += line;
      if (opts.stream) broadcast({ type: "log", line: line.trimEnd() });
      if (opts.trackBuild) {
        buildTicks++;
        const buildPct = Math.min(Math.floor(buildTicks * 2), 95);
        setTarget(opts.baseProgress + Math.floor(buildPct / 100 * opts.weight), progressPhase);
      }
    });
    proc.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `exit ${code}`)));
    proc.on("error", reject);
  });
}

// First existing candidate path, else any of pathNames found on PATH.
function findBin(candidatePaths, pathNames = []) {
  for (const p of candidatePaths) { if (p && fs.existsSync(p)) return p; }
  const dirs = (process.env.PATH || "").split(IS_WIN ? ";" : ":");
  for (const name of pathNames) {
    for (const d of dirs) {
      if (!d) continue;
      const full = path.join(d, name);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

// Non-interactive keychain fingerprint: `security dump-keychain` pops a GUI
// prompt that can hang the server, so we hash each *.keychain-db's size+mtime.
function keychainFingerprint() {
  try {
    const dir = path.join(process.env.HOME || "", "Library", "Keychains");
    if (!fs.existsSync(dir)) return "";
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith(".keychain-db"))
      .sort()
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return `${f}:${st.size}:${Math.floor(st.mtimeMs)}`;
      })
      .join("|");
  } catch (_) {
    return "";
  }
}

function detectIDEs() {
  const ides = [];
  const HOME = process.env.HOME || process.env.USERPROFILE || "";
  const PF = process.env.ProgramFiles || "C:\\Program Files";
  const LAD = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");

  const localDefs = IS_WIN ? [
    { name: "VS Code",          bins: ["code.cmd"],          paths: [`${PF}\\Microsoft VS Code\\bin\\code.cmd`, `${LAD}\\Programs\\Microsoft VS Code\\bin\\code.cmd`] },
    { name: "VS Code Insiders", bins: ["code-insiders.cmd"], paths: [`${PF}\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd`, `${LAD}\\Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd`] },
    { name: "Cursor",           bins: ["cursor.cmd"],        paths: [`${LAD}\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd`, `${LAD}\\Programs\\cursor\\Cursor.exe`] },
    { name: "Windsurf",         bins: ["windsurf.cmd"],      paths: [`${LAD}\\Programs\\Windsurf\\bin\\windsurf.cmd`, `${LAD}\\Programs\\windsurf\\Windsurf.exe`] },
    { name: "VSCodium",         bins: ["codium.cmd"],        paths: [`${LAD}\\Programs\\VSCodium\\bin\\codium.cmd`] },
  ] : process.platform === "darwin" ? [
    { name: "VS Code",          bins: ["code"],          paths: ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"] },
    { name: "VS Code Insiders", bins: ["code-insiders"], paths: ["/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders"] },
    { name: "Cursor",           bins: ["cursor"],        paths: ["/Applications/Cursor.app/Contents/Resources/app/bin/cursor"] },
    { name: "Windsurf",         bins: ["windsurf"],      paths: ["/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"] },
    { name: "VSCodium",         bins: ["codium"],        paths: ["/Applications/VSCodium.app/Contents/Resources/app/bin/codium"] },
  ] : [ // Linux — rely on PATH (deb/rpm/snap/flatpak all drop a CLI there)
    { name: "VS Code",          bins: ["code"],          paths: ["/usr/bin/code", "/usr/local/bin/code", "/snap/bin/code"] },
    { name: "VS Code Insiders", bins: ["code-insiders"], paths: ["/usr/bin/code-insiders"] },
    { name: "Cursor",           bins: ["cursor"],        paths: ["/usr/bin/cursor", "/usr/local/bin/cursor"] },
    { name: "Windsurf",         bins: ["windsurf"],      paths: ["/usr/bin/windsurf", "/usr/local/bin/windsurf"] },
    { name: "VSCodium",         bins: ["codium"],        paths: ["/usr/bin/codium", "/snap/bin/codium"] },
  ];

  for (const def of localDefs) {
    const bin = findBin(def.paths, def.bins);
    if (bin) ides.push({ name: def.name, kind: "local", path: bin });
  }

  // Web options — always available, no local install required.
  ides.push({ name: "vscode.dev", kind: "url", url: "https://vscode.dev", note: "VS Code for the web" });
  ides.push({ name: "github.dev", kind: "url", url: "https://github.dev", note: "VS Code for the web on GitHub" });
  ides.push({ name: "GitHub Codespaces", kind: "url", url: "https://github.com/codespaces/new", note: "Cloud dev container" });
  ides.push({ name: "DevPod", kind: "instruction", instruction: "Open DevPod, add this folder as a workspace, and it will build from the committed devcontainer.json." });

  state.ides = ides;
}

async function captureSnapshot() {
  addStep("snapshot", "Capturing pre-install state", "running");
  const snapshot = { ts: new Date().toISOString(), files: {}, credentials: {} };
  try {
    if (IS_WIN) {
      snapshot.files.desktop = await run(`Get-ChildItem "$env:USERPROFILE\\Desktop" -File -EA SilentlyContinue | Select -ExpandProperty FullName`).catch(() => "");
      snapshot.files.downloads = await run(`Get-ChildItem "$env:USERPROFILE\\Downloads" -File -EA SilentlyContinue | Select -ExpandProperty FullName`).catch(() => "");
      snapshot.credentials.cmdkeyCount = await run(`(cmdkey /list 2>$null | Select-String 'Target:').Count`).catch(() => "0");
    } else {
      const home = process.env.HOME;
      snapshot.files.desktop = await run(`ls -1 "${home}/Desktop/" 2>/dev/null`).catch(() => "");
      snapshot.files.downloads = await run(`ls -1 "${home}/Downloads/" 2>/dev/null`).catch(() => "");
      snapshot.credentials.keychainFingerprint = keychainFingerprint();
    }
  } catch (_) {}
  state.snapshot = snapshot;
  fs.writeFileSync(path.join(ROOT, ".session_snapshot.json"), JSON.stringify(snapshot, null, 2));
  addStep("snapshot", "Pre-install state captured", "done");
}

// Strip Google's export-HTML chrome down to a clean fragment we can render inline.
function cleanDocHtml(htmlRaw) {
  if (!htmlRaw || !htmlRaw.includes("<body")) return null;
  let body = htmlRaw;
  const bodyMatch = htmlRaw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) body = bodyMatch[1];
  return body
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<a[^>]*href="https?:\/\/www\.google\.com\/url\?q=([^&"]+)[^"]*"/gi, '<a href="$1"')
    .replace(/style="[^"]*"/gi, "")
    .replace(/class="[^"]*"/gi, "")
    // Strip span wrappers regardless of leftover attributes; after class/style
    // removal Google emits <span > tags that a bare /<span>/ would miss.
    .replace(/<\/?span[^>]*>/gi, "")
    .replace(/<p[^>]*>\s*<\/p>/gi, "")
    .trim();
}

// List a Google Doc's tabs (id + title) by scraping the public /preview page —
// the export endpoints don't reveal tab IDs and we have no API credentials. The
// first tab exports as "t.0"; the rest carry their own t.<id>. Returns [] for a
// non-tabbed doc, or if the page can't be read, so callers fall back gracefully.
async function listDocTabs(docId) {
  try {
    const resp = await httpRequest(`https://docs.google.com/document/d/${docId}/preview`);
    const html = resp.body || "";
    if (resp.status >= 400 || !html) return [];
    const decode = (s) => { try { return JSON.parse('"' + s + '"'); } catch (_) { return s; } };
    // First tab: title from the "mkch" entry. Subsequent tabs: id + title from
    // each "ac" entry. Their ids match the export's ?tab= parameter exactly.
    const first = html.match(/\{"ty":"mkch","d":\[\[1,"((?:[^"\\]|\\.)*)"\]\]\}/);
    const re = /\{"ty":"ac","d":\["(t\.[a-zA-Z0-9]+)",\[1,"((?:[^"\\]|\\.)*)"\]/g;
    const acTabs = [];
    let m;
    while ((m = re.exec(html))) acTabs.push({ id: m[1], title: decode(m[2]) });
    if (!acTabs.length && !first) return [];
    const tabs = [{ id: "t.0", title: first ? decode(first[1]) : "Tab 1" }, ...acTabs];
    const seen = new Set();
    return tabs.filter((t) => (seen.has(t.id) ? false : seen.add(t.id)));
  } catch (_) {
    return [];
  }
}

// Export a Google Doc (optionally one tab) to question.pdf for the in-page
// reader / remote handoff. Cache-busts the URL so a re-rolled question never
// shows a stale PDF; silent no-op if the export isn't a real PDF.
async function exportQuestionPdf(docId, tab) {
  const tabParam = tab ? `&tab=${encodeURIComponent(tab)}` : "";
  try {
    const pdfResp = await httpRequest(`https://docs.google.com/document/d/${docId}/export?format=pdf${tabParam}`, { binary: true });
    if (pdfResp.status < 400 && Buffer.isBuffer(pdfResp.body) && pdfResp.body.length > 1000
        && pdfResp.body.slice(0, 4).toString() === "%PDF") {
      fs.writeFileSync(path.join(ROOT, "question.pdf"), pdfResp.body);
      state.questionPdf = "/api/question.pdf?v=" + Date.now();
    }
  } catch (_) { state.questionPdf = null; }
}

// Render a single Google Doc tab as the assigned question: export a PDF copy for
// the in-page reader, and clean HTML for the inline view. `tabTitle`/`locator`,
// when the caller has already resolved the tab, override the title/locator that
// would otherwise be derived from the exported body (per-tab exports carry no
// heading, so the tab name is the authoritative title).
async function renderDocQuestion(docId, tab, tabTitle, locator) {
  const tabParam = tab ? `&tab=${encodeURIComponent(tab)}` : "";
  addStep("question", "Loading formatted question", "running");

  await exportQuestionPdf(docId, tab);

  const docResp = await httpRequest(`https://docs.google.com/document/d/${docId}/export?format=html${tabParam}`);
  const raw = docResp.body || "";
  const body = cleanDocHtml(raw);

  // Title from the doc's Title-styled paragraph (Google exports it as a
  // <p class="...title...">, not an <h1>), then the first heading, then generic.
  let title = tabTitle || "Interview question";
  if (!tabTitle) {
    const titleP = raw.match(/<p[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    const head = raw.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    const titleText = (titleP && titleP[1].replace(/<[^>]+>/g, "").trim())
      || (head && head[1].replace(/<[^>]+>/g, "").trim());
    if (titleText) title = titleText;
  }

  locator = locator || (tab ? `tab ${tab}` : "whole doc");
  state.question = title;
  state.questionHtml = body;
  state.questionLoading = false;
  addStep("question", `Assigned: ${title} (${locator})`, "done");
  broadcast({ type: "question", html: body, text: title, pdf: state.questionPdf, error: null });
  broadcast({ type: "log", line: `[question] Assigned: ${title} (${locator})` });
  fireQuestionWebhook(title, locator);
}

// Fetch interview question (always runs, not behind a toggle)
// QUESTION_ROW overrides random selection. Webhook fires either way.
async function fetchQuestion() {
  addStep("question", "Loading interview question", "running");
  state.questionLoading = true;
  state.questionPdf = null;
  broadcast({ type: "question_loading" });
  
  let url = (state.config.QUESTIONS_URL || "").trim();
  if (!url) {
    state.questionLoading = false;
    addStep("question", "No QUESTIONS_URL configured", "skipped");
    broadcast({ type: "question", html: null, text: null, error: "Set QUESTIONS_URL in .env" });
    return;
  }

  try {
    // Google Docs URL → single doc. Each question lives in its own tab; the
    // assigned tab comes from the URL (?tab=t.xxx) or is pinned via QUESTION_TAB.
    // This lets the team keep one living doc of questions, off-repo, and assign a
    // tab per station without maintaining a separate index sheet.
    const docsMatch = url.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
    if (docsMatch) {
      const docId = docsMatch[1];
      // A pasted doc link always carries the currently-open tab (?tab=t.0), so we
      // must NOT treat that as a pin — only an explicit QUESTION_TAB pins. With no
      // pin we detect every tab and randomly assign one (re-rolls on reroll) — the
      // doc equivalent of random row selection from a sheet.
      const pinned = (state.config.QUESTION_TAB || "").trim();
      const tabs = await listDocTabs(docId);
      let tab = "", tabTitle = null, locator = "whole doc";
      if (pinned) {
        tab = pinned;
        const found = tabs.find((t) => t.id === pinned);
        tabTitle = found ? found.title : null;
        locator = found ? `${found.title} (pinned)` : `tab ${pinned} (pinned)`;
      } else if (tabs.length) {
        const pick = tabs[Math.floor(Math.random() * tabs.length)];
        tab = pick.id; tabTitle = pick.title;
        locator = `${pick.title} (random of ${tabs.length})`;
        broadcast({ type: "log", line: `[question] Detected ${tabs.length} tab(s); randomly assigned "${pick.title}".` });
      } else {
        // Non-tabbed doc (or detection failed): honor an explicit URL tab, else whole doc.
        const urlTab = url.match(/[?&]tab=(t\.[a-zA-Z0-9_-]+)/);
        if (urlTab) { tab = urlTab[1]; locator = `tab ${tab}`; }
      }
      await renderDocQuestion(docId, tab, tabTitle, locator);
      return;
    }

    // Google Sheets URL → TSV export
    const sheetsMatch = url.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (sheetsMatch) {
      url = `https://docs.google.com/spreadsheets/d/${sheetsMatch[1]}/export?format=tsv`;
    }

    const resp = await httpRequest(url);
    const raw = resp.body || "";
    if (resp.status >= 400) throw new Error(`HTTP ${resp.status}`);
    if (!raw || raw.trim().length < 5) throw new Error("Empty response");

    const lines = raw.split("\n").map(l => l.trim()).filter(l => l.length > 5);
    if (lines.length < 2) throw new Error("No questions found (only header row)");

    const dataRows = lines.slice(1);

    // QUESTION_ROW overrides random: row 2 = index 0, row 3 = index 1, etc.
    const rowConfig = parseInt(state.config.QUESTION_ROW);
    let chosen;
    let rowIndex;
    if (rowConfig && rowConfig >= 2 && (rowConfig - 2) < dataRows.length) {
      rowIndex = rowConfig - 2;
      chosen = dataRows[rowIndex];
      broadcast({ type: "log", line: `[question] Pre-assigned row ${rowConfig}` });
    } else {
      rowIndex = Math.floor(Math.random() * dataRows.length);
      chosen = dataRows[rowIndex];
    }

    const cols = chosen.split("\t");
    const title = (cols[0] || "").replace(/^["']|["']$/g, "").trim();
    const docId = (cols[1] || "").replace(/^["']|["']$/g, "").trim();
    const sheetRow = rowIndex + 2;

    if (docId && docId.length > 10 && /^[a-zA-Z0-9_-]+$/.test(docId)) {
      addStep("question", "Loading formatted question", "running");

      await exportQuestionPdf(docId);

      const docResp = await httpRequest(`https://docs.google.com/document/d/${docId}/export?format=html`);
      const body = cleanDocHtml(docResp.body || "");

      if (body) {
        state.question = title;
        state.questionHtml = body;
        state.questionLoading = false;
        addStep("question", `Assigned: ${title} (row ${sheetRow})`, "done");
        broadcast({ type: "question", html: body, text: title, pdf: state.questionPdf, error: null });
        broadcast({ type: "log", line: `[question] Assigned: ${title} (row ${sheetRow})` });
        fireQuestionWebhook(title, `row ${sheetRow}`);
        return;
      }
    }

    // Fallback: no doc ID, or HTML fetch failed — title only.
    state.question = title;
    state.questionHtml = null;
    state.questionLoading = false;
    addStep("question", `Assigned: ${title} (row ${sheetRow})`, "done");
    broadcast({ type: "question", html: null, text: title, pdf: state.questionPdf, error: null });
    broadcast({ type: "log", line: `[question] Assigned: ${title} (row ${sheetRow})` });
    fireQuestionWebhook(title, `row ${sheetRow}`);

  } catch (err) {
    state.questionLoading = false;
    addStep("question", "Question unavailable", "skipped");
    broadcast({ type: "question", html: null, text: null, error: "Could not load question. Check QUESTIONS_URL in .env" });
  }
}

// Webhook notification — fires every time a question is assigned.
// `source` is a human-readable locator: a sheet row ("row 4") or a doc tab ("tab t.ab12").
async function fireQuestionWebhook(title, source) {
  const webhookUrl = (state.config.QUESTION_WEBHOOK || "").trim();
  if (!webhookUrl) return;

  const hostname = os.hostname();
  const serial = await getMachineSerial();
  const label = (state.config.MACHINE_LABEL || "").trim() || `${hostname} (${serial})`;
  const project = (state.config.PROJECT_NAME || "").trim() || "—";
  const mode = (state.config.QUESTION_ROW || state.config.QUESTION_TAB) ? "pre-assigned" : "random";
  const ts = new Date().toLocaleString("en-US", { timeZone: "America/Denver", hour12: true, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  const payload = JSON.stringify({
    text: `ShellPort: ${label} → ${title} (${source}, ${mode})`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `*ShellPort — Question Assigned*`,
            ``,
            `*Machine:* ${label}`,
            `*Serial:* ${serial}`,
            `*Question:* ${title}`,
            `*Source:* ${source}  |  *Mode:* ${mode}`,
            `*Project:* ${project}`,
            `*Time:* ${ts}`,
          ].join("\n")
        }
      }
    ]
  });

  // POST via Node, not a shell — titles with quotes (e.g. "Conway's Game of Life") stay safe.
  httpRequest(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    body: payload,
  }).then((res) => {
    if (res.status >= 200 && res.status < 300) broadcast({ type: "log", line: `[webhook] Sent: ${label} → ${title}` });
    else broadcast({ type: "log", line: `[webhook] Delivery returned HTTP ${res.status}` });
  }).catch(() => {
    broadcast({ type: "log", line: `[webhook] Failed to deliver notification` });
  });
}

async function getMachineSerial() {
  try {
    if (IS_WIN) {
      const raw = await run(`powershell -NoProfile -Command "(Get-CimInstance Win32_BIOS).SerialNumber"`);
      return raw.trim() || "unknown";
    } else if (process.platform === "darwin") {
      const raw = await run(`ioreg -l | grep IOPlatformSerialNumber | awk -F'"' '{print $4}'`);
      return raw.trim() || "unknown";
    } else {
      const raw = await run(`cat /sys/class/dmi/id/product_serial 2>/dev/null || hostname`);
      return raw.trim() || "unknown";
    }
  } catch (_) {
    return "unknown";
  }
}

// ── Admin authentication ─────────────────────────────────────────────────────
// Privileged actions are gated on proving OS-admin rights (not a ShellPort
// secret): the DO candidate account can't unlock, the interviewer/IT one can;
// on BYOD the owner self-resets. A challenge mints a short-lived bearer token.
const adminTokens = new Map(); // token -> expiresAt (ms)
const TOKEN_TTL = 30 * 60 * 1000;

function issueToken() {
  const t = crypto.randomBytes(24).toString("hex");
  adminTokens.set(t, Date.now() + TOKEN_TTL);
  return t;
}
function validToken(t) {
  if (!t) return false;
  const exp = adminTokens.get(t);
  if (!exp) return false;
  if (Date.now() > exp) { adminTokens.delete(t); return false; }
  return true;
}
function tokenFromReq(req) {
  const h = req.headers["authorization"] || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  return (req.headers["x-admin-token"] || "").trim();
}
function requireAuth(req, res) {
  if (validToken(tokenFromReq(req))) return true;
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Admin authentication required" }));
  return false;
}

// Trigger the native OS admin challenge. Returns true only on valid admin creds.
function authenticateAdmin() {
  return new Promise((resolve) => {
    if (IS_WIN) {
      // UAC elevation on a no-op; throws if the user cancels or isn't an admin.
      const cmd = `try { Start-Process cmd -ArgumentList '/c','exit' -Verb RunAs -WindowStyle Hidden -Wait -ErrorAction Stop; 'ok' } catch { 'fail' }`;
      run(cmd).then((o) => resolve(o.trim().endsWith("ok"))).catch(() => resolve(false));
    } else if (process.platform === "darwin") {
      // Native macOS admin auth dialog; echoes 'ok' only on success.
      run(`osascript -e 'do shell script "echo ok" with administrator privileges'`)
        .then((o) => resolve(o.trim() === "ok")).catch(() => resolve(false));
    } else {
      // Linux: pkexec shows a polkit admin prompt; exit 0 only on success.
      run(`pkexec true`).then(() => resolve(true)).catch(() => resolve(false));
    }
  });
}

// Verify a typed password against the current OS user account, non-interactively.
// Managed stations are provisioned so candidates never hold this password, so it
// is an OS-strength gate. Linux can't verify a typed password without root, so it
// falls back to the native admin prompt (the typed value is ignored there).
function verifyOsPassword(password) {
  return new Promise((resolve) => {
    if (!password && process.platform !== "linux") return resolve(false);
    const user = os.userInfo().username;
    if (process.platform === "darwin") {
      // Args (not a shell string) so the password is never interpolated/quoted.
      const p = spawn("dscl", [".", "-authonly", user, password]);
      p.on("close", (code) => resolve(code === 0));
      p.on("error", () => resolve(false));
    } else if (IS_WIN) {
      // Password handed to PowerShell via the environment, never argv or the script body.
      const ps = "Add-Type -AssemblyName System.DirectoryServices.AccountManagement;"
        + "$c=New-Object System.DirectoryServices.AccountManagement.PrincipalContext('Machine');"
        + "if($c.ValidateCredentials($env:USERNAME,$env:SP_PW)){exit 0}else{exit 1}";
      const p = spawn("powershell", ["-NoProfile", "-Command", ps], { env: { ...process.env, SP_PW: password } });
      p.on("close", (code) => resolve(code === 0));
      p.on("error", () => resolve(false));
    } else {
      authenticateAdmin().then(resolve).catch(() => resolve(false));
    }
  });
}

// Command an admin runs to remove ShellPort entirely (BYOD self-uninstall).
function uninstallCommand() {
  return IS_WIN
    ? `Remove-Item -Recurse -Force "${ROOT}"`
    : `rm -rf "${ROOT}"`;
}

// Release installs are extracted from a tarball (no .git); a .git here means a
// dev/manual checkout. We never delete a working tree.
function isGitCheckout() {
  return fs.existsSync(path.join(ROOT, ".git"));
}

// Remove ShellPort's own install directory — and nothing else. Refuses on a git
// checkout so an errant teardown can't wipe a working tree. Returns true only if
// the directory was actually removed.
function removeInstallDir() {
  if (isGitCheckout()) {
    broadcast({ type: "log", line: `[remove] ${ROOT} is a git checkout — leaving it in place.` });
    return false;
  }
  broadcast({ type: "log", line: `[remove] Removing ${ROOT}…` });
  try { fs.rmSync(ROOT, { recursive: true, force: true }); return true; }
  catch (e) { broadcast({ type: "log", line: `[remove] Could not remove ${ROOT}: ${e.message}` }); return false; }
}

// Prep a DO station for storage and power it off. Order is deliberate: we confirm
// a shutdown command is actually *accepted* before deleting the install dir, so a
// machine that can't power off (e.g. macOS Automation permission denied) is left
// fully intact and recoverable rather than wiped-but-still-on. The power-off
// commands schedule with a short delay and return immediately, giving this
// process time to remove its own files before the OS goes down. End state: the
// machine shuts down and the install folder no longer exists.
async function shutdownMachine() {
  const home = process.env.HOME || process.env.USERPROFILE || "/";

  // Container teardown must happen while docker-compose.yml still exists.
  broadcast({ type: "log", line: "[shutdown] Tearing down ShellPort container…" });
  await run(`docker compose -f "${path.join(ROOT, "docker-compose.yml")}" down -v --remove-orphans`, { cwd: ROOT, stream: true }).catch(() => {});

  // Verify shutdown capability first. Each command schedules a power-off and
  // returns immediately; a non-zero exit means we lack the rights, so we try the
  // next. If none succeed we abort WITHOUT deleting anything.
  broadcast({ type: "log", line: "[shutdown] Scheduling power-off…" });
  const cmds = IS_WIN
    ? [`shutdown /s /f /t 20`]
    : process.platform === "darwin"
      ? [`osascript -e 'tell application "System Events" to shut down'`, `shutdown -h now`]
      : [`shutdown -h +1`, `systemctl poweroff`, `shutdown -h now`];

  let initiated = false;
  for (const cmd of cmds) {
    try { await run(cmd, { cwd: home }); initiated = true; broadcast({ type: "log", line: `[shutdown] Power-off accepted via "${cmd}".` }); break; }
    catch (e) { broadcast({ type: "log", line: `[shutdown] "${cmd}" failed: ${e.message}` }); }
  }

  if (!initiated) {
    broadcast({ type: "log", line: "[shutdown] Could not power off automatically — leaving the install in place so this machine stays recoverable. Shut down manually." });
    return;
  }

  // Shutdown is confirmed and pending — safe to remove our own files now.
  removeInstallDir();
  broadcast({ type: "log", line: "[shutdown] Clean. Powering off…" });
}

// ── Pre-interview validation ─────────────────────────────────────────────────
// Catch prior-candidate residue before setup. Our own leftovers (container,
// session files) clear automatically; DO-station credential residue can't be
// wiped unattended, so we hold setup for an authenticated admin reset.
async function validatePreInterview() {
  addStep("validate", "Validating clean state", "running");
  const residue = [];
  if (fs.existsSync(path.join(ROOT, ".session_snapshot.json"))) residue.push("previous session snapshot");
  const ours = await run(`docker compose -f "${path.join(ROOT, "docker-compose.yml")}" ps -q`, { cwd: ROOT }).catch(() => "");
  if (ours.trim()) residue.push("previous interview container");

  let credResidue = false;
  if (ADMIN_MODE) {
    const home = process.env.HOME || process.env.USERPROFILE;
    for (const d of [".config/gh", ".config/doctl", ".claude", ".git-credentials"]) {
      if (fs.existsSync(path.join(home, d))) { residue.push(`leftover credentials (${d})`); credResidue = true; break; }
    }
  }

  if (residue.length === 0) {
    addStep("validate", "Clean state verified", "done");
    return true;
  }

  addStep("validate", `Residue found: ${residue.join(", ")}`, "warning");
  broadcast({ type: "validation", residue });

  // Safe to clear automatically: our own container and session files.
  await run(`docker compose -f "${path.join(ROOT, "docker-compose.yml")}" down -v --remove-orphans`, { cwd: ROOT, stream: true }).catch(() => {});
  for (const f of [".session_snapshot", ".session_snapshot.json", ".current_question", "question.pdf"]) {
    try { fs.unlinkSync(path.join(ROOT, f)); } catch (_) {}
  }

  if (credResidue) {
    state.validationLocked = true;
    addStep("validate", "Prior-candidate credentials detected — admin reset required before this machine is interview-ready", "warning");
    updateStatus("needs_reset");
    broadcast({ type: "validation_locked", residue });
    return false;
  }
  addStep("validate", "Interview residue cleared", "done");
  return true;
}

// Setup flow
async function setup() {
  updateStatus("setup");
  loadEnv();
  detectIDEs();
  deriveEditorAccess();
  resetProgress("setup");
  state.validationLocked = false;
  state.eventComplete = null;

  try {
    // Must run before captureSnapshot, which writes the .session_snapshot.json
    // that the residue check looks for.
    if (!(await validatePreInterview())) return; // held for admin reset
    setTarget(3, "setup");

    await captureSnapshot();
    setTarget(5, "setup");

    // Fetch early so the candidate can read while the container builds.
    if ((state.config.QUESTIONS_URL || "").trim()) fetchQuestion();

    addStep("docker", "Checking Docker", "running");
    await run("docker info");
    addStep("docker", "Docker running", "done");
    setTarget(10, "setup");

    addStep("devcontainer-cli", "Checking devcontainers CLI", "running");
    let devcontainerCmd = "devcontainer";
    try {
      await run("devcontainer --version");
    } catch (_) {
      const homeBin = path.join(process.env.HOME || process.env.USERPROFILE, ".devcontainers", "bin", "devcontainer");
      if (fs.existsSync(homeBin)) {
        devcontainerCmd = homeBin;
      } else {
        addStep("devcontainer-cli", "Installing devcontainers CLI", "running");
        await run("npm install -g @devcontainers/cli", { stream: true });
        try {
          devcontainerCmd = (await run(IS_WIN ? "where devcontainer" : "which devcontainer")).split("\n")[0].trim();
        } catch (_) {
          try {
            const npmPrefix = (await run("npm prefix -g")).trim();
            const candidate = IS_WIN ? path.join(npmPrefix, "devcontainer.cmd") : path.join(npmPrefix, "bin", "devcontainer");
            if (fs.existsSync(candidate)) devcontainerCmd = candidate;
          } catch (_) {}
        }
      }
    }
    addStep("devcontainer-cli", "devcontainers CLI ready", "done");
    setTarget(15, "setup");

    addStep("build", "Building container", "running");
    await run(`"${devcontainerCmd}" up --workspace-folder "${ROOT}" --remove-existing-container`, {
      stream: true, trackBuild: true, baseProgress: 15, weight: 60
    });
    addStep("build", "Container ready", "done");
    setTarget(90, "setup");

    if (state.config.ENABLE_TIMER === "true") startTimer();

    setTarget(100, "setup");
    updateStatus("ready");
  } catch (err) {
    state.error = err.message;
    updateStatus("error");
  }
}

// Timer
let timerInterval = null;
let workspaceWatch = null;
let lastActivity = Date.now();
function recordActivity() { lastActivity = Date.now(); }
function idleThresholdSecs() {
  const mins = parseInt(state.config.INACTIVITY_TIMEOUT_MINUTES, 10);
  return Number.isFinite(mins) && mins > 0 ? mins * 60 : 120;
}

// Coding happens in the container, not the dashboard tab, so we treat fresh
// /workspaces file activity (not tab heartbeats) as "active".
function startWorkspaceWatch() {
  workspaceWatch = setInterval(() => {
    run(`docker compose exec -T interview-env bash -c "find /workspaces -type f -newermt '-40 seconds' -printf . 2>/dev/null | wc -c"`, { cwd: ROOT })
      .then((out) => { if (parseInt(out.trim(), 10) > 0) recordActivity(); })
      .catch(() => {});
  }, 30000);
}

function startTimer() {
  const limitSecs = parseInt(state.config.TIME_LIMIT_MINUTES) * 60;
  lastActivity = Date.now();
  startWorkspaceWatch();
  state.timer = { start: Date.now(), active: 0, idle: 0, idleNow: false, limitSecs, action: state.config.TIMEOUT_ACTION, expired: false, notified: false };
  timerInterval = setInterval(() => {
    if (!state.timer) return;
    const elapsed = Math.floor((Date.now() - state.timer.start) / 1000);
    const quietSecs = (Date.now() - lastActivity) / 1000;
    state.timer.idleNow = quietSecs >= idleThresholdSecs();
    if (state.timer.idleNow) state.timer.idle += 1;
    state.timer.active = elapsed - state.timer.idle;
    broadcast({ type: "timer", ...state.timer });
    if (state.timer.active >= limitSecs && !state.timer.expired) {
      state.timer.expired = true;
      if (state.timer.action === "NOTIFY") {
        state.timer.notified = true;
        broadcast({ type: "timer_expired", action: "NOTIFY", message: "Time limit reached. Session still active." });
      } else if (state.timer.action === "LOCK") {
        broadcast({ type: "timer_expired", action: "LOCK", message: "Time limit reached. Workspace locked." });
        run(`docker compose exec -T interview-env bash -c "sudo chown -R root:root /workspaces && sudo chmod -R 555 /workspaces"`, { cwd: ROOT }).catch(() => {});
      } else if (state.timer.action === "WIPE") {
        broadcast({ type: "timer_expired", action: "WIPE", message: "Time limit reached. Initiating cleanup." });
        cleanup();
      }
    }
  }, 1000);
}

// Launch IDE
async function launchIDE(ideName) {
  const ide = state.ides.find((i) => i.name === ideName);
  if (!ide) throw new Error(`IDE not found: ${ideName}`);

  switch (ide.kind) {
    case "local": {
      // Attach the host editor to the dev container. --new-window forces a fresh
      // window; without it a running editor swallows the URI and nothing opens.
      const hexPath = Buffer.from(ROOT).toString("hex");
      const uri = `vscode-remote://dev-container+${hexPath}/workspaces`;
      const cmd = IS_WIN
        ? `start "" "${ide.path}" --new-window --folder-uri "${uri}"`
        : `"${ide.path}" --new-window --folder-uri "${uri}" &`;
      exec(cmd, (err) => {
        if (err) broadcast({ type: "log", line: `[launch] ${ideName} failed: ${err.message}` });
      });
      return { launched: ideName };
    }

    case "url":
      return { launched: ideName, url: ide.url };

    case "instruction":
      return { launched: ideName, instruction: ide.instruction };

    default:
      throw new Error(`Unknown IDE kind: ${ide.kind}`);
  }
}

// Open a native terminal window running `inner` (bash syntax on macOS/Linux,
// PowerShell on Windows). `manual` is the copy/paste command returned to the UI
// as a fallback when no terminal could be launched.
function spawnTerminal(inner, manual) {
  manual = manual || inner;
  return new Promise((resolve) => {
    const ok = () => resolve({ ok: true });
    const fail = (reason) => resolve({ ok: false, reason, command: manual });

    // Write the command to a temp script and launch the terminal against the
    // script path. This avoids nesting the (arbitrary) command inside osascript
    // / shell quoting, which is what made most "Run in terminal" buttons fail.
    const stamp = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
    let scriptPath;
    try {
      if (IS_WIN) {
        scriptPath = path.join(os.tmpdir(), "shellport-fix-" + stamp + ".ps1");
        const body =
          "Set-Location -LiteralPath '" + ROOT.replace(/'/g, "''") + "'\n" +
          inner + "\n" +
          "Write-Host ''\n" +
          "Write-Host '[ShellPort] Done — this window can be closed.'\n";
        fs.writeFileSync(scriptPath, body);
      } else {
        scriptPath = path.join(os.tmpdir(), "shellport-fix-" + stamp + ".sh");
        const body =
          "#!/usr/bin/env bash\n" +
          'cd "' + ROOT + '" 2>/dev/null\n' +
          inner + "\n" +
          'echo\n' +
          'echo "[ShellPort] Done — this window can be closed."\n' +
          "exec bash -l\n";
        fs.writeFileSync(scriptPath, body, { mode: 0o700 });
      }
    } catch (e) {
      return fail("Could not stage terminal command: " + e.message);
    }

    if (process.platform === "darwin") {
      const hasITerm = fs.existsSync("/Applications/iTerm.app");
      // scriptPath is an alphanumeric temp path — safe to embed unquoted-ish.
      const appCmd = hasITerm
        ? "osascript -e 'tell application \"iTerm\" to create window with default profile command \"bash " + scriptPath + "\"' -e 'tell application \"iTerm\" to activate'"
        : "osascript -e 'tell application \"Terminal\" to do script \"bash " + scriptPath + "\"' -e 'tell application \"Terminal\" to activate'";
      run(appCmd).then(ok).catch(() => fail("Could not open Terminal"));
    } else if (IS_WIN) {
      const wtCmd = "wt -d \"" + ROOT + "\" powershell -NoExit -ExecutionPolicy Bypass -File \"" + scriptPath + "\"";
      const fallback = "start powershell -NoExit -ExecutionPolicy Bypass -File \"" + scriptPath + "\"";
      run(wtCmd).then(ok).catch(() => run(fallback).then(ok).catch(() => fail("No terminal found")));
    } else {
      const emus = ["gnome-terminal", "konsole", "xterm", "x-terminal-emulator"];
      const found = emus.find((e) => findBin([], [e]));
      if (!found) return fail("No terminal emulator found");
      const cmd = found === "gnome-terminal"
        ? "gnome-terminal -- bash " + scriptPath
        : found + " -e bash " + scriptPath;
      run(cmd).then(ok).catch(() => fail("Could not open terminal"));
    }
  });
}
function openTerminal() {
  const inner = "cd \"" + ROOT + "\" && docker compose exec interview-env bash";
  const manual = "cd " + ROOT + " && docker compose exec interview-env bash";
  return spawnTerminal(inner, manual);
}

// Server-owned troubleshooting / manual commands, resolved per-platform so the
// command shown in the UI is exactly the one /api/run-fix executes. Only ids in
// this list can ever be run — the client sends an id, never a command string.
// IMPORTANT: teardown is ShellPort-scoped (compose down -v). No host-wide
// `docker system prune` — that would destroy unrelated Docker projects and, on a
// candidate's own machine, damage their computer.
function buildFixes() {
  const q = (p) => '"' + p + '"';
  const R = ROOT;
  if (IS_WIN) {
    const cd = "Set-Location " + q(R) + "; ";
    const trouble = [
      { id: "t-docker", label: "Docker not running", cause: "cannot connect to the Docker engine", run: true, cmd: "Start-Process 'Docker Desktop'" },
      { id: "t-node", label: "Node.js not found", cause: "'node' is not recognized", run: false, cmd: "Install the LTS build from https://nodejs.org, then re-run the installer." },
      { id: "t-restart", label: "Dashboard won't open", cause: "localhost:3000 blank or refused", run: true, cmd: "Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }; Set-Location " + q(R + "\\app") + "; Start-Process node -ArgumentList 'server.js' -WindowStyle Hidden" },
      { id: "t-port", label: "Port 3000 already in use", cause: "EADDRINUSE :3000", run: true, cmd: "Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }" },
      { id: "t-ext", label: "IDE won't enter the container", cause: "no Dev Container badge in the editor", run: true, cmd: "code --install-extension ms-vscode-remote.remote-containers" },
      { id: "t-perm", label: "Permission denied in /workspaces", cause: "cannot write files in the editor", run: true, cmd: cd + "docker compose exec interview-env sudo chown -R vscode:vscode /workspaces" },
      { id: "t-build", label: "Build hangs or fails on a layer", cause: "stuck pulling or building", run: true, cmd: cd + "docker compose build --no-cache" },
    ];
    const manual = [
      { id: "m-up", label: "Start the environment", cause: "", run: true, cmd: cd + "docker compose up -d --build" },
      { id: "m-shell", label: "Open a shell in the container", cause: "", run: true, cmd: cd + "docker compose exec interview-env bash" },
      { id: "m-editor", label: "Or open it in your editor", cause: "then: Reopen in Container", run: true, cmd: "code " + q(R) },
      { id: "m-down", label: "Tear everything down", cause: "ShellPort's container and volume only", run: true, cmd: cd + "docker compose down -v --remove-orphans" },
      { id: "m-remove", label: "Remove ShellPort entirely", cause: "", run: true, cmd: "Remove-Item -Recurse -Force " + q(R) },
    ];
    const emergency = { id: "emergency", label: "Force a full rebuild", run: true, cmd: cd + "docker compose down -v --remove-orphans; docker compose up -d --build" };
    return { trouble, manual, emergency };
  }
  // macOS / Linux (bash)
  const dockerStart = process.platform === "darwin"
    ? "open -a OrbStack 2>/dev/null || open -a Docker"
    : "systemctl --user start docker 2>/dev/null || sudo systemctl start docker";
  const cd = "cd " + q(R) + " && ";
  const trouble = [
    { id: "t-docker", label: "Docker not running", cause: "ECONNREFUSED · cannot connect to docker.sock", run: true, cmd: dockerStart },
    { id: "t-node", label: "Node.js not found", cause: "command not found: node", run: false, cmd: "Install the LTS build from https://nodejs.org, then re-run the installer." },
    { id: "t-restart", label: "Dashboard won't open", cause: "localhost:3000 blank or refused", run: true, cmd: "pkill -f server.js; lsof -ti:3000 | xargs kill -9 2>/dev/null; cd " + q(R + "/app") + " && node server.js & disown" },
    { id: "t-port", label: "Port 3000 already in use", cause: "EADDRINUSE :3000", run: true, cmd: "lsof -ti:3000 | xargs kill -9" },
    { id: "t-ext", label: "IDE won't enter the container", cause: "no Dev Container badge in the editor", run: true, cmd: "code --install-extension ms-vscode-remote.remote-containers" },
    { id: "t-perm", label: "Permission denied in /workspaces", cause: "cannot write files in the editor", run: true, cmd: cd + "docker compose exec interview-env sudo chown -R vscode:vscode /workspaces" },
    { id: "t-build", label: "Build hangs or fails on a layer", cause: "stuck pulling or building", run: true, cmd: cd + "docker compose build --no-cache" },
  ];
  const manual = [
    { id: "m-up", label: "Start the environment", cause: "", run: true, cmd: cd + "docker compose up -d --build" },
    { id: "m-shell", label: "Open a shell in the container", cause: "", run: true, cmd: cd + "docker compose exec interview-env bash" },
    { id: "m-editor", label: "Or open it in your editor", cause: "then: Reopen in Container", run: true, cmd: "code " + q(R) },
    { id: "m-down", label: "Tear everything down", cause: "ShellPort's container and volume only", run: true, cmd: cd + "docker compose down -v --remove-orphans" },
    { id: "m-remove", label: "Remove ShellPort entirely", cause: "", run: true, cmd: "rm -rf " + q(R) },
  ];
  const emergency = { id: "emergency", label: "Force a full rebuild", run: true, cmd: cd + "docker compose down -v --remove-orphans && docker compose up -d --build" };
  return { trouble, manual, emergency };
}
const FIXES = buildFixes();
state.fixes = FIXES;
function findFix(id) {
  return FIXES.trouble.concat(FIXES.manual, [FIXES.emergency]).find((f) => f.id === id && f.run);
}

// Cleanup — container teardown, safe on any machine. With removeInstall (the
// candidate "Reset & remove ShellPort" action) it also deletes ShellPort's own
// install directory and stops the server — BYOD only.
async function cleanup(removeInstall = false) {
  if (state.status === "cleanup" || state.status === "done") return;
  updateStatus("cleanup");
  resetProgress("cleanup");
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  if (workspaceWatch) { clearInterval(workspaceWatch); workspaceWatch = null; }
  const config = state.config;
  setTarget(15, "cleanup");

  if (config.ENABLE_TELEMETRY === "true") {
    addStep("telemetry", "Exporting telemetry", "running");
    try {
      const telemetry = {};
      telemetry.shellHistory = await run(`docker compose exec -T interview-env bash -c "cat /home/vscode/.bash_history 2>/dev/null || echo ''"`, { cwd: ROOT }).catch(() => "");
      telemetry.claudeUsage = await run(`docker compose exec -T interview-env bash -c "cat /home/vscode/.claude/history.json 2>/dev/null || echo ''"`, { cwd: ROOT }).catch(() => "");
      telemetry.gitLog = await run(`docker compose exec -T interview-env bash -c "cd /workspaces && git log --oneline --all 2>/dev/null || echo ''"`, { cwd: ROOT }).catch(() => "");
      telemetry.files = await run(`docker compose exec -T interview-env bash -c "find /workspaces -type f 2>/dev/null | sort"`, { cwd: ROOT }).catch(() => "");
      state.telemetry = telemetry;
      broadcast({ type: "telemetry", data: telemetry });
      addStep("telemetry", "Telemetry exported", "done");
    } catch (_) { addStep("telemetry", "Telemetry failed", "error"); }
  }
  setTarget(30, "cleanup");

  addStep("kill", "Stopping IDE processes", "running");
  try {
    if (IS_WIN) await run(`Get-Process -Name Code,Cursor,"Cursor Helper",Windsurf,"Windsurf Helper" -EA SilentlyContinue | Stop-Process -Force`).catch(() => {});
    else for (const app of ["Visual Studio Code", "Code", "Cursor", "Cursor Helper", "Windsurf", "Windsurf Helper"]) await run(`killall "${app}" 2>/dev/null || true`).catch(() => {});
  } catch (_) {}
  addStep("kill", "IDE processes stopped", "done");
  setTarget(45, "cleanup");

  addStep("docker-clean", "Removing container and volumes", "running");
  try {
    // Scoped to ShellPort only; never a global prune (BYOD safety).
    await run(`docker compose -f "${path.join(ROOT, "docker-compose.yml")}" down -v --remove-orphans`, { stream: true }).catch(() => {});
    setTarget(75, "cleanup");
  } catch (_) {}
  addStep("docker-clean", "Docker cleaned", "done");
  setTarget(85, "cleanup");

  addStep("verify", "Verifying cleanup", "running");
  const issues = [];
  try {
    const snap = state.snapshot;
    if (snap) {
      if (IS_WIN) {
        const cur = await run(`(cmdkey /list 2>$null | Select-String 'Target:').Count`).catch(() => "0");
        if (parseInt(cur) > parseInt(snap.credentials.cmdkeyCount || "0"))
          issues.push(`New credentials detected (was ${snap.credentials.cmdkeyCount}, now ${cur})`);
      } else {
        const cur = keychainFingerprint();
        if (snap.credentials.keychainFingerprint && cur && cur !== snap.credentials.keychainFingerprint)
          issues.push("Keychain changed since pre-install snapshot — review for new credentials");
      }
    }
  } catch (_) {}
  state.cleanupIssues = issues;
  if (issues.length > 0) {
    addStep("verify", `Issues found: ${issues.length}`, "warning");
    broadcast({ type: "cleanup_issues", issues });
  } else {
    addStep("verify", "Clean. No residue detected.", "done");
  }
  try { fs.unlinkSync(path.join(ROOT, ".session_snapshot.json")); } catch (_) {}
  setTarget(100, "cleanup");
  updateStatus("done");
  broadcast({ type: "cleanup_complete", issues });

  // Candidate "Reset & remove ShellPort" (BYOD only): ShellPort's container,
  // volume and session files are gone — now remove the install directory itself
  // and stop the server. We only ever touch ShellPort's own footprint, never
  // anything the candidate did outside the app (browser sessions, Google
  // sign-ins, downloaded docs) and never on a managed DO station.
  if (removeInstall && !ADMIN_MODE) {
    if (removeInstallDir()) {
      broadcast({ type: "log", line: "[remove] ShellPort removed. Stopping server." });
      setTimeout(() => process.exit(0), 500);
    }
  }
}

// Clear per-session state before a reset / recycle / end-event.
function resetSessionState(status) {
  state.status = status;
  state.steps = [];
  state.timer = null;
  state.question = null;
  state.questionHtml = null;
  state.questionPdf = null;
  state.questionLoading = false;
  state.questionVisible = true;
  state.error = null;
  state.cleanupIssues = null;
  state.telemetry = null;
  state.eventComplete = null;
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  if (workspaceWatch) { clearInterval(workspaceWatch); workspaceWatch = null; }
  broadcast({ type: "status", status });
  resetProgress("setup");
}

// Host teardown. aggressive=true is the full DO-station scrub (credentials,
// keychain, browser/IDE data, history, trash). aggressive=false is BYOD-safe:
// ShellPort's own footprint only — "we cannot damage their computer".
// Returns the count of residual issues found during verification.
async function hostScrub(aggressive = true) {
  const home = process.env.HOME || process.env.USERPROFILE;

  // ── Phase 1: Kill IDEs (browsers stay open so admin can watch) ──
  addStep("phase1", "Phase 1: Kill — stopping IDEs", "running");
  setTarget(5, "setup");
  const ideTargets = IS_WIN
    ? ["Code", "Cursor", "Windsurf"]
    : ["Visual Studio Code", "Code", "Cursor", "Cursor Helper", "Windsurf", "Windsurf Helper", "Claude"];
  for (const app of ideTargets) {
    if (IS_WIN) await run(`Stop-Process -Name "${app}" -Force -ErrorAction SilentlyContinue`).catch(() => {});
    else await run(`killall "${app}" 2>/dev/null || true`).catch(() => {});
  }
  await new Promise(r => setTimeout(r, 1000));
  addStep("phase1", "Phase 1: Kill — complete", "done");
  setTarget(12, "setup");

  // ── Phase 2: Docker wipe ──
  addStep("phase2", aggressive ? "Phase 2: Docker — removing containers and volumes" : "Phase 2: Docker — removing ShellPort container and volumes", "running");
  setTarget(14, "setup");
  try {
    await run(`docker compose -f "${path.join(ROOT, "docker-compose.yml")}" down -v --remove-orphans`, { stream: true }).catch(() => {});
    if (aggressive) {
      setTarget(20, "setup");
      const containers = await run("docker ps -aq").catch(() => "");
      if (containers.trim()) {
        await run(`docker stop ${containers.trim().split("\n").join(" ")}`).catch(() => {});
        await run(`docker rm -f ${containers.trim().split("\n").join(" ")}`).catch(() => {});
      }
      const volumes = await run("docker volume ls -q").catch(() => "");
      if (volumes.trim()) await run(`docker volume rm ${volumes.trim().split("\n").join(" ")}`).catch(() => {});
      await run("docker system prune -af --volumes", { stream: true }).catch(() => {});
    }
  } catch (_) {}
  addStep("phase2", "Phase 2: Docker — complete", "done");
  setTarget(30, "setup");

  // BYOD stops here: only ShellPort's own session files are removed below.
  if (!aggressive) {
    addStep("phase-byod", "Removing ShellPort session files", "running");
    setTarget(70, "setup");
    for (const f of [".session_snapshot", ".session_snapshot.json", ".current_question", "question.pdf"]) {
      try { fs.unlinkSync(path.join(ROOT, f)); } catch (_) {}
    }
    try { fs.rmSync(path.join(ROOT, ".timer"), { recursive: true, force: true }); } catch (_) {}
    addStep("phase-byod", "ShellPort session files removed", "done");
    setTarget(82, "setup");

    addStep("verify", "Verify — checking ShellPort footprint", "running");
    setTarget(88, "setup");
    let byodFails = 0;
    const ours = await run(`docker compose -f "${path.join(ROOT, "docker-compose.yml")}" ps -q`, { cwd: ROOT }).catch(() => "");
    if (ours.trim()) { byodFails++; broadcast({ type: "log", line: "[verify] ShellPort container still exists" }); }
    if (byodFails === 0) addStep("verify", "Verify — ShellPort footprint removed", "done");
    else addStep("verify", `Verify — ${byodFails} issue(s) found`, "warning");
    setTarget(90, "setup");
    return byodFails;
  }

  // ── Phase 3: CLI/agent credential scrub ──
  addStep("phase3", "Phase 3: CLI — scrubbing credentials", "running");
  setTarget(32, "setup");
  await run("gh auth logout --hostname github.com 2>/dev/null || true").catch(() => {});
  await run("doctl auth remove --context default 2>/dev/null || true").catch(() => {});
  const credDirs = [
    ".config/gh", ".config/doctl", ".ssh", ".gitconfig", ".git-credentials", ".netrc",
    ".claude", ".config/claude", ".config/Claude", ".anthropic", ".config/anthropic",
    ".aider", ".config/aider", ".codeium", ".config/codeium",
    ".continue", ".config/continue", ".copilot", ".config/copilot"
  ];
  for (const dir of credDirs) {
    const full = path.join(home, dir);
    if (fs.existsSync(full)) { try { fs.rmSync(full, { recursive: true, force: true }); } catch (_) {} }
  }
  // Clear tokens from .env
  const envPath = path.join(ROOT, ".env");
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, "utf8");
    envContent = envContent.replace(/^GH_TOKEN=.*/m, 'GH_TOKEN=""');
    fs.writeFileSync(envPath, envContent);
  }
  addStep("phase3", "Phase 3: CLI — complete", "done");
  setTarget(40, "setup");

  // ── Phase 4: Keychain / credential manager purge ──
  addStep("phase4", "Phase 4: Keychain — purging credential entries", "running");
  setTarget(42, "setup");
  if (IS_WIN) {
    const winTargets = ["git:https://github.com", "github.com", "docker", "vscode", "cursor"];
    for (const t of winTargets) await run(`cmdkey /delete:${t} 2>$null`).catch(() => {});
  } else {
    const keychainServices = [
      "gh:github.com", "github.com", "api.github.com",
      "vscodevscode.github-authentication", "cursorcursor.github-authentication",
      "cursor.github-authentication", "vscode.github-authentication",
      "Chrome Safe Storage", "Chromium Safe Storage", "Microsoft Edge Safe Storage",
      "Brave Safe Storage", "Arc Safe Storage", "Firefox Safe Storage",
      "docker-credential-osxkeychain", "Docker Credentials",
      "Claude Safe Storage", "claude", "anthropic", "doctl"
    ];
    for (const svc of keychainServices) {
      await run(`security delete-generic-password -s "${svc}" 2>/dev/null || true`).catch(() => {});
      await run(`security delete-generic-password -l "${svc}" 2>/dev/null || true`).catch(() => {});
      await run(`security delete-internet-password -s "${svc}" 2>/dev/null || true`).catch(() => {});
      await run(`security delete-internet-password -l "${svc}" 2>/dev/null || true`).catch(() => {});
    }
  }
  addStep("phase4", "Phase 4: Keychain — complete", "done");
  setTarget(55, "setup");

  // ── Phase 5: Kill browsers, wipe browser + IDE data, reopen dashboard ──
  addStep("phase5", "Phase 5: Deep clean — killing browsers", "running");
  setTarget(57, "setup");
  const browserTargets = IS_WIN
    ? ["chrome", "msedge", "firefox", "brave"]
    : ["Google Chrome", "Safari", "Firefox", "Microsoft Edge", "Brave Browser", "Arc"];
  for (const app of browserTargets) {
    if (IS_WIN) await run(`Stop-Process -Name "${app}" -Force -ErrorAction SilentlyContinue`).catch(() => {});
    else await run(`killall "${app}" 2>/dev/null || true`).catch(() => {});
  }
  await new Promise(r => setTimeout(r, 1500));
  addStep("phase5", "Phase 5: Deep clean — wiping browser and IDE data", "running");
  setTarget(60, "setup");
  const cleanTargets = IS_WIN ? [
    path.join(home, "AppData/Local/Google/Chrome"),
    path.join(home, "AppData/Local/Microsoft/Edge"),
    path.join(home, "AppData/Local/BraveSoftware"),
    path.join(home, "AppData/Roaming/Mozilla/Firefox"),
    path.join(home, "AppData/Roaming/Code"),
    path.join(home, "AppData/Roaming/Cursor"),
    path.join(home, "AppData/Roaming/Windsurf"),
    path.join(home, "AppData/Roaming/Claude"),
  ] : [
    `${home}/Library/Application Support/Google/Chrome`,
    `${home}/Library/Caches/com.google.Chrome`,
    `${home}/Library/Saved Application State/com.google.Chrome.savedState`,
    `${home}/Library/Application Support/Microsoft Edge`,
    `${home}/Library/Caches/Microsoft Edge`,
    `${home}/Library/Application Support/BraveSoftware/Brave-Browser`,
    `${home}/Library/Caches/BraveSoftware`,
    `${home}/Library/Application Support/Arc`,
    `${home}/Library/Caches/Arc`,
    `${home}/Library/Application Support/Firefox`,
    `${home}/Library/Caches/Firefox`,
    `${home}/Library/Safari/History.db`, `${home}/Library/Safari/History.db-wal`,
    `${home}/Library/Safari/History.db-shm`, `${home}/Library/Safari/LastSession.plist`,
    `${home}/Library/Safari/RecentlyClosedTabs.plist`, `${home}/Library/Safari/Downloads.plist`,
    `${home}/Library/Containers/com.apple.Safari`,
    `${home}/Library/Preferences/com.apple.Safari.plist`,
    `${home}/Library/WebKit`,
    `${home}/Library/Application Support/Code`,
    `${home}/Library/Caches/com.microsoft.VSCode`,
    `${home}/Library/Saved Application State/com.microsoft.VSCode.savedState`,
    `${home}/Library/Application Support/Cursor`,
    `${home}/Library/Caches/Cursor`,
    `${home}/Library/Saved Application State/com.todesktop.230313mzl4w4u92.savedState`,
    `${home}/Library/Application Support/Windsurf`,
    `${home}/Library/Application Support/Claude`,
    `${home}/Library/Caches/Claude`,
    `${home}/Library/Saved Application State/com.anthropic.claudefordesktop.savedState`,
  ];
  for (const target of cleanTargets) {
    if (fs.existsSync(target)) { try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) {} }
  }
  addStep("phase5", "Phase 5: Deep clean — complete", "done");
  setTarget(70, "setup");

  // Reopen the dashboard so admin can watch remaining phases
  if (IS_WIN) exec('start http://localhost:' + PORT);
  else exec('open http://localhost:' + PORT);
  await new Promise(r => setTimeout(r, 2000));

  // ── Phase 6: Clear history and trash ──
  addStep("phase6", "Phase 6: Rebuild — clearing history and trash", "running");
  setTarget(72, "setup");
  if (IS_WIN) {
    await run(`Clear-RecycleBin -Force -ErrorAction SilentlyContinue`).catch(() => {});
  } else {
    await run(`osascript -e 'tell application "Finder" to empty trash' 2>/dev/null || rm -rf "${home}/.Trash/"*`).catch(() => {});
  }
  const histFiles = [".zsh_history", ".bash_history", ".node_repl_history", ".python_history", ".lesshst", ".viminfo"];
  for (const h of histFiles) {
    const hp = path.join(home, h);
    if (fs.existsSync(hp)) { try { fs.writeFileSync(hp, ""); } catch (_) {} }
  }
  for (const f of [".session_snapshot", ".session_snapshot.json", ".current_question"]) {
    try { fs.unlinkSync(path.join(ROOT, f)); } catch (_) {}
  }
  try { fs.rmSync(path.join(ROOT, ".timer"), { recursive: true, force: true }); } catch (_) {}
  addStep("phase6", "Phase 6: Rebuild — complete", "done");
  setTarget(80, "setup");

  // ── Phase 7: Verify ──
  addStep("phase7", "Phase 7: Verify — checking for residue", "running");
  setTarget(82, "setup");
  let verifyFails = 0;
  const verifyDirs = IS_WIN ? [
    path.join(home, "AppData/Local/Google/Chrome"),
    path.join(home, "AppData/Roaming/Code"),
  ] : [
    `${home}/.config/gh`, `${home}/.ssh`, `${home}/.gitconfig`, `${home}/.git-credentials`,
    `${home}/.claude`, `${home}/.anthropic`,
    `${home}/Library/Application Support/Google/Chrome`,
    `${home}/Library/Application Support/Microsoft Edge`,
    `${home}/Library/Application Support/Firefox`,
    `${home}/Library/Application Support/Code`,
    `${home}/Library/Application Support/Cursor`,
  ];
  for (const d of verifyDirs) {
    if (fs.existsSync(d)) { verifyFails++; broadcast({ type: "log", line: `[verify] STILL EXISTS: ${d}` }); }
  }
  const dockerContainers = await run("docker ps -aq").catch(() => "");
  if (dockerContainers.trim()) { verifyFails++; broadcast({ type: "log", line: "[verify] Docker containers still exist" }); }
  const dockerVolumes = await run("docker volume ls -q").catch(() => "");
  if (dockerVolumes.trim()) { verifyFails++; broadcast({ type: "log", line: "[verify] Docker volumes still exist" }); }

  if (verifyFails === 0) {
    addStep("phase7", "Phase 7: Verify — passed. Zero residue.", "done");
  } else {
    addStep("phase7", `Phase 7: Verify — ${verifyFails} issue(s) found`, "warning");
  }
  setTarget(88, "setup");

  try { fs.writeFileSync(path.join(ROOT, ".last_station_reset"), new Date().toISOString()); } catch (_) {}
  addStep("reset-done", "Host teardown complete", "done");
  setTarget(90, "setup");
  return verifyFails;
}

// Recycle (DO station): scrub the host, then rebuild into Ready with a new question.
async function recycle() {
  if (!ADMIN_MODE) return;
  if (state.status === "resetting") return;
  resetSessionState("resetting");
  await hostScrub(true);
  state.steps = [];
  broadcast({ type: "clear_steps" });
  resetProgress("setup");
  await setup(); // → ready with a new question
}

// End event: tear down for storage. DO gets the full scrub + shutdown prompt;
// BYOD gets the safe scrub + an uninstall command.
async function endEvent() {
  if (state.status === "ending" || state.status === "event_complete") return;
  resetSessionState("ending");
  await hostScrub(ADMIN_MODE);
  setTarget(100, "setup");
  state.status = "event_complete";
  if (ADMIN_MODE) {
    state.eventComplete = {
      mode: "do",
      canShutdown: true,
      message: "Interview event complete. This machine is clean and prepped for storage.",
    };
  } else {
    state.eventComplete = {
      mode: "byod",
      canShutdown: false,
      uninstall: uninstallCommand(),
      message: "ShellPort has reset your machine to its pre-install state. Run the command below to remove ShellPort itself.",
    };
  }
  broadcast({ type: "event_complete", info: state.eventComplete });
  broadcast({ type: "status", status: "event_complete" });
}

// Config keys safe to expose to any client (incl. a candidate on a DO station).
// Question sources (QUESTIONS_URL/QUESTION_ROW/QUESTION_TAB) and secrets
// (QUESTION_WEBHOOK, PROJECT_NAME) are withheld so a candidate cannot read the
// source off the wire and reach questions other than the one assigned to them.
const WIRE_CONFIG_KEYS = [
  "ENABLE_TIMER", "TIMEOUT_ACTION", "TIME_LIMIT_MINUTES", "INACTIVITY_TIMEOUT_MINUTES",
  "ENABLE_TELEMETRY", "MACHINE_LABEL", "ENABLED_EDITORS", "TERMINAL_ACCESS", "QUESTION_DELIVERY",
];
function wireConfig(cfg) {
  const out = {};
  for (const k of WIRE_CONFIG_KEYS) if (k in (cfg || {})) out[k] = cfg[k];
  return out;
}
function wireState() {
  const { telemetry, snapshot, config, ...rest } = state;
  return { ...rest, config: wireConfig(config) };
}

// HTTP server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(wireState()));
    return;
  }
  if (url.pathname === "/api/activity" && req.method === "POST") {
    recordActivity();
    res.writeHead(204);
    res.end();
    return;
  }
  // Appearance preset — GET is open (every view applies it); POST is admin-gated.
  if (url.pathname === "/api/appearance") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state.appearance));
      return;
    }
    if (req.method === "POST") {
      if (!requireAuth(req, res)) return;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const incoming = JSON.parse(body);
          const next = { ...state.appearance };
          for (const k of Object.keys(APPEARANCE_DEFAULTS)) {
            if (APPEARANCE_ENUMS[k].includes(incoming[k])) next[k] = incoming[k];
          }
          fs.writeFileSync(APPEARANCE_FILE, JSON.stringify(next, null, 2));
          state.appearance = next;
          broadcast({ type: "appearance", appearance: next });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ saved: true, appearance: next }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }
  // Admin unlock — verifies the OS user password and mints a privileged token.
  // Managed stations only; candidate BYOD has no admin surface.
  if (url.pathname === "/api/admin-unlock" && req.method === "POST") {
    if (!ADMIN_MODE) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Admin features are unavailable on this machine." }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let password = "";
      try { password = (JSON.parse(body || "{}").password) || ""; } catch (_) {}
      verifyOsPassword(password).then((ok) => {
        if (ok) {
          const token = issueToken();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, token, expiresIn: TOKEN_TTL }));
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Incorrect password." }));
        }
      });
    });
    return;
  }
  // Read-only build/reset log. Open: it carries operation lines (no secrets) and
  // already streams to every client via the WS `log`/`step` messages.
  if (url.pathname === "/api/build-log" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ entries: buildLog }));
    return;
  }
  // Open the native OS terminal into the container shell. Gated by Terminal access.
  if (url.pathname === "/api/open-terminal" && req.method === "POST") {
    if (!state.terminalEnabled) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "Terminal access is disabled." }));
      return;
    }
    openTerminal().then((r) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r));
    });
    return;
  }
  // Run a troubleshooting / manual-fallback command in a native terminal. The
  // client sends only a known fix id; the command itself is server-defined.
  if (url.pathname === "/api/run-fix" && req.method === "POST") {
    // Troubleshooting is candidate-usable on BYOD (it's their own machine), but on
    // a managed DO station the fixes (incl. teardown/remove) are admin-gated so a
    // candidate session can't reach them.
    if (ADMIN_MODE && !requireAuth(req, res)) return;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let id = "";
      try { id = (JSON.parse(body || "{}").id || "").toString(); } catch (_) {}
      const fix = findFix(id);
      if (!fix) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "Unknown command." }));
        return;
      }
      spawnTerminal(fix.cmd, fix.cmd).then((r) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      });
    });
    return;
  }
  // Admin challenge — returns a short-lived bearer token for privileged routes.
  if (url.pathname === "/api/auth" && req.method === "POST") {
    authenticateAdmin().then((ok) => {
      if (ok) {
        const token = issueToken();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ token, expiresIn: TOKEN_TTL }));
      } else {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Admin authentication failed or cancelled" }));
      }
    }).catch(() => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Admin authentication failed" }));
    });
    return;
  }
  if (url.pathname === "/api/question.pdf" && req.method === "GET") {
    const pdfPath = path.join(ROOT, "question.pdf");
    fs.readFile(pdfPath, (err, data) => {
      if (err) { res.writeHead(404); res.end("Not found"); return; }
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=\"question.pdf\"", "Cache-Control": "no-store, must-revalidate", "Pragma": "no-cache" });
      res.end(data);
    });
    return;
  }
  if (url.pathname === "/api/launch" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { ide } = JSON.parse(body);
        const result = await launchIDE(ide);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  if (url.pathname === "/api/cleanup" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let remove = false;
      try { remove = !!JSON.parse(body || "{}").remove; } catch (_) {}
      cleanup(remove);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ started: true }));
    });
    return;
  }
  // Recycle for the next candidate (DO station).
  if (url.pathname === "/api/reset" && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    if (!ADMIN_MODE) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Recycle is only available on DO interview stations. Use End Event on BYOD." }));
      return;
    }
    recycle();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ started: true }));
    return;
  }
  // End the interview event (tear down for storage / BYOD uninstall).
  if (url.pathname === "/api/end-event" && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    endEvent();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ started: true }));
    return;
  }
  // Shut the machine down after an end-event (DO station).
  if (url.pathname === "/api/shutdown" && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ started: true }));
    shutdownMachine();
    return;
  }
  if (url.pathname === "/api/reroll" && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    state.question = null;
    state.questionHtml = null;
    state.questionPdf = null;
    state.questionLoading = true;
    broadcast({ type: "question_loading" });
    fetchQuestion();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ started: true }));
    return;
  }
  if (url.pathname === "/api/question-toggle" && req.method === "POST") {
    state.questionVisible = !state.questionVisible;
    broadcast({ type: "question_visibility", visible: state.questionVisible });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ visible: state.questionVisible }));
    return;
  }
  // Admin-only read-back of the question SOURCE fields. These are withheld from
  // the wired config (so candidates can't read them), but an authenticated admin
  // needs the current value to edit the link in Settings.
  if (url.pathname === "/api/admin/config" && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      QUESTIONS_URL: state.config.QUESTIONS_URL || "",
      QUESTION_ROW: state.config.QUESTION_ROW || "",
      QUESTION_TAB: state.config.QUESTION_TAB || "",
    }));
    return;
  }

  if (url.pathname === "/api/config" && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const patch = JSON.parse(body);
        // Merge into the server's full config so withheld secrets (QUESTIONS_URL,
        // QUESTION_WEBHOOK, …) survive a save that the client never sees.
        const merged = { ...state.config, ...patch };
        const escVal = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "").replace(/\n/g, "\\n");
        const envLines = Object.entries(merged).map(([k, v]) => `${k}="${escVal(v)}"`).join("\n");
        fs.writeFileSync(path.join(ROOT, ".env"), envLines);
        try { fs.chmodSync(path.join(ROOT, ".env"), 0o600); } catch (_) {}
        const oldTimer = state.config.ENABLE_TIMER;
        const oldSource = `${state.config.QUESTIONS_URL}|${state.config.QUESTION_ROW}|${state.config.QUESTION_TAB}`;
        loadEnv();
        deriveEditorAccess();
        if (state.config.ENABLE_TIMER === "true" && oldTimer !== "true" && state.status === "ready") startTimer();
        if (state.config.ENABLE_TIMER !== "true" && timerInterval) {
          clearInterval(timerInterval); timerInterval = null; state.timer = null;
          if (workspaceWatch) { clearInterval(workspaceWatch); workspaceWatch = null; }
          broadcast({ type: "timer_stopped" });
        }
        // If the admin changed the question source, reload the assigned question.
        const newSource = `${state.config.QUESTIONS_URL}|${state.config.QUESTION_ROW}|${state.config.QUESTION_TAB}`;
        if (newSource !== oldSource && (state.config.QUESTIONS_URL || "").trim()) fetchQuestion();
        broadcast({ type: "config", config: wireConfig(state.config) });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ saved: true, config: wireConfig(state.config) }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  const filePath = url.pathname === "/" ? path.join(__dirname, "index.html") : path.join(__dirname, url.pathname);
  const ext = path.extname(filePath);
  const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": types[ext] || "text/plain" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "init", state: wireState() }));
  ws.on("close", () => clients.delete(ws));
});

server.listen(PORT, () => {
  console.log(`ShellPort running at http://localhost:${PORT}`);
  setup();
});
