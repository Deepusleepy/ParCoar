import { useContext, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { DayNightContext } from "./DayNight";
import {
  CITY_NS_ROADS,
  CITY_EW_ROADS,
  CITY_PALETTE,
  CITY_Z_START,
  CITY_Z_END,
  WORLD_HALF,
} from "./constants";

/**
 * CityDistrict — the Shibuya-style city south of the river.
 *
 * Buildings are generated procedurally across the city grid (between the NS
 * and EW roads) and merged by material type so the whole district renders in
 * ~13 draw calls regardless of building count. Window glow and neon signage
 * are driven by the shared day/night state every frame.
 *
 * Building variety is the core requirement: every building differs from its
 * neighbors in at least two of height, footprint, color, window pattern, and
 * roof clutter. Four building types are mixed: slab towers, glass curtain-wall
 * towers, podium towers (Tokyo tower-on-a-shop-base), and low-rise shops.
 */

/* ------------------------------------------------------------------ *
 *  Types
 * ------------------------------------------------------------------ */

type BuildingType = "slab" | "glass" | "podium" | "lowrise";
type NeonColor = "cyan" | "magenta" | "warmwhite" | "red" | "green";

/** An axis-aligned box described by center + half-extents, for facade math. */
interface FacadeBox {
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
}

/** Buckets of unmerged geometries, one per material category. */
interface GeometryGroups {
  concreteGeoms: THREE.BufferGeometry[][];
  glassGeoms: THREE.BufferGeometry[][];
  awningGeoms: THREE.BufferGeometry[];
  clutterGeoms: THREE.BufferGeometry[];
  windowGeoms: THREE.BufferGeometry[];
  neonGeoms: Record<NeonColor, THREE.BufferGeometry[]>;
}

/** Merged geometry ready to attach to a single material. */
interface CityGeometry {
  concrete: (THREE.BufferGeometry | null)[];
  glass: (THREE.BufferGeometry | null)[];
  awning: THREE.BufferGeometry | null;
  clutter: THREE.BufferGeometry | null;
  windows: THREE.BufferGeometry | null;
  neon: Record<NeonColor, THREE.BufferGeometry | null>;
}

/* ------------------------------------------------------------------ *
 *  Layout constants
 * ------------------------------------------------------------------ */

/** Half-width of a city road (roads are 10 units wide). */
const ROAD_HALF = 5;
/** Building setback from a road edge (road half-width + a small margin). */
const SETBACK = ROAD_HALF + 1.5;
/** Largest block dimension before it is subdivided into smaller blocks. */
const MAX_BLOCK = 50;
/** Gap left between buildings sharing a block. */
const BUILDING_GAP = 1.2;

/* ------------------------------------------------------------------ *
 *  Material palettes
 * ------------------------------------------------------------------ */

/** Concrete tints — a mix of warm (beige/cream/teracotta) and cool greys so
 *  the district doesn't read as a uniform grey mass. 8 shades for variety. */
const CONCRETE_TINTS = [
  "#c8b896", "#d8d0c0", "#b89878", "#e0d8c8", // warm
  "#8898a8", "#9aa0a8", "#7a8088", "#a09080", // cool
];
/** Tint index used for cornices on glass towers (a neutral cool grey). */
const CORNICE_TINT = 5;
/** Units of wall surface covered by one tile of the concrete albedo texture. */
const CONCRETE_TILE = 8;
/** Blue-green glass tints for curtain-wall towers (5 shades). */
const GLASS_TINTS = ["#6aa0b0", "#4a8294", "#8ab8c4", "#5a92a4", "#7ab0c0"];
/** Awning canvas color. */
const AWNING_COLOR = "#9a6a4a";
/** Rooftop clutter (water tanks, AC units, antenna masts). */
const CLUTTER_COLOR = "#2a2a2e";

const NEON_HEX: Record<NeonColor, string> = {
  cyan: CITY_PALETTE.neonCyan,
  magenta: CITY_PALETTE.neonMagenta,
  warmwhite: CITY_PALETTE.neonWarmWhite,
  red: CITY_PALETTE.neonRed,
  green: CITY_PALETTE.neonGreen,
};

/* ------------------------------------------------------------------ *
 *  Window glow shader
 * ------------------------------------------------------------------ *
 *  All window planes share one ShaderMaterial. Each window carries an
 *  `aPhase` attribute in [0,1]; the window lights up as the global
 *  `uWindowGlow` crosses its phase threshold, so windows switch on
 *  staggered rather than in unison.
 */

const WINDOW_VERT = /* glsl */ `
  attribute float aPhase;
  attribute float aBrightness;
  attribute float aTint;     // 0 = warm, 1 = cool, 0.5 = neutral
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

const WINDOW_FRAG = /* glsl */ `
  uniform float uWindowGlow;
  uniform vec3 uGlowWarm;
  uniform vec3 uGlowCool;
  varying float vPhase;
  varying float vBrightness;
  varying float vTint;
  void main() {
    // Daytime base: dark blue-grey glass — clearly visible against light concrete.
    vec3 dayGlass = vec3(0.25, 0.30, 0.38);
    // Night glow color: warm or cool per window.
    vec3 nightCol = mix(uGlowWarm, uGlowCool, vTint);
    // Windows light up staggered as uWindowGlow crosses their phase.
    float on = smoothstep(vPhase - 0.08, vPhase + 0.08, uWindowGlow);
    // Per-window brightness at night.
    float nightLit = mix(0.0, vBrightness, on);
    // Daytime: windows are dark glass with some variation.
    // Nighttime: windows glow with their tint and brightness.
    vec3 col = mix(dayGlass, nightCol, nightLit);
    // Brightness: during day, windows are at ~0.4-0.6 brightness (visible dark glass).
    // At night, lit windows are at full brightness, unlit at ~0.05.
    float dayBright = 0.35 + vBrightness * 0.2;
    float nightBright = 0.05 + nightLit;
    float brightness = mix(dayBright, nightBright, on);
    gl_FragColor = vec4(col * brightness, 1.0);
  }
`;

/* ------------------------------------------------------------------ *
 *  Seeded RNG (deterministic per grid cell)
 * ------------------------------------------------------------------ */

function hashSeed(a: number, b: number): number {
  let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663)) >>> 0;
  if (h === 0) h = 0x9e3779b9;
  return h;
}

/** Mulberry32-style PRNG: deterministic, fast, good enough for placement. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 *  Block subdivision
 * ------------------------------------------------------------------ */

/** Split [a,b] into n sub-ranges separated by `gap`, with random widths. */
function splitRange(
  a: number,
  b: number,
  n: number,
  gap: number,
  rng: () => number,
): [number, number][] {
  if (n <= 1) return [[a, b]];
  const weights: number[] = [];
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const wv = 0.7 + rng() * 0.6;
    weights.push(wv);
    wsum += wv;
  }
  const avail = b - a - gap * (n - 1);
  if (avail <= 0) return [[a, b]];
  const unit = avail / wsum;
  const slots: [number, number][] = [];
  let cur = a;
  for (let i = 0; i < n; i++) {
    const len = weights[i] * unit;
    slots.push([cur, cur + len]);
    cur += len + gap;
  }
  return slots;
}

/**
 * Build the list of block intervals along one axis from a set of road
 * centerlines. Gaps larger than MAX_BLOCK (outside the road grid) are
 * subdivided so the city fills edge-to-edge.
 */
function blockIntervals(
  roads: readonly number[],
  lo: number,
  hi: number,
): [number, number][] {
  const sorted = [...roads].sort((x, y) => x - y);
  const intervals: [number, number][] = [];
  const subdivide = (a: number, b: number) => {
    let cur = a;
    while (b - cur > MAX_BLOCK) {
      intervals.push([cur, cur + MAX_BLOCK]);
      cur += MAX_BLOCK;
    }
    intervals.push([cur, b]);
  };
  let prev = lo;
  for (const r of sorted) {
    if (r > lo && r < hi) {
      subdivide(prev, r);
      prev = r;
    }
  }
  subdivide(prev, hi);
  return intervals;
}

/* ------------------------------------------------------------------ *
 *  Geometry helpers
 * ------------------------------------------------------------------ */

/** Scale a box geometry's UVs per-face so a repeating texture tiles at `tile`
 *  units per texture tile. BoxGeometry orders faces px, nx, py, ny, pz, nz,
 *  each with 4 UV pairs. */
function scaleBoxUvs(g: THREE.BoxGeometry, w: number, h: number, d: number, tile: number): void {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  // Per-face (width, height) in world units, matching three's face order.
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

/** Create a translated box and push it into a material bucket. When `tile` is
 *  given, UVs are scaled so a repeating albedo texture tiles at that rate. */
function addBox(
  arr: THREE.BufferGeometry[],
  cx: number,
  cy: number,
  cz: number,
  w: number,
  h: number,
  d: number,
  tile?: number,
): void {
  const g = new THREE.BoxGeometry(w, h, d);
  if (tile) scaleBoxUvs(g, w, h, d, tile);
  g.translate(cx, cy, cz);
  arr.push(g);
}

/** Create a window plane with per-window phase, brightness, and tint attributes.
 *  `rngVal` seeds the per-window variation (brightness, tint, some dark). */
function addWindow(
  arr: THREE.BufferGeometry[],
  cx: number,
  cy: number,
  cz: number,
  w: number,
  h: number,
  rotY: number,
  rngVal: number,
): void {
  const g = new THREE.PlaneGeometry(w, h);
  g.rotateY(rotY);
  g.translate(cx, cy, cz);
  const n = g.attributes.position.count;
  // Phase: when the window lights up (staggered across the dusk transition).
  const phase = rngVal;
  // Brightness: ~15% of windows stay dark, rest vary from dim to bright.
  const brightness = rngVal < 0.15 ? 0.0 : 0.3 + ((rngVal * 13.7) % 1) * 0.7;
  // Tint: mostly warm, some cool, some neutral.
  const tint = ((rngVal * 7.3) % 1) < 0.7 ? rngVal * 0.2 : 0.6 + rngVal * 0.4;
  g.setAttribute("aPhase", new THREE.BufferAttribute(new Float32Array(n).fill(phase), 1));
  g.setAttribute("aBrightness", new THREE.BufferAttribute(new Float32Array(n).fill(brightness), 1));
  g.setAttribute("aTint", new THREE.BufferAttribute(new Float32Array(n).fill(tint), 1));
  arr.push(g);
}

/* ------------------------------------------------------------------ *
 *  Facade generators
 * ------------------------------------------------------------------ */

type Face = "px" | "nx" | "pz" | "nz";

/** Add a regular window grid to one facade of a box. */
function addWindowGrid(
  box: FacadeBox,
  face: Face,
  facadeW: number,
  rng: () => number,
  winArr: THREE.BufferGeometry[],
): void {
  const facadeH = box.hy * 2;
  const cols = Math.max(1, Math.floor(facadeW / 2.2));
  const rows = Math.max(1, Math.floor((facadeH - 1.5) / 2.6));
  if (rows < 1) return;
  const colSp = facadeW / cols;
  const rowSp = (facadeH - 1) / rows;
  const winW = Math.min(1.2, colSp * 0.55);
  const winH = Math.min(1.5, rowSp * 0.6);
  const baseY = box.cy - box.hy + 1 + rowSp / 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const off = (c - (cols - 1) / 2) * colSp;
      let wx = 0;
      let wz = 0;
      let rotY = 0;
      if (face === "pz") {
        wx = box.cx + off;
        wz = box.cz + box.hz + 0.05;
        rotY = 0;
      } else if (face === "nz") {
        wx = box.cx + off;
        wz = box.cz - box.hz - 0.05;
        rotY = Math.PI;
      } else if (face === "px") {
        wx = box.cx + box.hx + 0.05;
        wz = box.cz + off;
        rotY = Math.PI / 2;
      } else {
        wx = box.cx - box.hx - 0.05;
        wz = box.cz + off;
        rotY = -Math.PI / 2;
      }
      addWindow(winArr, wx, baseY + r * rowSp, wz, winW, winH, rotY, rng());
    }
  }
}

/** Put window grids on the two longer facades, plus sparse windows on short facades. */
function addWindowGridOnLongFacades(
  box: FacadeBox,
  w: number,
  d: number,
  rng: () => number,
  winArr: THREE.BufferGeometry[],
): void {
  if (w >= d) {
    addWindowGrid(box, "pz", w, rng, winArr);
    addWindowGrid(box, "nz", w, rng, winArr);
    // Sparse windows on the short facades too.
    addWindowGrid(box, "px", d, rng, winArr);
    addWindowGrid(box, "nx", d, rng, winArr);
  } else {
    addWindowGrid(box, "px", d, rng, winArr);
    addWindowGrid(box, "nx", d, rng, winArr);
    addWindowGrid(box, "pz", w, rng, winArr);
    addWindowGrid(box, "nz", w, rng, winArr);
  }
}

/** Add large ground-floor shop panes on one long facade. */
function addShopFront(
  box: FacadeBox,
  w: number,
  d: number,
  rng: () => number,
  winArr: THREE.BufferGeometry[],
): void {
  const face: Face = w >= d ? "pz" : "px";
  const facadeW = w >= d ? w : d;
  const facadeH = box.hy * 2;
  const cols = Math.max(2, Math.floor(facadeW / 2.5));
  const colSp = facadeW / cols;
  const winW = colSp * 0.7;
  const winH = Math.min(2.2, facadeH * 0.55);
  const y = box.cy - box.hy + winH / 2 + 0.3;
  for (let c = 0; c < cols; c++) {
    const off = (c - (cols - 1) / 2) * colSp;
    if (face === "pz") {
      addWindow(winArr, box.cx + off, y, box.cz + box.hz + 0.05, winW, winH, 0, rng());
    } else {
      addWindow(winArr, box.cx + box.hx + 0.05, y, box.cz + off, winW, winH, Math.PI / 2, rng());
    }
  }
}

/** Add a protruding awning box above a shop front. */
function addAwning(
  cx: number,
  topY: number,
  cz: number,
  w: number,
  d: number,
  arr: THREE.BufferGeometry[],
): void {
  const awH = 0.3;
  const awD = 1.6;
  if (w >= d) {
    const awW = w * 0.9;
    addBox(arr, cx, topY - awH, cz + d / 2 + awD / 2 - 0.2, awW, awH, awD);
  } else {
    const awW = d * 0.9;
    addBox(arr, cx + w / 2 + awD / 2 - 0.2, topY - awH, cz, awD, awH, awW);
  }
}

/** Add rooftop clutter (water tanks, AC units, antenna masts) on ~40% of towers. */
function addRooftopClutter(
  cx: number,
  topY: number,
  cz: number,
  w: number,
  d: number,
  rng: () => number,
  arr: THREE.BufferGeometry[],
): void {
  const count = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < count; i++) {
    const ox = (rng() - 0.5) * Math.max(0, w - 2);
    const oz = (rng() - 0.5) * Math.max(0, d - 2);
    const r = rng();
    if (r < 0.4) {
      const s = 1.5 + rng() * 1.5;
      addBox(arr, cx + ox, topY + s / 2, cz + oz, s, s, s);
    } else if (r < 0.75) {
      const bw = 1.5 + rng() * 2;
      const bh = 0.8 + rng() * 0.8;
      const bd = 1.5 + rng() * 2;
      addBox(arr, cx + ox, topY + bh / 2, cz + oz, bw, bh, bd);
    } else {
      const mh = 3 + rng() * 5;
      addBox(arr, cx + ox, topY + mh / 2, cz + oz, 0.3, mh, 0.3);
    }
  }
}

/** Add a thin emissive neon panel to one facade. */
function addNeonPanel(
  box: FacadeBox,
  w: number,
  d: number,
  rng: () => number,
  G: GeometryGroups,
): void {
  const colors: NeonColor[] = ["cyan", "magenta", "warmwhite", "red", "green"];
  const color = colors[Math.floor(rng() * colors.length)];
  const face: Face =
    w >= d ? (rng() < 0.5 ? "pz" : "nz") : rng() < 0.5 ? "px" : "nx";
  const facadeW = face === "pz" || face === "nz" ? w : d;
  const panelW = facadeW * (0.4 + rng() * 0.4);
  const panelH = box.hy * (0.3 + rng() * 0.4);
  const py = box.cy + (rng() - 0.3) * box.hy * 0.3;
  const off = (rng() - 0.5) * (facadeW - panelW) * 0.6;
  let px = 0;
  let pz = 0;
  let rotY = 0;
  if (face === "pz") {
    px = box.cx + off;
    pz = box.cz + box.hz + 0.3;
    rotY = 0;
  } else if (face === "nz") {
    px = box.cx + off;
    pz = box.cz - box.hz - 0.3;
    rotY = Math.PI;
  } else if (face === "px") {
    px = box.cx + box.hx + 0.3;
    pz = box.cz + off;
    rotY = Math.PI / 2;
  } else {
    px = box.cx - box.hx - 0.3;
    pz = box.cz + off;
    rotY = -Math.PI / 2;
  }
  // Thin panel (0.08 deep) pushed 0.3 out from the facade to avoid
  // overlapping the window planes at 0.05.
  const g = new THREE.BoxGeometry(panelW, panelH, 0.08);
  g.rotateY(rotY);
  g.translate(px, py, pz);
  G.neonGeoms[color].push(g);
}

/* ------------------------------------------------------------------ *
 *  Setback stacks & floor-line cornices
 * ------------------------------------------------------------------ */

/**
 * Stack a tall building into 2-3 setback tiers of decreasing footprint
 * (100% → 85% → 75% width). Boxes are pushed into the given bucket and the
 * FacadeBox for each tier is returned so windows/clutter can be added per
 * tier. Lower tiers are slightly taller for a grounded silhouette.
 */
function addSetbackStack(
  bucket: THREE.BufferGeometry[],
  cx: number,
  cz: number,
  w: number,
  d: number,
  totalH: number,
  rng: () => number,
  tile?: number,
): FacadeBox[] {
  const tiers = totalH > 40 ? 3 : 2;
  const scales = tiers === 3 ? [1.0, 0.85, 0.75] : [1.0, 0.85];
  // Lower tiers get more height — weighted toward the base.
  const weights = scales.map((_, i) => 1 + (tiers - 1 - i) * 0.3);
  const wsum = weights.reduce((a, b) => a + b, 0);
  let y = 0;
  const boxes: FacadeBox[] = [];
  for (let i = 0; i < tiers; i++) {
    const segH = (totalH * weights[i]) / wsum;
    const sw = w * scales[i];
    const sd = d * scales[i];
    // Upper tiers get a small horizontal offset for an asymmetric silhouette.
    const ox = i === 0 ? 0 : (rng() - 0.5) * (w - sw) * 0.5;
    const oz = i === 0 ? 0 : (rng() - 0.5) * (d - sd) * 0.5;
    const cy = y + segH / 2;
    addBox(bucket, cx + ox, cy, cz + oz, sw, segH, sd, tile);
    boxes.push({ cx: cx + ox, cy, cz: cz + oz, hx: sw / 2, hy: segH / 2, hz: sd / 2 });
    y += segH;
  }
  return boxes;
}

/**
 * Add thin protruding floor-line cornices every ~12 units of height. Each
 * cornice is a box slightly larger than the footprint, protruding 0.3 units
 * on every side, so it catches light and casts micro-shadows on the facade.
 * Merged into the given (concrete) bucket.
 */
function addFloorCornices(
  bucket: THREE.BufferGeometry[],
  cx: number,
  cz: number,
  w: number,
  d: number,
  baseY: number,
  totalH: number,
  rng: () => number,
): void {
  const spacing = 11 + rng() * 2; // ~12 units ≈ 3-4 floors
  const corniceH = 0.35;
  const protrude = 0.3;
  for (let y = baseY + spacing; y < baseY + totalH - corniceH; y += spacing) {
    addBox(bucket, cx, y, cz, w + protrude * 2, corniceH, d + protrude * 2);
  }
}

/* ------------------------------------------------------------------ *
 *  Building generation
 * ------------------------------------------------------------------ */

function generateBuilding(
  type: BuildingType,
  cx: number,
  cz: number,
  w: number,
  d: number,
  rng: () => number,
  G: GeometryGroups,
): void {
  if (type === "slab") {
    const h = 12 + rng() * 45; // 12-57
    const tint = Math.floor(rng() * CONCRETE_TINTS.length);
    const bucket = G.concreteGeoms[tint];
    if (h > 25) {
      // Setback stack: 2-3 tiers of decreasing footprint.
      const tiers = addSetbackStack(bucket, cx, cz, w, d, h, rng, CONCRETE_TILE);
      for (const tb of tiers) {
        addWindowGridOnLongFacades(tb, tb.hx * 2, tb.hz * 2, rng, G.windowGeoms);
        addFloorCornices(bucket, tb.cx, tb.cz, tb.hx * 2, tb.hz * 2, tb.cy - tb.hy, tb.hy * 2, rng);
      }
      const top = tiers[tiers.length - 1];
      if (rng() < 0.5) addRooftopClutter(top.cx, top.cy + top.hy, top.cz, top.hx * 2, top.hz * 2, rng, G.clutterGeoms);
      if (rng() < 0.3) addNeonPanel(tiers[0], w, d, rng, G);
    } else {
      addBox(bucket, cx, h / 2, cz, w, h, d, CONCRETE_TILE);
      const box: FacadeBox = { cx, cy: h / 2, cz, hx: w / 2, hy: h / 2, hz: d / 2 };
      addWindowGridOnLongFacades(box, w, d, rng, G.windowGeoms);
      addFloorCornices(bucket, cx, cz, w, d, 0, h, rng);
      if (rng() < 0.5) addRooftopClutter(cx, h, cz, w, d, rng, G.clutterGeoms);
      if (rng() < 0.3) addNeonPanel(box, w, d, rng, G);
    }
    // L-shape: ~20% of slab buildings get a smaller adjacent wing.
    if (rng() < 0.2) {
      const lTint = Math.floor(rng() * CONCRETE_TINTS.length);
      const lBucket = G.concreteGeoms[lTint];
      const lW = w * (0.4 + rng() * 0.2);
      const lD = d * (0.4 + rng() * 0.2);
      const lH = h * (0.5 + rng() * 0.3);
      const alongX = w >= d;
      const side = rng() < 0.5 ? 1 : -1;
      const endSide = rng() < 0.5 ? 1 : -1;
      const lcx = alongX ? cx + side * (w / 2 + lW / 2 - 0.3) : cx + endSide * (w / 2 - lW / 2);
      const lcz = alongX ? cz + endSide * (d / 2 - lD / 2) : cz + side * (d / 2 + lD / 2 - 0.3);
      addBox(lBucket, lcx, lH / 2, lcz, lW, lH, lD, CONCRETE_TILE);
      const lbox: FacadeBox = { cx: lcx, cy: lH / 2, cz: lcz, hx: lW / 2, hy: lH / 2, hz: lD / 2 };
      addWindowGridOnLongFacades(lbox, lW, lD, rng, G.windowGeoms);
      addFloorCornices(lBucket, lcx, lcz, lW, lD, 0, lH, rng);
    }
    return;
  }

  if (type === "glass") {
    const h = 15 + rng() * 35;
    const tint = Math.floor(rng() * GLASS_TINTS.length);
    const glassBucket = G.glassGeoms[tint];
    const corniceBucket = G.concreteGeoms[CORNICE_TINT];
    if (h > 25) {
      // Setback stack for glass towers too (no concrete albedo tile on glass).
      const tiers = addSetbackStack(glassBucket, cx, cz, w, d, h, rng);
      for (const tb of tiers) {
        addWindowGridOnLongFacades(tb, tb.hx * 2, tb.hz * 2, rng, G.windowGeoms);
        addFloorCornices(corniceBucket, tb.cx, tb.cz, tb.hx * 2, tb.hz * 2, tb.cy - tb.hy, tb.hy * 2, rng);
      }
      const top = tiers[tiers.length - 1];
      if (rng() < 0.5) addRooftopClutter(top.cx, top.cy + top.hy, top.cz, top.hx * 2, top.hz * 2, rng, G.clutterGeoms);
      if (rng() < 0.3) addNeonPanel(tiers[0], w, d, rng, G);
    } else {
      addBox(glassBucket, cx, h / 2, cz, w, h, d);
      const box: FacadeBox = { cx, cy: h / 2, cz, hx: w / 2, hy: h / 2, hz: d / 2 };
      addWindowGridOnLongFacades(box, w, d, rng, G.windowGeoms);
      addFloorCornices(corniceBucket, cx, cz, w, d, 0, h, rng);
      if (rng() < 0.5) addRooftopClutter(cx, h, cz, w, d, rng, G.clutterGeoms);
      if (rng() < 0.3) addNeonPanel(box, w, d, rng, G);
    }
    return;
  }

  if (type === "podium") {
    const baseH = 4 + rng() * 4; // 1-2 story base
    const baseTint = Math.floor(rng() * CONCRETE_TINTS.length);
    const baseBucket = G.concreteGeoms[baseTint];
    addBox(baseBucket, cx, baseH / 2, cz, w, baseH, d, CONCRETE_TILE);
    addFloorCornices(baseBucket, cx, cz, w, d, 0, baseH, rng);
    // Tower on top, smaller footprint, offset for variety.
    const tw = w * (0.5 + rng() * 0.3);
    const td = d * (0.5 + rng() * 0.3);
    const tH = 10 + rng() * 30;
    const tTint = Math.floor(rng() * CONCRETE_TINTS.length);
    const tBucket = G.concreteGeoms[tTint];
    const tcx = cx + (rng() - 0.5) * (w - tw) * 0.4;
    const tcz = cz + (rng() - 0.5) * (d - td) * 0.4;
    addBox(tBucket, tcx, baseH + tH / 2, tcz, tw, tH, td, CONCRETE_TILE);
    addFloorCornices(tBucket, tcx, tcz, tw, td, baseH, tH, rng);
    // Shop-front glazing on the podium base.
    addShopFront(
      { cx, cy: baseH / 2, cz, hx: w / 2, hy: baseH / 2, hz: d / 2 },
      w,
      d,
      rng,
      G.windowGeoms,
    );
    // Tower window grid.
    addWindowGridOnLongFacades(
      { cx: tcx, cy: baseH + tH / 2, cz: tcz, hx: tw / 2, hy: tH / 2, hz: td / 2 },
      tw,
      td,
      rng,
      G.windowGeoms,
    );
    if (rng() < 0.4) addRooftopClutter(tcx, baseH + tH, tcz, tw, td, rng, G.clutterGeoms);
    if (rng() < 0.15)
      addNeonPanel(
        { cx: tcx, cy: baseH + tH / 2, cz: tcz, hx: tw / 2, hy: tH / 2, hz: td / 2 },
        tw,
        td,
        rng,
        G,
      );
    return;
  }

  // lowrise shop: 2-3 stories, wider than tall, shop front + awning.
  const h = 6 + rng() * 3;
  const tint = Math.floor(rng() * CONCRETE_TINTS.length);
  const bucket = G.concreteGeoms[tint];
  addBox(bucket, cx, h / 2, cz, w, h, d, CONCRETE_TILE);
  const box: FacadeBox = { cx, cy: h / 2, cz, hx: w / 2, hy: h / 2, hz: d / 2 };
  addShopFront(box, w, d, rng, G.windowGeoms);
  // Upper-floor windows on all facades (not just the shop front).
  addWindowGridOnLongFacades(box, w, d, rng, G.windowGeoms);
  addAwning(cx, h, cz, w, d, G.awningGeoms);
  if (rng() < 0.2) addNeonPanel(box, w, d, rng, G);
}

/** Generate 1-3 buildings inside one block, set back from the roads. */
function generateBlock(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  rng: () => number,
  G: GeometryGroups,
): void {
  const zx0 = x0 + SETBACK;
  const zx1 = x1 - SETBACK;
  const zz0 = z0 + SETBACK;
  const zz1 = z1 - SETBACK;
  const zoneW = zx1 - zx0;
  const zoneD = zz1 - zz0;
  if (zoneW < 6 || zoneD < 6) return;

  const n = 1 + Math.floor(rng() * 3);
  const splitLong = zoneW >= zoneD;
  const slots = splitRange(
    splitLong ? zx0 : zz0,
    splitLong ? zx1 : zz1,
    n,
    BUILDING_GAP,
    rng,
  );

  for (const slot of slots) {
    const slotLen = slot[1] - slot[0];
    const longFp = slotLen * (0.72 + rng() * 0.22);
    const shortFp = (splitLong ? zoneD : zoneW) * (0.62 + rng() * 0.33);
    const fpW = splitLong ? longFp : shortFp;
    const fpD = splitLong ? shortFp : longFp;
    const slotCenter = (slot[0] + slot[1]) / 2;
    const cx = splitLong ? slotCenter : (zx0 + zx1) / 2;
    const cz = splitLong ? (zz0 + zz1) / 2 : slotCenter;
    // Jitter along the non-split axis so buildings don't line up perfectly.
    const jx = splitLong ? 0 : (rng() - 0.5) * Math.max(0, zoneW - fpW) * 0.5;
    const jz = splitLong ? (rng() - 0.5) * Math.max(0, zoneD - fpD) * 0.5 : 0;
    const bcx = cx + jx;
    const bcz = cz + jz;

    const tr = rng();
    let type: BuildingType;
    if (tr < 0.4) type = "slab";
    else if (tr < 0.55) type = "glass";
    else if (tr < 0.8) type = "podium";
    else type = "lowrise";

    generateBuilding(type, bcx, bcz, fpW, fpD, rng, G);
  }
}

/* ------------------------------------------------------------------ *
 *  City generation + merge
 * ------------------------------------------------------------------ */

function emptyGroups(): GeometryGroups {
  return {
    concreteGeoms: CONCRETE_TINTS.map(() => []),
    glassGeoms: GLASS_TINTS.map(() => []),
    awningGeoms: [],
    clutterGeoms: [],
    windowGeoms: [],
    neonGeoms: { cyan: [], magenta: [], warmwhite: [], red: [], green: [] } as Record<NeonColor, THREE.BufferGeometry[]>,
  };
}

function mergeOrNull(arr: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (arr.length === 0) return null;
  const merged = mergeGeometries(arr, false);
  for (const g of arr) g.dispose();
  return merged;
}

/** Generate every building in the city and merge geometries by material. */
function generateCity(): CityGeometry {
  const G = emptyGroups();
  const xIntervals = blockIntervals(CITY_NS_ROADS, -WORLD_HALF, WORLD_HALF);
  const zIntervals = blockIntervals(CITY_EW_ROADS, CITY_Z_START, CITY_Z_END);

  for (let zi = 0; zi < zIntervals.length; zi++) {
    for (let xi = 0; xi < xIntervals.length; xi++) {
      const [x0, x1] = xIntervals[xi];
      const [z0, z1] = zIntervals[zi];
      const rng = makeRng(hashSeed(xi * 7919 + 1, zi * 6151 + 1));
      generateBlock(x0, z0, x1, z1, rng, G);
    }
  }

  return {
    concrete: G.concreteGeoms.map(mergeOrNull),
    glass: G.glassGeoms.map(mergeOrNull),
    awning: mergeOrNull(G.awningGeoms),
    clutter: mergeOrNull(G.clutterGeoms),
    windows: mergeOrNull(G.windowGeoms),
    neon: {
      cyan: mergeOrNull(G.neonGeoms.cyan),
      magenta: mergeOrNull(G.neonGeoms.magenta),
      warmwhite: mergeOrNull(G.neonGeoms.warmwhite),
      red: mergeOrNull(G.neonGeoms.red),
      green: mergeOrNull(G.neonGeoms.green),
    },
  };
}

/* ------------------------------------------------------------------ *
 *  Materials
 * ------------------------------------------------------------------ */

interface CityMaterials {
  concreteMats: THREE.MeshStandardMaterial[];
  glassMats: THREE.MeshStandardMaterial[];
  awningMat: THREE.MeshStandardMaterial;
  clutterMat: THREE.MeshStandardMaterial;
  windowMat: THREE.ShaderMaterial;
  neonMats: Record<NeonColor, THREE.MeshStandardMaterial>;
}

function createMaterials(): CityMaterials {
  // Procedural concrete normal map — gives flat box surfaces some
  // surface detail (bumps, grain) so they catch light differently.
  const concreteNormal = makeConcreteNormalMap();
  // Procedural concrete albedo map — formwork lines, slab lines, staining,
  // and bottom weathering. Near-white base so material tints show through.
  // Per-building tiling is baked into each box's UVs (see scaleBoxUvs), so a
  // single shared texture works across all concrete of a given tint.
  const concreteAlbedo = makeConcreteAlbedoMap();
  const concreteMats = CONCRETE_TINTS.map(
    (c) =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(c),
        map: concreteAlbedo,
        roughness: 0.85,
        metalness: 0.05,
        normalMap: concreteNormal,
        normalScale: new THREE.Vector2(0.3, 0.3),
      }),
  );
  // Glass: lower metalness so it reads as tinted glass even without
  // a perfect env map. The env map from WorldScene provides reflections.
  const glassMats = GLASS_TINTS.map(
    (c) =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(c),
        roughness: 0.25,
        metalness: 0.3,
        emissive: new THREE.Color(CITY_PALETTE.windowGlow),
        emissiveIntensity: 0,
      }),
  );
  const awningMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(AWNING_COLOR),
    roughness: 0.9,
    metalness: 0,
  });
  const clutterMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(CLUTTER_COLOR),
    roughness: 0.7,
    metalness: 0.1,
  });
  const windowMat = new THREE.ShaderMaterial({
    uniforms: {
      uWindowGlow: { value: 0 },
      uGlowWarm: { value: new THREE.Color("#ffcf8a") },
      uGlowCool: { value: new THREE.Color("#a0c8ff") },
    },
    vertexShader: WINDOW_VERT,
    fragmentShader: WINDOW_FRAG,
    toneMapped: true,
  });
  const neonMats = {} as Record<NeonColor, THREE.MeshStandardMaterial>;
  (Object.keys(NEON_HEX) as NeonColor[]).forEach((k) => {
    neonMats[k] = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#101010"),
      emissive: new THREE.Color(NEON_HEX[k]),
      emissiveIntensity: 0,
      roughness: 0.4,
      metalness: 0.2,
      toneMapped: false,
    });
  });
  return { concreteMats, glassMats, awningMat, clutterMat, windowMat, neonMats };
}

/** Procedural concrete normal map — subtle bumps and grain via CanvasTexture. */
function makeConcreteNormalMap(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  // Fill with neutral normal (0,0,1) → (128,128,255).
  ctx.fillStyle = "#8080ff";
  ctx.fillRect(0, 0, size, size);
  // Add random bumps (lighter/darker spots) for surface grain.
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (Math.random() - 0.5) * 30;
    data[i] = Math.max(0, Math.min(255, 128 + n));
    data[i + 1] = Math.max(0, Math.min(255, 128 + n));
    data[i + 2] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // Add a few horizontal lines (concrete seams).
  ctx.strokeStyle = "rgba(60,60,80,0.3)";
  ctx.lineWidth = 1;
  for (let y = 0; y < size; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Procedural concrete albedo map (512x512). A near-white base lets the
 * per-tint material color show through; vertical formwork lines (~40px),
 * horizontal floor-slab lines (~80px), subtle radial staining, and darker
 * weathering at the bottom 20% add the surface variation flat colors lack.
 * Tiling is driven by per-box UVs (scaleBoxUvs), so repeat stays at (1,1).
 */
function makeConcreteAlbedoMap(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  // Base: near-white so vertex/material tints show through.
  ctx.fillStyle = "#f5f5f5";
  ctx.fillRect(0, 0, size, size);
  // Subtle staining: a few radial gradients of warmer or darker tones.
  const stains = 6;
  for (let i = 0; i < stains; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 40 + Math.random() * 120;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    if (Math.random() < 0.5) {
      grad.addColorStop(0, "rgba(180,160,120,0.16)");
      grad.addColorStop(1, "rgba(180,160,120,0)");
    } else {
      grad.addColorStop(0, "rgba(60,55,50,0.14)");
      grad.addColorStop(1, "rgba(60,55,50,0)");
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Vertical formwork lines every ~40px, slightly varied darkness.
  for (let x = 0; x <= size; x += 40) {
    const dark = 90 + Math.random() * 40;
    ctx.strokeStyle = `rgba(${dark},${dark},${dark + 10},${0.22 + Math.random() * 0.15})`;
    ctx.lineWidth = 1 + Math.random();
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();
  }
  // Horizontal floor-slab lines every ~80px.
  for (let y = 0; y <= size; y += 80) {
    const dark = 70 + Math.random() * 30;
    ctx.strokeStyle = `rgba(${dark},${dark},${dark + 10},${0.28 + Math.random() * 0.15})`;
    ctx.lineWidth = 1.5 + Math.random();
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }
  // Darker weathering at the bottom 20% (dirt/soot accumulation at ground
  // level). CanvasTexture flips Y by default, so canvas-top maps to the
  // bottom of the wall (v=0).
  const weather = ctx.createLinearGradient(0, 0, 0, size * 0.2);
  weather.addColorStop(0, "rgba(50,45,40,0.28)");
  weather.addColorStop(1, "rgba(50,45,40,0)");
  ctx.fillStyle = weather;
  ctx.fillRect(0, 0, size, size * 0.2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1);
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ *
 *  Component
 * ------------------------------------------------------------------ */

export function CityDistrict() {
  const dayNightRef = useContext(DayNightContext);
  const mats = useMemo(() => createMaterials(), []);
  const city = useMemo(() => generateCity(), []);

  // Drive window glow, glass emissive, and neon intensity from the live
  // day/night state every frame. Materials are stable (useMemo), so closing
  // over them here is safe.
  useFrame(() => {
    const s = dayNightRef?.current;
    if (!s) return;
    const wg = s.windowGlow;
    const ni = s.neonIntensity;
    mats.windowMat.uniforms.uWindowGlow.value = wg;
    for (const m of mats.glassMats) m.emissiveIntensity = wg * 0.35;
    for (const k of Object.keys(mats.neonMats) as NeonColor[]) {
      mats.neonMats[k].emissiveIntensity = 0.15 + ni * 2.4;
    }
  });

  if (!dayNightRef) {
    throw new Error("CityDistrict must be used within DayNightContext.Provider");
  }

  return (
    <group>
      {city.concrete.map((geo, i) =>
        geo ? (
          <mesh
            key={`c${i}`}
            geometry={geo}
            material={mats.concreteMats[i]}
            castShadow
            receiveShadow
          />
        ) : null,
      )}
      {city.glass.map((geo, i) =>
        geo ? (
          <mesh
            key={`g${i}`}
            geometry={geo}
            material={mats.glassMats[i]}
            castShadow
            receiveShadow
          />
        ) : null,
      )}
      {city.awning ? (
        <mesh geometry={city.awning} material={mats.awningMat} castShadow receiveShadow />
      ) : null}
      {city.clutter ? (
        <mesh geometry={city.clutter} material={mats.clutterMat} castShadow />
      ) : null}
      {city.windows ? <mesh geometry={city.windows} material={mats.windowMat} /> : null}
      {(Object.keys(city.neon) as NeonColor[]).map((k) =>
        city.neon[k] ? (
          <mesh key={`n${k}`} geometry={city.neon[k]} material={mats.neonMats[k]} />
        ) : null,
      )}
    </group>
  );
}
