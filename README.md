# Extra Omnes

Single-file browser simulations of historical papal conclaves. Each variant is playable as a standalone HTML page and can also expose a small headless API for regression testing.

## Variant Status

- `1492.html` — complete/stable baseline.
- `viterbo-1268.html` — alpha.
- `carafa-winter-1559.html` — alpha.
- `venice-1800.html` — alpha.
- `1903.html` — beta.
- `october-1978.html` — alpha.
- `constance-1417.html` — alpha.

## Local Use

Open `index.html` in a browser, or serve this directory with any static file server.

The games need no build step or runtime package. Their typography requests Google Fonts when online and falls back to local serif/monospace faces when offline. Engine changes should remain testable through explicit exports such as `runHeadless`, `initState`, and ballot-resolution functions.

## Regression Harness

The project-level harness is in `tests/harness.js`. It loads the same embedded engines used by the browser, exercises each page's UI bootstrap against a minimal DOM, and runs every variant in an isolated, time-limited worker. Use Node 22 to match CI.

Run the quick release gate from this directory with Node:

```bash
node tests/harness.js
```

Run representative-player soak tests before publishing engine or balance changes:

```bash
node tests/harness.js --seeds=20
```

Use every playable cardinal for a much slower one-seed compatibility pass:

```bash
node tests/harness.js --seeds=1 --full --timeout-ms=1800000
```

`--seeds=N` uses the three representative players for each game unless combined with `--quick` or `--full`. `--timeout-ms=N` is a per-variant worker timeout. Unknown, contradictory, missing-value, and malformed options are rejected rather than silently ignored.

The harness fails on:

- missing or duplicate cardinal IDs;
- missing configured players or engine exports;
- runtime errors, timeouts, deadlocks, or non-deterministic runs;
- self-votes, unknown names, duplicate approvals, excess names, duplicate voters, illegal or repeated accessions, or tally/roll disagreement;
- thresholds that do not match the variant's historical rule;
- a correction pass changing the player's submitted ballot;
- Viterbo blank-ballot or accessus validation regressions;
- Herzan voting before arrival;
- missing navigation, reduced-motion, live-status, or key historical anchors.

The report also prints winner distributions and ballot-count summaries. Threshold policy is variant-specific: October 1978 uses the two-thirds-plus-one rule in Paul VI's *Romano Pontifici Eligendo*. The minimal-DOM bootstrap and presentation-RNG probes catch common integration errors, but they do not replace a final play-through in a current browser.

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

### Provenance spine

- **1492:** Francis A. Burkle-Young / *The Cardinals of the Holy Roman Church*; Ludwig von Pastor, *History of the Popes*, vol. V; Kenneth Setton; the standard 1492-conclave literature. Individual relationships, prices and dialogue are modelled where the record is incomplete.
- **1268–71:** J. P. Adams, *Sede Vacante 1268–1271*; Richard Sternfeld; Cristofori; Burkle-Young. The page itself labels documented events, modelled tallies and later legends separately.
- **1559:** Salvador Miranda's conclave roster; Ludwig von Pastor; Kenneth Setton, *The Papacy and the Levant*; surviving diplomatic and conclave narratives. The exact ordinary ballot rolls are modelled, while the documented acclamation and confirmatory scrutiny anchor the ending.
- **1799–1800:** J. P. Adams, *Sede Vacante 1799–1800*; Ercole Consalvi's *Mémoires*; R. Obechea on Lorenzana and the Venice conclave. Game rounds represent documented shifts rather than claiming to reproduce every lost ballot.
- **1903:** J. P. Adams, *Sede Vacante 1903*; François-Désiré Mathieu's contemporary account; detailed 1903 conclave rosters and scholarship on the Austro-Hungarian veto. Historical aggregate tallies anchor the pressure model while individual rolls remain simulated.
- **October 1978:** Paul VI's *Romano Pontifici Eligendo*; official Vatican biographies; contemporary and retrospective conclave accounts. Historical ballot papers remain secret: every displayed vote is exact model output, not a claimed reconstruction.
- **1417:** J. P. Adams, *Sede Vacante 1417*, built on Cardinal Fillastre's conclave daybook (ap. Heinrich Finke, *Acta Concilii Constanciensis* ii); Ulrich Richental's chronicle for the city; Walsingham (used with caution) for the English deputation; Zurita for Aragon and Peñíscola; Eubel, *Hierarchia Catholica* i, and catholic-hierarchy.org for the College. The six-college rule, the roster of fifty-three, the second scrutiny's per-college counts and the "accedimus nos duo" accession are documented; the first scrutiny's exact distribution is modelled within Fillastre's stated constraints, and Beaufort of Winchester appears only as the rumour he historically was. The variant's election test is composite — two-thirds of the cardinals *and* of each of the five nations in the same scrutiny — so its ballot records carry per-college tallies rather than a single integer threshold, and the harness checks the six locks directly.

Each game should continue to distinguish roster facts, documented chronology, inferred relationships, procedural rules, gameplay abstractions and deliberately scripted historical pressure in its rules/source note.

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
