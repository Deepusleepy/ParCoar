import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useDayNightState } from "./DayNight";
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
 * houses with pitched (gable/hip) tile roofs, side yards between buildings,
 * a vermilion shrine, rice paddies framing Mt. Fuji, and a small JR-style
 * train station with a level crossing.
 *
 * Everything static is baked into a handful of merged BufferGeometries so
 * the whole town renders in ~6 draw calls. Only the streetlight lamps and
 * window glow use emissive materials that animate with the day/night cycle.
 */

/* ------------------------------------------------------------------ *
 *  Colors
 * ------------------------------------------------------------------ */

const C_CREAM = new THREE.Color(TOWN_PALETTE.wallCream);
const C_SAGE = new THREE.Color(TOWN_PALETTE.wallSage);
const C_TERRA = new THREE.Color(TOWN_PALETTE.wallTerracotta);
const C_VERMILION = new THREE.Color("#c04020");
const C_STONE = new THREE.Color("#9a958c");
const C_STONE_DARK = new THREE.Color("#6a6560");
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

const WALL_COLORS = [C_CREAM, C_SAGE, C_TERRA];

/** Per-building roof tints — varied so roofs aren't all one blue-grey. */
const ROOF_TINTS = [
  new THREE.Color("#3a4252"), // dark blue-grey (original tile)
  new THREE.Color("#8a8e94"), // light grey
  new THREE.Color("#9a4a32"), // terracotta
  new THREE.Color("#4a5a4a"), // weathered green
  new THREE.Color("#4a3a2a"), // dark brown
];

/** Fence post + garden/driveway colors. */
const C_FENCE = new THREE.Color("#6a5a4a");
const C_FENCE_DARK = new THREE.Color("#3a3530");
const C_GARDEN_GREEN = new THREE.Color("#3a5a32");
const C_GARDEN_BROWN = new THREE.Color("#5a4a32");
const C_DRIVEWAY = new THREE.Color("#2a2a2a");
const C_TORII_BLACK = new THREE.Color("#1a1a1a");

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
    float nightBright = 0.05 + nightLit;
    float brightness = mix(dayBright, nightBright, on);
    gl_FragColor = vec4(col * brightness, 1.0);
  }
