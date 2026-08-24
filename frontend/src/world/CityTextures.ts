import * as THREE from "three";

/**
 * Procedural CanvasTexture generators for the city district.
 *
 * All textures are generated once at module load and cached as singletons so
 * the whole city shares a tiny set of 1024² canvases. Textures use
 * THREE.RepeatWrapping so they can be tiled across large surfaces at a
 * consistent world scale.
 *
 * Currently provides the asphalt set (albedo + normal + roughness) used by
 * the city ground plane. Concrete/glass/neon generators will be added here as
 * the building system is built out.
 */

const TEX_SIZE = 1024;

/* ------------------------------------------------------------------ *
 *  Value noise — cheap multi-octave fractal noise on a 2D grid
 * ------------------------------------------------------------------ */

/** Hash-based pseudo-random in [0,1) from integer coords. */
function hash2(x: number, y: number): number {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Bilinear sample of the value-noise lattice. */
function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const v00 = hash2(x0, y0);
  const v10 = hash2(x0 + 1, y0);
  const v01 = hash2(x0, y0 + 1);
  const v11 = hash2(x0 + 1, y0 + 1);
  const sx = smooth(fx);
  const sy = smooth(fy);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
}

/** Fractal Brownian motion: sum of value-noise octaves. Returns [0,1]. */
function fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ *
 *  Canvas helpers
 * ------------------------------------------------------------------ */

function makeCanvas(size = TEX_SIZE): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  return c;
}

function toTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ------------------------------------------------------------------ *
 *  Asphalt albedo — multi-octave noise + hairline cracks + lane markings
 * ------------------------------------------------------------------ */

let asphaltAlbedoCache: THREE.CanvasTexture | null = null;

/**
 * Asphalt albedo: a base of mottled dark grey value noise, hairline cracks
 * drawn as jittered polylines, a few darker oil-stain patches, and faded
 * dashed lane markings near the horizontal centerline. Crosswalk blocks are
 * left to the decal pass in CityGround; this texture just gives the surface
 * its gritty, non-flat read.
 */
export function getAsphaltAlbedo(): THREE.CanvasTexture {
  if (asphaltAlbedoCache) return asphaltAlbedoCache;

  const size = TEX_SIZE;
  const c = makeCanvas(size);
  const ctx = c.getContext("2d")!;

  // Base fill — dark warm grey.
  ctx.fillStyle = "#2a2622";
  ctx.fillRect(0, 0, size, size);

  // Multi-octave value noise to break up the flat base. Sample on a coarse
  // grid and fill cells; cheaper than per-pixel.
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Base noise in [0,1].
      const n = fbm(x / 64, y / 64, 5, 2.2, 0.55);
      // Fine grain.
      const grain = (hash2(x, y) - 0.5) * 0.04;
      // Map to a dark grey range (~38..58).
      const v = 42 + n * 22 + grain * 255;
      data[i] = v * 0.98; // R
      data[i + 1] = v * 0.96; // G
      data[i + 2] = v * 0.92; // B (slightly warm)
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Oil-stain patches: darker soft blobs.
  ctx.globalCompositeOperation = "multiply";
  for (let i = 0; i < 14; i++) {
    const px = hash2(i, 1) * size;
    const py = hash2(i, 2) * size;
    const r = 40 + hash2(i, 3) * 90;
    const g = ctx.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, "rgba(20,18,16,0.55)");
    g.addColorStop(1, "rgba(20,18,16,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";

  // Hairline cracks: jittered polylines, dark, thin.
  ctx.strokeStyle = "rgba(10,8,6,0.85)";
  ctx.lineCap = "round";
  for (let i = 0; i < 26; i++) {
    let x = hash2(i, 10) * size;
    let y = hash2(i, 11) * size;
    const segs = 6 + Math.floor(hash2(i, 12) * 8);
    ctx.lineWidth = 0.6 + hash2(i, 13) * 1.0;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < segs; s++) {
      x += (hash2(i * 7 + s, 20) - 0.5) * 120;
      y += (hash2(i * 7 + s, 21) - 0.5) * 120;
      x = THREE.MathUtils.clamp(x, 0, size);
      y = THREE.MathUtils.clamp(y, 0, size);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Faded dashed lane marking along the horizontal centerline.
  ctx.strokeStyle = "rgba(200,200,180,0.18)";
  ctx.lineWidth = 4;
  ctx.setLineDash([48, 48]);
  ctx.beginPath();
  ctx.moveTo(0, size / 2);
  ctx.lineTo(size, size / 2);
  ctx.stroke();
  ctx.setLineDash([]);

  asphaltAlbedoCache = toTexture(c);
  return asphaltAlbedoCache;
}

/* ------------------------------------------------------------------ *
 *  Asphalt normal — crack relief derived from a height map
 * ------------------------------------------------------------------ */

let asphaltNormalCache: THREE.CanvasTexture | null = null;

/**
 * Asphalt normal map: builds a height field from the same noise + crack
 * lines, then computes a Sobel-encoded normal into RGB. Gives the surface
 * visible micro-relief so it catches light along the cracks.
 */
export function getAsphaltNormal(): THREE.CanvasTexture {
  if (asphaltNormalCache) return asphaltNormalCache;

  const size = TEX_SIZE;
  // Height field in [0,1].
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      h[y * size + x] = fbm(x / 64, y / 64, 5, 2.2, 0.55);
    }
  }
  // Add crack depressions: re-trace crack polylines and carve the height.
  for (let i = 0; i < 26; i++) {
    let x = Math.floor(hash2(i, 10) * size);
    let y = Math.floor(hash2(i, 11) * size);
    const segs = 6 + Math.floor(hash2(i, 12) * 8);
    for (let s = 0; s < segs; s++) {
      const nx = THREE.MathUtils.clamp(
        Math.floor(x + (hash2(i * 7 + s, 20) - 0.5) * 120),
        0,
        size - 1,
      );
      const ny = THREE.MathUtils.clamp(
        Math.floor(y + (hash2(i * 7 + s, 21) - 0.5) * 120),
        0,
        size - 1,
      );
      // Carve a short dark groove.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const px = nx + dx;
          const py = ny + dy;
          if (px < 0 || py < 0 || px >= size || py >= size) continue;
          h[py * size + px] *= 0.4;
        }
      }
      x = nx;
      y = ny;
    }
  }

  // Sobel -> normal.
  const c = makeCanvas(size);
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const out = img.data;
  const strength = 2.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xm = x > 0 ? x - 1 : x;
      const xp = x < size - 1 ? x + 1 : x;
      const ym = y > 0 ? y - 1 : y;
      const yp = y < size - 1 ? y + 1 : y;
      const hl = h[y * size + xm];
      const hr = h[y * size + xp];
      const ht = h[ym * size + x];
      const hb = h[yp * size + x];
      const dx = (hr - hl) * strength;
      const dy = (hb - ht) * strength;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const nx = dx / len;
      const ny = dy / len;
      const nz = 1 / len;
      const i = (y * size + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  // Normal maps are linear data, not sRGB.
  t.colorSpace = THREE.NoColorSpace;
  asphaltNormalCache = t;
  return t;
}

