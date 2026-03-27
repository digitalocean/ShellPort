const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec, spawn } = require("child_process");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const ROOT = path.resolve(__dirname, "..");
const IS_WIN = process.platform === "win32";
const ADMIN_MODE = fs.existsSync(path.join(ROOT, "admin"));

let state = {
  status: "initializing",
  steps: [],
  config: {},
  ides: [],
  question: null,
  questionHtml: null,
  questionLoading: false,
  questionVisible: true,
  questionError: null,
  timer: null,
  snapshot: null,
  adminMode: ADMIN_MODE,
  error: null,
};

const clients = new Set();
function broadcast(msg) {
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
    ENABLE_ARCHIVE: "false", ENABLE_TELEMETRY: "false",
    PROJECT_NAME: "", DO_TOKEN: "", SPACES_BUCKET: "", SPACES_REGION: "nyc3",
    QUESTIONS_URL: "",
    QUESTION_ROW: "",
    QUESTION_WEBHOOK: "",
    MACHINE_LABEL: "",
  };
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
      line = line.trim();
      if (!line || line.startsWith("#")) return;
      const [k, ...rest] = line.split("=");
      if (k) config[k.trim()] = rest.join("=").trim().replace(/^["']|["']$/g, "");
    });
  }
  state.config = config;
  return config;
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

function detectIDEs() {
  const ides = [];
  if (IS_WIN) {
    [{ name: "VS Code", path: `${process.env.ProgramFiles}\\Microsoft VS Code\\bin\\code.cmd` },
     { name: "Cursor", path: `${process.env.LOCALAPPDATA}\\Programs\\cursor\\Cursor.exe` },
     { name: "Windsurf", path: `${process.env.LOCALAPPDATA}\\Programs\\windsurf\\Windsurf.exe` }
    ].forEach((ide) => { if (fs.existsSync(ide.path)) ides.push(ide); });
  } else {
    [{ name: "VS Code", path: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" },
     { name: "Cursor", path: "/Applications/Cursor.app/Contents/MacOS/Cursor" },
     { name: "Windsurf", path: "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf" }
    ].forEach((ide) => { if (fs.existsSync(ide.path)) ides.push(ide); });
  }
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
      snapshot.credentials.keychainCount = await run(`security dump-keychain 2>/dev/null | grep -c "keychain"`).catch(() => "0");
    }
  } catch (_) {}
  state.snapshot = snapshot;
  fs.writeFileSync(path.join(ROOT, ".session_snapshot.json"), JSON.stringify(snapshot, null, 2));
  addStep("snapshot", "Pre-install state captured", "done");
}

// Fetch interview question (always runs, not behind a toggle)
// QUESTION_ROW overrides random selection. Webhook fires either way.
async function fetchQuestion() {
  addStep("question", "Loading interview question", "running");
  state.questionLoading = true;
  broadcast({ type: "question_loading" });
  
  let url = (state.config.QUESTIONS_URL || "").trim();
  if (!url) {
    state.questionLoading = false;
    addStep("question", "No QUESTIONS_URL configured", "skipped");
    broadcast({ type: "question", html: null, text: null, error: "Set QUESTIONS_URL in .env" });
    return;
  }

  try {
    // Detect Google Sheets URL and convert to TSV export
    const sheetsMatch = url.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (sheetsMatch) {
      url = `https://docs.google.com/spreadsheets/d/${sheetsMatch[1]}/export?format=tsv`;
    }

    const raw = await run(`curl -fsSL -L "${url}" 2>/dev/null | head -5000`);
    if (!raw || raw.trim().length < 5) throw new Error("Empty response");

    // Parse as TSV lines, skip row 1 (header)
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
    const sheetRow = rowIndex + 2; // actual sheet row number

    // Fetch Google Doc as HTML if doc ID exists
    if (docId && docId.length > 10 && /^[a-zA-Z0-9_-]+$/.test(docId)) {
      addStep("question", "Loading formatted question", "running");
      const htmlRaw = await run(`curl -fsSL -L "https://docs.google.com/document/d/${docId}/export?format=html" 2>/dev/null`);
      
      if (htmlRaw && htmlRaw.includes("<body")) {
        let body = htmlRaw;
        const bodyMatch = htmlRaw.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        if (bodyMatch) body = bodyMatch[1];
        
        body = body
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/style="[^"]*"/gi, "")
          .replace(/class="[^"]*"/gi, "")
          .replace(/<span>/gi, "").replace(/<\/span>/gi, "")
          .replace(/<p><\/p>/gi, "")
          .replace(/<a[^>]*href="https?:\/\/www\.google\.com\/url\?q=([^&"]+)[^"]*"/gi, '<a href="$1"')
          .trim();

        state.question = title;
        state.questionHtml = body;
        state.questionLoading = false;
        addStep("question", `Assigned: ${title} (row ${sheetRow})`, "done");
        broadcast({ type: "question", html: body, text: title, error: null });
        broadcast({ type: "log", line: `[question] Assigned: ${title} (row ${sheetRow})` });
        fireQuestionWebhook(title, sheetRow);
        return;
      }
    }

    // No doc ID or doc fetch failed
    state.question = title;
    state.questionHtml = null;
    state.questionLoading = false;
    addStep("question", `Assigned: ${title} (row ${sheetRow})`, "done");
    broadcast({ type: "question", html: null, text: title, error: null });
    broadcast({ type: "log", line: `[question] Assigned: ${title} (row ${sheetRow})` });
    fireQuestionWebhook(title, sheetRow);

  } catch (err) {
    state.questionLoading = false;
    addStep("question", "Question unavailable", "skipped");
    broadcast({ type: "question", html: null, text: null, error: "Could not load question. Check QUESTIONS_URL in .env" });
  }
}

