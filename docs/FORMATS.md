## Formats (USDA / USDC / USDZ)

This repo implements parsers/utilities for the formats below.

### USDA (`.usda`) — text

- Human-readable, diff-friendly.
- Often used for “interface” or “edit” layers.

OpenUSD references:
- OpenUSD spec overview: [https://openusd.org/release/spec.html](https://openusd.org/release/spec.html)
- Formats FAQ: [https://openusd.org/release/usdfaq.html](https://openusd.org/release/usdfaq.html)

### USDC (`.usdc`) — binary “crate”

- Compact, optimized for load time and random access.
- `.usd` files may be either text or crate; crate files start with the magic header `PXR-USDC`.

OpenUSD references:
- Formats FAQ: [https://openusd.org/release/usdfaq.html](https://openusd.org/release/usdfaq.html)

Implementation notes:
- Crate decoding parity notes live at `src/usdc/PIXAR_PARITY.md`.

### USDZ (`.usdz`) — package

USDZ is a read-only, uncompressed ZIP container with constraints intended to enable efficient access.

OpenUSD reference:
- USDZ specification: [https://openusd.org/release/spec_usdz.html](https://openusd.org/release/spec_usdz.html)

Key constraints (high level):
- entries are **stored** (no compression), not encrypted
- entry data must be aligned (commonly 64-byte alignment)

