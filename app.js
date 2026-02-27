import * as THREE from "https://unpkg.com/three@0.161.0/build/three.module.js";
import { OrbitControls } from "https://unpkg.com/three@0.161.0/examples/jsm/controls/OrbitControls.js";
import { STLExporter } from "https://unpkg.com/three@0.161.0/examples/jsm/exporters/STLExporter.js";
import { mergeGeometries, mergeVertices } from "https://unpkg.com/three@0.161.0/examples/jsm/utils/BufferGeometryUtils.js";
import JSZip from "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";
import { detectColors, estimateNeededColorCount } from "./colorDetection.mjs";

if (window.location.hostname === "[::]") {
  const safeHostUrl = `${window.location.protocol}//localhost:${window.location.port}${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.replace(safeHostUrl);
}

const imageInput = document.getElementById("imageInput");
const detectBtn = document.getElementById("detectBtn");
const quantizeBtn = document.getElementById("quantizeBtn");
const generateBtn = document.getElementById("generateBtn");
const applyPaletteBtn = document.getElementById("applyPaletteBtn");
const downloadCombinedBtn = document.getElementById("downloadCombinedBtn");
const download3mfBtn = document.getElementById("download3mfBtn");
const downloadStemBtn = document.getElementById("downloadStemBtn");
const layerExports = document.getElementById("layerExports");
const paletteEl = document.getElementById("palette");
const statusEl = document.getElementById("status");

const targetColorsInput = document.getElementById("targetColors");
const resolutionInput = document.getElementById("resolution");
const baseThicknessInput = document.getElementById("baseThickness");
const colorThicknessInput = document.getElementById("colorThickness");
const targetSizeMmInput = document.getElementById("targetSizeMm");
const nozzleMmInput = document.getElementById("nozzleMm");
const stemPaletteIndexSelect = document.getElementById("stemPaletteIndex");
const stemColorPreview = document.getElementById("stemColorPreview");
const geometryModeSelect = document.getElementById("geometryMode");
const baseShapeModeSelect = document.getElementById("baseShapeMode");
const baseShapePaddingInput = document.getElementById("baseShapePadding");
const baseShapePaddingValueEl = document.getElementById("baseShapePaddingValue");
const showBaseOverlayInput = document.getElementById("showBaseOverlay");
const cleanupIslandsInput = document.getElementById("cleanupIslands");
const cleanupMinSizeInput = document.getElementById("cleanupMinSize");
const cleanupMinSizeValueEl = document.getElementById("cleanupMinSizeValue");
const resolutionHelpEl = document.getElementById("resolutionHelp");
const baseThicknessInchesEl = document.getElementById("baseThicknessInches");
const colorThicknessInchesEl = document.getElementById("colorThicknessInches");
const targetSizeInchesEl = document.getElementById("targetSizeInches");
const nozzleInchesEl = document.getElementById("nozzleInches");

const originalCanvas = document.getElementById("originalCanvas");
const processedCanvas = document.getElementById("processedCanvas");
const octx = originalCanvas.getContext("2d", { willReadFrequently: true });
const pctx = processedCanvas.getContext("2d", { willReadFrequently: true });

let sourceImage = null;
let imageData = null;
let reduced = null;
let currentPalette = [];
let currentColorLabels = [];
let modelGroup = null;
let layerMeshes = [];

const state = {
  width: 0,
  height: 0,
  alphaMask: null,
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf8fbff);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
camera.position.set(0, 0, 120);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const viewer = document.getElementById("viewer");
viewer.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 8);

const hemi = new THREE.HemisphereLight(0xffffff, 0x8fa9c6, 1.1);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(30, -30, 55);
scene.add(dir);

const grid = new THREE.GridHelper(180, 24, 0xd3deec, 0xe3ebf6);
grid.position.z = -0.03;
scene.add(grid);

function resizeRenderer() {
  const w = viewer.clientWidth;
  const h = Math.max(320, viewer.clientHeight);
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resizeRenderer);
resizeRenderer();

function animate() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.background = isError ? "#ffeef0" : "#edf3ff";
  statusEl.style.color = isError ? "#8a1f2f" : "#264577";
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function roundToStep(v, step = 8) {
  return Math.max(step, Math.round(v / step) * step);
}

function mmToInText(mm) {
  const inches = mm / 25.4;
  return `${mm.toFixed(2)} mm = ${inches.toFixed(3)} in`;
}

function toHex([r, g, b]) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(hex) {
  const v = hex.replace("#", "");
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function tintHex(hex, factor) {
  const [r, g, b] = hexToRgb(hex);
  return toHex([
    clamp(Math.round(r * factor), 0, 255),
    clamp(Math.round(g * factor), 0, 255),
    clamp(Math.round(b * factor), 0, 255),
  ]);
}

function toTitleCase(text) {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

function rgbToHsl([r, g, b]) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (delta > 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s * 100, l * 100];
}

function approximateColorName(rgb) {
  const [h, s, l] = rgbToHsl(rgb);
  if (s < 12) {
    if (l < 10) return "black";
    if (l < 24) return "charcoal";
    if (l < 45) return "gray";
    if (l < 72) return "silver";
    return "white";
  }

  let base;
  if (h < 15 || h >= 345) base = "red";
  else if (h < 35) base = l < 45 ? "brown" : "orange";
  else if (h < 56) base = l < 45 ? "brown" : "yellow";
  else if (h < 85) base = "lime";
  else if (h < 160) base = "green";
  else if (h < 192) base = "teal";
  else if (h < 220) base = "cyan";
  else if (h < 252) base = "blue";
  else if (h < 276) base = "indigo";
  else if (h < 306) base = "purple";
  else if (h < 336) base = "magenta";
  else base = "rose";

  if (base === "brown" && l > 62) return "tan";

  let tone = "";
  if (l < 22) tone = "dark";
  else if (l > 78) tone = "light";
  else if (s < 35) tone = "muted";

  return tone ? `${tone} ${base}` : base;
}

function buildUniqueColorLabels(palette) {
  const counts = new Map();
  const out = [];
  for (const rgb of palette) {
    const base = approximateColorName(rgb);
    const next = (counts.get(base) || 0) + 1;
    counts.set(base, next);
    out.push(next === 1 ? base : `${base} ${next}`);
  }
  return out;
}

function sanitizePartName(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "color";
}

function getResolutionRecommendation() {
  const targetMm = clamp(parseFloat(targetSizeMmInput.value) || 30, 12, 60);
  const nozzleMm = clamp(parseFloat(nozzleMmInput.value) || 0.4, 0.2, 1.2);
  // Oversample analysis grid 2x so contour extraction is smoother than nozzle-sized voxels.
  const rawRecommended = (targetMm / nozzleMm) * 2;
  const recommended = clamp(roundToStep(rawRecommended, 8), 32, 256);
  const current = clamp(parseInt(resolutionInput.value, 10) || 112, 32, 256);
  const pixelMm = targetMm / current;
  return { targetMm, nozzleMm, recommended, current, pixelMm };
}

function updateResolutionGuidance() {
  const { targetMm, nozzleMm, recommended } = getResolutionRecommendation();
  resolutionInput.value = String(recommended);
  const pixelMm = targetMm / recommended;
  const relation = pixelMm < nozzleMm ? "finer than your nozzle" : "printable for your nozzle";
  resolutionHelpEl.textContent =
    `Current grid cell: ${pixelMm.toFixed(2)} mm. With nozzle ${nozzleMm.toFixed(2)} mm and target ${targetMm.toFixed(0)} mm, ` +
    `recommended resolution is ${recommended}. (${recommended} is ${relation})`;
}

function updateUnitHints() {
  const baseMm = clamp(parseFloat(baseThicknessInput.value) || 1.8, 0.8, 6);
  const colorMm = clamp(parseFloat(colorThicknessInput.value) || 0.8, 0.2, 3);
  const targetMm = clamp(parseFloat(targetSizeMmInput.value) || 30, 12, 60);
  const nozzleMm = clamp(parseFloat(nozzleMmInput.value) || 0.4, 0.2, 1.2);
  baseThicknessInchesEl.textContent = mmToInText(baseMm);
  colorThicknessInchesEl.textContent = mmToInText(colorMm);
  targetSizeInchesEl.textContent = mmToInText(targetMm);
  nozzleInchesEl.textContent = mmToInText(nozzleMm);
}

function updateStemPreview(hex) {
  stemColorPreview.style.backgroundColor = hex;
}

function getStemHexFromSelection() {
  if (!currentPalette.length) return "#E7EDF5";
  const idx = clamp(parseInt(stemPaletteIndexSelect.value || "0", 10), 0, currentPalette.length - 1);
  const rgb = currentPalette[idx] || currentPalette[0];
  return toHex(rgb).toUpperCase();
}

function setStemOptionLabel(idx, hex, colorLabel = "") {
  const opt = stemPaletteIndexSelect.options[idx];
  if (!opt) return;
  const displayName = colorLabel ? toTitleCase(colorLabel) : `Color ${idx + 1}`;
  opt.textContent = `${displayName} ${hex}`;
}

function syncStemSelectionOptions(palette) {
  const labels = buildUniqueColorLabels(palette);
  const prev = clamp(parseInt(stemPaletteIndexSelect.value || "0", 10), 0, Math.max(0, palette.length - 1));
  stemPaletteIndexSelect.innerHTML = "";
  if (!palette.length) {
    stemPaletteIndexSelect.disabled = true;
    updateStemPreview("#E7EDF5");
    return;
  }

  palette.forEach((rgb, idx) => {
    const hex = toHex(rgb).toUpperCase();
    const option = document.createElement("option");
    option.value = String(idx);
    option.textContent = `${toTitleCase(labels[idx])} ${hex}`;
    stemPaletteIndexSelect.appendChild(option);
  });

  stemPaletteIndexSelect.value = String(Math.min(prev, palette.length - 1));
  stemPaletteIndexSelect.disabled = false;
  updateStemPreview(getStemHexFromSelection());
}

function drawImageScaled(img) {
  octx.clearRect(0, 0, originalCanvas.width, originalCanvas.height);
  const scale = Math.min(originalCanvas.width / img.width, originalCanvas.height / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const x = (originalCanvas.width - w) / 2;
  const y = (originalCanvas.height - h) / 2;
  octx.drawImage(img, x, y, w, h);
}

function getWorkingPixels(maxDim) {
  const img = sourceImage;
  const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
  const w = Math.max(8, Math.round(img.width * scale));
  const h = Math.max(8, Math.round(img.height * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  return { data, width: w, height: h };
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

function kmeansReduce(imgData, k = 4, iters = 16) {
  const pixels = [];
  const alphaMask = [];
  const d = imgData.data;

  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 20) {
      alphaMask.push(0);
      continue;
    }
    alphaMask.push(1);
    pixels.push([d[i], d[i + 1], d[i + 2]]);
  }

  if (!pixels.length) {
    return { palette: [], indexed: new Int16Array(alphaMask.length).fill(-1), alphaMask: Uint8Array.from(alphaMask) };
  }

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
      if (sums[i][3]) {
        centroids[i][0] = Math.round(sums[i][0] / sums[i][3]);
        centroids[i][1] = Math.round(sums[i][1] / sums[i][3]);
        centroids[i][2] = Math.round(sums[i][2] / sums[i][3]);
      }
    }
  }

  const indexed = new Int16Array(alphaMask.length).fill(-1);
  let p = 0;
  for (let i = 0; i < alphaMask.length; i++) {
    if (!alphaMask[i]) continue;
    indexed[i] = nearestColorIndex(pixels[p], centroids);
    p += 1;
  }

  return { palette: centroids, indexed, alphaMask: Uint8Array.from(alphaMask) };
}

function buildIndexedFromPalette(imgData, palette) {
  const d = imgData.data;
  const indexed = new Int16Array(d.length / 4).fill(-1);
  const alphaMask = new Uint8Array(d.length / 4);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    if (d[i + 3] < 20) continue;
    alphaMask[p] = 1;
    indexed[p] = nearestColorIndex([d[i], d[i + 1], d[i + 2]], palette);
  }
  return { palette, indexed, alphaMask };
}

function cleanupSmallIslands(reducedData, width, height, minSize) {
  if (!reducedData || !reducedData.palette.length || minSize <= 1) return reducedData;
  const indexed = new Int16Array(reducedData.indexed);
  const alphaMask = new Uint8Array(reducedData.alphaMask);
  const visited = new Uint8Array(indexed.length);
  const dirs = [1, -1, width, -width];

  for (let i = 0; i < indexed.length; i++) {
    if (visited[i] || !alphaMask[i] || indexed[i] < 0) continue;
    const colorIdx = indexed[i];
    const queue = [i];
    const cells = [];
    visited[i] = 1;

    while (queue.length) {
      const cur = queue.pop();
      cells.push(cur);
      const x = cur % width;
      const y = Math.floor(cur / width);

      for (const d of dirs) {
        const n = cur + d;
        if (n < 0 || n >= indexed.length || visited[n]) continue;
        const nx = n % width;
        const ny = Math.floor(n / width);
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        if (!alphaMask[n] || indexed[n] !== colorIdx) continue;
        visited[n] = 1;
        queue.push(n);
      }
    }

    if (cells.length >= minSize) continue;

    for (const cell of cells) {
      const cx = cell % width;
      const cy = Math.floor(cell / width);
      let best = -1;
      let bestCount = -1;
      const neighborCounts = new Map();
      const nbs = [cell - 1, cell + 1, cell - width, cell + width];
      for (const n of nbs) {
        if (n < 0 || n >= indexed.length || !alphaMask[n]) continue;
        const nx = n % width;
        const ny = Math.floor(n / width);
        if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
        const idx = indexed[n];
        if (idx < 0 || idx === colorIdx) continue;
        const count = (neighborCounts.get(idx) || 0) + 1;
        neighborCounts.set(idx, count);
        if (count > bestCount) {
          bestCount = count;
          best = idx;
        }
      }

      if (best >= 0) indexed[cell] = best;
    }
  }

  return { palette: reducedData.palette, indexed, alphaMask };
}

function getMaskBounds(mask, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY, empty: maxX < 0 };
}

function dilateMask(mask, width, height, radius) {
  if (radius <= 0) return Uint8Array.from(mask);
  const out = Uint8Array.from(mask);
  const offsets = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) offsets.push([dx, dy]);
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        out[ny * width + nx] = 1;
      }
    }
  }
  return out;
}

function buildBaseMask(alphaMask, width, height, shapeMode, paddingPx) {
  if (shapeMode === "none") return Uint8Array.from(alphaMask);
  const source = Uint8Array.from(alphaMask);
  if (shapeMode === "contour") {
    return dilateMask(source, width, height, paddingPx);
  }

  const bounds = getMaskBounds(source, width, height);
  if (bounds.empty) return source;
  const out = new Uint8Array(source.length);

  if (shapeMode === "rectangle") {
    const x0 = Math.max(0, bounds.minX - paddingPx);
    const y0 = Math.max(0, bounds.minY - paddingPx);
    const x1 = Math.min(width - 1, bounds.maxX + paddingPx);
    const y1 = Math.min(height - 1, bounds.maxY + paddingPx);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) out[y * width + x] = 1;
    }
    return out;
  }

  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const halfW = (bounds.maxX - bounds.minX + 1) / 2;
  const halfH = (bounds.maxY - bounds.minY + 1) / 2;
  const radius = Math.max(halfW, halfH) + paddingPx;
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) out[y * width + x] = 1;
    }
  }
  return out;
}

function findStemAttachPoint(mask, width, height) {
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  let best = null;
  let bestD2 = Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = { x, y };
      }
    }
  }
  return best || { x: Math.floor(cx), y: Math.floor(cy) };
}

function drawProcessed(reducedData, width, height) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
  const out = ctx.createImageData(width, height);
  for (let i = 0; i < reducedData.indexed.length; i++) {
    const off = i * 4;
    if (!reducedData.alphaMask[i] || reducedData.indexed[i] < 0) {
      out.data[off + 3] = 0;
      continue;
    }
    const color = reducedData.palette[reducedData.indexed[i]];
    out.data[off] = color[0];
    out.data[off + 1] = color[1];
    out.data[off + 2] = color[2];
    out.data[off + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);

  pctx.clearRect(0, 0, processedCanvas.width, processedCanvas.height);
  const scale = Math.min(processedCanvas.width / width, processedCanvas.height / height);
  const w = width * scale;
  const h = height * scale;
  const x = (processedCanvas.width - w) / 2;
  const y = (processedCanvas.height - h) / 2;
  pctx.imageSmoothingEnabled = true;
  pctx.drawImage(c, x, y, w, h);
  if (showBaseOverlayInput.checked) {
    drawBaseOverlay(reducedData, width, height, x, y, w, h);
  }
}

function drawBaseOverlay(reducedData, width, height, x, y, w, h) {
  const shapeMode = baseShapeModeSelect.value || "contour";
  const padding = clamp(parseInt(baseShapePaddingInput.value, 10) || 4, 0, 24);
  const baseMask = buildBaseMask(reducedData.alphaMask, width, height, shapeMode, padding);
  const overlay = pctx.createImageData(width, height);
  const out = overlay.data;

  for (let yy = 0; yy < height; yy++) {
    for (let xx = 0; xx < width; xx++) {
      const idx = yy * width + xx;
      if (!baseMask[idx]) continue;
      const left = xx > 0 ? baseMask[idx - 1] : 0;
      const right = xx < width - 1 ? baseMask[idx + 1] : 0;
      const up = yy > 0 ? baseMask[idx - width] : 0;
      const down = yy < height - 1 ? baseMask[idx + width] : 0;
      const edge = !left || !right || !up || !down;
      if (!edge) continue;
      const o = idx * 4;
      out[o] = 255;
      out[o + 1] = 167;
      out[o + 2] = 38;
      out[o + 3] = 220;
    }
  }

  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
  ctx.putImageData(overlay, 0, 0);
  pctx.imageSmoothingEnabled = false;
  pctx.drawImage(c, x, y, w, h);
}

function redrawProcessedPreview() {
  if (!reduced || !state.width || !state.height) return;
  drawProcessed(reduced, state.width, state.height);
}

function renderPalette(palette) {
  currentColorLabels = buildUniqueColorLabels(palette);
  paletteEl.innerHTML = "";
  palette.forEach((rgb, idx) => {
    const holder = document.createElement("div");
    holder.className = "swatch";

    const label = document.createElement("span");
    label.className = "swatch-name";
    label.dataset.idx = String(idx);
    label.textContent = toTitleCase(currentColorLabels[idx] || `color ${idx + 1}`);

    const pickerWrap = document.createElement("label");
    pickerWrap.className = "picker-wrap";

    const preview = document.createElement("span");
    preview.className = "swatch-preview";

    const input = document.createElement("input");
    input.type = "color";
    input.className = "swatch-picker";
    const hex = toHex(rgb);
    input.value = hex;
    input.dataset.idx = String(idx);
    preview.style.backgroundColor = hex;

    const hexLabel = document.createElement("code");
    hexLabel.className = "swatch-hex";
    hexLabel.textContent = hex.toUpperCase();

    input.addEventListener("input", () => {
      preview.style.backgroundColor = input.value;
      hexLabel.textContent = input.value.toUpperCase();
      const allInputs = [...paletteEl.querySelectorAll("input[type='color']")];
      const workingPalette = allInputs.map((el) => hexToRgb(el.value));
      const labels = buildUniqueColorLabels(workingPalette);
      currentColorLabels = labels;
      const allNameEls = [...paletteEl.querySelectorAll(".swatch-name")];
      for (let i = 0; i < allNameEls.length; i++) {
        allNameEls[i].textContent = toTitleCase(labels[i] || `color ${i + 1}`);
      }
      for (let i = 0; i < allInputs.length; i++) {
        setStemOptionLabel(i, allInputs[i].value.toUpperCase(), labels[i]);
      }
      updateStemPreview(getStemHexFromSelection());
    });

    pickerWrap.append(preview, input);

    holder.append(label, pickerWrap, hexLabel);
    paletteEl.appendChild(holder);
  });
  applyPaletteBtn.disabled = palette.length === 0;
  syncStemSelectionOptions(palette);
}

function rebuildUsingPaletteInputs() {
  if (!imageData || !currentPalette.length) return;
  const inputs = [...paletteEl.querySelectorAll("input[type='color']")];
  const palette = inputs.map((el) => hexToRgb(el.value));
  currentPalette = palette;
  currentColorLabels = buildUniqueColorLabels(palette);
  reduced = buildIndexedFromPalette(imageData, palette);
  drawProcessed(reduced, state.width, state.height);
  syncStemSelectionOptions(palette);
}

function gridFromMask(mask, width, height, fn) {
  const grid = Array.from({ length: height }, () => Array(width).fill(0));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      grid[y][x] = fn(mask, idx) ? 1 : 0;
    }
  }
  return grid;
}

function pointKey(x, y) {
  return `${x},${y}`;
}

function parsePointKey(key) {
  const [x, y] = key.split(",").map((v) => parseInt(v, 10));
  return [x, y];
}

function signedArea2D(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    area += p1.x * p2.y - p2.x * p1.y;
  }
  return area * 0.5;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect = yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointsEqual(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function perpendicularDistance(point, lineStart, lineEnd) {
  const [x, y] = point;
  const [x1, y1] = lineStart;
  const [x2, y2] = lineEnd;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  const px = x1 + t * dx;
  const py = y1 + t * dy;
  return Math.hypot(x - px, y - py);
}

function simplifyRdp(points, epsilon) {
  if (points.length <= 2) return points.slice();
  const start = points[0];
  const end = points[points.length - 1];
  let maxDist = -1;
  let index = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], start, end);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist <= epsilon) return [start, end];
  const left = simplifyRdp(points.slice(0, index + 1), epsilon);
  const right = simplifyRdp(points.slice(index), epsilon);
  return [...left.slice(0, -1), ...right];
}

function removeCollinear(loop) {
  if (loop.length < 3) return loop;
  const out = [];
  for (let i = 0; i < loop.length; i++) {
    const prev = loop[(i - 1 + loop.length) % loop.length];
    const curr = loop[i];
    const next = loop[(i + 1) % loop.length];
    const v1x = curr[0] - prev[0];
    const v1y = curr[1] - prev[1];
    const v2x = next[0] - curr[0];
    const v2y = next[1] - curr[1];
    const cross = v1x * v2y - v1y * v2x;
    if (cross !== 0) out.push(curr);
  }
  return out.length >= 3 ? out : loop;
}

function simplifyClosedLoop(loop, epsilon) {
  if (loop.length < 4) return loop;
  const dedup = [];
  for (const p of loop) {
    if (!dedup.length || !pointsEqual(dedup[dedup.length - 1], p)) dedup.push(p);
  }
  if (dedup.length > 1 && pointsEqual(dedup[0], dedup[dedup.length - 1])) dedup.pop();
  if (dedup.length < 4) return dedup;
  const open = [...dedup, dedup[0]];
  const simplifiedOpen = simplifyRdp(open, epsilon);
  const simplified = simplifiedOpen.slice(0, -1);
  return removeCollinear(simplified);
}

function chaikinClosed(points, iterations = 1) {
  let out = points.slice();
  for (let iter = 0; iter < iterations; iter++) {
    if (out.length < 3) break;
    const next = [];
    for (let i = 0; i < out.length; i++) {
      const p0 = out[i];
      const p1 = out[(i + 1) % out.length];
      const q = [0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]];
      const r = [0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]];
      next.push(q, r);
    }
    out = next;
  }
  return out;
}

function traceBoundaryLoops(grid) {
  const h = grid.length;
  const w = grid[0].length;
  const edges = new Map();

  const addEdge = (a, b) => {
    const forward = `${a}>${b}`;
    const reverse = `${b}>${a}`;
    if (edges.has(reverse)) {
      edges.delete(reverse);
      return;
    }
    edges.set(forward, { start: a, end: b });
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!grid[y][x]) continue;
      const p0 = pointKey(x, y);
      const p1 = pointKey(x + 1, y);
      const p2 = pointKey(x + 1, y + 1);
      const p3 = pointKey(x, y + 1);
      addEdge(p0, p1);
      addEdge(p1, p2);
      addEdge(p2, p3);
      addEdge(p3, p0);
    }
  }

  const outgoing = new Map();
  for (const edge of edges.values()) {
    if (!outgoing.has(edge.start)) outgoing.set(edge.start, []);
    outgoing.get(edge.start).push(edge.end);
  }

  const loops = [];
  const used = new Set();
  for (const edgeKey of edges.keys()) {
    if (used.has(edgeKey)) continue;
    const startEdge = edges.get(edgeKey);
    let current = startEdge.start;
    const loopKeys = [];
    let guard = 0;
    while (guard < 100000) {
      guard += 1;
      loopKeys.push(current);
      const ends = outgoing.get(current);
      if (!ends || !ends.length) break;

      let next = null;
      let nextEdgeKey = null;
      for (const candidate of ends) {
        const k = `${current}>${candidate}`;
        if (!used.has(k)) {
          next = candidate;
          nextEdgeKey = k;
          break;
        }
      }
      if (!next || !nextEdgeKey) break;
      used.add(nextEdgeKey);
      current = next;
      if (current === startEdge.start) break;
    }

    if (loopKeys.length >= 3) {
      loops.push(loopKeys.map((k) => parsePointKey(k)));
    }
  }

  return loops;
}

function loopsToShapes(loops, width, height, pxSize, mode = "contour") {
  const halfW = (width * pxSize) / 2;
  const halfH = (height * pxSize) / 2;

  const loopObjs = loops
    .map((loop) => {
    // Aggressive simplification can introduce self-intersections that export as
    // open shells in some slicers. Keep contour loops topology-safe.
    const simplified =
      mode === "vector_trace" ? simplifyClosedLoop(loop, 1.0) : removeCollinear(loop);
    if (simplified.length < 3) return null;
    const pts = simplified.map(([gx, gy]) => new THREE.Vector2(gx * pxSize - halfW, halfH - gy * pxSize));
    if (pts.length < 3) return null;
    return {
      pts,
      absArea: Math.abs(signedArea2D(pts)),
      parent: -1,
      depth: 0,
    };
  })
    .filter(Boolean);

  if (!loopObjs.length) return [];

  const order = loopObjs.map((_, i) => i).sort((a, b) => loopObjs[b].absArea - loopObjs[a].absArea);
  for (const i of order) {
    const candidate = loopObjs[i];
    const testPoint = candidate.pts[0];
    let parent = -1;
    let parentArea = Infinity;
    for (const j of order) {
      if (i === j) continue;
      const container = loopObjs[j];
      if (container.absArea <= candidate.absArea) continue;
      if (container.absArea >= parentArea) continue;
      if (pointInPolygon(testPoint, container.pts)) {
        parent = j;
        parentArea = container.absArea;
      }
    }
    candidate.parent = parent;
  }

  for (const idx of order.slice().reverse()) {
    let depth = 0;
    let p = loopObjs[idx].parent;
    while (p !== -1) {
      depth += 1;
      p = loopObjs[p].parent;
    }
    loopObjs[idx].depth = depth;
  }

  const shapeMap = new Map();
  for (let i = 0; i < loopObjs.length; i++) {
    const item = loopObjs[i];
    if (item.depth % 2 === 0) {
      const shape = new THREE.Shape(item.pts);
      shapeMap.set(i, shape);
    }
  }

  for (let i = 0; i < loopObjs.length; i++) {
    const item = loopObjs[i];
    if (item.depth % 2 !== 1) continue;
    let parent = item.parent;
    while (parent !== -1 && loopObjs[parent].depth % 2 !== 0) parent = loopObjs[parent].parent;
    if (parent === -1 || !shapeMap.has(parent)) continue;
    shapeMap.get(parent).holes.push(new THREE.Path(item.pts));
  }

  return [...shapeMap.values()];
}

function buildLayerGeometry(grid, width, height, pxSize, thickness, zBase, mode = "contour") {
  // Build explicit closed shell quads from occupancy for slicer-robust manifolds.
  const halfW = (width * pxSize) / 2;
  const halfH = (height * pxSize) / 2;
  const z0 = zBase;
  const z1 = zBase + thickness;
  const positions = [];

  const has = (x, y) => x >= 0 && y >= 0 && x < width && y < height && grid[y][x] === 1;
  const pushTri = (a, b, c) => {
    positions.push(...a, ...b, ...c);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!grid[y][x]) continue;
      const x0 = x * pxSize - halfW;
      const x1 = (x + 1) * pxSize - halfW;
      const yTop = halfH - y * pxSize;
      const yBottom = halfH - (y + 1) * pxSize;

      const p000 = [x0, yBottom, z0];
      const p100 = [x1, yBottom, z0];
      const p110 = [x1, yTop, z0];
      const p010 = [x0, yTop, z0];
      const p001 = [x0, yBottom, z1];
      const p101 = [x1, yBottom, z1];
      const p111 = [x1, yTop, z1];
      const p011 = [x0, yTop, z1];

      // Top (+Z)
      pushTri(p001, p101, p111);
      pushTri(p001, p111, p011);
      // Bottom (-Z)
      pushTri(p000, p110, p100);
      pushTri(p000, p010, p110);

      // Left (-X)
      if (!has(x - 1, y)) {
        pushTri(p000, p001, p011);
        pushTri(p000, p011, p010);
      }
      // Right (+X)
      if (!has(x + 1, y)) {
        pushTri(p100, p110, p111);
        pushTri(p100, p111, p101);
      }
      // Front (+Y / image up)
      if (!has(x, y - 1)) {
        pushTri(p010, p011, p111);
        pushTri(p010, p111, p110);
      }
      // Back (-Y / image down)
      if (!has(x, y + 1)) {
        pushTri(p000, p101, p001);
        pushTri(p000, p100, p101);
      }
    }
  }

  if (!positions.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;

  // Legacy contour extrusion path retained below but intentionally unreachable.
  const loops = traceBoundaryLoops(grid);
  if (!loops.length) return null;
  const shapes = loopsToShapes(loops, width, height, pxSize, mode);
  if (!shapes.length) return null;

  const geos = [];
  for (const shape of shapes) {
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: thickness,
      bevelEnabled: false,
      curveSegments: mode === "vector_trace" ? 6 : 1,
      steps: 1,
    });
    geo.translate(0, 0, zBase);
    geos.push(geo.toNonIndexed());
  }

  const merged = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  return merged;
}

function makeStem(baseThickness, stemHex) {
  const group = new THREE.Group();
  // Build stem as one watertight manifold and add an internal anchor flange
  // so slicers consistently merge stem + backing as one printable body.
  const anchorDepth = clamp(baseThickness * 0.62, 0.9, 1.6);
  const anchorRadius = 4.6;
  const points = [
    new THREE.Vector2(0.0, -6.4),
    new THREE.Vector2(5.8, -6.4),
    new THREE.Vector2(5.8, -5.0),
    new THREE.Vector2(3.8, -5.0),
    new THREE.Vector2(3.8, 0.0),
    new THREE.Vector2(anchorRadius, 0.0),
    new THREE.Vector2(anchorRadius, anchorDepth),
    new THREE.Vector2(0.0, anchorDepth),
  ];
  const stemGeo = new THREE.LatheGeometry(points, 56);
  const stemMesh = new THREE.Mesh(
    stemGeo,
    new THREE.MeshStandardMaterial({ color: new THREE.Color(stemHex), metalness: 0, roughness: 0.88 })
  );
  stemMesh.rotation.x = Math.PI / 2;
  // Keep the anchor embedded within the backing for robust union in slicers.
  stemMesh.position.z = clamp(baseThickness * 0.1, 0.1, 0.3);
  stemMesh.name = "stem_body";
  group.add(stemMesh);

  return group;
}

function generateModel() {
  if (!reduced || !reduced.palette.length) {
    setStatus("No processed image data available.", true);
    return;
  }
  if (paletteEl.querySelector("input[type='color']")) {
    rebuildUsingPaletteInputs();
  }

  if (modelGroup) {
    scene.remove(modelGroup);
    layerMeshes = [];
  }

  const width = state.width;
  const height = state.height;
  const baseThickness = clamp(parseFloat(baseThicknessInput.value) || 1.8, 0.8, 6);
  const colorThickness = clamp(parseFloat(colorThicknessInput.value) || 0.8, 0.2, 3);
  const targetMm = clamp(parseFloat(targetSizeMmInput.value) || 30, 12, 60);
  const stemHex = getStemHexFromSelection();
  const geometryMode = geometryModeSelect.value || "contour";
  const baseShapeMode = baseShapeModeSelect.value || "contour";
  const baseShapePadding = clamp(parseInt(baseShapePaddingInput.value, 10) || 4, 0, 24);
  const cleanupOn = cleanupIslandsInput.checked;
  const cleanupMinSize = clamp(parseInt(cleanupMinSizeInput.value, 10) || 8, 1, 40);

  const longest = Math.max(width, height);
  const pxSize = targetMm / longest;
  const reducedForModel = cleanupOn ? cleanupSmallIslands(reduced, width, height, cleanupMinSize) : reduced;

  const group = new THREE.Group();

  const attachMask = buildBaseMask(reducedForModel.alphaMask, width, height, baseShapeMode, baseShapePadding);

  const zBaseForColors = baseThickness;
  const layerColorLabels = buildUniqueColorLabels(reducedForModel.palette);
  const baseGrid = gridFromMask(attachMask, width, height, (m, i) => m[i] === 1);
  const baseGeo = buildLayerGeometry(baseGrid, width, height, pxSize, baseThickness, 0, geometryMode);
  if (!baseGeo) {
    setStatus("Could not build base geometry. Try lowering cleanup size or disabling island cleanup.", true);
    return;
  }
  const baseMesh = new THREE.Mesh(
    baseGeo,
    new THREE.MeshStandardMaterial({ color: 0xf3f6fa, roughness: 0.9, metalness: 0 })
  );
  baseMesh.name = "base";
  group.add(baseMesh);
  layerMeshes.push({ name: "base", mesh: baseMesh });

  for (let c = 0; c < reducedForModel.palette.length; c++) {
    const colorGrid = gridFromMask(reducedForModel.indexed, width, height, (idxData, i) => idxData[i] === c);
    const layerGeo = buildLayerGeometry(colorGrid, width, height, pxSize, colorThickness, zBaseForColors, geometryMode);
    if (!layerGeo) continue;
    const rgb = reducedForModel.palette[c];
    const mesh = new THREE.Mesh(
      layerGeo,
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255),
        roughness: 0.85,
        metalness: 0,
      })
    );
    const colorLabel = layerColorLabels[c] || `color ${c + 1}`;
    const colorPartName = `color_${sanitizePartName(colorLabel)}`;
    mesh.name = colorPartName;
    group.add(mesh);
    layerMeshes.push({ name: toTitleCase(colorLabel), fileName: colorPartName, mesh });
  }

  const attach = findStemAttachPoint(attachMask, width, height);
  const halfW = (width * pxSize) / 2;
  const halfH = (height * pxSize) / 2;
  const stemX = (attach.x + 0.5) * pxSize - halfW;
  const stemY = halfH - (attach.y + 0.5) * pxSize;

  const stem = makeStem(baseThickness, stemHex);
  stem.name = "stem";
  stem.position.set(stemX, stemY, 0);
  group.add(stem);

  modelGroup = group;
  scene.add(group);

  const bbox = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const center = new THREE.Vector3();
  bbox.getCenter(center);

  group.position.sub(center);
  const faceDist = Math.max(size.x, size.y) * 1.9 + 18;
  controls.target.set(0, 0, 0);
  camera.position.set(0, 0, faceDist);

  downloadCombinedBtn.disabled = false;
  download3mfBtn.disabled = false;
  downloadStemBtn.disabled = false;
  renderLayerButtons();
  setStatus(
    `3D model generated. Approx size: ${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)} mm. ` +
      `Mode: ${geometryMode === "vector_trace" ? "Vector Trace" : "Contour"}, base: ${baseShapeMode}. ` +
      `Combined exports are auto-oriented logo-face down.`
  );
}

function downloadText(name, text) {
  const blob = new Blob([text], { type: "model/stl" });
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function downloadBlob(name, blob) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function exportSTL(object3d, filename) {
  const exporter = new STLExporter();
  const stlString = exporter.parse(object3d, { binary: false });
  downloadText(filename, stlString);
}

function applyFaceDownExportTransform(geometry) {
  geometry.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI));
  geometry.computeBoundingBox();
  const minZ = geometry.boundingBox?.min.z ?? 0;
  geometry.translate(0, 0, -minZ);
}

function cleanGeometryForExport(geometry) {
  const source = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const pos = source.getAttribute("position");
  if (!pos || pos.count < 3) {
    source.dispose();
    return null;
  }

  const kept = [];
  for (let i = 0; i < pos.count; i += 3) {
    const ax = pos.getX(i);
    const ay = pos.getY(i);
    const az = pos.getZ(i);
    const bx = pos.getX(i + 1);
    const by = pos.getY(i + 1);
    const bz = pos.getZ(i + 1);
    const cx = pos.getX(i + 2);
    const cy = pos.getY(i + 2);
    const cz = pos.getZ(i + 2);

    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const area2 = nx * nx + ny * ny + nz * nz;
    if (area2 <= 1e-14) continue;

    kept.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  }

  source.dispose();
  if (!kept.length) return null;

  const clean = new THREE.BufferGeometry();
  clean.setAttribute("position", new THREE.Float32BufferAttribute(kept, 3));
  const welded = mergeVertices(clean, 1e-5);
  clean.dispose();
  const idx = welded.getIndex();
  if (idx) {
    const arr = idx.array;
    const filtered = [];
    for (let i = 0; i < arr.length; i += 3) {
      const a = arr[i];
      const b = arr[i + 1];
      const c = arr[i + 2];
      if (a === b || b === c || c === a) continue;
      filtered.push(a, b, c);
    }
    welded.setIndex(filtered);
  }
  welded.computeVertexNormals();
  return welded;
}

function buildCombinedGeometry(root, options = {}) {
  const { includeStem = true, faceDown = false } = options;
  root.updateWorldMatrix(true, true);
  const geos = [];
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    if (!includeStem && obj.name.startsWith("stem")) return;
    const g = obj.geometry.clone();
    g.applyMatrix4(obj.matrixWorld);
    const clean = cleanGeometryForExport(g);
    g.dispose();
    if (!clean) return;
    const out = clean.index ? clean.toNonIndexed() : clean;
    geos.push(out);
    if (out !== clean) clean.dispose();
  });
  if (!geos.length) return null;
  const merged = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  if (faceDown) applyFaceDownExportTransform(merged);
  return merged;
}

function rgbToDisplayHex(color) {
  return `#${color.getHexString().toUpperCase()}`;
}

