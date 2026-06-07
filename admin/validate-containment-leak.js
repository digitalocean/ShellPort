#!/usr/bin/env node
// Validate that a managed-station reset cleared the candidate's containment leak
// (work saved outside the container) — and ONLY that. Run after a Recycle / End Event:
//   macOS/Linux:  node ~/shellport/admin/validate-containment-leak.js
//   Windows:      node $env:USERPROFILE\shellport\admin\validate-containment-leak.js
// (or pass the install dir explicitly: node validate-containment-leak.js /path/to/shellport)
//
// Reads .last_scrub.json (written by the reset) and checks, against the live disk:
//   1. every file the reset REMOVED is gone               (candidate work cleared)
//   2. every BASELINE file still exists                   (only added files removed)
//   3. no candidate-added file remains in the work dirs   (no residue)
// Exits 0 only if all three pass.

const fs = require("fs");
const path = require("path");

const root = process.argv[2] || path.join(process.env.HOME || process.env.USERPROFILE || "", "shellport");
const reportPath = path.join(root, ".last_scrub.json");

let report;
try { report = JSON.parse(fs.readFileSync(reportPath, "utf8")); }
catch (e) { console.error(`FAIL: cannot read ${reportPath}: ${e.message}`); process.exit(2); }

const exists = (f) => { try { fs.accessSync(f); return true; } catch (_) { return false; } };

// Re-list the work dirs live (same logic the server uses).
function listWorkFiles(dirs) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(full);
    }
  };
  (dirs || []).forEach(walk);
  return out;
}

console.log(`Scrub report: ${reportPath}`);
console.log(`  baseline captured: ${report.baselineFrom} (${report.baselineCount} file(s))`);
console.log(`  dirs: ${(report.dirs || []).join(", ")}`);
console.log(`  removed: ${report.removed.length}   could-not-remove: ${(report.stillPresent || []).length}\n`);

let pass = true;

// 1. Everything the reset claims it removed must actually be gone.
const notGone = report.removed.filter(exists);
if (notGone.length) { pass = false; console.error(`✗ ${notGone.length} "removed" file(s) STILL EXIST:`); notGone.forEach((f) => console.error("    " + f)); }
else console.log(`✓ all ${report.removed.length} removed file(s) are gone`);

// 2. Every pre-existing (baseline) file must still be present — proves we only
//    deleted ADDED files, never the station's own files.
const baseline = report.baseline || [];
const missing = baseline.filter((f) => !exists(f));
if (missing.length) { pass = false; console.error(`✗ ${missing.length} pre-existing baseline file(s) were WRONGLY removed:`); missing.forEach((f) => console.error("    " + f)); }
else console.log(`✓ all ${baseline.length} pre-existing file(s) preserved`);

// 3. Nothing added beyond the baseline may remain.
const baseSet = new Set(baseline);
const residue = listWorkFiles(report.dirs).filter((f) => !baseSet.has(f));
if (residue.length) { pass = false; console.error(`✗ ${residue.length} candidate-added file(s) REMAIN in the work dirs:`); residue.forEach((f) => console.error("    " + f)); }
else console.log(`✓ no candidate-added files remain in the work dirs`);

console.log("\n" + (pass ? "PASS — containment leak cleared; only added files removed." : "FAIL — see issues above."));
process.exit(pass ? 0 : 1);
