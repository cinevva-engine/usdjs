# Contributing

Thanks for taking the time to contribute.

## What We're Building

`@cinevva/usdjs` is a reference-quality OpenUSD implementation in pure TypeScript. We're working toward full spec correctness.

Our priorities:

**Correctness first.** We verify behavior against Pixar's C++ implementation. When there's ambiguity, we match OpenUSD.

**Corpus-validated.** Real USD files from production pipelines drive what we implement and how we test.

**Incremental progress.** We'd rather have fewer features that work correctly than more features that work "mostly."

## Ground Rules

**Be corpus-driven**: add or reference a real file that demonstrates the issue when possible.

**Verify against Pixar**: when implementing or fixing behavior, cross-reference with OpenUSD source. Document the mapping in comments or parity notes.

**Keep changes tight**: prefer small, reviewable PRs.

**No silent behavior changes**: if a fix changes observable behavior, document it and add a test.

## Development

```bash
npm i
npm run typecheck
npm run test
```

## Tests

Unit tests: `npm run test`

Corpus tests: `npm run test:corpus` (may require external corpora)

Perf tests: `npm run perf`

## Reporting Gaps

If your USD file doesn't load, provide:

A minimal reproduction (or a link to a publicly licensed asset).

Expected behavior (Pixar OpenUSD, usdcat output, or a viewer screenshot).

`usdjs` version and environment (Node/browser).
