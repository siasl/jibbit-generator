# Jibbitz 3D Generator

A browser app that turns an uploaded image into a 3D printable Jibbitz model with up to 4 color regions.

## What it does

- Upload an image.
- Detect whether the image already has 4 or fewer colors.
- If yes: use those colors directly.
- If not: reduce to 2-4 colors and let you customize the palette.
- Generate a 3D Jibbitz with:
  - base body
  - top color layers
  - back stem + cap
- Export printable STL files:
  - combined STL
  - per-layer STLs (`base`, each `color_n`, and `stem`) for multi-material workflows.

## Run

Because the app uses JavaScript modules, serve it from a local web server:

```bash
cd "/Users/silashowe/Jibbitz Generator"
python3 -m http.server 8000
```

Then open:

- http://localhost:8000

## Suggested print workflow

- Single-material: export `jibbitz-combined.stl`.
- Multi-color/material: export each layer STL and assign different filaments/colors in your slicer.

