function quantizedKey(r, g, b, a) {
  if (a < 20) return "transparent";
  // 4-bit channels to collapse anti-aliased shades into broader color families.
  return `${r >> 4},${g >> 4},${b >> 4}`;
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

function rgbToHsl(rgb) {
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) * 0.5;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s * 100, l * 100];
}

export function detectColors(imgData, width, height) {
  const map = new Map();
  const d = imgData.data;
  let opaquePixels = 0;
  let edgeOpaquePixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  const isEdgePixel = (p) => {
    const x = p % width;
    const y = Math.floor(p / width);
    return x === 0 || y === 0 || x === width - 1 || y === height - 1;
  };

  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const a = d[i + 3];
    if (a < 20) continue;
    opaquePixels += 1;
    const x = p % width;
    const y = Math.floor(p / width);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    const isEdge = isEdgePixel(p);
    if (isEdge) edgeOpaquePixels += 1;
    const key = quantizedKey(d[i], d[i + 1], d[i + 2], a);
    const item = map.get(key);
    if (item) {
      item.count += 1;
      item.sumR += d[i];
      item.sumG += d[i + 1];
      item.sumB += d[i + 2];
      if (isEdge) item.edgeCount += 1;
    } else {
      map.set(key, {
        key,
        count: 1,
        sumR: d[i],
        sumG: d[i + 1],
        sumB: d[i + 2],
        edgeCount: isEdge ? 1 : 0,
        bboxEdgeCount: 0,
      });
    }
  }

  // Track coverage on the opaque bounding-box edge so background stripping still works
  // when the working image has transparent margins.
  let bboxEdgeOpaquePixels = 0;
  if (maxX >= minX && maxY >= minY) {
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const a = d[i + 3];
      if (a < 20) continue;
      const x = p % width;
      const y = Math.floor(p / width);
      if (x !== minX && x !== maxX && y !== minY && y !== maxY) continue;
      bboxEdgeOpaquePixels += 1;
      const key = quantizedKey(d[i], d[i + 1], d[i + 2], a);
      const item = map.get(key);
      if (item) item.bboxEdgeCount += 1;
    }
  }

  const rawColors = [...map.values()]
    .map((c) => ({
      rgb: [Math.round(c.sumR / c.count), Math.round(c.sumG / c.count), Math.round(c.sumB / c.count)],
      count: c.count,
      edgeCount: c.edgeCount,
      bboxEdgeCount: c.bboxEdgeCount || 0,
    }))
    .sort((a, b) => b.count - a.count);

  // Keep smaller accent colors (common in logos) instead of dropping them too early.
  const minShare = 0.002;
  const significantRaw = rawColors.filter((c) => c.count / Math.max(1, opaquePixels) >= minShare);
  const candidateRaw =
    significantRaw.length >= 2 ? significantRaw : rawColors.slice(0, Math.min(6, Math.max(2, rawColors.length)));

  const distSq = (a, b) => {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    return dr * dr + dg * dg + db * db;
  };

  const mergeThresholdSq = 48 * 48;
  const merged = [];
  for (const c of candidateRaw) {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < merged.length; i++) {
      const d2 = distSq(c.rgb, merged[i].rgb);
      if (d2 < mergeThresholdSq && d2 < bestDist) {
        best = i;
        bestDist = d2;
      }
    }
    if (best === -1) {
      merged.push({
        rgb: c.rgb.slice(),
        count: c.count,
        edgeCount: c.edgeCount,
        bboxEdgeCount: c.bboxEdgeCount || 0,
        sumR: c.rgb[0] * c.count,
        sumG: c.rgb[1] * c.count,
        sumB: c.rgb[2] * c.count,
      });
    } else {
      const m = merged[best];
      m.count += c.count;
      m.edgeCount += c.edgeCount;
      m.bboxEdgeCount += c.bboxEdgeCount || 0;
      m.sumR += c.rgb[0] * c.count;
      m.sumG += c.rgb[1] * c.count;
      m.sumB += c.rgb[2] * c.count;
      m.rgb = [Math.round(m.sumR / m.count), Math.round(m.sumG / m.count), Math.round(m.sumB / m.count)];
    }
  }

  const colors = merged
    .map((c) => ({
      rgb: c.rgb,
      count: c.count,
      edgeCount: c.edgeCount,
      bboxEdgeCount: c.bboxEdgeCount || 0,
    }))
    .sort((a, b) => b.count - a.count);

  let backgroundIndex = -1;
  if (colors.length > 1) {
    const useBBoxEdge = bboxEdgeOpaquePixels > 0;
    const edgeDominant = colors.reduce((best, cur) => {
      const bestCount = useBBoxEdge ? best.bboxEdgeCount : best.edgeCount;
      const curCount = useBBoxEdge ? cur.bboxEdgeCount : cur.edgeCount;
      return curCount > bestCount ? cur : best;
    }, colors[0]);
    const edgeCoverage = useBBoxEdge
      ? edgeDominant.bboxEdgeCount / Math.max(1, bboxEdgeOpaquePixels)
      : edgeDominant.edgeCount / Math.max(1, edgeOpaquePixels);
    const areaCoverage = opaquePixels ? edgeDominant.count / opaquePixels : 0;
    const [, sat, light] = rgbToHsl(edgeDominant.rgb);
    // Only strip edge-dominant color as background when it looks background-like.
    const backgroundLike = sat < 24 || light > 70 || light < 18;
    if (edgeCoverage >= 0.45 && areaCoverage >= 0.12 && backgroundLike) {
      backgroundIndex = colors.indexOf(edgeDominant);
    }
  }

  const neededColors = colors.filter((_, idx) => idx !== backgroundIndex);
  return { colors, neededColors, backgroundIndex, opaquePixels };
}

