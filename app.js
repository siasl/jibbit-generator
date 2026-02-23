import * as THREE from "https://unpkg.com/three@0.161.0/build/three.module.js";
import { OrbitControls } from "https://unpkg.com/three@0.161.0/examples/jsm/controls/OrbitControls.js";
import { STLExporter } from "https://unpkg.com/three@0.161.0/examples/jsm/exporters/STLExporter.js";
import { mergeGeometries } from "https://unpkg.com/three@0.161.0/examples/jsm/utils/BufferGeometryUtils.js";

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
camera.position.set(0, -70, 85);
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

function getResolutionRecommendation() {
  const targetMm = clamp(parseFloat(targetSizeMmInput.value) || 30, 12, 60);
  const nozzleMm = clamp(parseFloat(nozzleMmInput.value) || 0.4, 0.2, 1.2);
  // Keep voxel width >= nozzle width so details are printable.
  const rawRecommended = targetMm / nozzleMm;
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

function setStemOptionLabel(idx, hex) {
  const opt = stemPaletteIndexSelect.options[idx];
  if (!opt) return;
  opt.textContent = `C${idx + 1} ${hex}`;
}

function syncStemSelectionOptions(palette) {
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
    option.textContent = `C${idx + 1} ${hex}`;
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
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  return { data, width: w, height: h };
}

function quantizedKey(r, g, b, a) {
  if (a < 20) return "transparent";
  // 5-bit channels to avoid tiny anti-aliasing variations inflating color count.
  return `${r >> 3},${g >> 3},${b >> 3}`;
}

function detectColors(imgData) {
  const map = new Map();
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a < 20) continue;
    const key = quantizedKey(d[i], d[i + 1], d[i + 2], a);
    const item = map.get(key);
    if (item) {
      item.count += 1;
      item.sumR += d[i];
      item.sumG += d[i + 1];
      item.sumB += d[i + 2];
    } else {
      map.set(key, { count: 1, sumR: d[i], sumG: d[i + 1], sumB: d[i + 2] });
    }
  }
  const colors = [...map.values()]
    .map((c) => [Math.round(c.sumR / c.count), Math.round(c.sumG / c.count), Math.round(c.sumB / c.count), c.count])
    .sort((a, b) => b[3] - a[3]);
  return colors;
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
  pctx.drawImage(c, x, y, w, h);
}

function renderPalette(palette) {
  paletteEl.innerHTML = "";
  palette.forEach((rgb, idx) => {
    const holder = document.createElement("div");
    holder.className = "swatch";

    const label = document.createElement("span");
    label.textContent = `C${idx + 1}`;

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
      setStemOptionLabel(idx, input.value.toUpperCase());
      if (parseInt(stemPaletteIndexSelect.value || "0", 10) === idx) {
        updateStemPreview(input.value.toUpperCase());
      }
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

function rectanglesFromGrid(grid) {
  const h = grid.length;
  const w = grid[0].length;
  const used = Array.from({ length: h }, () => Array(w).fill(false));
  const rects = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!grid[y][x] || used[y][x]) continue;

      let rw = 1;
      while (x + rw < w && grid[y][x + rw] && !used[y][x + rw]) rw++;

      let rh = 1;
      let canGrow = true;
      while (y + rh < h && canGrow) {
        for (let xx = x; xx < x + rw; xx++) {
          if (!grid[y + rh][xx] || used[y + rh][xx]) {
            canGrow = false;
            break;
          }
        }
        if (canGrow) rh++;
      }

      for (let yy = y; yy < y + rh; yy++) {
        for (let xx = x; xx < x + rw; xx++) used[yy][xx] = true;
      }
      rects.push({ x, y, w: rw, h: rh });
    }
  }

  return rects;
}

function buildLayerGeometry(rects, width, height, pxSize, thickness, zBase) {
  const geos = [];
  const halfW = (width * pxSize) / 2;
  const halfH = (height * pxSize) / 2;

  for (const r of rects) {
    const geo = new THREE.BoxGeometry(r.w * pxSize, r.h * pxSize, thickness);
    const cx = (r.x + r.w / 2) * pxSize - halfW;
    const cy = halfH - (r.y + r.h / 2) * pxSize;
    geo.translate(cx, cy, zBase + thickness / 2);
    geos.push(geo);
  }

  if (!geos.length) return null;
  const merged = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  return merged;
}