function getMeshColor(mesh) {
  if (mesh.material?.color) return mesh.material.color.clone();
  return new THREE.Color(0.8, 0.8, 0.8);
}

function build3MFXml(root, options = {}) {
  const { includeStem = true, faceDown = false } = options;
  root.updateWorldMatrix(true, true);
  const meshEntries = [];
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    if (!includeStem && obj.name.startsWith("stem")) return;
    const base = obj.geometry.clone();
    base.applyMatrix4(obj.matrixWorld);
    const geo = cleanGeometryForExport(base);
    base.dispose();
    if (!geo) return;
    const pos = geo.getAttribute("position");
    if (!pos || pos.count < 3) {
      geo.dispose();
      return;
    }
    meshEntries.push({
      name: obj.name || "part",
      geometry: geo,
      colorHex: rgbToDisplayHex(getMeshColor(obj)),
    });
  });

  if (!meshEntries.length) return null;

  if (faceDown) {
    let minZ = Infinity;
    for (const entry of meshEntries) {
      entry.geometry.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI));
      entry.geometry.computeBoundingBox();
      minZ = Math.min(minZ, entry.geometry.boundingBox?.min.z ?? minZ);
    }
    for (const entry of meshEntries) entry.geometry.translate(0, 0, -minZ);
  }

  const colorToIndex = new Map();
  const palette = [];
  for (const entry of meshEntries) {
    if (!colorToIndex.has(entry.colorHex)) {
      colorToIndex.set(entry.colorHex, palette.length);
      palette.push(entry.colorHex);
    }
  }

  const objectXml = [];
  const buildXml = [];
  let objectId = 2;
  for (const entry of meshEntries) {
    const pos = entry.geometry.getAttribute("position");
    const vertices = [];
    const triangles = [];
    for (let i = 0; i < pos.count; i++) {
      vertices.push(`<vertex x=\"${pos.getX(i).toFixed(5)}\" y=\"${pos.getY(i).toFixed(5)}\" z=\"${pos.getZ(i).toFixed(5)}\"/>`);
    }
    const index = entry.geometry.getIndex();
    if (index) {
      const arr = index.array;
      for (let i = 0; i < arr.length; i += 3) {
        triangles.push(
          `<triangle v1=\"${arr[i]}\" v2=\"${arr[i + 1]}\" v3=\"${arr[i + 2]}\" pid=\"1\" p1=\"${colorToIndex.get(entry.colorHex)}\"/>`
        );
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        triangles.push(
          `<triangle v1=\"${i}\" v2=\"${i + 1}\" v3=\"${i + 2}\" pid=\"1\" p1=\"${colorToIndex.get(entry.colorHex)}\"/>`
        );
      }
    }
    objectXml.push(
      `<object id=\"${objectId}\" type=\"model\" name=\"${entry.name}\"><mesh><vertices>${vertices.join("")}</vertices><triangles>${triangles.join("")}</triangles></mesh></object>`
    );
    buildXml.push(`<item objectid=\"${objectId}\"/>`);
    entry.geometry.dispose();
    objectId += 1;
  }
  if (!objectXml.length) return null;

  const baseMaterials = palette
    .map((hex, idx) => `<base name=\"color_${idx + 1}\" displaycolor=\"${hex}\"/>`)
    .join("");

  return (
    `<?xml version=\"1.0\" encoding=\"UTF-8\"?>` +
    `<model unit=\"millimeter\" xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\">` +
    `<resources><basematerials id=\"1\">${baseMaterials}</basematerials>${objectXml.join("")}</resources>` +
    `<build>${buildXml.join("")}</build>` +
    `</model>`
  );
}

