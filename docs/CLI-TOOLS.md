# Command-Line Tools Reference

Every command-line script in the SilkStack repository, in one place.

Scripts live in [`scripts/`](../scripts/) and are invoked either through an npm
alias (`npm run <alias>`) or directly with `node` / `tsx`.

> **Windows note:** paths containing spaces need quoting. In PowerShell use
> `.\` for local executables. The `--` separator is required before passing
> arguments through an npm alias.

---

## Contents

| Group | Scripts |
|---|---|
| [1. Metadata & prompt extraction](#1-metadata--prompt-extraction) | `extract-prompt`, `parse-comfy-workflow`, `parse-comfy-batch`, `SilkStack-cli` |
| [2. Development & build](#2-development--build) | `build-ai-intelligence`, `build-and-run-dev`, `build-prod`, `start-dev`, `verify-build-without-ai` |
| [3. Release & versioning](#3-release--versioning) | `auto-release`, `release-workflow`, `generate-release`, `update-version`, `sync-changelog` |
| [4. Data maintenance](#4-data-maintenance--one-off-utilities) | `reset-cache`, `clear-manual-tags`, `clear-stacking-tags`, `cleanup-clustering`, `cleanup-clustering-v2` |
| [5. Application launch flags](#5-application-launch-flags) | `electron/main.mjs` |
| [6. Docker](#6-running-the-cli-in-docker) | `Dockerfile` — run the CLI in a container |

**Quick alias index** (from `package.json`):

```bash
npm run prompt          # extract-prompt       — prompt from workflow OR media file
npm run comfy:parse     # parse-comfy-workflow — one workflow → structured JSON
npm run comfy:batch     # parse-comfy-batch    — directory of workflows → JSONL
npm run cli:parse       # cli.ts parse         — one image → metadata JSON
npm run cli:index       # cli.ts index         — directory → JSONL

npm run dev             # Vite dev server (browser only, port 5173)
npm run dev:app         # start-dev            — Electron + React dev environment
npm run build           # build:ai + tsc + vite build
npm run build:ai        # build-ai-intelligence — build the ai-intelligence package
npm run test            # vitest
npm run lint            # eslint

npm run update-version   # bump version across all files
npm run generate-release # generate release notes
npm run release-workflow # version + notes + tag + push (no build)
npm run auto-release     # full release pipeline
npm run reset-cache      # clear app caches (⚠️ deletes app data — read §4 first)
npm run sync-changelog   # copy CHANGELOG.md → public/
```

**Legend:** ⚠️ marks commands that destroy data or deploy, not commands that are
broken. Every script below was executed and verified on 2026-09-10; where a bug
was found it is noted in the relevant section as **Fixed** or **Gotcha**.

---

## 1. Metadata & prompt extraction

### `extract-prompt.ts`

Extracts a **plain generation prompt** from either a ComfyUI workflow JSON *or*
a media file with embedded metadata. The input type is detected automatically
from content — not from the file extension.

```bash
npm run prompt -- <file> [options]
npx tsx scripts/extract-prompt.ts <file> [options]

