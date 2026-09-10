/**
 * Build verification — ensures the app builds successfully WITHOUT the
 * ai-intelligence package present.
 *
 * Temporarily renames ai-intelligence/package.json (NOT the whole directory),
 * runs the TypeScript compiler + Vite build, then restores it. If the build
 * fails, it means some AI-dependent code is missing its compile-time guard
 * (import.meta.env.VITE_AI_FEATURES_AVAILABLE) or type stubs are out of
 * date in src/vite-env.d.ts.
 *
 * The restore runs in a `finally` block and from SIGINT/SIGTERM handlers, and
 * a leftover .bak from a previously killed run is recovered on startup — so
 * an interrupted run cannot leave the package hidden.
 *
 * Usage:  node scripts/verify-build-without-ai.cjs
 */

const { existsSync, renameSync } = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PKG_JSON = path.join(ROOT, 'ai-intelligence', 'package.json');
const PKG_JSON_BAK = path.join(ROOT, 'ai-intelligence', '_package.json.bak');

let failed = false;
let hidden = false;

/**
 * Put the package.json back. Safe to call more than once and from a signal
 * handler; returns true only if it actually moved the file.
 */
function restore() {
  if (!hidden || !existsSync(PKG_JSON_BAK)) return false;
  try {
    renameSync(PKG_JSON_BAK, PKG_JSON);
    hidden = false;
    return true;
  } catch (err) {
    console.error('[verify:no-ai] ✗ Could not restore ai-intelligence/package.json:');
    console.error(`[verify:no-ai]   ${err.message}`);
    console.error(`[verify:no-ai]   Restore it manually: rename "${PKG_JSON_BAK}" to "${PKG_JSON}"`);
    return false;
  }
}

// A signal would otherwise skip the `finally` block entirely.
function handleSignal(signal) {
  console.log(`\n[verify:no-ai] Received ${signal} — restoring before exit...`);
  restore();
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));

function runStep(label, command, cwd) {
  console.log(`\n[verify:no-ai] ${label}...`);
  try {
    execSync(command, { cwd: cwd || ROOT, stdio: 'inherit' });
    console.log(`[verify:no-ai] ✓ ${label} passed`);
    return true;
  } catch (err) {
    console.error(`[verify:no-ai] ✗ ${label} FAILED`);
    console.error(err.message);
    failed = true;
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────

console.log('[verify:no-ai] ─────────────────────────────────────────────');
console.log('[verify:no-ai] Verifying build works without ai-intelligence');
console.log('[verify:no-ai] ─────────────────────────────────────────────');

// Recover a leftover from a run that was killed outright (SIGKILL / power loss),
// which no handler can catch.
if (existsSync(PKG_JSON_BAK) && !existsSync(PKG_JSON)) {
  console.log('[verify:no-ai] Found a leftover _package.json.bak from an interrupted run.');
  console.log('[verify:no-ai] Restoring it before proceeding.');
  renameSync(PKG_JSON_BAK, PKG_JSON);
}

const aiPresent = existsSync(PKG_JSON);

if (!aiPresent) {
  console.log('[verify:no-ai] ai-intelligence/package.json not found —');
  console.log('[verify:no-ai] already building without AI. Proceeding directly.');
} else {
  console.log('[verify:no-ai] Temporarily hiding ai-intelligence/package.json...');
  renameSync(PKG_JSON, PKG_JSON_BAK);
  hidden = true;
}

try {
  // Step 1: TypeScript type-check
  runStep('TypeScript compilation (tsc -b)', 'npx tsc -b');

  // Step 2: Vite production build
  runStep('Vite production build (vite build)', 'npx vite build');

} finally {
  // Always restore, even if steps fail
  if (restore()) {
    console.log('[verify:no-ai] Restored ai-intelligence/package.json');
  }
}

if (failed) {
  console.log('\n[verify:no-ai] ─────────────────────────────────────────────');
  console.log('[verify:no-ai] ✗ BUILD VERIFICATION FAILED');
  console.log('[verify:no-ai] The app does NOT build without ai-intelligence.');
  console.log('[verify:no-ai] Check that all AI-dependent code is guarded by:');
  console.log('[verify:no-ai]   import.meta.env.VITE_AI_FEATURES_AVAILABLE');
  console.log('[verify:no-ai] ─────────────────────────────────────────────');
  process.exit(1);
} else {
  console.log('\n[verify:no-ai] ─────────────────────────────────────────────');
  console.log('[verify:no-ai] ✓ BUILD VERIFICATION PASSED');
  console.log('[verify:no-ai] The app builds correctly without ai-intelligence.');
  console.log('[verify:no-ai] ─────────────────────────────────────────────');
}
