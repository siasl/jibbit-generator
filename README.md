# Jibbitz 3D Generator

A browser app that turns an uploaded image into a 3D printable Jibbitz model with up to 4 color regions.

## What it does

- Upload an image.
- Detect whether the image already has 4 or fewer colors.
- If yes: use those colors directly.
- If not: reduce to 2-4 colors and let you customize the palette.
- Generate a 3D charm with:
  - base body
  - top color layers
  - either:
    - back Jibbitz stem + cap
    - top keychain loop attachment
- Export printable STL files:
  - combined STL
  - per-layer STLs (`base`, each `color_n`, and `stem` or `keychain-loop`) for multi-material workflows.
- Export color 3MF and optionally launch Bambu Studio with the exported file path using the `Open 3MF in Bambu Studio` button.

## Run

Because the app uses JavaScript modules, serve it from a local web server:

```bash
cd "/path/to/Jibbitz Generator"
python3 -m http.server 8000
```

Then open:

- http://localhost:8000

## Dependency policy

- Runtime dependencies are vendored and version-pinned in this repo:
  - `vendor/three` -> `three@0.161.0`
  - `vendor/jszip/jszip.esm.min.js` -> `jszip@3.10.1`
- GitHub Pages does not need third-party CDN script/font fetches at runtime.

## Suggested print workflow

- Single-material: export `jibbitz-combined.stl`.
- Multi-color/material: export each layer STL and assign different filaments/colors in your slicer.


## Automated test gate (pre-commit)

This repo uses a Git pre-commit hook to block commits if color detection tests fail.

Current hook path:

```bash
git config --get core.hooksPath
```

Manual run:

```bash
node tests/run-color-detection-tests.mjs
```