async function export3MF(root, filename, options = {}) {
  const modelXml = build3MFXml(root, options);
  if (!modelXml) {
    setStatus("Could not build 3MF model data.", true);
    return;
  }

  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version=\"1.0\" encoding=\"UTF-8\"?>` +
      `<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">` +
      `<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>` +
      `<Default Extension=\"model\" ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\"/>` +
      `</Types>`
  );
  zip.folder("_rels").file(
    ".rels",
    `<?xml version=\"1.0\" encoding=\"UTF-8\"?>` +
      `<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">` +
      `<Relationship Target=\"/3D/3dmodel.model\" Id=\"rel0\" Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\"/>` +
      `</Relationships>`
  );
  zip.folder("3D").file("3dmodel.model", modelXml);

  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType: "model/3mf",
  });

  downloadBlob(filename, blob);
}

function renderLayerButtons() {
  layerExports.innerHTML = "";
  for (const { name, fileName, mesh } of layerMeshes) {
    const btn = document.createElement("button");
    btn.textContent = `Download ${name}.stl`;
    btn.addEventListener("click", () => {
      const geo = buildCombinedGeometry(mesh, { includeStem: true, faceDown: true });
      if (!geo) return;
      const outMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
      exportSTL(outMesh, `${fileName || sanitizePartName(name)}.stl`);
      outMesh.geometry.dispose();
    });
    layerExports.appendChild(btn);
  }
}