// Webhook notification — fires every time a question is assigned
async function fireQuestionWebhook(title, row) {
  const webhookUrl = (state.config.QUESTION_WEBHOOK || "").trim();
  if (!webhookUrl) return;

  const hostname = require("os").hostname();
  const serial = await getMachineSerial();
  const label = (state.config.MACHINE_LABEL || "").trim() || `${hostname} (${serial})`;
  const project = (state.config.PROJECT_NAME || "").trim() || "—";
  const mode = state.config.QUESTION_ROW ? "pre-assigned" : "random";
  const ts = new Date().toLocaleString("en-US", { timeZone: "America/Denver", hour12: true, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  const payload = JSON.stringify({
    text: `ShellPort: ${label} → ${title} (row ${row}, ${mode})`,
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
            `*Row:* ${row}  |  *Mode:* ${mode}`,
            `*Project:* ${project}`,
            `*Time:* ${ts}`,
          ].join("\n")
        }
      }
    ]
  });

  const cmd = `curl -fsSL -X POST -H "Content-Type: application/json" -d '${payload.replace(/'/g, "\\'")}' "${webhookUrl}" 2>/dev/null`;
  run(cmd).then(() => {
    broadcast({ type: "log", line: `[webhook] Sent: ${label} → ${title}` });
  }).catch(() => {
    broadcast({ type: "log", line: `[webhook] Failed to deliver notification` });
  });
}

// Get machine serial number (automatic, no config needed)
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

