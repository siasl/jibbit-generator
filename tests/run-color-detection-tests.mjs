import assert from "node:assert/strict";
import { buildMergedPaletteFromDetection, detectColors, estimateNeededColorCount } from "../colorDetection.mjs";

function makeImageData(width, height, fill = [0, 0, 0, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    data[o] = fill[0];
    data[o + 1] = fill[1];
    data[o + 2] = fill[2];
    data[o + 3] = fill[3];
  }
  return { data, width, height };
}

function setPx(img, x, y, rgb, a = 255) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const o = (y * img.width + x) * 4;
  img.data[o] = rgb[0];
  img.data[o + 1] = rgb[1];
  img.data[o + 2] = rgb[2];
  img.data[o + 3] = a;
}

function rect(img, x0, y0, x1, y1, rgb, a = 255) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) setPx(img, x, y, rgb, a);
  }
}

function ringRect(img, x0, y0, x1, y1, thickness, rgb) {
  rect(img, x0, y0, x1, y0 + thickness - 1, rgb);
  rect(img, x0, y1 - thickness + 1, x1, y1, rgb);
  rect(img, x0, y0, x0 + thickness - 1, y1, rgb);
  rect(img, x1 - thickness + 1, y0, x1, y1, rgb);
}

function antialiasRing(img, x0, y0, x1, y1, rgb) {
  const shade1 = rgb.map((v) => Math.max(0, Math.min(255, Math.round(v * 0.82))));
  const shade2 = rgb.map((v) => Math.max(0, Math.min(255, Math.round(v * 0.62))));
  ringRect(img, x0 - 1, y0 - 1, x1 + 1, y1 + 1, 1, shade1);
  ringRect(img, x0 - 2, y0 - 2, x1 + 2, y1 + 2, 1, shade2);
}

function runAltaLikeTest() {
  const img = makeImageData(96, 96, [0, 0, 0, 255]);
  const white = [239, 239, 241];
  const blue = [29, 36, 133];
  const red = [229, 24, 39];

  rect(img, 20, 18, 75, 78, white);
  ringRect(img, 20, 18, 75, 78, 3, blue);
  antialiasRing(img, 20, 18, 75, 78, blue);
  rect(img, 26, 42, 68, 58, red);
  antialiasRing(img, 26, 42, 68, 58, red);

  const detection = detectColors(img, img.width, img.height);
  const estimated = estimateNeededColorCount(img, img.width, img.height, 2, 4);

  assert.ok(detection.colors.length <= 8, `generalized color groups too high: ${detection.colors.length}`);
  assert.equal(estimated, 3);
}

function runSnowbirdLikeTest() {
  const img = makeImageData(100, 70, [255, 255, 255, 255]);
  const black = [21, 21, 26];
  const blue = [22, 153, 210];
  const green = [82, 182, 68];

  rect(img, 12, 8, 88, 23, black);
  antialiasRing(img, 12, 8, 88, 23, black);
  rect(img, 18, 28, 46, 62, blue);
  rect(img, 54, 28, 82, 62, green);
  antialiasRing(img, 18, 28, 46, 62, blue);
  antialiasRing(img, 54, 28, 82, 62, green);

  const detection = detectColors(img, img.width, img.height);
  const estimated = estimateNeededColorCount(img, img.width, img.height, 2, 4);

  assert.ok(detection.backgroundIndex >= 0, "expected background detection");
  assert.equal(estimated, 3);
}

function runWebpLikeMarginBackgroundTest() {
  // Simulate a logo rendered onto transparent margins (current working-pixel flow).
  // The white card area should still be treated as background, preserving blue+red print colors.
  const img = makeImageData(120, 120, [0, 0, 0, 0]);
  const white = [246, 246, 247];
  const blue = [43, 56, 155];
  const red = [240, 32, 43];

  rect(img, 18, 12, 102, 108, white);
  rect(img, 26, 48, 96, 82, blue);
  rect(img, 30, 20, 43, 35, red);
  rect(img, 78, 18, 94, 33, red);

  const detection = detectColors(img, img.width, img.height);
  const estimated = estimateNeededColorCount(img, img.width, img.height, 1, 4);
  const palette = buildMergedPaletteFromDetection(detection, 3);

  assert.ok(detection.backgroundIndex >= 0, "expected white card to be detected as background");
  assert.ok(detection.neededColors.length >= 2, `expected at least 2 foreground colors, got ${detection.neededColors.length}`);
  assert.ok(estimated >= 2, `expected at least 2 estimated colors, got ${estimated}`);
  const hasBlue = palette.some((p) => p[2] > p[0] + 25 && p[2] > p[1] + 15);
  const hasRed = palette.some((p) => p[0] > p[2] + 45 && p[0] > p[1] + 20);
  assert.ok(hasBlue, `expected blue-like cluster in merged palette, got ${JSON.stringify(palette)}`);
  assert.ok(hasRed, `expected red-like cluster in merged palette, got ${JSON.stringify(palette)}`);
}

const tests = [
  ["ALTA-like logo", runAltaLikeTest],
  ["Snowbird-like logo", runSnowbirdLikeTest],
  ["WebP-like with transparent margins", runWebpLikeMarginBackgroundTest],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(err.message);
  }
}

if (failed > 0) process.exit(1);
console.log("All color detection tests passed.");
