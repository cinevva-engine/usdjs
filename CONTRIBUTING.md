## Contributing

Thanks for taking the time to contribute.

### What we’re trying to build

`@cinevva/usdjs` is a **pure JS/TS** USD core with a **practical** scope. We optimize for:

- correctness on real corpora
- deterministic behavior
- small API surface and low dependency footprint

We do *not* aim for full OpenUSD parity in one shot.

### Ground rules

- **Be corpus-driven**: add or reference a real file that demonstrates the issue when possible.
- **Keep changes tight**: prefer small, reviewable PRs.
- **No silent behavior changes**: if a fix changes observable behavior, document it and add a test.

### Development

```bash
npm i
npm run typecheck
npm run test
```

### Tests

- Unit tests: `npm run test`
- Corpus tests: `npm run test:corpus` (may require external corpora)
- Perf tests: `npm run perf`

### Reporting gaps

If your USD file doesn’t load:

- Provide a minimal reproduction (or a link to a publicly licensed asset)
- Include expected behavior (Pixar OpenUSD, usdcat output, or a viewer screenshot)
- Include `usdjs` version and environment (Node/browser)