# stdin (JSON text or raw file bytes)
cat workflow.json | npm run prompt --
cat render.png    | npx tsx scripts/extract-prompt.ts
```

**Detection** — decided by the leading bytes:

| Detected | Route |
|---|---|
| First non-whitespace byte is `{` or `[` | Workflow JSON (UI graph, `{workflow, prompt}` wrapper, or API format) |
| PNG / JPEG / WebP magic bytes | `parseImageBuffer` → shared parser factory |
| `ftyp` at offset 4, EBML magic, or RIFF/AVI | MP4 mdta walker, falling back to ffprobe |

Because routing is content-based, a mislabelled file still resolves correctly.

**Options**

| Flag | Description |
|---|---|
| `--stdin` | Force reading from stdin even when a file path is given |
| `-n`, `--negative` | Print the negative prompt instead of the positive one |
| `--json` | Print full structured metadata as JSON instead of the plain prompt |
| `--require-prompt` | Exit with code 3 when no prompt is found (for scripting/CI) |
| `-v`, `--verbose` | Print detection and parsing diagnostics to stderr |

**Exit codes**

| Code | Meaning |
|---|---|
| `0` | Prompt extracted and printed |
| `1` | Error — unreadable file, unrecognised format, parse failure |
| `3` | Parsed successfully but no prompt found (only with `--require-prompt`) |

**Supported generators** — via the shared parser factory, identical to the
desktop app: ComfyUI, Automatic1111, Forge, Fooocus, SwarmUI, InvokeAI,
Easy Diffusion, Draw Things, DreamStudio, Midjourney, Niji, DALL-E,
Adobe Firefly, and MetaHub Save Node/Video.

**ffprobe** is used only for video containers with no pure-JS reader in this
codebase (WebM/MKV/AVI), and only when the native MP4 mdta walker finds nothing.
It is optional: if absent, MP4/MOV still work natively. Override its location
with `FFPROBE_PATH`.

**Note on piping:** `npm run` writes its own banner to **stdout**, which will
land in redirected output. Use `npm run -s prompt --` (silent) or invoke
`npx tsx` directly when capturing output.

```bash
npm run -s prompt -- render.png > prompt.txt   # clean
```

---

### `parse-comfy-workflow.ts`

Parses one ComfyUI workflow into structured generation metadata — model, LoRAs,
VAE, sampler, scheduler, steps, CFG, seed, prompts, ControlNet.

> **`width`/`height` are always `null` here.** A workflow file carries no
> dimensions, so the parser deliberately does not derive them — the source says
> so directly: *"width/height are NOT extracted from workflow, they're read from
> actual image dimensions."* The keys exist in the output shape only for
> consistency with the image-parsing path. To get real dimensions, read the
> image (`cli.ts parse`) or the latent node's own values.

```bash
npm run comfy:parse -- <file> [options]
npx tsx scripts/parse-comfy-workflow.ts <file> [options]

# stdin
cat workflow.json | npm run comfy:parse --
Get-Clipboard | npm run comfy:parse --     # Windows clipboard
```

Accepts a file path, `-` for explicit stdin, or no argument (reads stdin).
On a file it cannot interpret it exits **1** with
`Error parsing workflow: …` on stderr and nothing on stdout.

**Which workflow formats are accepted**

| Input shape | Accepted | Notes |
|---|---|---|
| API format (`{"84:75": {"inputs":…, "class_type":…}}`) | ✅ | Richest result — resolves `model` |
| `{"workflow": <UI graph>}` | ✅ | Recovers prompts, sampling, LoRAs — but `model` is `null` |
| Bare UI graph (what `workflow.json` looks like on disk from the UI's Save) | ❌ | Exits 1 — see below |

> **UI graphs must stay wrapped.** A UI-format graph is only recognized when
> nested under a `workflow` key — which is exactly how it is stored inside a
> PNG/MP4. A standalone `workflow.json` exported from the ComfyUI interface is
> a *bare* graph and is **rejected**, because the detector looks for a
> `workflow` or `prompt` key or an API-format prompt object. Wrap it first:
>
> ```bash
> node -e "const g=require('./workflow.json');require('fs')\
>   .writeFileSync('wrapped.json',JSON.stringify({workflow:g}))"
> npm run -s comfy:parse -- wrapped.json
> ```
>
> Wrapped UI graphs also cannot resolve `model` — UI nodes carry
> `widgets_values`, which the parser does not use to resolve the checkpoint
> (API format's `inputs` are). The `prompt`, `negative_prompt`, `steps`, `cfg`,
> `seed`, `sampler`, `scheduler`, and `loras` all come through correctly.
> Verified 2026-09-10 against a full 7-node UI graph.

**Options**

| Flag | Description |
|---|---|
| `--stdin` | Force reading from stdin even when a file path is provided |
| `--pretty` | Pretty-print JSON with 2-space indentation |
| `--facts` | Output the grouped `WorkflowFacts` format (`prompts`, `model`, `loras`, `sampling`, `dimensions`) |
| `--raw` | Include the raw pre-cleaning result under `_raw` |
| `--no-telemetry` | Omit `_telemetry` (detection method, unknown node count, warnings) |

Full output schemas are documented in [comfy-cli-tools.md](comfy-cli-tools.md).

`--no-telemetry` works on both output paths (the default schema and `--facts`).

> **Fixed 2026-09-10.** This flag previously did nothing. Commander's
> `--no-telemetry` convention sets `options.telemetry = false`, but the script
> read `options.noTelemetry` — always `undefined`, so the guard never fired and
> `_telemetry` was emitted regardless. The helpers now read `options.telemetry`
> (omitting the key unless it is explicitly `false`, which keeps the default
> include behaviour for direct callers).

```bash
npm run comfy:parse -- workflow.json --facts | jq '.sampling'
npm run comfy:parse -- workflow.json | jq -r '.model'
```

---

### `parse-comfy-batch.ts`

Batch-processes every JSON file in a directory. Outputs JSONL by default.

```bash
npm run comfy:batch -- <directory> [options]
```

**Options**

| Flag | Description |
|---|---|
| `--recursive` | Scan subdirectories recursively |
| `--out <file>` | Write output to a file instead of stdout |
| `--array` | Output a JSON array (pretty-printed) instead of JSONL |
| `--summary` | Output aggregate statistics only (unique models, LoRAs, VAEs, samplers, schedulers) |
| `--failures` | Output only files that failed to parse, as a JSON array |

**All progress output goes to stderr**, so every mode above is safe to pipe —
`stdout` carries only the JSONL, the JSON array, or the summary object. That
means `--summary` feeds straight into `jq` with no banner stripping needed
(verified 2026-09-10).

Unparseable files are **not** dropped: they still get a row, marked
`"success": false` with an `error` string. So the row count always equals the
number of JSON files found.

```json
{"file":"ui-format.json","success":false,
 "error":"Not a ComfyUI workflow (no \"workflow\" or \"prompt\" section)","loras":[]}
```

Note this differs from [`cli.ts index`](#index--directory--jsonl), which drops
unparseable files from its output entirely and reports them only in its `Failed`
count (and exit code 1). Use `comfy:batch` when you need a row for every file.

```bash
npm run comfy:batch -- ~/ComfyUI/output/ --recursive --summary
npm run comfy:batch -- ./workflows/ | jq 'select(.loras | length > 0)' | wc -l
```

---

### `cli.ts` (`SilkStack-cli`)

The packaged CLI (declared in `package.json` → `bin.SilkStack-cli`). Uses the
same `parseImageFile` engine as the app.

#### `parse` — single image

```bash
npm run cli:parse -- <file> [options]
npx tsx scripts/cli.ts parse <file> [options]
```

| Flag | Description |
|---|---|
| `--json` | Output as JSON — **on by default** |
| `--pretty` | Pretty-print JSON output |
| `--raw` | Include the raw metadata payload under `raw_metadata` |
| `--quiet` | Suppress informational logs |

Output includes `file`, `format`, `raw_source`, `sha256`, `dimensions`,
`metadata`, `schema_version`, `_telemetry`, `parsed_at`, `errors`.

#### `index` — directory → JSONL

```bash
npm run cli:index -- <dir> [options]
npx tsx scripts/cli.ts index <dir> --out index.jsonl --recursive
```

| Flag | Description |
|---|---|
| `--out <file>` | Output JSONL file (default `index.jsonl`) |
| `--recursive` | Scan subdirectories recursively |
| `--raw` | Include the raw metadata payload |
| `--quiet` | Suppress informational logs |
| `--concurrency <number>` | Files processed in parallel (default: CPU count, clamped to 1–64) |

`index` and `parse` accept the same extensions as the desktop app's file
watcher (`.png .jpg .jpeg .webp .mp4 .webm .mkv .mov .avi` — the source list
lives in [electron/fileWatcher.mjs](../electron/fileWatcher.mjs)).

**Failures are reported separately, and a hard failure sets the exit code:**

| Outcome | Written to output? | Counted as | Exit code |
|---|---|---|---|
| Parsed cleanly | ✅ | `Processed` | — |
| Parsed with parser warnings | ✅ | `Warnings` | — |
| Threw while parsing | ❌ skipped | `Failed` | **1** |

- **Warnings** are routine — e.g. `ffprobe not available or failed to read
  video metadata` on video files. They stay exit **0** so that a mixed library
  doesn't look like a failed run.
- **Failed** means the file is absent from the output entirely; one
  `Error parsing <file>:` block goes to **stderr** per file. Any failure sets
  exit code 1, so `npm run cli:index -- ... && next-step` behaves correctly.

Arithmetic closes: `Processed + Failed = Images found`. Per-file warnings are
still in the output as `errors[]` on each record.

> **Fixed 2026-09-10.** Previously `.webp` was silently skipped (not even
> counted in "Images found"), and a single `Errors` counter conflated warnings
> with failures while always exiting **0**, so partial failures were invisible
> to a script.

```bash
# Audit LoRA usage across a library
npm run cli:index -- ./images --out index.jsonl --recursive --quiet
jq -r '.metadata.loras[]?.name' index.jsonl | sort | uniq -c
```

---

## 2. Development & build

| Script | npm alias | Arguments |
|---|---|---|
| `start-dev.js` | `dev:app` | pass-through to Electron |
| `build-ai-intelligence.cjs` | `build:ai` | none |
| `verify-build-without-ai.cjs` | — | none |
| `build-and-run-dev.ps1` | — | none |
| `build-prod.ps1` | — | none (⚠️ **deploys**) |

`npm run build` is a three-stage chain, and one hook that runs before it:

```
prebuild  →  copy docs/CHANGELOG.md → public/CHANGELOG.md
build     →  npm run build:ai  &&  tsc -b  &&  vite build
```

The `prebuild` hook is an npm lifecycle script, so it fires automatically on
every `npm run build` whether you invoke it directly or through
`package-win`. That copy is what makes the changelog visible inside the app —
editing `docs/CHANGELOG.md` alone is enough, and [sync-changelog](#3-release--versioning)
does the same copy as a standalone step.

> **Note:** `public/CHANGELOG.md` is **tracked in git**, not gitignored. It is a
> committed duplicate of `docs/CHANGELOG.md`, and the two can drift if you edit
> the doc and commit without running a build. If you change the changelog,
> either run `npm run sync-changelog` or `npm run build` before committing.

### `start-dev.js`

```bash
npm run dev:app
npm run dev:app -- --dir "C:\path\to\images"
```

Runs the full development environment: starts Vite (`npm run dev`), waits for
`http://localhost:5173` (30 s timeout), then spawns `electron . <args>`.

Arguments after `--` are forwarded verbatim to Electron, so any
[application launch flag](#5-application-launch-flags) works here.

It also **strips `ELECTRON_RUN_AS_NODE` from the child environment**. That
variable makes the Electron binary behave as plain Node, which prevents the
window from ever opening; if it's set in your shell, this script removes it for
the Electron child only.

`Ctrl+C` is trapped (`SIGINT`/`SIGTERM`) and tears down both the Vite and
Electron processes. Note that both children are spawned with `shell: true`, so
the kill signal reaches the shell wrapper (on Windows, `cmd.exe`) rather than
Electron itself — a stray `electron.exe` may survive a teardown. Also note that
`ELECTRON_RUN_AS_NODE` is a known hazard on this machine: it is injected into
tool shells and will silently break an Electron launch unless removed, which is
exactly what this script does.

No arguments are defined or validated by the script; they pass through blind.

### `build-ai-intelligence.cjs`

```bash
npm run build:ai
```

Conditional build for the separate `ai-intelligence/` package:

- If `ai-intelligence/package.json` exists → runs `npm run build` inside it
  (`tsup`), propagating failure as exit 1
- If it does **not** exist → prints a skip notice and **exits 0**, because the
  app is designed to compile and run without AI features

Takes no arguments. It runs as the first step of `npm run build`.

### `verify-build-without-ai.cjs`

```bash
node scripts/verify-build-without-ai.cjs
```

Guards against AI-dependent code that isn't properly compile-time guarded. It
temporarily renames `ai-intelligence/package.json` to `_package.json.bak`,
runs `npx tsc -b` and `npx vite build`, then restores the file in a `finally`
block. Exits 1 if either step fails, with a hint pointing at
`import.meta.env.VITE_AI_FEATURES_AVAILABLE`.

Both steps always run: a failure is recorded in a flag rather than thrown, so
`vite build` still executes after a `tsc` failure and you get the full picture
from one invocation. If the package is already absent it says so and proceeds
without renaming anything.

**An interrupted run cannot leave the package hidden.** Three layers guard the
restore: the `finally` block, `SIGINT`/`SIGTERM` handlers, and — for a kill that
no handler can catch (`SIGKILL`, power loss) — a startup check that detects a
leftover `_package.json.bak` and restores it before doing anything else. If the
restore itself fails, it prints the manual `rename` command.

> **Fixed 2026-09-10.** The `finally` block was the only restore path, so
> `Ctrl+C` during the build left `ai-intelligence/package.json` renamed and the
> next `npm run build` silently built without AI. Note that on Windows the
> signal handlers only fire for a real console `Ctrl+C` — `kill` from Git Bash
> can't deliver a catchable signal — so the **startup recovery is the safety net
> that matters there**, and it is verified working.

### `build-and-run-dev.ps1`

```powershell
powershell -File scripts/build-and-run-dev.ps1
```

Clears `dist`, `dist-electron`, and `release`, runs `npm run build`, then
launches `npx electron . --dist` — i.e. dev mode against the *built* output
rather than the Vite dev server. Takes no parameters.

> ⚠️ **The repo path is hardcoded** — the script begins with
> `Set-Location -Path "C:\Projects\AI-Images-Browser\"`. It only works from
> that exact location.

### `build-prod.ps1`

> ⚠️ **This is the production deploy script.** It packages the app and copies
> the result onto the machine at `C:\Programs\SilkStack Image Browser`,
> **deleting the contents of that folder first**. Per `AGENTS.md`, never run
> this automatically — it is deliberately not registered as an npm alias.

```powershell
powershell -File scripts/build-prod.ps1
```

What it does:

1. Kills running instances — processes named `SilkStack Image Browser`,
   `ai-images-browser`, `silkstack`, and `SilkStack`
2. Clears `dist`, `dist-electron`, `release`, `release-builds`, `dist-packager`
3. Runs `npm run package-win` — electron-packager, chosen over electron-builder
   to avoid its `winCodeSign` issues. It builds with `--asar` for `win32/x64`
   and excludes `src`, `scripts`, `tests`, `__tests__`, `.git`, `.github`,
   `.vscode`, `release-builds`, `dist-packager`, and `.electron-cache` — so the
   packaged app runs from `dist/` only, never from source
4. Takes the first directory in `release-builds/` and copies it to
   `C:\Programs\SilkStack Image Browser`, **wiping that destination first**

It runs with `$ErrorActionPreference = "Stop"` and exits with the failing exit
code if packaging fails. The repo path is hardcoded, as with the dev script.

---

## 3. Release & versioning

> ⚠️ **`auto-release` and `release-workflow` commit, tag, and `git push` to
> `origin` with no confirmation step.** Per `AGENTS.md`, never run these
> automatically. See [RELEASE-GUIDE.md](RELEASE-GUIDE.md) for the maintainer
> workflow.

All five take the version as a single positional argument and parse
`process.argv` directly — there is no `--help`, no dry-run, and no
confirmation prompt anywhere in the group.

| Script | Validates semver? | Writes files | Commits / pushes |
|---|---|---|---|
| `update-version.js` | ✅ `MAJOR.MINOR.PATCH[-pre]` | 3 files | — |
| `generate-release.js` | ❌ any non-empty string | 1 file (never overwrites) | — |
| `sync-changelog.js` | n/a | 1 file (overwrites) | — |
| `release-workflow.js` | ❌ | via the two above | ✅ commit, tag, 2× push |
| `auto-release.js` | ❌ | via the two above | ✅ commit, tag, 2× push |

### `update-version.js`

```bash
npm run update-version -- <version>
node scripts/update-version.js <version>
```

Validates the version against `^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$` and exits 1 if it
doesn't match. Updates exactly **three** targets:

1. `package.json` — the `"version"` field
2. `docs/ARCHITECTURE.md` — the `- **Version:**` line
3. `public/CHANGELOG.md` — copied from `docs/CHANGELOG.md`

Each step is independently try/caught; a missing pattern prints
`⚠️ [SKIP]` and is not counted, and any I/O error is collected and reported at
the end with exit code 1.

> **Note:** [RELEASE-AUTOMATION.md](RELEASE-AUTOMATION.md) states this script
> updates **11 files** (components, `index.html`, `electron.mjs`, …). That is
> out of date — the current script touches the three targets listed above.

### `generate-release.js`

```bash
npm run generate-release -- <version>
```

Reads `docs/CHANGELOG.md` (relative to the **current working directory**), finds
the section headed `## [<version>]` (falling back to the version with any
`-rc` suffix stripped), and writes `docs/release-v<version>.md`.

- **Never overwrites** — if the notes file exists it prints
  `⚠️ … skipping to preserve hand-written notes` and leaves it alone.
  (It still prints "Release notes generated" either way.)
- If the version has no changelog section, it lists every version it did find
  and exits 1.
- Writes no git state and makes no network calls.

### `sync-changelog.js`

```bash
npm run sync-changelog -- [--to-public|--to-root]
```

Two directions, defaulting to `--to-public`:

| Argument | Direction |
|---|---|
| `--to-public` (default) | `docs/CHANGELOG.md` → `public/CHANGELOG.md` |
| `--to-root` | `public/CHANGELOG.md` → `docs/CHANGELOG.md` |

Both directions **overwrite** the destination. Paths resolve from the script's
own location, not the cwd, so it works from any directory. An unrecognised
argument exits 1. (Its header comment says "root CHANGELOG.md", but the source
path is `docs/CHANGELOG.md`.)

### `release-workflow.js`

```bash
npm run release-workflow -- <version>
```

The lighter path — **skips the build**. Runs `update-version.js`, then
`generate-release.js`, then:

1. `git add package.json docs/ARCHITECTURE.md`
2. `git commit -m "chore: bump version to v<version>"`
3. `git tag v<version>`
4. `git push origin main` and `git push origin v<version>`

Steps 2–4 are individually try/caught and **failures are swallowed** with a
`⚠️` warning — the script continues and still exits 0. A failure inside either
child script, by contrast, throws uncaught and aborts.

It finishes by printing the **manual** GitHub release steps (create the release
at the GitHub releases page using the generated notes file).

### `auto-release.js`

```bash
npm run auto-release -- <version>
```

The full pipeline — the only script here that runs the build:

1. `npm run build` — on failure prints "Build failed! Aborting release." and exits 1
2. `node scripts/update-version.js <version>`
3. `node scripts/generate-release.js <version>`
4. `git add .`
5. `git commit -m "chore: release v<version>"` — **with a hardcoded commit body**
   (bullet points about performance/logging/duplication fixes that are baked
   into the script, not derived from the changelog)
6. `git tag v<version>`, `git push origin main`, `git push origin v<version>`
7. Waits 3 s, then prints GitHub Actions URLs

Only step 1 has error handling; every later failure aborts with an uncaught
exception. Unlike `release-workflow.js` it performs no version-format
validation, so a typo'd version becomes a real tag and push.

---

## 4. Data maintenance & one-off utilities

> ⚠️ **Everything in this section is destructive by default.** None has a
> dry-run mode. Only `reset-cache.js` has any confirmation gate at all.
> `cleanup-clustering*.py` rewrite **source files in place, with no backup**.

Not all of these are terminal commands — two are **browser console** snippets
that cannot run under Node. That distinction is called out per script.

| Script | Runs where | Confirmation |
|---|---|---|
| `reset-cache.js` | Node CLI (npm alias) | `--yes` / `-y` required |
| `clear-manual-tags.js` | **Browser DevTools console** | none |
| `clear-stacking-tags.js` | **Browser DevTools console** | none |
| `cleanup-clustering.py` | Python 3 (repo root) | none |
| `cleanup-clustering-v2.py` | Python 3 (repo root) | none |

### `reset-cache.js`

```bash
npm run reset-cache -- --yes
node scripts/reset-cache.js -y
```

Requires `--yes` or `-y` (checked with `process.argv.includes`, so position is
irrelevant). Without it the script prints a usage line and **exits 0** — note
that an aborted run is indistinguishable from a successful one by exit code
alone.

> ⚠️ **This deletes application data.** Quit the app first — see the note on
> step 1 below, which will kill it for you.

With the flag it:

1. Kills running processes — `electron.exe` (dev), `silkstack.exe` (packaged),
   and `SilkStack Image Browser.exe` on Windows; `pkill -f electron` /
   `pkill -f silkstack` on macOS and Linux
2. **Deletes the Electron userData directories** — both `silkstack` *and*
   `silkstack (Dev)`, since dev mode runs against a separate folder
   ([electron/main.mjs](../electron/main.mjs) appends ` (Dev)`). Per platform:
   `%APPDATA%\<name>` on Windows,
   `~/Library/Application Support/<name>` on macOS,
   `~/.config/<name>` on Linux
3. Clears `dist-electron`, `node_modules/.vite`, and `tsconfig.tsbuildinfo`
   from the **repo root**
4. Prints manual instructions for clearing browser data (it does not do this itself)

It reports each path as `cleared` or `not found`, so you can see exactly what
was removed.

> **Not touched, deliberately:** `silkstack-photos` is a *different application*
> — deleting it here would destroy another app's data. The pre-rename
> `ImageMetaHub` folders are likewise left alone.
>
> **Fixed 2026-09-10.** Every path in this script used to be wrong: it targeted
> the project's former name (`ImageMetaHub`, `ImageMetaHub.exe`) and built the
> build-artifact paths from `__dirname` (= `scripts/`) instead of the repo root,
> so it reported success while deleting nothing. Verified fixed by running it
> against a redirected `USERPROFILE` sandbox: both `silkstack` folders and all
> three build artifacts were removed, while `silkstack-photos` and
> `ImageMetaHub` survived.

**A safer alternative for some cases:** the app's own **Settings → Clear Cache**
button (`SettingsModal.tsx` → `utils/cacheReset.ts` → the `delete-cache-folder`
IPC handler) resolves the path via `app.getPath("userData")`, so it cannot drift
the way this script did. It is **much broader** though — its confirmation dialog
warns that it also deletes indexed metadata, loaded directories, thumbnails and
`localStorage` preferences — **and your license**, returning the app to the
unlicensed state. It auto-reloads when done. Use this script when you want the
caches gone but your license and preferences kept.

### `clear-manual-tags.js` — browser console only

**Not a Node script.** It's an IIFE using `indexedDB` and `location`, with no
argument parsing. Run it by pasting the file into the DevTools console with the
app open.

Empties only the `tags` array on every record in IndexedDB
`image-metahub-preferences` (v7) → store `imageAnnotations`. Auto-tags,
metadata-tags, and favourites are preserved. Reloads the page when done.

### `clear-stacking-tags.js` — browser console only

**Not a Node script.** Same IIFE pattern. Paste into the DevTools console, or
call the app's own `resetStacking()` function.

Clears `stackGroupId`, `similarityGroupId`, and `isStackAnalyzed` on every
`imageAnnotations` record, then removes the `similarityGroupVersion`
localStorage key so similarity is recomputed with the current threshold. Reloads
after 2 seconds.

### `cleanup-clustering.py` / `cleanup-clustering-v2.py`

```bash
python scripts/cleanup-clustering.py
python scripts/cleanup-clustering-v2.py
```

**One-time source refactors, not data tools.** They strip clustering-feature
code from the TypeScript sources — in-place, with no backup, no dry-run, and no
argument parsing. They do not touch IndexedDB, localStorage, or user data.

`cleanup-clustering.py` edits 5 files: `src/App.tsx`,
`src/components/Footer.tsx`, `src/services/cacheManager.ts`,
`src/services/fileIndexer.ts`, `src/services/imageAnnotationsStorage.ts`.

`cleanup-clustering-v2.py` is the more aggressive follow-up (written to run
*after* deleting the clustering engine/worker/cache files) and edits 6 files,
including `src/store/useImageStore.ts`.

> ⚠️ **`cleanup-clustering-v2.py` has no `if __name__ == '__main__'` guard** —
> all of its edits run at module top level, so merely *importing* the file
> rewrites your sources. It ends by advising you to run `npx tsc --noEmit`.

Both are historical migration scripts tied to a specific past refactor; running
them against the current tree will most likely report few or no changes, but
review the source before use.

---

## 5. Application launch flags

The Electron main process ([`electron/main.mjs`](../electron/main.mjs)) accepts
arguments at launch:

| Argument | Effect |
|---|---|
| `--dev` | Force development mode |
| `--dist` | Load from the build output (`dist/`) instead of the Vite dev server |
| `--dir <path>` | Open the app with `<path>` as the startup directory |
| `<path>` | Bare path argument — same as `--dir`, used when no `--dir` is present |

```bash
# After `npm run build`, launch against the build output instead of the dev server
npx electron . --dist

# Launch with a specific library folder
npx electron . --dir "C:\images"
npx electron . "C:\images"      # equivalent bare-path form
```

`--dev` and `--dist` are both checked at each window load (`isDev && !--dist`),
so `--dist` overrides an ambient dev environment.

---

## 6. Running the CLI in Docker

The repo ships a [`Dockerfile`](../Dockerfile) (Node 22 slim + `npm ci`, dev
deps kept so `tsx` can run TypeScript directly). Its entrypoint is
`npx tsx scripts/cli.ts`, so anything after the image name is passed to the
CLI as arguments:

```bash
docker build -t silkstack-cli:local .

# Recursive index of a mounted folder
docker run --rm \
  -v /host/images:/data -v /host/output:/out \
  silkstack-cli:local index /data --out /out/index.jsonl --recursive --raw --concurrency 8 --quiet

# Single file
docker run --rm -v /host/images:/data silkstack-cli:local parse /data/image.png --pretty --quiet
```

The CLI writes to stdout, so you can pipe the container output directly. On
Windows, mount with a Windows-style path (`-v C:\images:/data`).

> **Note:** the image tag in the old `CLI-README.md` was `imagemetahub-cli:local`
> and the entrypoint pointed at a root-level `cli.ts` that no longer exists —
> both were fixed when that file was retired into this one.

---

## Related documentation

| Document | Scope |
|---|---|
| [comfy-cli-tools.md](comfy-cli-tools.md) | Deep dive on the ComfyUI parsers — output schemas, supported node types, jq/PowerShell/Python examples |
| [RELEASE-AUTOMATION.md](RELEASE-AUTOMATION.md) | Release script walkthrough (Portuguese) |
| [RELEASE-GUIDE.md](RELEASE-GUIDE.md) | Maintainer release checklist |
