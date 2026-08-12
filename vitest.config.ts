/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import { existsSync } from 'fs';

// Detect whether the ai-intelligence package is available — mirrors
// vite.config.ts exactly (same file check, same boolean define).
// Previously this hardcoded the STRING 'true' and an unconditional alias,
// so the no-module path (guard `if (!import.meta.env.VITE_AI_FEATURES_AVAILABLE)`)
// was never exercised by tests. A real boolean makes CI take the true
// no-module path.
const aiFeaturesAvailable = existsSync(
  resolve(__dirname, 'ai-intelligence', 'package.json'),
);

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
  },
  resolve: {
    alias: {
      // ALWAYS alias the module path — Vite's transform resolves every
      // `import('@ai-images-browser/ai-intelligence')` in app source at
      // transform time, and an unresolvable bare specifier is a hard error
      // (not a warning like rollup's build path). To the real package when
      // present; to the empty test stub when absent. Test files that mock
      // the module (vi.mock) replace this target wholesale.
      '@ai-images-browser/ai-intelligence': aiFeaturesAvailable
        ? resolve(__dirname, 'ai-intelligence')
        : resolve(__dirname, 'test', 'ai-intelligence-stub.ts'),
    },
  },
  define: {
    'import.meta.env.VITE_AI_FEATURES_AVAILABLE': JSON.stringify(
      aiFeaturesAvailable,
    ),
    'import.meta.env.VITE_IMH_LICENSE_SECRET': JSON.stringify(
      process.env.VITE_IMH_LICENSE_SECRET ||
        process.env.IMH_LICENSE_SECRET ||
        'test-secret-do-not-use-in-production',
    ),
  },
});
