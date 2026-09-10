#!/usr/bin/env node

/**
 * Complete Cache Reset Script for SilkStack
 * This script completely removes ALL application data and caches
 * Use this to test the app in a completely fresh state
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Build artifacts (node_modules/.vite, tsconfig.tsbuildinfo, dist-electron) live
// at the repo root. This file sits in scripts/, so step up one level.
const ROOT = path.join(__dirname, '..');

console.log('🧹 COMPLETE SilkStack Cache Reset Script');
console.log('===============================================');
console.log('⚠️  WARNING: This will delete ALL application data!');
console.log('   - IndexedDB caches');
console.log('   - localStorage data');
console.log('   - Electron userData directory');
console.log('   - Browser cache/storage');
console.log('');

// Ask for confirmation
if (process.argv.includes('--yes') || process.argv.includes('-y')) {
  console.log('🚀 Proceeding with cache reset...');
} else {
  console.log('Run with --yes or -y to confirm: npm run reset-cache -- --yes');
  process.exit(0);
}

/**
 * Electron derives userData from the app name in package.json ("silkstack"),
 * so the packaged build and `electron .` share one folder. Dev mode appends
 * " (Dev)" to a separate folder (see electron/main.mjs).
 *
 * Note: "silkstack-photos" is a different application and is deliberately not
 * touched here, nor are the pre-rename "ImageMetaHub" folders.
 */
function getElectronUserDataDirs() {
  const appNames = ['silkstack', 'silkstack (Dev)'];
  let baseDir;

  switch (process.platform) {
    case 'win32':
      baseDir = path.join(os.homedir(), 'AppData', 'Roaming');
      break;
    case 'darwin':
      baseDir = path.join(os.homedir(), 'Library', 'Application Support');
      break;
    case 'linux':
      baseDir = path.join(os.homedir(), '.config');
      break;
    default:
      console.log('❌ Unsupported platform');
      return [];
  }

  return appNames.map((name) => path.join(baseDir, name));
}

// Clear Electron userData directories
function clearElectronCache() {
  const userDataDirs = getElectronUserDataDirs();
  if (userDataDirs.length === 0) return;

  let cleared = 0;

  for (const userDataDir of userDataDirs) {
    console.log(`📁 Checking Electron userData directory: ${userDataDir}`);

    if (!fs.existsSync(userDataDir)) {
      console.log('ℹ️ Not found (first run?)');
      continue;
    }

    try {
      // Remove the entire directory
      fs.rmSync(userDataDir, { recursive: true, force: true });
      console.log('✅ Electron userData directory cleared');
      cleared++;
    } catch (error) {
      console.error('❌ Error clearing Electron userData:', error.message);
    }
  }

  if (cleared === 0) {
    console.log('ℹ️ No Electron userData directories were found');
  }
}

// Remove a path if it exists, reporting what happened
function removePath(targetPath, label, { directory = true } = {}) {
  console.log(`📁 Checking ${label}: ${targetPath}`);

  if (!fs.existsSync(targetPath)) {
    console.log(`ℹ️ ${label} not found`);
    return false;
  }

  try {
    if (directory) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(targetPath);
    }
    console.log(`✅ ${label} cleared`);
    return true;
  } catch (error) {
    console.error(`❌ Error clearing ${label}:`, error.message);
    return false;
  }
}

// Clear dist-electron directory (built app cache)
function clearDistElectron() {
  removePath(path.join(ROOT, 'dist-electron'), 'dist-electron directory');
}

// Clear node_modules/.vite cache
function clearViteCache() {
  removePath(path.join(ROOT, 'node_modules', '.vite'), 'Vite cache');
}

// Clear TypeScript build cache
function clearTSBuildCache() {
  removePath(path.join(ROOT, 'tsconfig.tsbuildinfo'), 'TypeScript build cache', {
    directory: false,
  });
}

// Clear browser data (Chrome/Chromium cache)
function clearBrowserData() {
  console.log('🌐 Browser cache clearing instructions:');
  console.log('   For Chrome/Chromium:');
  console.log('   1. Open chrome://settings/clearBrowserData');
  console.log('   2. Select "Cached images and files" and "Cookies and other site data"');
  console.log('   3. Clear data for "Last hour"');
  console.log('');
  console.log('   Or run this app in an incognito/private window');
}

// Try to kill any running Electron processes
function killElectronProcesses() {
  console.log('🔪 Killing any running Electron processes...');

  try {
    switch (process.platform) {
      case 'win32':
        try {
          // Dev runs use electron.exe; the packaged app ships as silkstack.exe.
          execSync('taskkill /f /im electron.exe', { stdio: 'ignore' });
          execSync('taskkill /f /im silkstack.exe', { stdio: 'ignore' });
          execSync('taskkill /f /im "SilkStack Image Browser.exe"', { stdio: 'ignore' });
        } catch (e) {
          // Ignore errors if processes aren't running
        }
        break;
      case 'darwin':
        try {
          execSync('pkill -f electron', { stdio: 'ignore' });
          execSync('pkill -f silkstack', { stdio: 'ignore' });
        } catch (e) {
          // Ignore errors if processes aren't running
        }
        break;
      case 'linux':
        try {
          execSync('pkill -f electron', { stdio: 'ignore' });
          execSync('pkill -f silkstack', { stdio: 'ignore' });
        } catch (e) {
          // Ignore errors if processes aren't running
        }
        break;
    }
    console.log('✅ Electron processes killed');
  } catch (error) {
    console.log('ℹ️ No running Electron processes found');
  }
}

console.log('\n🔧 Starting complete cache reset...');

// Kill running processes first
killElectronProcesses();

// Clear all caches
clearElectronCache();
clearDistElectron();
clearViteCache();
clearTSBuildCache();
clearBrowserData();

console.log('\n🎉 Complete cache reset finished!');
console.log('🔄 The application is now in a completely fresh state.');
console.log('');
console.log('Next steps:');
console.log('1. Close all browser tabs/windows with the app');
console.log('2. Clear browser cache manually (see instructions above)');
console.log('3. Restart the application');
console.log('');
console.log('💡 Tip: Use incognito/private browsing mode for testing');
