# MPL-2.0 Covered Sources — SilkStack

These files are the **corresponding Source Code Form** for the MPL-2.0-covered
portions of SilkStack (a fork of Image-MetaHub), published in accordance with
the compliance exchange with the Image-MetaHub author (audit email of
2026-08-21) and MPL-2.0 §3.1/§3.2. They are the same files that ship
(transpiled) inside releases **v2.0.0, v2.1.0, v2.2.0 and all later releases**,
and they are the source offer referenced on the release pages.

Each file carries an MPL-2.0 header. The full license text is in
[LICENSE](LICENSE) (Mozilla Public License 2.0).

## File mapping

At build time these files live inside the private `@ai-images-browser/ai-intelligence`
module, which is why the drop's paths differ from the module's paths. The
"Origin lineage" column records the upstream Image-MetaHub source each file
derives from, with the verified blob/commit references used in the audit.

| File (this directory) | Origin lineage (upstream) | Verified reference |
| --- | --- | --- |
| `stacking-similarity.ts` | Prompt-similarity metrics (`utils/similarityMetrics.ts`) + the similarity-grouping worker (`computeSimilarityGroups`) | `utils/similarityMetrics.ts` blob `683b2c14ff6f0321694da2ae1ced852949ccf1c5` at v0.13.0; worker logic retained from the public repo |
| `autoTagWorker.ts` | Auto-tagging worker route (`src/services/workers/autoTaggingWorker.ts`), consolidated into the single AI worker at `97be3b2` | `autoTaggingWorker.ts` blob `b196a129a5558a89f2a72822c4314e740b617728` at v0.13.0 |
| `StackCard.tsx` | `src/components/StackCard.tsx` (109 lines) | moved at `6c38fd6` (109 → 121 lines; only an `onContextMenu` handler added) |
| `SimilarityStackExpandedView.tsx` | `src/components/SimilarityStackExpandedView.tsx` (443 lines) | moved at `6c38fd6` (443 → 511 lines; store-wiring changed to props) |
| `useImageStacking.ts` | `src/hooks/useImageStacking.ts` lineage | public hook, moved into the module and extended |
| `stacking-types.ts` | Structural type subset of the public `IndexedImage`/`ImageStack` types | no independent logic — types only |

## Reproducing the release archive

From v2.4.0 onward, the archive attached to each release is built with
[`scripts/build-mpl-archive.py`](../scripts/build-mpl-archive.py) and nowhere
else:

```sh
python3 scripts/build-mpl-archive.py <version> --out-dir .
```

The script is byte-reproducible — entries sorted by name, stored uncompressed,
fixed timestamps and host-independent metadata — so anyone can rebuild a
release's archive and get the identical SHA-256 the release notes cite. CI
enforces this: the release workflow rebuilds the archive from the tag and
refuses to publish unless the digest matches the one committed in the notes
(`.github/workflows/release.yml`). Do not build this archive with a different
tool; `Compress-Archive`, `zip` and friends embed host- and version-dependent
metadata and will not match.

## Notes

- **Not covered:** the LLM tag generator, the shared WebGPU engine and model
  catalog, the embedding/semantic-search pipeline, the license system, and the
  stacking-engine orchestration (worker lifecycle, watchdog) are independently
  developed and remain closed. The files above reference some of those closed
  modules at runtime; under MPL-2.0 §3.3 (Larger Work) those dependencies are
  not themselves covered by this drop.
- **Split provenance:** `stacking-similarity.ts` was split out of the module's
  `stacking-engine.ts` and `autoTagWorker.ts` out of `aiWorker.ts` on
  2026-08-28 so that only covered code lands in this drop. The module's files
  are byte-identical to the drop's files at publish time.
- **Build provenance:** each release pins and records the private module
  revision it was built from; see the release notes for the mapping.
