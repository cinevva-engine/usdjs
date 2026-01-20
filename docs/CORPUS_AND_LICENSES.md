## Corpus and third‑party licensing notes

This repository includes test corpora under `test/corpus/` to validate behavior against real-world files.

### What’s included

- Curated JSON manifests and small samples.
- Some third‑party corpora are vendored under `test/corpus/external/` to enable repeatable CI and debugging.

### Important

- **Each external corpus remains under its own license**, typically included alongside the files (e.g. `LICENSE.md` inside the extracted corpus).
- If you redistribute or mirror this repository, ensure you comply with those third‑party licenses.

### Why keep corpora in-repo?

USD compatibility work is corpus-driven. Tests that only use synthetic files miss the real compatibility cliffs:

- authoring variations across DCC tools
- composition patterns in the wild
- crate value types and compression paths that only appear in real assets

