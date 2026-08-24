import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useDayNightState } from "./DayNight";
import {
  WORLD_SIZE,
  CITY_GROUND_Z,
  CITY_GROUND_DEPTH,
  TOWN_GROUND_Z,
  TOWN_GROUND_DEPTH,
  CITY_PALETTE,
  TOWN_PALETTE,
} from "./constants";

/**
 * Two ground planes split by the river gap:
 *  - City side (Z > 20): textured urban asphalt with procedural noise.
 *  - Town side (Z < -20): grassy green with subtle variation.
 *
 * Both planes use procedural CanvasTextures for albedo + normal maps so
 * they have surface detail (cracks, grain, wear) instead of being flat
 * colors. Both darken at night, driven by the day/night state.
 *
 * All textures are generated from deterministic seeded noise (hash2 + fBm)
 * so they look identical on every page load — no Math.random().
 */

// Day colors (full brightness).
const CITY_DAY = new THREE.Color(CITY_PALETTE.asphalt);
const TOWN_DAY = new THREE.Color(TOWN_PALETTE.ground);
// Night colors (darkened, retaining a hint of the day hue).
const CITY_NIGHT = new THREE.Color(CITY_PALETTE.asphalt).multiplyScalar(0.2);
const TOWN_NIGHT = new THREE.Color(TOWN_PALETTE.ground).multiplyScalar(0.15);

const ASPHALT_SIZE = 1024;
const NORMAL_SIZE = 512;
const GRASS_SIZE = 512;
const ROUGHNESS_SIZE = 512;

/* ------------------------------------------------------------------ *
 *  Deterministic seeded noise (hash2 + value noise + fBm)
 *  Mirrors the pipeline in CityTextures.ts so results are stable across
 *  page loads — never uses Math.random().
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
function fbm(
  x: number,
  y: number,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
): number {
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

const clamp255 = (v: number) => Math.max(0, Math.min(255, v));

/* ------------------------------------------------------------------ *
 *  Asphalt albedo — 1024² multi-octave fBm + cracks + oil stains +
 *  lane edge markings + color variation
 * ------------------------------------------------------------------ */