function distSq(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

export function buildMergedPaletteFromDetection(detection, targetColors = 4) {
  const target = Math.max(1, Math.min(12, Math.round(targetColors || 4)));
  let pool = (detection.neededColors && detection.neededColors.length ? detection.neededColors : detection.colors).map((c) => ({
    rgb: c.rgb.slice(),
    count: Math.max(1, c.count || 1),
  }));
  if (!pool.length) return [];

  while (pool.length > target) {
    let bestI = 0;
    let bestJ = 1;
    let best = Infinity;
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const d2 = distSq(pool[i].rgb, pool[j].rgb);
        if (d2 < best) {
          best = d2;
          bestI = i;
          bestJ = j;
        }
      }
    }
    const a = pool[bestI];
    const b = pool[bestJ];
    const total = a.count + b.count;
    pool[bestI] = {
      rgb: [
        Math.round((a.rgb[0] * a.count + b.rgb[0] * b.count) / total),
        Math.round((a.rgb[1] * a.count + b.rgb[1] * b.count) / total),
        Math.round((a.rgb[2] * a.count + b.rgb[2] * b.count) / total),
      ],
      count: total,
    };
    pool.splice(bestJ, 1);
  }

  pool.sort((a, b) => b.count - a.count);
  return pool.map((p) => p.rgb.slice());
}

function sampleOpaquePixels(imgData, maxSamples = 12000, excludedRgb = null, excludedDist = 40) {
  const d = imgData.data;
  const pixels = [];
  const total = d.length / 4;
  const stride = Math.max(1, Math.floor(total / maxSamples));
  const excludedDistSq = excludedDist * excludedDist;
  for (let p = 0; p < total; p += stride) {
    const i = p * 4;
    if (d[i + 3] < 20) continue;
    const rgb = [d[i], d[i + 1], d[i + 2]];
    if (excludedRgb) {
      const dr = rgb[0] - excludedRgb[0];
      const dg = rgb[1] - excludedRgb[1];
      const db = rgb[2] - excludedRgb[2];
      if (dr * dr + dg * dg + db * db <= excludedDistSq) continue;
    }
    pixels.push(rgb);
  }
  return pixels;
}

function kmeansErrorForK(pixels, k, iters = 10) {
  if (!pixels.length) return { error: 0, palette: [] };
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
  for (let i = 0; i < k; i++) centroids.push((unique[i] || unique[i % unique.length]).slice());

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

  let sse = 0;
  for (const px of pixels) {
    const idx = nearestColorIndex(px, centroids);
    const c = centroids[idx];
    const dr = px[0] - c[0];
    const dg = px[1] - c[1];
    const db = px[2] - c[2];
    sse += dr * dr + dg * dg + db * db;
  }
  return { error: sse / pixels.length, palette: centroids };
}

export function estimateNeededColorCount(imgData, width, height, minK = 2, maxK = 4) {
  const detection = detectColors(imgData, width, height);
  if (detection.neededColors.length <= 1) {
    const dominantAll = detection.colors.filter((c) => c.count / Math.max(1, detection.opaquePixels) >= 0.02).length;
    if (dominantAll <= 1) return 1;
  }

  const effectiveMinK = detection.neededColors.length <= 1 ? Math.max(2, minK) : minK;

  const luminance = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const shareOf = (c) => c.count / Math.max(1, detection.opaquePixels);

  // Guard for logo/text cases: preserve black/dark text if it is a meaningful cluster.
  const darkClusters = detection.neededColors.filter((c) => luminance(c.rgb) < 70 && shareOf(c) >= 0.01);
  const vividClusters = detection.neededColors.filter((c) => luminance(c.rgb) >= 70 && shareOf(c) >= 0.025);
  if (darkClusters.length >= 1 && vividClusters.length >= 2) {
    return Math.max(3, minK);
  }

  const dominantNeeded = detection.neededColors.filter((c) => c.count / Math.max(1, detection.opaquePixels) >= 0.03);
  if (dominantNeeded.length >= effectiveMinK && dominantNeeded.length <= maxK) {
    return dominantNeeded.length;
  }

  const bgRgb = detection.backgroundIndex >= 0 ? detection.colors[detection.backgroundIndex].rgb : null;
  let pixels = sampleOpaquePixels(imgData, 12000, bgRgb, 42);
  if (pixels.length < 500) {
    // Fallback: do not exclude background if too little data remains.
    pixels = sampleOpaquePixels(imgData, 12000);
  }
  if (!pixels.length) return effectiveMinK;

  const errors = {};
  for (let k = effectiveMinK; k <= maxK; k++) {
    errors[k] = kmeansErrorForK(pixels, k, 10).error;
  }

  // Choose the smallest k where adding another color gives limited gain.
  let chosen = effectiveMinK;
  for (let k = effectiveMinK; k < maxK; k++) {
    const curr = errors[k];
    const next = errors[k + 1];
    if (curr <= 0) {
      chosen = k;
      break;
    }
    const improvement = (curr - next) / curr;
    if (improvement < 0.17) {
      chosen = k;
      break;
    }
    chosen = k + 1;
  }
  return chosen;
}
