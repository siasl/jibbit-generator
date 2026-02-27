import { execFileSync } from "node:child_process";
import { buildMergedPaletteFromDetection, detectColors, estimateNeededColorCount } from "../colorDetection.mjs";

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function nearestColorIndex(rgb, palette) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const dr = rgb[0] - p[0];
    const dg = rgb[1] - p[1];
    const db = rgb[2] - p[2];
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function kmeansReducePalette(imgData, k = 4, iters = 16) {
  const pixels = [];
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 20) continue;
    pixels.push([d[i], d[i + 1], d[i + 2]]);
  }
  if (!pixels.length) return [];

  const unique = [];
  const seen = new Set();
  for (const p of pixels) {
    const key = `${p[0]},${p[1]},${p[2]}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(p);
    }
    if (unique.length >= k) break;
  }

  const centroids = [];
  for (let i = 0; i < k; i++) centroids.push(unique[i % unique.length].slice());

  for (let step = 0; step < iters; step++) {
    const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (const px of pixels) {
      const idx = nearestColorIndex(px, centroids);
      sums[idx][0] += px[0];
      sums[idx][1] += px[1];
      sums[idx][2] += px[2];
      sums[idx][3] += 1;
    }
    for (let i = 0; i < k; i++) {
      if (!sums[i][3]) continue;
      centroids[i][0] = Math.round(sums[i][0] / sums[i][3]);
      centroids[i][1] = Math.round(sums[i][1] / sums[i][3]);
      centroids[i][2] = Math.round(sums[i][2] / sums[i][3]);
    }
  }
  return centroids;
}

function toHex(rgb) {
  return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function parseArgs(argv) {
  const out = { imagePath: "", resolution: 112, target: 4 };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--resolution" || arg === "-r") {
      out.resolution = clamp(parseInt(argv[++i], 10) || 112, 32, 256);
    } else if (arg === "--target" || arg === "-t") {
      out.target = clamp(parseInt(argv[++i], 10) || 4, 1, 4);
    } else if (!out.imagePath) {
      out.imagePath = arg;
    }
  }
  return out;
}

function probeSize(imagePath) {
  const output = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", imagePath],
    { encoding: "utf8" }
  );
  const parsed = JSON.parse(output);
  const stream = parsed.streams?.[0];
  if (!stream?.width || !stream?.height) throw new Error("Failed to probe image size");
  return { width: stream.width, height: stream.height };
}

function decodeWorkingImage(imagePath, resolution) {
  const src = probeSize(imagePath);
  const margin = clamp(Math.round(resolution * 0.08), 6, 24);
  const innerMax = Math.max(8, resolution - margin * 2);
  const scale = Math.min(innerMax / src.width, innerMax / src.height, 1);
  const width = Math.max(8, Math.round(src.width * scale));
  const height = Math.max(8, Math.round(src.height * scale));
  const outWidth = width + margin * 2;
  const outHeight = height + margin * 2;

  const vf = [`scale=${width}:${height}:flags=bicubic`, `pad=${outWidth}:${outHeight}:${margin}:${margin}:color=black@0`];
  const buffer = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", imagePath, "-vf", vf.join(","), "-f", "rawvideo", "-pix_fmt", "rgba", "-vframes", "1", "pipe:1"],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  if (buffer.length !== outWidth * outHeight * 4) {
    throw new Error(`Unexpected decoded byte length ${buffer.length} for ${outWidth}x${outHeight}`);
  }

  return {
    sourceWidth: src.width,
    sourceHeight: src.height,
    width: outWidth,
    height: outHeight,
    margin,
    data: new Uint8ClampedArray(buffer),
  };
}

function summarizeClusters(clusters, opaquePixels) {
  return clusters.map((c) => ({
    hex: toHex(c.rgb),
    rgb: c.rgb,
    share: +(c.count / Math.max(1, opaquePixels)).toFixed(4),
  }));
}

function main() {
  const { imagePath, resolution, target } = parseArgs(process.argv);
  if (!imagePath) {
    console.error("Usage: node tests/analyze-image-colors.mjs <image-path> [--resolution 112] [--target 4]");
    process.exit(1);
  }

  const working = decodeWorkingImage(imagePath, resolution);
  const imgData = { data: working.data };
  const detection = detectColors(imgData, working.width, working.height);
  const estimated = estimateNeededColorCount(imgData, working.width, working.height, 1, 4);
  const mergedPalette = buildMergedPaletteFromDetection(detection, target);
  const kmeansPalette = kmeansReducePalette(imgData, target, 18);

  console.log(JSON.stringify(
    {
      imagePath,
      sourceSize: [working.sourceWidth, working.sourceHeight],
      workingSize: [working.width, working.height],
      resolution,
      margin: working.margin,
      target,
      estimated,
      opaquePixels: detection.opaquePixels,
      backgroundIndex: detection.backgroundIndex,
      detectedColors: summarizeClusters(detection.colors, detection.opaquePixels),
      neededColors: summarizeClusters(detection.neededColors, detection.opaquePixels),
      reducedPaletteDetected: mergedPalette.map((rgb) => ({ hex: toHex(rgb), rgb })),
      reducedPaletteKmeans: kmeansPalette.map((rgb) => ({ hex: toHex(rgb), rgb })),
    },
    null,
    2
  ));
}

main();
