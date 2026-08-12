import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

// Read package.json to get version
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

// Ensure the license secret is baked into the renderer bundle.
// If only IMH_LICENSE_SECRET is set, we mirror it to VITE_IMH_LICENSE_SECRET here.
const licenseSecret =
  process.env.VITE_IMH_LICENSE_SECRET ||
  process.env.IMH_LICENSE_SECRET ||
  'CHANGE-ME-BEFORE-RELEASE'

// Detect whether the ai-intelligence package is available at build time.
// This lets components conditionally show/hide AI-dependent UI.
const aiFeaturesAvailable = existsSync(
  resolve(__dirname, 'ai-intelligence', 'package.json')
)

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    // Force single copies of React and friends even when the
    // ai-intelligence package ships nested node_modules copies of them
    // (bare imports inside ai-intelligence/dist/* resolve against the
    // nested copy first, which would otherwise duplicate React in the
    // bundle — a second React instance never receives a hooks
    // dispatcher from react-dom, so its useState crashes with
    // "Cannot read properties of null (reading 'useState')").
    dedupe: ['react', 'react-dom', 'lucide-react'],
    // ALWAYS alias the module path — rolldown (vite 8) hard-fails on
    // unresolvable dynamic imports even inside VITE_AI_FEATURES_AVAILABLE
    // guards (classic rollup only warned). To the real package when
    // present; to the empty test stub when absent, so the false define
    // can dead-code the guarded imports and the open-source build stays
    // green without the module.
    alias: {
      '@ai-images-browser/ai-intelligence': aiFeaturesAvailable
        ? resolve(__dirname, 'ai-intelligence')
        : resolve(__dirname, 'test', 'ai-intelligence-stub.ts'),
    },
  },
  plugins: [
    react(),
    {
      name: 'copy-assets',
      closeBundle() {
        // Copy CHANGELOG.md and logo to dist folder after build
        try {
          copyFileSync(
            resolve(__dirname, 'docs/CHANGELOG.md'),
            resolve(__dirname, 'dist/CHANGELOG.md')
          )
          console.log('✅ CHANGELOG.md copied to dist/')
          
          copyFileSync(
            resolve(__dirname, 'public/logo1.png'),
            resolve(__dirname, 'dist/logo1.png')
          )
          console.log('✅ logo1.png copied to dist/')
        } catch (error) {
          console.warn('⚠️ Failed to copy assets:', error)
        }
      }
    }
  ],
  base: './',
  define: {
    'import.meta.env.VITE_IMH_LICENSE_SECRET': JSON.stringify(licenseSecret),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
    'import.meta.env.VITE_AI_FEATURES_AVAILABLE': JSON.stringify(aiFeaturesAvailable),
  },
  server: {
    host: true, // Expose server to the network
  },
  css: {
    postcss: './postcss.config.cjs'
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  }
})