// Setup flow
async function setup() {
  updateStatus("setup");
  loadEnv();
  detectIDEs();
  resetProgress("setup");

  try {
    await captureSnapshot();
    setTarget(5, "setup");

    // Fetch question early so candidate can read during build (only if URL configured)
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
function startTimer() {
  const limitSecs = parseInt(state.config.TIME_LIMIT_MINUTES) * 60;
  state.timer = { start: Date.now(), active: 0, idle: 0, limitSecs, action: state.config.TIMEOUT_ACTION, expired: false, notified: false };
  timerInterval = setInterval(() => {
    if (!state.timer) return;
    const elapsed = Math.floor((Date.now() - state.timer.start) / 1000);
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
  const hexPath = Buffer.from(ROOT).toString("hex");
  const uri = `vscode-remote://dev-container+${hexPath}/workspaces`;
  if (IS_WIN) exec(`start "" "${ide.path}" --folder-uri "${uri}"`);
  else exec(`"${ide.path}" --folder-uri "${uri}" &`);
  return { launched: ideName };
}

// Cleanup (universal - container only)
async function cleanup() {
  if (state.status === "cleanup" || state.status === "done") return;
  updateStatus("cleanup");
  resetProgress("cleanup");
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  const config = state.config;

  if (config.ENABLE_ARCHIVE === "true" && config.DO_TOKEN && config.SPACES_BUCKET) {
    addStep("archive", "Archiving workspace to Spaces", "running");
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const name = `${config.PROJECT_NAME || "interview"}-${ts}.zip`;
      await run(`docker compose exec -T interview-env bash -c "cd /workspaces && zip -r /tmp/${name} . && s3cmd --access_key=\\"${config.DO_TOKEN}\\" --secret_key=\\"${config.DO_TOKEN}\\" --host=\\"${config.SPACES_REGION}.digitaloceanspaces.com\\" --host-bucket=\\"%(bucket)s.${config.SPACES_REGION}.digitaloceanspaces.com\\" --no-encrypt put /tmp/${name} s3://${config.SPACES_BUCKET}/${name}"`, { cwd: ROOT, stream: true });
      addStep("archive", `Archived to Spaces`, "done");
    } catch (_) { addStep("archive", "Archive failed", "error"); }
  }
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
    await run(`docker compose -f "${path.join(ROOT, "docker-compose.yml")}" down -v --remove-orphans`, { stream: true }).catch(() => {});
    setTarget(65, "cleanup");
    await run("docker system prune -af --volumes", { stream: true }).catch(() => {});
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
        const cur = await run(`security dump-keychain 2>/dev/null | grep -c "keychain" || echo 0`).catch(() => "0");
        if (parseInt(cur) > parseInt(snap.credentials.keychainCount || "0"))
          issues.push(`New keychain entries (was ${snap.credentials.keychainCount}, now ${cur})`);
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
}

// Admin reset — full host teardown executed directly from Node
async function adminReset() {
  if (state.status === "resetting") return;
  state.status = "resetting";
  state.steps = [];
  state.timer = null;
  state.question = null;
  state.questionHtml = null;
  state.questionLoading = false;
  state.questionVisible = true;
  state.error = null;
  state.cleanupIssues = null;
  state.telemetry = null;
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  broadcast({ type: "status", status: "resetting" });
  resetProgress("setup");

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
  addStep("phase2", "Phase 2: Docker — removing containers and volumes", "running");
  setTarget(14, "setup");
  try {
    await run(`docker compose -f "${path.join(ROOT, "docker-compose.yml")}" down -v --remove-orphans`, { stream: true }).catch(() => {});
    setTarget(20, "setup");
    const containers = await run("docker ps -aq").catch(() => "");
    if (containers.trim()) {
      await run(`docker stop ${containers.trim().split("\n").join(" ")}`).catch(() => {});
      await run(`docker rm -f ${containers.trim().split("\n").join(" ")}`).catch(() => {});
    }
    const volumes = await run("docker volume ls -q").catch(() => "");
    if (volumes.trim()) await run(`docker volume rm ${volumes.trim().split("\n").join(" ")}`).catch(() => {});
    await run("docker system prune -af --volumes", { stream: true }).catch(() => {});
  } catch (_) {}
  addStep("phase2", "Phase 2: Docker — complete", "done");
  setTarget(30, "setup");

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

  state.steps = [];
  broadcast({ type: "clear_steps" });
  resetProgress("setup");
  await setup();
}

// HTTP server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state));
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
    cleanup();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ started: true }));
    return;
  }
  if (url.pathname === "/api/reset" && req.method === "POST") {
    adminReset();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ started: true }));
    return;
  }
  if (url.pathname === "/api/reroll" && req.method === "POST") {
    state.question = null;
    state.questionHtml = null;
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
  if (url.pathname === "/api/config" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const newConfig = JSON.parse(body);
        const envLines = Object.entries(newConfig).map(([k, v]) => `${k}="${v}"`).join("\n");
        fs.writeFileSync(path.join(ROOT, ".env"), envLines);
        const oldTimer = state.config.ENABLE_TIMER;
        loadEnv();
        if (state.config.ENABLE_TIMER === "true" && oldTimer !== "true" && state.status === "ready") startTimer();
        if (state.config.ENABLE_TIMER !== "true" && timerInterval) {
          clearInterval(timerInterval); timerInterval = null; state.timer = null;
          broadcast({ type: "timer_stopped" });
        }
        broadcast({ type: "config", config: state.config });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ saved: true, config: state.config }));
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
  ws.send(JSON.stringify({ type: "init", state }));
  ws.on("close", () => clients.delete(ws));
});

server.listen(PORT, () => {
  console.log(`ShellPort running at http://localhost:${PORT}`);
  setup();
});