`;

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
 * the town window shader can light windows staggered at night. Mirrors the
 * city's addWindow approach but uses the town's axisQuad facing convention.
 */
function pushTownWindow(
  arr: THREE.BufferGeometry[],
  cx: number,
  cy: number,
  cz: number,
  w: number,
  h: number,
  face: Dir,
  rngVal: number,
): void {
  const g = axisQuad(cx, cy, cz, w, h, face);
  const n = g.attributes.position.count;
  const phase = rngVal;
  const brightness = rngVal < 0.15 ? 0.0 : 0.3 + ((rngVal * 13.7) % 1) * 0.7;
  const tint =
    ((rngVal * 7.3) % 1) < 0.7 ? rngVal * 0.2 : 0.6 + rngVal * 0.4;
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
          const roofTint =
            ROOF_TINTS[Math.floor(rng() * ROOF_TINTS.length)];
          const commercial = rng() < 0.22;
          out.push({ x: px, z: pz, w, d, h, color, roofType, roofTint, commercial });
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
  walls: THREE.BufferGeometry | null;
  roofs: THREE.BufferGeometry | null;
  misc: THREE.BufferGeometry | null;
  fences: THREE.BufferGeometry | null;
  paddies: THREE.BufferGeometry | null;
  paddyWater: THREE.BufferGeometry | null;
  lamps: THREE.BufferGeometry | null;
  windows: THREE.BufferGeometry | null;
}

function buildTown(): TownGeometries {
  const walls: THREE.BufferGeometry[] = [];
  const roofs: THREE.BufferGeometry[] = [];
  const misc: THREE.BufferGeometry[] = [];
  const fences: THREE.BufferGeometry[] = [];
  const paddies: THREE.BufferGeometry[] = [];
  const paddyWater: THREE.BufferGeometry[] = [];
  const lamps: THREE.BufferGeometry[] = [];
  const windows: THREE.BufferGeometry[] = [];

  const buildings = generateBuildings();

  for (const b of buildings) {
    // Wall body.
    let w = b.w;
    let d = b.d;
    let roofType = b.roofType;
    // Keep the gable ridge along the longer side by swapping so w >= d.
    if (roofType === "gable" && d > w) {
      [w, d] = [d, w];
    }
    const wallGeo = toPNC(new THREE.BoxGeometry(w, b.h, d), b.color);
    translate(wallGeo, b.x, b.h / 2, b.z);
    walls.push(wallGeo);

    // Roof — vertex-colored with the building's random roof tint.
    const rh = THREE.MathUtils.clamp(Math.min(w, d) * 0.4, 1.4, 3);
    const roofGeo =
      roofType === "gable" ? gableRoofGeo(w, d, rh) : hipRoofGeo(w, d, rh);
    translate(roofGeo, b.x, b.h, b.z);
    roofs.push(toPNC(roofGeo, b.roofTint));

    // Windows on the two long facades (upper floors only). Each window
    // carries per-window phase/brightness/tint for the glow shader.
    const cols = Math.max(1, Math.floor(w / 2.4));
    const rows = Math.max(1, Math.floor((b.h - 2) / 2.2));
    const sx = w / (cols + 1);
    const sy = (b.h - 2) / (rows + 1);
    const winSize = 0.7;
    const winRng = mulberry32(hashSeed(Math.round(b.x * 3.1), Math.round(b.z * 2.3)));
    for (let r = 0; r < rows; r++) {
      const wy = 1.4 + (r + 1) * sy;
      for (let c = 0; c < cols; c++) {
        const wx = b.x - w / 2 + (c + 1) * sx;
        pushTownWindow(
          windows, wx, wy, b.z + d / 2 + 0.06, winSize, winSize, "+Z", winRng(),
        );
        pushTownWindow(
          windows, wx, wy, b.z - d / 2 - 0.06, winSize, winSize, "-Z", winRng(),
        );
      }
    }

    // Commercial ground-floor details: shutter panel, awning, sign.
    if (b.commercial) {
      const shutter = toPNC(
        new THREE.BoxGeometry(w * 0.7, 1.6, 0.08),
        C_SHUTTER,
      );
      translate(shutter, b.x, 0.9, b.z + d / 2 + 0.05);
      walls.push(shutter);

      const awning = toPNC(new THREE.BoxGeometry(w * 0.6, 0.12, 1.1), C_AWNING);
      translate(awning, b.x, 1.9, b.z + d / 2 + 0.55);
      walls.push(awning);

      // Warm shop sign — emissive via the window shader (always-on at night).
      pushTownWindow(
        windows, b.x, 2.5, b.z + d / 2 + 0.07, w * 0.5, 0.5, "+Z", 0.02,
      );
    }

    // Fence, garden patches and a driveway around the house plot.
    buildPlotFence(fences, b);
  }

  /* ---- Shrine ---- */
  buildShrine(misc);

  /* ---- Train station + tracks + level crossing ---- */
  buildStation(walls, roofs, misc);

  /* ---- Streetlights along every road ---- */
  buildStreetlights(misc, lamps);

  /* ---- Street trees lining the town roads ---- */
  buildStreetTrees(misc);

  /* ---- Rice paddies north of the last road, framing Fuji ---- */
  buildPaddies(paddies, paddyWater);

  return {
    walls: merge(walls),
    roofs: merge(roofs),
    misc: merge(misc),
    fences: merge(fences),
    paddies: merge(paddies),
    paddyWater: merge(paddyWater),
    lamps: merge(lamps),
    windows: merge(windows),
  };
}

/** Shrine: torii gate, stone platform, stone lanterns, a few trees. */
function buildShrine(misc: THREE.BufferGeometry[]): void {
  const sx = 0;
  const sz = -70; // Between EW roads at -40 and -80, away from the track at Z=-100.

  // Torii pillars.
  const pillarL = toPNC(new THREE.BoxGeometry(0.55, 6, 0.55), C_VERMILION);
  translate(pillarL, sx - 2.7, 3, sz);
  misc.push(pillarL);
  const pillarR = toPNC(new THREE.BoxGeometry(0.55, 6, 0.55), C_VERMILION);
  translate(pillarR, sx + 2.7, 3, sz);
  misc.push(pillarR);

  // Kasagi (top beam) — a gently curved vermilion beam that overhangs past
  // the pillars, like a real Shinto torii. Built from a torus arc: we take the
  // top slice of a large-radius ring so the chord runs horizontal (along X,
  // spanning ~7.2 units with overhang) and the arc bulges upward. The torus
  // tube gives the beam its depth along Z.
  const kArc = 1.0; // ~57° arc — shallow arch
  const kRadius = 7.52; // chord ≈ 7.2, sagitta ≈ 0.9
  const kHalf = kArc / 2;
  const chordY = kRadius * Math.cos(kHalf); // height of the chord above origin
  const kasagiArc = toPNC(
    new THREE.TorusGeometry(kRadius, 0.26, 10, 48, kArc),
    C_VERMILION,
  );
  // Center the arc on +Y so the chord is horizontal and the arch bulges up.
  kasagiArc.rotateZ(Math.PI / 2 - kHalf);
  translate(kasagiArc, sx, 6.4 - chordY, sz); // rest the chord on the pillars
  misc.push(kasagiArc);

  // Black top cap — a thin flat board along the crown of the curve.
  const apexY = 6.4 + (kRadius - chordY);
  const cap = toPNC(new THREE.BoxGeometry(8.2, 0.22, 0.95), C_TORII_BLACK);
  translate(cap, sx, apexY + 0.12, sz);
  misc.push(cap);

  // Nuki (second beam).
  const nuki = toPNC(new THREE.BoxGeometry(5.4, 0.38, 0.62), C_VERMILION);
  translate(nuki, sx, 5.2, sz);
  misc.push(nuki);

  // Gakuzuka (central name board).
  const gakuzuka = toPNC(new THREE.BoxGeometry(0.65, 0.85, 0.3), C_VERMILION);
  translate(gakuzuka, sx, 5.85, sz);
  misc.push(gakuzuka);

  // Stone platform + front steps.
  const platform = toPNC(new THREE.BoxGeometry(11, 0.4, 7), C_STONE);
  translate(platform, sx, 0.2, sz + 1.5);
  misc.push(platform);
  const steps = toPNC(new THREE.BoxGeometry(3, 0.3, 1), C_STONE_DARK);
  translate(steps, sx, 0.15, sz - 2.2);
  misc.push(steps);

  // Stone lanterns flanking the approach.
  for (const lx of [sx - 4, sx + 4]) {
    const base = toPNC(new THREE.BoxGeometry(0.8, 0.3, 0.8), C_STONE_DARK);
    translate(base, lx, 0.15, sz - 2.6);
    misc.push(base);
    const body = toPNC(new THREE.BoxGeometry(0.5, 0.8, 0.5), C_STONE);
    translate(body, lx, 0.7, sz - 2.6);
    misc.push(body);
    const cap = toPNC(new THREE.BoxGeometry(0.75, 0.2, 0.75), C_STONE_DARK);
    translate(cap, lx, 1.2, sz - 2.6);
    misc.push(cap);
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

/** JR-style station: elevated platform, gable-roofed building, tracks, crossing. */
function buildStation(
  walls: THREE.BufferGeometry[],
  roofs: THREE.BufferGeometry[],
  misc: THREE.BufferGeometry[],
): void {
  const stX = 64;
  const stZ = -97;
  const trackZ = -100;

  // Elevated platform (north side of tracks).
  const platform = toPNC(
    new THREE.BoxGeometry(32, 1.2, 6),
    C_PLATFORM,
  );
  translate(platform, stX, 0.6, trackZ - 4);
  misc.push(platform);

  // Station building (on the south side of the tracks).
  const bw = 9;
  const bd = 5;
  const bh = 4;
  const bWall = toPNC(new THREE.BoxGeometry(bw, bh, bd), C_CREAM);
  translate(bWall, stX, bh / 2, stZ);
  walls.push(bWall);

  const rh = 1.8;
  const bRoof = gableRoofGeo(bw, bd, rh);
  translate(bRoof, stX, bh, stZ);
  roofs.push(toPNC(bRoof, ROOF_TINTS[0]));

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

  const geos = useMemo(() => buildTown(), []);

  // Animate emissive materials with the day/night cycle.
  useFrame(() => {
    const s = stateRef.current;
    if (lampMatRef.current) {
      lampMatRef.current.emissiveIntensity = s.streetlightIntensity * 2.2;
    }
    if (windowMatRef.current) {
      windowMatRef.current.uniforms.uWindowGlow.value = s.windowGlow;
    }
  });

  return (
    <group>
      {geos.walls && (
        <mesh geometry={geos.walls} castShadow receiveShadow>
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
    </group>
  );
}
