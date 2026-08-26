import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useDayNightState } from "./DayNight";
import type { Box2 } from "./car/physics";
import {
  TOWN_NS_ROADS,
  TOWN_EW_ROADS,
  TOWN_PALETTE,
  NATURE_PALETTE,
} from "./constants";

/**
 * Town — the quiet Japanese town north of the river (Z < -20).
 *
 * The opposite of the city: horizontal, low, warm, residential. 2-3 story
 * houses with pitched (gable/hip) tile roofs or flat-roofed corner shops,
 * side yards between buildings, a vermilion shrine with paper lanterns,
 * rice paddies framing Mt. Fuji, and a small JR-style train station.
 *
 * Everything static is baked into a handful of merged BufferGeometries.
 * House walls share one subtle plaster/siding canvas texture, UV-scaled
 * per house; roofs pick from a weighted tile-shade palette. At night only
 * a handful of warm windows per house light up (HDR values so bloom
 * catches them), plus occasional porch lights, stone lanterns, and a
 * string of paper lanterns at the shrine.
 */

/**
 * Ground-level house footprints for the car's collision world. Cleared and
 * refilled at the start of every generation pass (idempotent under
 * StrictMode double-invoke), mirroring CityDistrict's cityCollisionBoxes.
 */
export const townCollisionBoxes: Box2[] = [];

// WorldCar reads town boxes through this global pointer so the reference
// survives HMR module swaps.
(globalThis as { __townCollisionBoxes?: Box2[] }).__townCollisionBoxes =
  townCollisionBoxes;

/* ------------------------------------------------------------------ *
 *  Colors
 * ------------------------------------------------------------------ */

const C_CREAM = new THREE.Color(TOWN_PALETTE.wallCream);
const C_SAGE = new THREE.Color(TOWN_PALETTE.wallSage);
const C_TERRA = new THREE.Color(TOWN_PALETTE.wallTerracotta);
const C_VERMILION = new THREE.Color("#ff2a1a");
const C_STONE = new THREE.Color("#9a958c");
const C_STONE_DARK = new THREE.Color("#5d584f");
const C_TRUNK = new THREE.Color(NATURE_PALETTE.earth);
const C_FOLIAGE = new THREE.Color("#2a4a2a");
const C_AWNING = new THREE.Color("#8a4a3a");
const C_SHUTTER = new THREE.Color("#3a3530");
const C_TRACK = new THREE.Color("#262220");
const C_RAIL = new THREE.Color("#9a9088");
const C_BARRIER = new THREE.Color("#c8b070");
const C_POLE = new THREE.Color("#2e2e2e");
const C_PLATFORM = new THREE.Color("#8a8580");
const C_PADDY_GREEN = new THREE.Color(NATURE_PALETTE.ricePaddy);
const C_PADDY_GOLD = new THREE.Color("#b8a85a");
const C_EARTH = new THREE.Color(NATURE_PALETTE.earth);

/** Pastel wall choices for houses. */
const WALL_COLORS = [C_CREAM, C_SAGE, C_TERRA];

/**
 * Roof tile shades — dark grey-blue is the base family (most houses);
 * weathered grey, terracotta, and moss green appear occasionally.
 */
const ROOF_BLUE_A = new THREE.Color("#39414f");
const ROOF_BLUE_B = new THREE.Color("#2f3743");
const ROOF_WEATHERED = new THREE.Color("#7f848b");
const ROOF_TERRACOTTA = new THREE.Color("#9a4a32");
const ROOF_MOSS = new THREE.Color("#4c5c48");

/** Weighted roof tint pick: mostly the grey-blue tile family. */
function pickRoofTint(r: number): THREE.Color {
  if (r < 0.36) return ROOF_BLUE_A;
  if (r < 0.62) return ROOF_BLUE_B;
  if (r < 0.76) return ROOF_WEATHERED;
  if (r < 0.88) return ROOF_TERRACOTTA;
  return ROOF_MOSS;
}

const C_GRAVEL = new THREE.Color("#767268"); // flat shop roof slabs
const C_UTILITY = new THREE.Color("#aab0b4"); // wall-side utility boxes
const C_UTILITY_DOOR = new THREE.Color("#7d8488");
const C_POT = new THREE.Color("#8a4a30"); // plant pots
const C_POT_PLANT = new THREE.Color("#3f6a38");
const C_CANOPY_GREEN = new THREE.Color("#2e5c4d"); // station platform canopy
const C_WOOD_BENCH = new THREE.Color("#7a5636");
const C_VENDING = new THREE.Color("#c81f36");
const C_VENDING_FACE = new THREE.Color("#1d232b");
const C_TACTILE = new THREE.Color("#d8b93a"); // platform edge strip
const C_PAPER = new THREE.Color("#f2e3cc"); // paper lanterns
const C_ROPE = new THREE.Color("#4a3f32");

/** Fence post + garden/driveway colors. */
const C_FENCE = new THREE.Color("#6a5a4a");
const C_FENCE_DARK = new THREE.Color("#3a3530");
const C_GARDEN_GREEN = new THREE.Color("#3a5a32");
const C_GARDEN_BROWN = new THREE.Color("#5a4a32");
const C_DRIVEWAY = new THREE.Color("#2a2a2a");

/* ------------------------------------------------------------------ *
 *  Town window glow shader
 * ------------------------------------------------------------------ *
 *  Simplified port of CityDistrict's window shader. Each window carries
 *  aPhase / aBrightness / aTint attributes so windows switch on at night
 *  staggered, with per-window brightness and warm/cool tint variation.
 *  During the day windows read as dark glass against the walls.
 */

const TOWN_WINDOW_VERT = /* glsl */ `
  attribute float aPhase;
  attribute float aBrightness;
  attribute float aTint;
  varying float vPhase;
  varying float vBrightness;
  varying float vTint;
  void main() {
    vPhase = aPhase;
    vBrightness = aBrightness;
    vTint = aTint;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TOWN_WINDOW_FRAG = /* glsl */ `
  uniform float uWindowGlow;
  uniform vec3 uGlowWarm;
  uniform vec3 uGlowCool;
  varying float vPhase;
  varying float vBrightness;
  varying float vTint;
  void main() {
    vec3 dayGlass = vec3(0.22, 0.26, 0.32);
    vec3 nightCol = mix(uGlowWarm, uGlowCool, vTint);
    float on = smoothstep(vPhase - 0.08, vPhase + 0.08, uWindowGlow);
    float nightLit = mix(0.0, vBrightness, on);
    vec3 col = mix(dayGlass, nightCol, nightLit);
    float dayBright = 0.35 + vBrightness * 0.2;
    // HDR at night (up to ~2.4x) so the bloom pass catches lit windows.
    float nightBright = 0.03 + nightLit * 2.4;
    float brightness = mix(dayBright, nightBright, on);
    gl_FragColor = vec4(col * brightness, 1.0);
  }