function makeStem(zBase, stemHex) {
  const group = new THREE.Group();
  const capHex = tintHex(stemHex, 0.86);

  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(5.4, 5.4, 5.6, 40),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(stemHex), metalness: 0, roughness: 0.85 })
  );
  post.rotation.x = Math.PI / 2;
  post.position.z = zBase - 2.8;
  group.add(post);

  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(8.2, 8.2, 1.6, 40),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(capHex), metalness: 0, roughness: 0.9 })
  );
  cap.rotation.x = Math.PI / 2;
  cap.position.z = zBase - 6.4;
  group.add(cap);

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

  const longest = Math.max(width, height);
  const pxSize = targetMm / longest;

  const group = new THREE.Group();

  const baseGrid = gridFromMask(reduced.alphaMask, width, height, (m, i) => m[i] === 1);
  const baseRects = rectanglesFromGrid(baseGrid);
  const baseGeo = buildLayerGeometry(baseRects, width, height, pxSize, baseThickness, 0);
  const baseMesh = new THREE.Mesh(
    baseGeo,
    new THREE.MeshStandardMaterial({ color: 0xf3f6fa, roughness: 0.9, metalness: 0 })
  );
  baseMesh.name = "base";
  group.add(baseMesh);
  layerMeshes.push({ name: "base", mesh: baseMesh });

  for (let c = 0; c < reduced.palette.length; c++) {
    const colorGrid = gridFromMask(reduced.indexed, width, height, (idxData, i) => idxData[i] === c);
    const rects = rectanglesFromGrid(colorGrid);
    if (!rects.length) continue;

    const layerGeo = buildLayerGeometry(rects, width, height, pxSize, colorThickness, baseThickness);
    const rgb = reduced.palette[c];
    const mesh = new THREE.Mesh(
      layerGeo,
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255),
        roughness: 0.85,
        metalness: 0,
      })
    );
    mesh.name = `color_${c + 1}`;
    group.add(mesh);
    layerMeshes.push({ name: `color_${c + 1}`, mesh });
  }

  const stem = makeStem(0, stemHex);
  stem.name = "stem";
  group.add(stem);

  modelGroup = group;
  scene.add(group);

  const bbox = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const center = new THREE.Vector3();
  bbox.getCenter(center);

  group.position.sub(center);
  controls.target.set(0, 0, size.z * 0.2);
  camera.position.set(size.x * 1.35, -size.y * 1.45, size.z * 2.8 + 22);

  downloadCombinedBtn.disabled = false;
  renderLayerButtons();
  setStatus(`3D model generated. Approx size: ${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)} mm.`);
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

function exportSTL(object3d, filename) {
  const exporter = new STLExporter();
  const stlString = exporter.parse(object3d, { binary: false });
  downloadText(filename, stlString);
}

function renderLayerButtons() {
  layerExports.innerHTML = "";
  for (const { name, mesh } of layerMeshes) {
    const btn = document.createElement("button");
    btn.textContent = `Download ${name}.stl`;
    btn.addEventListener("click", () => exportSTL(mesh, `${name}.stl`));
    layerExports.appendChild(btn);
  }

  const stemBtn = document.createElement("button");
  stemBtn.textContent = "Download stem.stl";
  stemBtn.addEventListener("click", () => {
    if (!modelGroup) return;
    const stem = modelGroup.getObjectByName("stem");
    if (stem) exportSTL(stem, "stem.stl");
  });
  layerExports.appendChild(stemBtn);
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

  const found = detectColors(imageData);
  const target = clamp(parseInt(targetColorsInput.value, 10) || 4, 2, 4);

  if (found.length <= 4) {
    currentPalette = found.map((v) => v.slice(0, 3));
    reduced = buildIndexedFromPalette(imageData, currentPalette);
    drawProcessed(reduced, state.width, state.height);
    renderPalette(currentPalette);
    generateBtn.disabled = false;
    setStatus(`Detected ${found.length} colors (<= 4). Using original palette directly.`);
  } else {
    reduced = kmeansReduce(imageData, target, 16);
    currentPalette = reduced.palette.map((p) => p.slice());
    drawProcessed(reduced, state.width, state.height);
    renderPalette(currentPalette);
    generateBtn.disabled = false;
    setStatus(`Detected ${found.length} colors (> 4). Reduced to ${target} colors. Adjust swatches if needed.`);
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

generateBtn.addEventListener("click", generateModel);

downloadCombinedBtn.addEventListener("click", () => {
  if (!modelGroup) return;
  exportSTL(modelGroup, "jibbitz-combined.stl");
});