function buildExportRoot() {
  return modelGroup;
}

imageInput.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    sourceImage = img;
    drawImageScaled(img);
    setStatus("Image loaded. Detecting colors...");
    detectBtn.disabled = false;
    quantizeBtn.disabled = false;
    generateBtn.disabled = true;
    downloadCombinedBtn.disabled = true;
    download3mfBtn.disabled = true;
    downloadStemBtn.disabled = true;
    applyPaletteBtn.disabled = true;
    stemPaletteIndexSelect.disabled = true;
    layerExports.innerHTML = "";

    if (modelGroup) {
      scene.remove(modelGroup);
      modelGroup = null;
      layerMeshes = [];
    }

    URL.revokeObjectURL(url);
    detectBtn.click();
  };
  img.onerror = () => setStatus("Failed to load image.", true);
  img.src = url;
});

detectBtn.addEventListener("click", () => {
  if (!sourceImage) return;

  const resolution = clamp(parseInt(resolutionInput.value, 10) || 112, 32, 256);
  const working = getWorkingPixels(resolution);
  imageData = working.data;
  state.width = working.width;
  state.height = working.height;

  const detection = detectColors(imageData, state.width, state.height);
  const found = detection.colors.map((c) => [...c.rgb, c.count]);
  const needed = detection.neededColors.map((c) => [...c.rgb, c.count]);
  const estimatedNeeded = estimateNeededColorCount(imageData, state.width, state.height, 2, 4);
  const autoTarget = clamp(estimatedNeeded || needed.length || found.length || 2, 2, 4);
  targetColorsInput.value = String(autoTarget);
  const target = autoTarget;

  if (needed.length <= target) {
    currentPalette = needed.map((v) => v.slice(0, 3));
    if (!currentPalette.length) currentPalette = found.slice(0, target).map((v) => v.slice(0, 3));
    reduced = buildIndexedFromPalette(imageData, currentPalette);
    drawProcessed(reduced, state.width, state.height);
    renderPalette(currentPalette);
    generateBtn.disabled = false;
    setStatus(
      `Detected ${needed.length || found.length} generalized shades, estimated ${target} print colors. Auto-set target to ${target}.`
    );
  } else {
    reduced = kmeansReduce(imageData, target, 16);
    currentPalette = reduced.palette.map((p) => p.slice());
    drawProcessed(reduced, state.width, state.height);
    renderPalette(currentPalette);
    generateBtn.disabled = false;
    setStatus(`Detected ${needed.length} generalized shades, estimated ${target} print colors. Reduced image to ${target}.`);
  }
});