/** Procedural asphalt texture — dark grey with noise, cracks, and wear. */
function makeAsphaltTexture(): THREE.CanvasTexture {
  const size = ASPHALT_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = CITY_PALETTE.asphalt;
  ctx.fillRect(0, 0, size, size);

  // Multi-octave value noise for surface grain + color variation. Per-pixel
  // fBm gives mottled patches of lighter/darker asphalt, not a flat grey.
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Coarse mottling (large patches) + fine grain.
      const n = fbm(x / 96, y / 96, 5, 2.2, 0.55);
      const grain = (hash2(x, y) - 0.5) * 0.05;
      // Map to a dark warm grey range (~36..60).
      const v = 40 + n * 24 + grain * 255;
      data[i] = clamp255(v * 0.98); // R
      data[i + 1] = clamp255(v * 0.96); // G
      data[i + 2] = clamp255(v * 0.92); // B (slightly warm)
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Oil-stain patches: darker soft radial blobs.
  ctx.globalCompositeOperation = "multiply";
  for (let i = 0; i < 16; i++) {
    const px = hash2(i, 1) * size;
    const py = hash2(i, 2) * size;
    const r = 40 + hash2(i, 3) * 100;
    const g = ctx.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, "rgba(18,16,14,0.55)");
    g.addColorStop(1, "rgba(18,16,14,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";

  // Hairline cracks: jittered polylines, dark and thin.
  ctx.strokeStyle = "rgba(10,8,6,0.85)";
  ctx.lineCap = "round";
  for (let i = 0; i < 28; i++) {
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

  // Lane edge markings: solid white lines along the left and right edges of
  // the tile, baked in so the road reads as having defined edges.
  ctx.strokeStyle = "rgba(220,220,200,0.55)";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(4, 0);
  ctx.lineTo(4, size);
  ctx.moveTo(size - 4, 0);
  ctx.lineTo(size - 4, size);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(40, 20); // tile across the 600×280 city ground
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ *
 *  Asphalt normal map — 512² Sobel filter on a heightmap (not random)
 * ------------------------------------------------------------------ */

/** Procedural asphalt normal map derived from a noise heightmap via Sobel. */
function makeAsphaltNormalMap(): THREE.CanvasTexture {
  const size = NORMAL_SIZE;
  // Build a height field in [0,1] from the same noise used for albedo,
  // scaled to the smaller normal-map resolution.
  const h = new Float32Array(size * size);
  const scale = ASPHALT_SIZE / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      h[y * size + x] = fbm((x * scale) / 96, (y * scale) / 96, 5, 2.2, 0.55);
    }
  }
  // Carve crack depressions into the height field so normals pick up relief
  // along the cracks. Re-trace the same crack polylines (deterministic).
  for (let i = 0; i < 28; i++) {
    let x = Math.floor((hash2(i, 10) * ASPHALT_SIZE) / scale);
    let y = Math.floor((hash2(i, 11) * ASPHALT_SIZE) / scale);
    const segs = 6 + Math.floor(hash2(i, 12) * 8);
    for (let s = 0; s < segs; s++) {
      const nx = THREE.MathUtils.clamp(
        Math.floor(x + (hash2(i * 7 + s, 20) - 0.5) * (120 / scale)),
        0,
        size - 1,
      );
      const ny = THREE.MathUtils.clamp(
        Math.floor(y + (hash2(i * 7 + s, 21) - 0.5) * (120 / scale)),
        0,
        size - 1,
      );
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

  // Sobel filter -> normal vector -> RGB.
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
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

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(40, 20);
  tex.anisotropy = 8;
  // Normal maps are linear data, not sRGB.
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ *
 *  Asphalt roughness map — varies between ~0.7 and ~0.95 so wet/dry
 *  patches read differently under lighting. Oil stains = smoother.
 * ------------------------------------------------------------------ */

function makeAsphaltRoughnessMap(): THREE.CanvasTexture {
  const size = ROUGHNESS_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const scale = ASPHALT_SIZE / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // fBm in [0,1] -> roughness range 0.70..0.95 -> luminance 178..242.
      const n = fbm((x * scale) / 80, (y * scale) / 80, 4);
      const v = 178 + n * 64;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Oil stains = smoother (darker in the roughness map).
  for (let i = 0; i < 16; i++) {
    const px = (hash2(i, 1) * ASPHALT_SIZE) / scale;
    const py = (hash2(i, 2) * ASPHALT_SIZE) / scale;
    const r = (40 + hash2(i, 3) * 100) / scale;
    const g = ctx.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, "rgba(120,120,120,0.5)");
    g.addColorStop(1, "rgba(120,120,120,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(40, 20);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ *
 *  Grass texture — 512² multi-octave color variation + blade streaks +
 *  dirt patches
 * ------------------------------------------------------------------ */

/** Procedural grass texture for the town side. */
function makeGrassTexture(): THREE.CanvasTexture {
  const size = GRASS_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = TOWN_PALETTE.ground;
  ctx.fillRect(0, 0, size, size);

  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  // Base grass color from the palette.
  const base = new THREE.Color(TOWN_PALETTE.ground);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Two noise fields: large-scale color variation + fine grain.
      const patch = fbm(x / 70, y / 70, 5, 2.2, 0.5); // patches of green/yellow/brown
      const fine = fbm(x / 8, y / 8, 3, 2.0, 0.5); // fine speckle
      // Blend between darker green, base green, and a dry yellow-brown.
      const dark = base.clone().multiplyScalar(0.7);
      const dry = new THREE.Color("#8a8a4a");
      let col: THREE.Color;
      if (patch < 0.45) {
        col = dark.clone().lerp(base, patch / 0.45);
      } else {
        col = base.clone().lerp(dry, (patch - 0.45) / 0.55);
      }
      // Fine grain brightness wobble.
      const wobble = (fine - 0.5) * 0.18;
      data[i] = clamp255((col.r + wobble) * 255);
      data[i + 1] = clamp255((col.g + wobble) * 255);
      data[i + 2] = clamp255((col.b + wobble * 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Blade-like patterns: short vertical streaks of lighter green, drawn
  // deterministically from the hash.
  ctx.strokeStyle = "rgba(120,150,80,0.5)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 1400; i++) {
    const x = hash2(i, 30) * size;
    const y = hash2(i, 31) * size;
    const len = 2 + hash2(i, 32) * 5;
    const tilt = (hash2(i, 33) - 0.5) * 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + tilt, y - len);
    ctx.stroke();
  }

  // Dirt patches: soft brown radial blobs.
  for (let i = 0; i < 10; i++) {
    const px = hash2(i, 40) * size;
    const py = hash2(i, 41) * size;
    const r = 20 + hash2(i, 42) * 50;
    const g = ctx.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, "rgba(90,74,58,0.45)");
    g.addColorStop(1, "rgba(90,74,58,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(40, 20);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function Ground() {
  const stateRef = useDayNightState();
  const cityMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const townMatRef = useRef<THREE.MeshStandardMaterial>(null);

  const cityGeo = useMemo(
    () => new THREE.PlaneGeometry(WORLD_SIZE, CITY_GROUND_DEPTH),
    [],
  );
  const townGeo = useMemo(
    () => new THREE.PlaneGeometry(WORLD_SIZE, TOWN_GROUND_DEPTH),
    [],
  );

  // Procedural textures (created once, deterministic across reloads).
  const asphaltTex = useMemo(() => makeAsphaltTexture(), []);
  const asphaltNormal = useMemo(() => makeAsphaltNormalMap(), []);
  const asphaltRoughness = useMemo(() => makeAsphaltRoughnessMap(), []);
  const grassTex = useMemo(() => makeGrassTexture(), []);

  useFrame(() => {
    const s = stateRef.current;
    const dayFactor = THREE.MathUtils.clamp(s.sunIntensity / 3, 0, 1);
    if (cityMatRef.current) {
      cityMatRef.current.color.copy(CITY_NIGHT).lerp(CITY_DAY, dayFactor);
    }
    if (townMatRef.current) {
      townMatRef.current.color.copy(TOWN_NIGHT).lerp(TOWN_DAY, dayFactor);
    }
  });

  return (
    <group>
      {/* City ground — textured asphalt with normal + roughness maps. */}
      <mesh
        geometry={cityGeo}
        position={[0, 0, CITY_GROUND_Z]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <meshStandardMaterial
          ref={cityMatRef}
          map={asphaltTex}
          normalMap={asphaltNormal}
          roughnessMap={asphaltRoughness}
          normalScale={new THREE.Vector2(0.4, 0.4)}
          color={CITY_PALETTE.asphalt}
          roughness={0.95}
          metalness={0}
        />
      </mesh>

      {/* Town ground — textured grass. */}
      <mesh
        geometry={townGeo}
        position={[0, 0, TOWN_GROUND_Z]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <meshStandardMaterial
          ref={townMatRef}
          map={grassTex}
          color={TOWN_PALETTE.ground}
          roughness={0.95}
          metalness={0}
        />
      </mesh>
    </group>
  );
}
