#!/usr/bin/env node

/**
 * Complete Version Update Script
 * Updates version across ALL files in the project
 * 
 * Usage: node update-version.js <version>
 * Example: node update-version.js 1.0.0
 */

import { readFileSync, writeFileSync, copyFileSync } from 'fs';
import { resolve } from 'path';

const NEW_VERSION = process.argv[2];
if (!NEW_VERSION) {
  console.error('❌ Error: Version argument required');
  console.error('Usage: node update-version.js <version>');
  console.error('Example: node update-version.js 1.0.0');
  process.exit(1);
}

// Validate semver format
if (!/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/.test(NEW_VERSION)) {
  console.error(`❌ Error: Invalid version format: ${NEW_VERSION}`);
  console.error('Expected format: MAJOR.MINOR.PATCH (e.g., 1.0.0 or 1.0.0-rc)');
  process.exit(1);
}

console.log(`\n🔄 Updating version to v${NEW_VERSION}...\n`);

let updatedCount = 0;
let errors = [];

/**
 * Update a file with pattern replacement
 */
function updateFile(filePath, pattern, replacement, description) {
  try {
    const fullPath = resolve(process.cwd(), filePath);
    const content = readFileSync(fullPath, 'utf8');
    const newContent = content.replace(pattern, replacement);

    if (content === newContent) {
      console.log(`⚠️  [SKIP] ${description} - no changes needed or pattern not found`);
      return false;
    }

    writeFileSync(fullPath, newContent, 'utf8');
    console.log(`✅ [${++updatedCount}] ${description}`);
    return true;
  } catch (error) {
    const errorMsg = `Failed to update ${filePath}: ${error.message}`;
    errors.push(errorMsg);
    console.error(`❌ ${errorMsg}`);
    return false;
  }
}

// ============================================================
// 1. package.json - Main version field
// ============================================================
updateFile(
  'package.json',
  /"version":\s*"[^"]+"/,
  `"version": "${NEW_VERSION}"`,
  'package.json version field'
);

// ============================================================
// 2. ARCHITECTURE.md - Current Version section
// ============================================================
updateFile(
  'docs/ARCHITECTURE.md',
  /- \*\*Version:\*\*\s*\d+\.\d+\.\d+(-[a-z0-9.-]+)?/,
  `- **Version:** ${NEW_VERSION}`,
  'ARCHITECTURE.md current version'
);

// ============================================================
// 3. Sync CHANGELOG.md to public/ (Important for build)
// ============================================================
try {
  copyFileSync('docs/CHANGELOG.md', 'public/CHANGELOG.md');
  console.log(`✅ [${++updatedCount}] Synced CHANGELOG.md to public/`);
} catch (error) {
  errors.push(`Failed to sync CHANGELOG.md: ${error.message}`);
  console.error(`❌ Failed to sync CHANGELOG.md: ${error.message}`);
}

// ============================================================
// Note: UI components (Header, StatusBar, FolderSelector) 
// now use import.meta.env.VITE_APP_VERSION which reads from 
// package.json automatically via vite.config.ts.
// Electron and CLI also load version from package.json.
// ============================================================

// Summary
console.log('\n' + '='.repeat(60));
if (errors.length > 0) {
  console.log(`⚠️  Version update completed with ${errors.length} error(s)`);
  console.log('\nErrors:');
  errors.forEach(err => console.log(`  - ${err}`));
  console.log('\n' + '='.repeat(60));
  process.exit(1);
} else {
  console.log(`✅ Successfully updated ${updatedCount} files to v${NEW_VERSION}`);
  console.log('='.repeat(60));
  console.log('\n📋 Next steps:');
  console.log(`  1. Review changes: git diff`);
  console.log(`  2. Ensure docs/CHANGELOG.md has entries for v${NEW_VERSION}`);
  console.log(`  3. Run: npm run auto-release ${NEW_VERSION}`);
  console.log('\n');
}
