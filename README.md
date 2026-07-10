# Extra Omnes

Single-file browser simulations of historical papal conclaves. Each variant is playable as a standalone HTML page and can also expose a small headless API for regression testing.

## Variant Status

- `1492.html` — complete/stable baseline.
- `viterbo-1268.html` — alpha.
- `carafa-winter-1559.html` — alpha; no headless API yet.
- `venice-1800.html` — alpha.
- `october-1978.html` — alpha.

## Local Use

Open `index.html` in a browser, or serve this directory with any static file server.

The files are intentionally self-contained for GitHub Pages deployment. Engine changes should still be kept testable through explicit exports such as `runHeadless`, `initState`, and ballot-resolution functions.

## Regression Harness

The first project-level harness is in `tests/harness.js`.

Run from this directory with Node:

```bash
node tests/harness.js --seeds=80
```

Use a larger seed count before publishing balance or engine changes:

```bash
node tests/harness.js --seeds=500 --full
```

The harness checks, where the variant exposes enough engine API:

- identical seed and player produce identical histories;
- no recorded self-votes;
- recorded thresholds match the active electorate;
- runtime errors are reported by variant;
- winner distribution and ballot-count summaries are printed.

Variants without a headless API are reported as skipped rather than silently ignored.

## Seed and Replay Semantics

A seed should determine hidden initial variance and ballot randomness. Rendering, opening dossiers, filtering rosters, and resizing must not consume simulation randomness or change future ballots.

For any variant with a headless API, repeated calls with the same seed and action path should produce byte-identical ballot histories.

## Historical Scripting

These games mix historical reconstruction with counterfactual play. Each variant should make clear which mechanics are:

- roster facts;
- inferred relationships or blocs;
- procedural constraints;
- deliberately scripted historical pressure;
- sandboxable abstractions.

The long-term goal is for each variant to include an explicit source/provenance section for these categories.

## Adding or Refactoring a Variant

Keep the deployable HTML single-file if useful, but preserve these internal sections:

- cardinal data;
- historical state and scripted events;
- pure engine functions;
- AI/utility functions;
- UI/rendering;
- persistence;
- test exports.

Rendering code must read state only. It must not mutate the engine or consume random numbers.