/* ------------------------------------------------------------------ *
 *  Asphalt roughness — mostly 0.95 with darker (smoother) oil stains
 * ------------------------------------------------------------------ */

let asphaltRoughnessCache: THREE.CanvasTexture | null = null;

/**
 * Asphalt roughness map: near-uniform high roughness (~0.95) with slightly
 * smoother patches where oil stains sit, so those areas catch a faint
 * specular sheen. Encoded as a greyscale luminance texture.
 */
export function getAsphaltRoughness(): THREE.CanvasTexture {
  if (asphaltRoughnessCache) return asphaltRoughnessCache;

  const size = TEX_SIZE;
  const c = makeCanvas(size);
  const ctx = c.getContext("2d")!;
  // Base roughness ~0.95 -> 242/255.
  ctx.fillStyle = "rgb(242,242,242)";
  ctx.fillRect(0, 0, size, size);

  // Subtle noise variation.
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const n = fbm(x / 80, y / 80, 4);
      const v = 235 + n * 20;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Oil stains = smoother (darker in the roughness map).
  for (let i = 0; i < 14; i++) {
    const px = hash2(i, 1) * size;
    const py = hash2(i, 2) * size;
    const r = 40 + hash2(i, 3) * 90;
    const g = ctx.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, "rgba(120,120,120,0.5)");
    g.addColorStop(1, "rgba(120,120,120,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.colorSpace = THREE.NoColorSpace;
  asphaltRoughnessCache = t;
  return asphaltRoughnessCache;
}

/* ------------------------------------------------------------------ *
 *  Cleanup
 * ------------------------------------------------------------------ */

/** Dispose all cached textures. Call on unmount of the world. */
export function disposeCityTextures(): void {
  if (asphaltAlbedoCache) {
    asphaltAlbedoCache.dispose();
    asphaltAlbedoCache = null;
  }
  if (asphaltNormalCache) {
    asphaltNormalCache.dispose();
    asphaltNormalCache = null;
  }
  if (asphaltRoughnessCache) {
    asphaltRoughnessCache.dispose();
    asphaltRoughnessCache = null;
  }
}