quantizeBtn.addEventListener("click", () => {
  if (!imageData) {
    setStatus("Load and detect colors first.", true);
    return;
  }
  const target = clamp(parseInt(targetColorsInput.value, 10) || 4, 2, 4);
  reduced = kmeansReduce(imageData, target, 18);
  currentPalette = reduced.palette.map((p) => p.slice());
  drawProcessed(reduced, state.width, state.height);
  renderPalette(currentPalette);
  generateBtn.disabled = false;
  setStatus(`Image reduced to ${target} colors. You can tweak palette colors and apply.`);
});

applyPaletteBtn.addEventListener("click", () => {
  rebuildUsingPaletteInputs();
  setStatus("Palette changes applied to the image regions.");
});

stemPaletteIndexSelect.addEventListener("change", () => {
  updateStemPreview(getStemHexFromSelection());
});
geometryModeSelect.addEventListener("change", () => {
  if (modelGroup) setStatus("Geometry mode changed. Click Generate 3D Model to rebuild before exporting.");
});
baseShapeModeSelect.addEventListener("change", () => {
  redrawProcessedPreview();
  if (modelGroup) setStatus("Backing shape changed. Click Generate 3D Model to rebuild before exporting.");
});
baseShapePaddingInput.addEventListener("input", () => {
  baseShapePaddingValueEl.textContent = `${baseShapePaddingInput.value} px`;
  redrawProcessedPreview();
  if (modelGroup) setStatus("Backing padding changed. Click Generate 3D Model to rebuild before exporting.");
});
showBaseOverlayInput.addEventListener("change", () => {
  redrawProcessedPreview();
});
cleanupIslandsInput.addEventListener("change", () => {
  cleanupMinSizeInput.disabled = !cleanupIslandsInput.checked;
  if (modelGroup) setStatus("Cleanup setting changed. Click Generate 3D Model to rebuild before exporting.");
});
cleanupMinSizeInput.addEventListener("input", () => {
  cleanupMinSizeValueEl.textContent = `${cleanupMinSizeInput.value} px`;
  if (modelGroup) setStatus("Cleanup size changed. Click Generate 3D Model to rebuild before exporting.");
});

