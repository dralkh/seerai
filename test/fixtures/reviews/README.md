# Review pipeline fixtures

Each JSON file is a complete systematic-review test case: a protocol, an
extraction template, several included primary studies (each with its own
groundable source text + gold per-study extraction), and gold expectations for
the **synthesis** and **gap-analysis** stages. Together they exercise every
branch of the measure taxonomy and the full pipeline
(extraction → synthesis → gap analysis).

| Fixture                      | Regime           | Modeled on                                                                              | Exercises                                                                                                                            |
| ---------------------------- | ---------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `corticosteroids-or.json`    | ratio (OR)       | WHO REACT corticosteroids-for-COVID meta-analysis (Sterne et al., _JAMA_ 2020)          | log-OR inverse-variance pooling, low heterogeneity, GRADE "moderate" → **adequate** outcome; a single-study outcome → **sparse gap** |
| `meditation-smd.json`        | continuous (SMD) | Goyal et al., meditation programs for stress/well-being (_JAMA Intern Med_ 2014)        | continuous (SMD) pooling, a consistent outcome → **adequate**; a deliberately discordant outcome → **conflicting gap**               |
| `dl-imaging-diagnostic.json` | diagnostic       | Liu et al., deep learning vs clinicians in medical imaging (_Lancet Digit Health_ 2019) | AUROC / sensitivity / specificity recognised as first-class but **non-poolable → narrative**, surfaced as coverage gaps              |

## Important: the numbers are representative test data

Per-study effect sizes, confidence intervals, and sample sizes are _illustrative_
values structured to match each review's design; they are **not** verbatim
transcriptions of the cited papers. Grounding is evaluated against the `source`
text inside each fixture (which is internally consistent), so the fixtures are
fully functional today and can be swapped for real extracted PDF text later
without touching the harness.

## How they're used

- **Deterministic regression** (`npm test`, no network):
  `test/systematicReviewPipeline.test.ts` feeds the gold rows straight into
  `buildSynthesisRun` + `buildGapAnalysisRun` and asserts the synthesis/gap gold.
  This proves the expectations are achievable and that the engine wiring is sound.
- **Live model eval** (`npm run test:pipeline-eval`, hits the `.env` models):
  `test/pipelineEval.ts` runs the real extraction prompt over each study with
  model1 (`LLM_MODEL`) and model2 (`LLM_MODEL2`), auto-verifies the surviving
  rows, runs the same engine, and scores extraction/synthesis/gap against the
  gold. A full log is written to `test/logs/pipeline-eval-<timestamp>.md`.

## Fixture shape

```jsonc
{
  "id": "…", "title": "…", "citation": "…", "regime": "ratio|continuous|diagnostic",
  "protocol": { "framework": "PICOTS", "researchQuestion": "…", "values": { "P": "…", … } },
  "template": { /* full ExtractionTemplate */ },
  "studies": [
    { "paperId": 101, "label": "…", "source": "groundable text…",
      "expected": [ { "outcomeId": "mort", "effectType": "OR",
                      "effectSize": 0.66, "ciLow": 0.51, "ciHigh": 0.85,
                      "n": 403, "events": 116, "quote": "…", "tolerance": 0.03 } ] }
  ],
  "gold": {
    "synthesis": [ { "outcome": "…", "measure": "OR", "method": "random_effects",
                     "status": "poolable", "direction": "positive",
                     "minStudies": 4, "estimate": { "value": 0.68, "tolerance": 0.18 },
                     "i2Max": 60 } ],
    "narrativeOutcomes": ["…"],
    "gaps": { "expectGapOutcomes": ["…"], "expectAdequateOutcomes": ["…"] }
  }
}
```
