/**
 * Stand-in module for the closed-source ai-intelligence package.
 *
 * vitest.config.ts and vite.config.ts ALWAYS alias
 * '@ai-images-browser/ai-intelligence' so that transforms/builds can
 * resolve it: to the real package when present, to THIS file when absent.
 * Without an always-resolvable target, Vite's transform hard-fails (and
 * rolldown's build hard-fails) on the guarded
 * `import('@ai-images-browser/ai-intelligence')` calls in the app source,
 * so the open-source CI path can never run.
 *
 * This stub is deliberately EMPTY. Every app-side consumer guards its
 * module access (VITE_AI_FEATURES_AVAILABLE define + null checks), so an
 * absent module resolves to `undefined` exports and the app degrades by
 * design. Test files that mock the module (vi.mock) replace this stub
 * wholesale; the few tests that need the real package skip without it.
 */
export {};