`;

/* ------------------------------------------------------------------ *
 *  Shared procedural textures
 * ------------------------------------------------------------------ */

/**
 * Subtle plaster/stucco wall texture: near-white base (so vertex tints
 * show through), fine speckle grain, and faint horizontal siding lines.
 * One shared texture; per-house tiling is baked into each box's UVs.
 */
function makeStuccoTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fdfcfa";
  ctx.fillRect(0, 0, size, size);
  // Plaster grain: low-alpha speckle.
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    data[i] = Math.max(0, Math.min(255, data[i] + n));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n * 0.8));
  }
  ctx.putImageData(img, 0, 0);
  // Faint horizontal siding lines.
  ctx.strokeStyle = "rgba(70, 64, 54, 0.10)";
  ctx.lineWidth = 1;
  for (let y = 8; y < size; y += 16) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Radial warm glow blob for porch-light ground pools (additive blending). */
function makeGlowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(
    size / 2, size / 2, 2, size / 2, size / 2, size / 2,
  );
  grad.addColorStop(0, "rgba(255, 214, 160, 0.85)");
  grad.addColorStop(0.45, "rgba(255, 190, 120, 0.35)");
  grad.addColorStop(1, "rgba(255, 180, 100, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** JR-style station name board: kanji + romaji on deep green. */
function makeStationSignTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 144;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#0d5a40";
  ctx.fillRect(0, 0, 512, 144);
  ctx.strokeStyle = "#e8efe8";
  ctx.lineWidth = 5;
  ctx.strokeRect(7, 7, 498, 130);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#f5f7f2";
  ctx.font = "700 60px 'Hiragino Sans', 'Yu Gothic', sans-serif";
  ctx.fillText("鳥居町駅", 26, 74);
  ctx.font = "600 26px 'Helvetica Neue', Arial, sans-serif";
  ctx.fillStyle = "#cfe0d4";
  ctx.fillText("TORIIMACHI STATION", 28, 120);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ *
 *  Seeded random — deterministic per grid cell
 * ------------------------------------------------------------------ */

/** Hash two ints into a 32-bit seed. */
function hashSeed(x: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263)) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  return h >>> 0;
}

/** mulberry32 PRNG: returns a function producing floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 *  Geometry helpers
 * ------------------------------------------------------------------ */

const _m = new THREE.Matrix4();

/** Translate a geometry in place (bakes the transform into vertices). */
function translate(
  geo: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
): THREE.BufferGeometry {
  _m.makeTranslation(x, y, z);
  geo.applyMatrix4(_m);
  return geo;
}

/**
 * Normalize a geometry to non-indexed, position + normal + color attributes
 * so it can be merged with other vertex-colored geometries.
 */
function toPNC(
  geo: THREE.BufferGeometry,
  color: THREE.Color,
): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute("uv");
  g.deleteAttribute("uv1");
  g.deleteAttribute("uv2");
  g.computeVertexNormals();
  const pos = g.attributes.position;
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    arr[i * 3] = color.r;
    arr[i * 3 + 1] = color.g;
    arr[i * 3 + 2] = color.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g;
}

/** Normalize to non-indexed position + normal (no color) for emissive merges. */
function toPN(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute("uv");
  g.deleteAttribute("uv1");
  g.deleteAttribute("uv2");
  g.computeVertexNormals();
  return g;
}

/** Like toPNC but keeps UVs, for geometries carrying the shared wall map. */
function toPNCUV(
  geo: THREE.BufferGeometry,
  color: THREE.Color,
): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute("uv1");
  g.deleteAttribute("uv2");
  g.computeVertexNormals();
  const pos = g.attributes.position;
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    arr[i * 3] = color.r;
    arr[i * 3 + 1] = color.g;
    arr[i * 3 + 2] = color.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g;
}

/**
 * Scale a box geometry's UVs per-face so a repeating texture tiles at
 * `tile` world units. BoxGeometry orders faces px, nx, py, ny, pz, nz,
 * each with 4 uv pairs.
 */
function scaleBoxUvs(
  g: THREE.BoxGeometry,
  w: number,
  h: number,
  d: number,
  tile: number,
): void {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const faceDims: [number, number][] = [
    [d, h], [d, h], // px, nx
    [w, d], [w, d], // py, ny
    [w, h], [w, h], // pz, nz
  ];
  for (let f = 0; f < 6; f++) {
    const [fw, fh] = faceDims[f];
    const ru = fw / tile;
    const rv = fh / tile;
    for (let i = 0; i < 4; i++) {
      const idx = f * 4 + i;
      uv.setXY(idx, uv.getX(idx) * ru, uv.getY(idx) * rv);
    }
  }
  uv.needsUpdate = true;
}

/** Safely merge an array of geometries; returns null if the array is empty. */
function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geos.length === 0) return null;
  return mergeGeometries(geos, false);
}

type Dir = "+Z" | "-Z" | "+X" | "-X";

/**
 * Build a small axis-aligned quad (two triangles) facing a cardinal
 * direction. Used for window panes and shop signs. Winding is CCW outward
 * so front-face culling works without DoubleSide.
 */
function axisQuad(
  cx: number,
  cy: number,
  cz: number,
  w: number,
  h: number,
  face: Dir,
): THREE.BufferGeometry {
  const hw = w / 2;
  const hh = h / 2;
  let p: number[];
  switch (face) {
    case "+Z":
      p = [
        cx - hw, cy - hh, cz, cx + hw, cy - hh, cz, cx + hw, cy + hh, cz,
        cx - hw, cy + hh, cz,
      ];
      break;
    case "-Z":
      p = [
        cx + hw, cy - hh, cz, cx - hw, cy - hh, cz, cx - hw, cy + hh, cz,
        cx + hw, cy + hh, cz,
      ];
      break;
    case "+X":
      p = [
        cx, cy - hh, cz + hw, cx, cy - hh, cz - hw, cx, cy + hh, cz - hw,
        cx, cy + hh, cz + hw,
      ];
      break;
    case "-X":
      p = [
        cx, cy - hh, cz - hw, cx, cy - hh, cz + hw, cx, cy + hh, cz + hw,
        cx, cy + hh, cz - hw,
      ];
      break;
  }
  const positions = new Float32Array([
    p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8],
    p[0], p[1], p[2], p[6], p[7], p[8], p[9], p[10], p[11],
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Build a window quad with per-window phase/brightness/tint attributes so
 * the town window shader can light windows staggered at night. `lit`
 * windows glow warm and HDR; unlit ones stay dark glass.
 */
function pushTownWindow(
  arr: THREE.BufferGeometry[],
  cx: number,
  cy: number,
  cz: number,
  w: number,
  h: number,
  face: Dir,
  phase: number,
  brightness: number,
  tint: number,
): void {
  const g = axisQuad(cx, cy, cz, w, h, face);
  const n = g.attributes.position.count;
  g.setAttribute(
    "aPhase",
    new THREE.BufferAttribute(new Float32Array(n).fill(phase), 1),
  );
  g.setAttribute(
    "aBrightness",
    new THREE.BufferAttribute(new Float32Array(n).fill(brightness), 1),
  );
  g.setAttribute(
    "aTint",
    new THREE.BufferAttribute(new Float32Array(n).fill(tint), 1),
  );
  arr.push(g);
}

/** Horizontal colored quad sitting on the ground (for gardens/driveways). */
function groundQuad(
  cx: number,
  cz: number,
  w: number,
  d: number,
  color: THREE.Color,
): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  g.translate(cx, 0, cz);
  return toPNC(g, color);
}

/**
 * Gable roof: a triangular prism with the ridge running along X. Base sits
 * at y=0 (positioned at the wall top by the caller), apex at y=rh. Slight
 * eave overhang on all sides.
 */
function gableRoofGeo(w: number, d: number, rh: number): THREE.BufferGeometry {
  const w2 = w / 2 + 0.25;
  const d2 = d / 2 + 0.25;
  const y0 = -0.25;
  const positions = new Float32Array([
    // left gable end (outward -X)
    -w2, y0, -d2, -w2, y0, d2, -w2, rh, 0,
    // right gable end (outward +X)
    w2, y0, d2, w2, y0, -d2, w2, rh, 0,
    // back slope (outward -Z)
    w2, y0, -d2, -w2, y0, -d2, -w2, rh, 0,
    w2, y0, -d2, -w2, rh, 0, w2, rh, 0,
    // front slope (outward +Z)
    -w2, y0, d2, w2, y0, d2, w2, rh, 0,
    -w2, y0, d2, w2, rh, 0, -w2, rh, 0,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Hip roof: a four-sided pyramid. Apex centered above the base, four sloped
 * faces. Eave overhang on all sides.
 */
function hipRoofGeo(w: number, d: number, rh: number): THREE.BufferGeometry {
  const w2 = w / 2 + 0.25;
  const d2 = d / 2 + 0.25;
  const y0 = -0.25;
  const positions = new Float32Array([
    // front (+Z)
    -w2, y0, d2, w2, y0, d2, 0, rh, 0,
    // back (-Z)
    w2, y0, -d2, -w2, y0, -d2, 0, rh, 0,
    // right (+X)
    w2, y0, d2, w2, y0, -d2, 0, rh, 0,
    // left (-X)
    -w2, y0, -d2, -w2, y0, d2, 0, rh, 0,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------------------------------------------ *
 *  Building generation
 * ------------------------------------------------------------------ */

interface BuildingSpec {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  color: THREE.Color;
  roofType: "gable" | "hip";
  roofTint: THREE.Color;
  commercial: boolean;
  /** Flat-roofed shop with parapet instead of a pitched tile roof. */
  flat: boolean;
}

/** Town road half-width (TOWN_ROAD_WIDTH=7 / 2) + 1 unit sidewalk buffer. */
const ROAD_HALF = 4.5;
const PLOT_W = 12;
const PLOT_D = 11;

/** Blocks reserved for the shrine and station (no houses generated there).
 *  Shrine is at X=0, Z=-70 (between NS roads -16/16 = bi 2, EW roads -40/-80 = bj 0).
 *  Station is at X=48, Z=-100 (between NS roads 16/48 = bi 3... actually 48/80 = bi 4, EW roads -80/-120 = bj 1). */
const SHRINE_BLOCK = { bi: 2, bj: 0 };
const STATION_BLOCK = { bi: 4, bj: 1 };
/** Z of the ground-level train track through the town. */
const TRACK_Z = -100;

function generateBuildings(): BuildingSpec[] {
  const out: BuildingSpec[] = [];
  for (let bi = 0; bi < TOWN_NS_ROADS.length - 1; bi++) {
    const xL = TOWN_NS_ROADS[bi] + ROAD_HALF;
    const xR = TOWN_NS_ROADS[bi + 1] - ROAD_HALF;
    for (let bj = 0; bj < TOWN_EW_ROADS.length - 1; bj++) {
      if (
        (bi === SHRINE_BLOCK.bi && bj === SHRINE_BLOCK.bj) ||
        (bi === STATION_BLOCK.bi && bj === STATION_BLOCK.bj)
      ) {
        continue;
      }
      const zS = TOWN_EW_ROADS[bj] - ROAD_HALF;
      const zN = TOWN_EW_ROADS[bj + 1] + ROAD_HALF;
      for (let px = xL + PLOT_W / 2; px < xR; px += PLOT_W) {
        for (let pz = zS - PLOT_D / 2; pz > zN; pz -= PLOT_D) {
          // Skip buildings too close to the train track corridor (Z=TRACK_Z ± 3).
          if (Math.abs(pz - TRACK_Z) < 4) continue;
          const rng = mulberry32(hashSeed(Math.round(px), Math.round(pz)));
          const w = 5 + rng() * 5;
          const d = 5 + rng() * 5;
          const h = 4 + rng() * 5;
          const color = WALL_COLORS[Math.floor(rng() * WALL_COLORS.length)];
          const roofType: "gable" | "hip" = rng() < 0.62 ? "gable" : "hip";
          const roofTint = pickRoofTint(rng());
          const commercial = rng() < 0.22;
          // About half the commercial buildings read as flat-roofed shops.
          const flat = commercial && rng() < 0.5;
          out.push({ x: px, z: pz, w, d, h, color, roofType, roofTint, commercial, flat });
        }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  Town geometry builder
 * ------------------------------------------------------------------ */

interface TownGeometries {
  wallsTextured: THREE.BufferGeometry | null;
  trim: THREE.BufferGeometry | null;
  roofs: THREE.BufferGeometry | null;
  misc: THREE.BufferGeometry | null;
  fences: THREE.BufferGeometry | null;
  paddies: THREE.BufferGeometry | null;
  paddyWater: THREE.BufferGeometry | null;
  lamps: THREE.BufferGeometry | null;
  windows: THREE.BufferGeometry | null;
  porchGlow: THREE.BufferGeometry | null;
  porchPools: THREE.BufferGeometry | null;
  lanterns: THREE.BufferGeometry | null;
}

/** Texture tile size for the shared stucco wall map, in world units. */
const WALL_TILE = 3.0;

function buildTown(): TownGeometries {
  const wallsTextured: THREE.BufferGeometry[] = [];
  const trim: THREE.BufferGeometry[] = [];
  const roofs: THREE.BufferGeometry[] = [];
  const misc: THREE.BufferGeometry[] = [];
  const fences: THREE.BufferGeometry[] = [];
  const paddies: THREE.BufferGeometry[] = [];
  const paddyWater: THREE.BufferGeometry[] = [];
  const lamps: THREE.BufferGeometry[] = [];
  const windows: THREE.BufferGeometry[] = [];
  const porchGlow: THREE.BufferGeometry[] = [];
  const porchPools: THREE.BufferGeometry[] = [];
  const lanterns: THREE.BufferGeometry[] = [];

  // Idempotent under StrictMode double-invoke.
  townCollisionBoxes.length = 0;

  const buildings = generateBuildings();

  for (const b of buildings) {
    // Wall body — textured bucket so houses pick up plaster/siding detail.
    let w = b.w;
    let d = b.d;
    let roofType = b.roofType;
    if (!b.flat && roofType === "gable" && d > w) {
      [w, d] = [d, w];
    }

    // Register ground footprint for car collision (final wall extents).
    townCollisionBoxes.push([b.x - w / 2, b.x + w / 2, b.z - d / 2, b.z + d / 2]);

    const wallBox = new THREE.BoxGeometry(w, b.h, d);
    scaleBoxUvs(wallBox, w, b.h, d, WALL_TILE);
    translate(wallBox, b.x, b.h / 2, b.z);
    wallsTextured.push(toPNCUV(wallBox, b.color));

    // Roof — weighted tile shade; gables get a ridge cap box, flat shops
    // get a gravel slab with a parapet ring.
    if (b.flat) {
      const slab = toPNC(new THREE.BoxGeometry(w + 0.5, 0.28, d + 0.5), C_GRAVEL);
      translate(slab, b.x, b.h + 0.14, b.z);
      roofs.push(slab);
      const parapetColor = b.color.clone().multiplyScalar(0.8);
      for (const [pw, pd, ox, oz] of [
        [w + 0.5, 0.18, 0, d / 2 + 0.16],
        [w + 0.5, 0.18, 0, -d / 2 - 0.16],
        [0.18, d + 0.5, w / 2 + 0.16, 0],
        [0.18, d + 0.5, -w / 2 - 0.16, 0],
      ] as Array<[number, number, number, number]>) {
        const par = toPNC(new THREE.BoxGeometry(pw, 0.5, pd), parapetColor);
        translate(par, b.x + ox, b.h + 0.5, b.z + oz);
        roofs.push(par);
      }
    } else {
      const rh = THREE.MathUtils.clamp(Math.min(w, d) * 0.4, 1.4, 3);
      const roofGeo =
        roofType === "gable" ? gableRoofGeo(w, d, rh) : hipRoofGeo(w, d, rh);
      translate(roofGeo, b.x, b.h, b.z);
      roofs.push(toPNC(roofGeo, b.roofTint));
      if (roofType === "gable") {
        const capColor = b.roofTint.clone().multiplyScalar(0.62);
        const cap = toPNC(new THREE.BoxGeometry(w + 0.45, 0.16, 0.42), capColor);
        translate(cap, b.x, b.h + rh + 0.04, b.z);
        roofs.push(cap);
      }
    }

    // Windows on the two long facades. Most stay dark at night; exactly
    // 2-5 are chosen per house to glow warm, staggered like the city.
    const cols = Math.max(1, Math.floor(w / 2.4));
    const rows = Math.max(1, Math.floor((b.h - 2) / 2.2));
    const sx = w / (cols + 1);
    const sy = (b.h - 2) / (rows + 1);
    const winSize = 0.7;
    const winRng = mulberry32(hashSeed(Math.round(b.x * 3.1), Math.round(b.z * 2.3)));
    interface WinCand {
      x: number;
      y: number;
      face: Dir;
    }
    const cands: WinCand[] = [];
    for (let r = 0; r < rows; r++) {
      const wy = 1.4 + (r + 1) * sy;
      for (let c = 0; c < cols; c++) {
        const wx = b.x - w / 2 + (c + 1) * sx;
        cands.push({ x: wx, y: wy, face: "+Z" });
        cands.push({ x: wx, y: wy, face: "-Z" });
      }
    }
    // Shuffle candidates so lit windows scatter across the facade.
    for (let i = cands.length - 1; i > 0; i--) {
      const j = Math.floor(winRng() * (i + 1));
      [cands[i], cands[j]] = [cands[j], cands[i]];
    }
    const litCount = Math.min(cands.length, 2 + Math.floor(winRng() * 4));
    cands.forEach((cd, i) => {
      const zFace = cd.face === "+Z" ? b.z + d / 2 + 0.06 : b.z - d / 2 - 0.06;
      if (i < litCount) {
        pushTownWindow(
          windows, cd.x, cd.y, zFace, winSize, winSize, cd.face,
          winRng(), 0.75 + winRng() * 0.25, winRng() * 0.15,
        );
      } else {
        pushTownWindow(
          windows, cd.x, cd.y, zFace, winSize, winSize, cd.face,
          winRng(), 0, 0.5,
        );
      }
    });

    // Commercial ground-floor details: shutter panel, awning, sign.
    if (b.commercial) {
      const shutter = toPNC(new THREE.BoxGeometry(w * 0.7, 1.6, 0.08), C_SHUTTER);
      translate(shutter, b.x, 0.9, b.z + d / 2 + 0.05);
      trim.push(shutter);

      const awning = toPNC(new THREE.BoxGeometry(w * 0.6, 0.12, 1.1), C_AWNING);
      translate(awning, b.x, 1.9, b.z + d / 2 + 0.55);
      trim.push(awning);

      // Warm shop sign — emissive via the window shader (always-on at night).
      pushTownWindow(
        windows, b.x, 2.5, b.z + d / 2 + 0.07, w * 0.5, 0.5, "+Z", 0.02, 1.0, 0.05,
      );
    } else if (winRng() < 0.18) {
      // Porch light: small warm quad by the door + additive ground pool.
      const px = b.x + (winRng() < 0.5 ? -1 : 1) * w * 0.3;
      porchGlow.push(toPN(axisQuad(px, 2.25, b.z + d / 2 + 0.07, 0.3, 0.22, "+Z")));
      const pool = new THREE.PlaneGeometry(2.8, 2.8);
      pool.rotateX(-Math.PI / 2);
      translate(pool, px, 0.05, Math.min(b.z + d / 2 + 1.15, b.z + PLOT_D / 2 - 0.4));
      porchPools.push(pool);
    }

    // Street clutter: utility boxes and potted plants against walls.
    const detRng = mulberry32(hashSeed(Math.round(b.x * 5.3), Math.round(b.z * 7.7)));
    if (detRng() < 0.22) {
      const side = detRng() < 0.5 ? -1 : 1;
      const ux = b.x + side * (w / 2 + 0.34);
      const uz = b.z + (detRng() - 0.5) * d * 0.5;
      const ubox = toPNC(new THREE.BoxGeometry(0.55, 1.35, 0.95), C_UTILITY);
      translate(ubox, ux, 0.675, uz);
      fences.push(ubox);
      const udoor = toPNC(new THREE.BoxGeometry(0.05, 0.95, 0.65), C_UTILITY_DOOR);
      translate(udoor, ux - side * 0.3, 0.72, uz);
      fences.push(udoor);
    }
    if (detRng() < 0.3) {
      const side = detRng() < 0.5 ? -1 : 1;
      const potX = b.x + side * w * 0.32;
      const potZ = Math.min(b.z + d / 2 + 0.75, b.z + PLOT_D / 2 - 0.6);
      const pot = toPNC(new THREE.CylinderGeometry(0.17, 0.22, 0.32, 7), C_POT);
      translate(pot, potX, 0.16, potZ);
      fences.push(pot);
      const plant = toPNC(new THREE.SphereGeometry(0.24, 6, 5), C_POT_PLANT);
      plant.scale(1, 0.85, 1);
      translate(plant, potX, 0.48, potZ);
      fences.push(plant);
    }

    // Fence, garden patches and a driveway around the house plot.
    buildPlotFence(fences, b);
  }

  /* ---- Shrine ---- */
  buildShrine(misc, lamps, lanterns);

  /* ---- Train station + tracks + level crossing ---- */
  buildStation(wallsTextured, roofs, misc, lamps);

  /* ---- Streetlights along every road ---- */
  buildStreetlights(misc, lamps);

  /* ---- Street trees lining the town roads ---- */
  buildStreetTrees(misc);

  /* ---- Rice paddies north of the last road, framing Fuji ---- */
  buildPaddies(paddies, paddyWater);

  return {
    wallsTextured: merge(wallsTextured),
    trim: merge(trim),
    roofs: merge(roofs),
    misc: merge(misc),
    fences: merge(fences),
    paddies: merge(paddies),
    paddyWater: merge(paddyWater),
    lamps: merge(lamps),
    windows: merge(windows),
    porchGlow: merge(porchGlow),
    porchPools: merge(porchPools),
    lanterns: merge(lanterns),
  };
}

/**
 * Shrine: proper myojin-style torii (stacked-box lintel with upturned
 * ends), dark stone plinths and platform, six stone lanterns with warm
 * light boxes, a string of sagging paper lanterns across the approach,
 * and a few trees.
 */
function buildShrine(
  misc: THREE.BufferGeometry[],
  lamps: THREE.BufferGeometry[],
  lanterns: THREE.BufferGeometry[],
): void {
  const sx = 0;
  const sz = -70; // Between EW roads at -40 and -80, away from the track at Z=-100.

  // Dark stone plinths under each pillar + raised approach platform/steps.
  for (const px of [sx - 2.7, sx + 2.7]) {
    const plinth = toPNC(new THREE.BoxGeometry(1.15, 0.5, 1.15), C_STONE_DARK);
    translate(plinth, px, 0.25, sz);
    misc.push(plinth);
    // Pillar footprints are solid for the car.
    townCollisionBoxes.push([px - 0.58, px + 0.58, sz - 0.58, sz + 0.58]);
  }
  const platform = toPNC(new THREE.BoxGeometry(11, 0.4, 7), C_STONE);
  translate(platform, sx, 0.2, sz + 1.5);
  misc.push(platform);
  const steps = toPNC(new THREE.BoxGeometry(3, 0.3, 1), C_STONE_DARK);
  translate(steps, sx, 0.15, sz - 2.2);
  misc.push(steps);

  // Vermilion pillars (slightly tapered boxes).
  for (const px of [sx - 2.7, sx + 2.7]) {
    const pillar = toPNC(new THREE.BoxGeometry(0.62, 5.6, 0.62), C_VERMILION);
    translate(pillar, px, 0.5 + 2.8, sz);
    misc.push(pillar);
  }

  // Nuki (lower lintel) passes through the pillars.
  const nuki = toPNC(new THREE.BoxGeometry(6.8, 0.38, 0.55), C_VERMILION);
  translate(nuki, sx, 4.9, sz);
  misc.push(nuki);

  // Gakuzuka (central name plaque) between nuki and shimaki.
  const gakuzuka = toPNC(new THREE.BoxGeometry(0.7, 0.9, 0.28), C_VERMILION);
  translate(gakuzuka, sx, 5.38, sz);
  misc.push(gakuzuka);

  // Double top lintel: shimaki under a kasagi whose stacked end boxes step
  // upward toward the tips, suggesting the classic curved-up silhouette.
  const shimaki = toPNC(new THREE.BoxGeometry(7.4, 0.34, 0.68), C_VERMILION);
  translate(shimaki, sx, 5.95, sz);
  misc.push(shimaki);
  const kasagi = toPNC(new THREE.BoxGeometry(7.6, 0.4, 0.8), C_VERMILION);
  translate(kasagi, sx, 6.32, sz);
  misc.push(kasagi);
  for (const dir of [-1, 1]) {
    const lift = toPNC(new THREE.BoxGeometry(1.7, 0.4, 0.8), C_VERMILION);
    _m.makeRotationZ(-dir * 0.2);
    _m.setPosition(sx + dir * 3.7, 6.5, sz);
    lift.applyMatrix4(_m);
    misc.push(lift);
    // Upturned tip cap.
    const tip = toPNC(new THREE.BoxGeometry(0.8, 0.5, 0.84), C_VERMILION);
    _m.makeRotationZ(-dir * 0.27);
    _m.setPosition(sx + dir * 4.5, 6.72, sz);
    tip.applyMatrix4(_m);
    misc.push(tip);
  }

  // Six stone lanterns flanking the approach; light boxes join the street
  // lamp material so they glow warm at night.
  for (const lz of [sz + 4.5, sz + 0.5, sz - 3.5]) {
    for (const lx of [sx - 4.2, sx + 4.2]) {
      const base = toPNC(new THREE.BoxGeometry(0.75, 0.25, 0.75), C_STONE_DARK);
      translate(base, lx, 0.125, lz);
      misc.push(base);
      const pedestal = toPNC(new THREE.BoxGeometry(0.42, 0.5, 0.42), C_STONE);
      translate(pedestal, lx, 0.5, lz);
      misc.push(pedestal);
      const shaft = toPNC(new THREE.CylinderGeometry(0.16, 0.2, 0.6, 6), C_STONE);
      translate(shaft, lx, 1.05, lz);
      misc.push(shaft);
      const lightBox = toPN(new THREE.BoxGeometry(0.44, 0.36, 0.44));
      translate(lightBox, lx, 1.53, lz);
      lamps.push(lightBox);
      const cap = toPNC(new THREE.ConeGeometry(0.56, 0.35, 4), C_STONE_DARK);
      cap.rotateY(Math.PI / 4);
      translate(cap, lx, 1.88, lz);
      misc.push(cap);
    }
  }

  // String of paper lanterns across the approach south of the torii:
  // two wooden poles, sagging rope segments, glowing paper spheres.
  const poleXs = [sx - 6, sx + 6];
  const ropeZ = sz + 8;
  for (const px of poleXs) {
    const pole = toPNC(new THREE.CylinderGeometry(0.09, 0.12, 2.7, 6), C_FENCE);
    translate(pole, px, 1.35, ropeZ);
    misc.push(pole);
  }
  const lanternCount = 9;
  const ys: number[] = [];
  for (let i = 0; i < lanternCount; i++) {
    const t = i / (lanternCount - 1);
    const lx = poleXs[0] + t * (poleXs[1] - poleXs[0]);
    const ly = 2.6 - Math.sin(t * Math.PI) * 0.5;
    ys.push(ly);
    if (i > 0) {
      const dx = lx - (poleXs[0] + ((i - 1) / (lanternCount - 1)) * (poleXs[1] - poleXs[0]));
      const dy = ly - ys[i - 1];
      const seg = toPNC(
        new THREE.BoxGeometry(Math.abs(dx) + 0.02, 0.03, 0.03),
        C_ROPE,
      );
      seg.rotateZ(Math.atan2(dy, dx));
      translate(seg, lx - dx / 2, ly + dy / 2 + 0.26, ropeZ);
      misc.push(seg);
    }
    const bulb = toPN(new THREE.SphereGeometry(0.24, 8, 6));
    bulb.scale(1, 1.18, 1);
    translate(bulb, lx, ly - 0.02, ropeZ);
    lanterns.push(bulb);
    const lcap = toPNC(new THREE.BoxGeometry(0.13, 0.06, 0.13), C_ROPE);
    translate(lcap, lx, ly + 0.27, ropeZ);
    misc.push(lcap);
  }

  // A few trees around the shrine.
  const treeSpots: Array<[number, number]> = [
    [sx - 5.5, sz + 3.5],
    [sx + 5.5, sz + 3.5],
    [sx - 5.5, sz - 4],
    [sx + 5.5, sz - 4],
    [sx - 6.5, sz],
    [sx + 6.5, sz],
  ];
  for (const [tx, tz] of treeSpots) {
    pushTree(misc, tx, tz);
  }
}

/** Simple tree: brown trunk + dark green cone foliage. */
function pushTree(misc: THREE.BufferGeometry[], x: number, z: number): void {
  const trunk = toPNC(new THREE.CylinderGeometry(0.3, 0.42, 2.2, 6), C_TRUNK);
  translate(trunk, x, 1.1, z);
  misc.push(trunk);
  const foliage = toPNC(
    new THREE.ConeGeometry(1.7, 3.8, 7),
    C_FOLIAGE,
  );
  translate(foliage, x, 3.4, z);
  misc.push(foliage);
}

/**
 * Fence, garden patches and a driveway around one house plot. Posts are
 * small boxes (0.1 x 0.8 x 0.1) spaced every 1.5 units around the plot
 * perimeter; a couple of garden quads and a dark driveway quad fill the
 * setback between the fence and the house. All merged into the fence bucket.
 */
function buildPlotFence(
  fences: THREE.BufferGeometry[],
  b: BuildingSpec,
): void {
  const halfW = PLOT_W / 2 - 0.3;
  const halfD = PLOT_D / 2 - 0.3;
  const postH = 0.8;
  const spacing = 1.5;
  const rng = mulberry32(hashSeed(Math.round(b.x * 1.7), Math.round(b.z * 1.3)));
  const postColor = rng() < 0.5 ? C_FENCE : C_FENCE_DARK;

  // Actual building half-extent in Z. Gable roofs swap w/d so the ridge runs
  // along the longer side, making the Z extent the shorter dimension.
  const edgeZ =
    b.roofType === "gable" ? Math.min(b.w, b.d) / 2 : b.d / 2;

  // Posts along the four sides (corners included).
  const pushPost = (x: number, z: number) => {
    const post = toPNC(
      new THREE.BoxGeometry(0.1, postH, 0.1),
      postColor,
    );
    translate(post, x, postH / 2, z);
    fences.push(post);
  };
  for (let x = -halfW; x <= halfW + 0.01; x += spacing) {
    pushPost(b.x + x, b.z + halfD);
    pushPost(b.x + x, b.z - halfD);
  }
  for (let z = -halfD + spacing; z < halfD; z += spacing) {
    pushPost(b.x + halfW, b.z + z);
    pushPost(b.x - halfW, b.z + z);
  }

  // Driveway toward the nearest east-west road.
  let drvSide = 1; // +Z (south)
  let nearest = Infinity;
  for (const rz of TOWN_EW_ROADS) {
    if (Math.abs(b.z - rz) < nearest) {
      nearest = Math.abs(b.z - rz);
      drvSide = rz > b.z ? 1 : -1;
    }
  }
  const drvLen = halfD - edgeZ - 0.4;
  if (drvLen > 1) {
    const drv = groundQuad(b.x, b.z + drvSide * (edgeZ + drvLen / 2 + 0.3), 2.4, drvLen, C_DRIVEWAY);
    translate(drv, 0, 0.02, 0);
    fences.push(drv);
  }

  // A couple of garden patches on the sides away from the driveway.
  const gardenColors = [C_GARDEN_GREEN, C_GARDEN_BROWN];
  for (let s of [-1, 1]) {
    if (s === drvSide) continue;
    if (rng() < 0.6) {
      const gc = gardenColors[Math.floor(rng() * gardenColors.length)];
      const gLen = halfD - edgeZ - 0.4;
      if (gLen > 1) {
        const garden = groundQuad(
          b.x + (rng() - 0.5) * (PLOT_W - b.w - 2),
          b.z + s * (edgeZ + gLen / 2 + 0.3),
          1.8 + rng() * 1.5,
          gLen,
          gc,
        );
        translate(garden, 0, 0.02, 0);
        fences.push(garden);
      }
    }
  }
}

/**
 * Street trees lining the town roads — placed every few houses (step ~40
 * units) on alternating sides so the town feels leafy without crowding the
 * sidewalks. Skips the train-track corridor and the shrine/station blocks.
 */
function buildStreetTrees(misc: THREE.BufferGeometry[]): void {
  const step = 40;
  const offset = ROAD_HALF + 1.4;
  // North-south roads: trees on one side, alternating per road.
  for (let i = 0; i < TOWN_NS_ROADS.length; i++) {
    const x = TOWN_NS_ROADS[i];
    const side = i % 2 === 0 ? 1 : -1;
    for (let z = -28; z >= -158; z -= step) {
      if (Math.abs(z - TRACK_Z) < 6) continue;
      pushTree(misc, x + side * offset, z);
    }
  }
  // East-west roads: trees on one side, alternating per road.
  for (let i = 0; i < TOWN_EW_ROADS.length; i++) {
    const z = TOWN_EW_ROADS[i];
    const side = i % 2 === 0 ? 1 : -1;
    for (let x = -72; x <= 72; x += step) {
      if (Math.abs(z - TRACK_Z) < 6) continue;
      // Keep the shrine approach and station front clear.
      if (Math.abs(x) < 12 && Math.abs(z + 70) < 14) continue;
      if (Math.abs(x - 64) < 16 && Math.abs(z + 100) < 10) continue;
      pushTree(misc, x, z + side * offset);
    }
  }
}

/**
 * JR-style station: elevated platform with a post-supported canopy and a
 * kanji/romaji name board, gable-roofed station building, tracks, benches,
 * vending machine, level crossing.
 */
function buildStation(
  wallsTextured: THREE.BufferGeometry[],
  roofs: THREE.BufferGeometry[],
  misc: THREE.BufferGeometry[],
  lamps: THREE.BufferGeometry[],
): void {
  const stX = 64;
  const stZ = -97;
  const trackZ = -100;

  // Elevated platform (north side of tracks) + yellow tactile edge strip.
  const platform = toPNC(new THREE.BoxGeometry(32, 1.2, 6), C_PLATFORM);
  translate(platform, stX, 0.6, trackZ - 4);
  misc.push(platform);
  const tactile = toPNC(new THREE.BoxGeometry(32, 0.06, 0.45), C_TACTILE);
  translate(tactile, stX, 1.23, trackZ - 1.35);
  misc.push(tactile);

  // Platform canopy on posts along the back (north) edge of the platform.
  for (const px of [stX - 13.5, stX - 4.5, stX + 4.5, stX + 13.5]) {
    const post = toPNC(new THREE.CylinderGeometry(0.13, 0.16, 3.4, 6), C_POLE);
    translate(post, px, 1.2 + 1.7, trackZ - 6.3);
    misc.push(post);
  }
  const canopy = toPNC(new THREE.BoxGeometry(31, 0.22, 5.2), C_CANOPY_GREEN);
  translate(canopy, stX, 4.75, trackZ - 4);
  roofs.push(canopy);
  const fascia = toPNC(
    new THREE.BoxGeometry(31, 0.5, 0.14),
    C_CANOPY_GREEN.clone().multiplyScalar(0.75),
  );
  translate(fascia, stX, 4.55, trackZ - 1.45);
  roofs.push(fascia);

  // Station building (on the south side of the tracks).
  const bw = 9;
  const bd = 5;
  const bh = 4;
  const bWallBox = new THREE.BoxGeometry(bw, bh, bd);
  scaleBoxUvs(bWallBox, bw, bh, bd, WALL_TILE);
  translate(bWallBox, stX, bh / 2, stZ);
  wallsTextured.push(toPNCUV(bWallBox, C_CREAM));
  townCollisionBoxes.push([stX - bw / 2, stX + bw / 2, stZ - bd / 2, stZ + bd / 2]);

  const rh = 1.8;
  const bRoof = gableRoofGeo(bw, bd, rh);
  translate(bRoof, stX, bh, stZ);
  roofs.push(toPNC(bRoof, ROOF_BLUE_A));

  // Name board hanging under the canopy front, facing the tracks.
  const frame = toPNC(new THREE.BoxGeometry(6.0, 1.8, 0.1), C_STONE_DARK);
  translate(frame, stX, 3.85, trackZ - 1.38);
  misc.push(frame);

  // Benches on the platform.
  for (const bx of [stX - 7, stX + 2]) {
    const seat = toPNC(new THREE.BoxGeometry(1.9, 0.1, 0.5), C_WOOD_BENCH);
    translate(seat, bx, 1.72, trackZ - 4.8);
    misc.push(seat);
    const back = toPNC(new THREE.BoxGeometry(1.9, 0.5, 0.09), C_WOOD_BENCH);
    translate(back, bx, 2.02, trackZ - 5.05);
    misc.push(back);
    for (const lx of [-0.8, 0.8]) {
      const leg = toPNC(new THREE.BoxGeometry(0.09, 0.52, 0.42), C_POLE);
      translate(leg, bx + lx, 1.46, trackZ - 4.82);
      misc.push(leg);
    }
  }

  // Vending machine silhouette at the platform end; front stripe glows
  // softly at night via the street-lamp material.
  const vmX = stX + 11;
  const body = toPNC(new THREE.BoxGeometry(1.1, 1.9, 0.75), C_VENDING);
  translate(body, vmX, 1.2 + 0.95, trackZ - 4.7);
  misc.push(body);
  const face = toPNC(new THREE.BoxGeometry(0.92, 1.45, 0.06), C_VENDING_FACE);
  translate(face, vmX, 2.05, trackZ - 4.28);
  misc.push(face);
  const glowStripe = toPN(new THREE.BoxGeometry(0.85, 0.22, 0.04));
  translate(glowStripe, vmX, 2.72, trackZ - 4.26);
  lamps.push(glowStripe);

  // Tracks (a long dark strip) + two rails.
  const trackBed = toPNC(new THREE.BoxGeometry(200, 0.12, 3), C_TRACK);
  translate(trackBed, 0, 0.06, trackZ);
  misc.push(trackBed);
  for (const dz of [-0.7, 0.7]) {
    const rail = toPNC(new THREE.BoxGeometry(200, 0.08, 0.16), C_RAIL);
    translate(rail, 0, 0.14, trackZ + dz);
    misc.push(rail);
  }

  // Level crossing at X = -16: two barrier beams + support poles.
  const cx = -16;
  for (const px of [cx - 3.5, cx + 3.5]) {
    const pole = toPNC(new THREE.CylinderGeometry(0.12, 0.12, 2.4, 6), C_POLE);
    translate(pole, px, 1.2, trackZ);
    misc.push(pole);
  }
  for (const dir of [-1, 1]) {
    const beam = toPNC(new THREE.BoxGeometry(3.4, 0.14, 0.18), C_BARRIER);
    translate(beam, cx + dir * 2.55, 1.15, trackZ);
    misc.push(beam);
  }
}

/** Streetlight poles (misc) + lamp heads (lamps, emissive) along every road.
 *  Poles are offset to the roadside (ROAD_HALF + 0.5) so they sit on the
 *  sidewalk, not in the middle of the asphalt. */
function buildStreetlights(
  misc: THREE.BufferGeometry[],
  lamps: THREE.BufferGeometry[],
): void {
  const step = 24;
  const offset = ROAD_HALF + 0.5; // 5.0 — just past the road edge
  // North-south roads: place poles on one side, alternating.
  for (const x of TOWN_NS_ROADS) {
    for (let z = -30; z >= -280; z -= step) {
      pushStreetlight(misc, lamps, x + offset, z);
    }
  }
  // East-west roads: place poles on one side.
  for (const z of TOWN_EW_ROADS) {
    for (let x = -76; x <= 76; x += step) {
      pushStreetlight(misc, lamps, x, z - offset);
    }
  }
}

function pushStreetlight(
  misc: THREE.BufferGeometry[],
  lamps: THREE.BufferGeometry[],
  x: number,
  z: number,
): void {
  const pole = toPNC(new THREE.CylinderGeometry(0.12, 0.16, 5, 6), C_POLE);
  translate(pole, x, 2.5, z);
  misc.push(pole);
  const head = toPN(new THREE.BoxGeometry(0.55, 0.32, 0.55));
  translate(head, x, 5.1, z);
  lamps.push(head);
}

/** Rice paddies: alternating green/gold panels with earthen borders, plus
 *  a thin standing-water layer that reflects the sky. */
function buildPaddies(
  paddies: THREE.BufferGeometry[],
  paddyWater: THREE.BufferGeometry[],
): void {
  const xMin = -130;
  const xMax = 130;
  const zMin = -285;
  const zMax = -166;
  const panelW = 22;
  const panelD = 16;
  const borderH = 0.25;
  const borderT = 0.5;

  for (let z0 = zMax; z0 > zMin; z0 -= panelD) {
    for (let x0 = xMin; x0 < xMax; x0 += panelW) {
      const cx = x0 + panelW / 2;
      const cz = z0 - panelD / 2;
      const gold = (Math.floor(x0 / panelW) + Math.floor((zMax - z0) / panelD)) % 2 === 0;
      const paddy = toPNC(
        new THREE.PlaneGeometry(panelW - borderT, panelD - borderT),
        gold ? C_PADDY_GOLD : C_PADDY_GREEN,
      );
      paddy.rotateX(-Math.PI / 2);
      translate(paddy, cx, 0.02, cz);
      paddies.push(paddy);

      // Standing water — a semi-transparent plane just above the paddy
      // surface; rendered with a high-metalness/low-roughness material so
      // it picks up sky reflections.
      const water = new THREE.PlaneGeometry(panelW - borderT, panelD - borderT);
      water.rotateX(-Math.PI / 2);
      translate(water, cx, 0.03, cz);
      paddyWater.push(water);

      // Earthen border on the north edge of the panel.
      const borderN = toPNC(
        new THREE.BoxGeometry(panelW, borderH, borderT),
        C_EARTH,
      );
      translate(borderN, cx, borderH / 2, z0 - panelD + borderT / 2);
      paddies.push(borderN);
    }
    // Continuous east-west border strip between rows.
    const borderRow = toPNC(
      new THREE.BoxGeometry(xMax - xMin, borderH, borderT),
      C_EARTH,
    );
    translate(borderRow, (xMin + xMax) / 2, borderH / 2, z0);
    paddies.push(borderRow);
  }
}

/* ------------------------------------------------------------------ *
 *  Component
 * ------------------------------------------------------------------ */

export function Town() {
  const stateRef = useDayNightState();
  const lampMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const windowMatRef = useRef<THREE.ShaderMaterial>(null);
  const porchLampMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const porchPoolMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const lanternMatRef = useRef<THREE.MeshStandardMaterial>(null);

  const { geos, stuccoTex, glowTex, signMat } = useMemo(() => {
    const signTex = makeStationSignTexture();
    return {
      geos: buildTown(),
      stuccoTex: makeStuccoTexture(),
      glowTex: makeGlowTexture(),
      // Shared by the platform board and the building-wall board.
      signMat: new THREE.MeshStandardMaterial({
        map: signTex,
        emissive: "#ffffff",
        emissiveMap: signTex,
        emissiveIntensity: 0.05,
        roughness: 0.6,
      }),
    };
  }, []);

  // Animate emissive materials with the day/night cycle.
  useFrame(() => {
    const s = stateRef.current;
    if (lampMatRef.current) {
      lampMatRef.current.emissiveIntensity = s.streetlightIntensity * 2.2;
    }
    if (windowMatRef.current) {
      windowMatRef.current.uniforms.uWindowGlow.value = s.windowGlow;
    }
    if (porchLampMatRef.current) {
      porchLampMatRef.current.emissiveIntensity =
        s.windowGlow * 3.2;
    }
    if (porchPoolMatRef.current) {
      porchPoolMatRef.current.opacity =
        Math.max(s.windowGlow, s.streetlightIntensity) * 0.42;
    }
    if (lanternMatRef.current) {
      lanternMatRef.current.emissiveIntensity =
        s.windowGlow * 2.4 + s.streetlightIntensity * 0.6;
    }
    signMat.emissiveIntensity = 0.05 + s.streetlightIntensity * 1.1;
  });

  return (
    <group>
      {/* House walls: vertex tint x shared plaster texture */}
      {geos.wallsTextured && (
        <mesh geometry={geos.wallsTextured} castShadow receiveShadow>
          <meshStandardMaterial
            vertexColors
            map={stuccoTex}
            roughness={0.92}
            metalness={0}
          />
        </mesh>
      )}
      {geos.trim && (
        <mesh geometry={geos.trim} castShadow receiveShadow>
          <meshStandardMaterial vertexColors roughness={0.88} metalness={0} />
        </mesh>
      )}
      {geos.roofs && (
        <mesh geometry={geos.roofs} castShadow receiveShadow>
          <meshStandardMaterial
            vertexColors
            roughness={0.7}
            metalness={0}
          />
        </mesh>
      )}
      {geos.misc && (
        <mesh geometry={geos.misc} castShadow receiveShadow>
          <meshStandardMaterial vertexColors roughness={0.85} metalness={0} />
        </mesh>
      )}
      {geos.fences && (
        <mesh geometry={geos.fences} castShadow receiveShadow>
          <meshStandardMaterial vertexColors roughness={0.9} metalness={0} />
        </mesh>
      )}
      {geos.paddies && (
        <mesh geometry={geos.paddies} receiveShadow>
          <meshStandardMaterial vertexColors roughness={0.95} metalness={0} />
        </mesh>
      )}
      {geos.paddyWater && (
        <mesh geometry={geos.paddyWater} receiveShadow>
          <meshStandardMaterial
            color={"#1a2a3a"}
            transparent
            opacity={0.55}
            roughness={0.08}
            metalness={0.9}
          />
        </mesh>
      )}
      {geos.lamps && (
        <mesh geometry={geos.lamps}>
          <meshStandardMaterial
            ref={lampMatRef}
            color={TOWN_PALETTE.streetlight}
            emissive={TOWN_PALETTE.streetlight}
            emissiveIntensity={0}
            toneMapped={false}
            roughness={0.5}
            metalness={0}
          />
        </mesh>
      )}
      {geos.windows && (
        <mesh geometry={geos.windows}>
          <shaderMaterial
            ref={windowMatRef}
            vertexShader={TOWN_WINDOW_VERT}
            fragmentShader={TOWN_WINDOW_FRAG}
            uniforms={{
              uWindowGlow: { value: 0 },
              uGlowWarm: { value: new THREE.Color("#ffcf8a") },
              uGlowCool: { value: new THREE.Color("#a0c8ff") },
            }}
            toneMapped
          />
        </mesh>
      )}
      {/* Porch lights + their additive ground pools */}
      {geos.porchGlow && (
        <mesh geometry={geos.porchGlow}>
          <meshStandardMaterial
            ref={porchLampMatRef}
            color="#ffc98a"
            emissive="#ffc98a"
            emissiveIntensity={0}
            toneMapped={false}
            roughness={0.5}
          />
        </mesh>
      )}
      {geos.porchPools && (
        <mesh geometry={geos.porchPools} renderOrder={4}>
          <meshBasicMaterial
            ref={porchPoolMatRef}
            map={glowTex}
            color="#ffb46a"
            transparent
            opacity={0}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      )}
      {/* Paper lantern string at the shrine */}
      {geos.lanterns && (
        <mesh geometry={geos.lanterns}>
          <meshStandardMaterial
            ref={lanternMatRef}
            color={C_PAPER}
            emissive="#ffb45e"
            emissiveIntensity={0}
            toneMapped={false}
            roughness={0.6}
          />
        </mesh>
      )}
      {/* Station name boards (kanji + romaji): platform + road-facing wall */}
      <mesh position={[64, 3.85, -101.3]} material={signMat}>
        <planeGeometry args={[5.6, 1.57]} />
      </mesh>
      <mesh position={[64, 2.7, -94.42]} material={signMat}>
        <planeGeometry args={[4.4, 1.24]} />
      </mesh>
    </group>
  );
}