targetSizeMmInput.addEventListener("input", () => {
  updateResolutionGuidance();
  updateUnitHints();
});
nozzleMmInput.addEventListener("input", () => {
  updateResolutionGuidance();
  updateUnitHints();
});
baseThicknessInput.addEventListener("input", updateUnitHints);
colorThicknessInput.addEventListener("input", updateUnitHints);
resolutionInput.addEventListener("input", updateResolutionGuidance);

updateResolutionGuidance();
updateUnitHints();
cleanupMinSizeValueEl.textContent = `${cleanupMinSizeInput.value} px`;
cleanupMinSizeInput.disabled = !cleanupIslandsInput.checked;
baseShapePaddingValueEl.textContent = `${baseShapePaddingInput.value} px`;

generateBtn.addEventListener("click", generateModel);

downloadCombinedBtn.addEventListener("click", () => {
  if (!modelGroup) return;
  const exportRoot = buildExportRoot();
  const combined = buildCombinedGeometry(exportRoot, { includeStem: true, faceDown: true });
  if (!combined) {
    setStatus("Could not build combined STL geometry.", true);
    return;
  }
  const mesh = new THREE.Mesh(combined, new THREE.MeshStandardMaterial());
  exportSTL(mesh, "jibbitz-combined.stl");
  mesh.geometry.dispose();
  setStatus("Combined STL exported. Note: STL has no color metadata. For AMS multi-color, import base/named color/stem STLs as parts.");
});

download3mfBtn.addEventListener("click", async () => {
  if (!modelGroup) return;
  try {
    const exportRoot = buildExportRoot();
    await export3MF(exportRoot, "jibbitz-combined.3mf", { includeStem: true, faceDown: true });
    setStatus("Combined 3MF exported with color groups.");
  } catch (error) {
    console.error(error);
    setStatus("3MF export failed.", true);
  }
});

downloadStemBtn.addEventListener("click", () => {
  if (!modelGroup) return;
  const stem = modelGroup.getObjectByName("stem");
  if (!stem) {
    setStatus("No stem found in current model. Regenerate model first.", true);
    return;
  }
  const geo = buildCombinedGeometry(stem, { includeStem: true, faceDown: false });
  if (!geo) {
    setStatus("Could not build stem geometry.", true);
    return;
  }
  const outMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  exportSTL(outMesh, "stem.stl");
  outMesh.geometry.dispose();
  setStatus("Stem STL exported.");
});
