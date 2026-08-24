import { useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  WORLD_HALF,
  CITY_NS_ROADS,
  CITY_EW_ROADS,
  CITY_Z_START,
  CITY_Z_END,
  TOWN_NS_ROADS,
  TOWN_EW_ROADS,
  TOWN_Z_START,
  TOWN_Z_END,
  CITY_PALETTE,
} from "./constants";

/**
 * RoadNetwork — the full road grid for the ParCoar open world.
 *
 * Builds five merged meshes so the spectator camera sees a clean city grid
 * (dark warm-grey asphalt with dashed warm-white center lines, zebra
 * crosswalks and stop lines at every intersection, raised concrete curbs),
 * a quieter town grid (warmer, unmarked), two elevated bridges across the
 * river, and raised concrete sidewalks alongside the city roads.
 *
 * Every strip is built with the `ribbon` helper (a flat PlaneGeometry
 * oriented along a start/end pair), then all ribbons for each layer are
 * merged into a single BufferGeometry to keep draw calls low. Road and
 * sidewalk surfaces use procedural CanvasTextures (asphalt grain + baked
 * edge/center lines, concrete scoring) with per-ribbon UV scaling so the
 * texture tiles at a consistent world scale regardless of segment length.
 */

/* ------------------------------------------------------------------ *
 *  Geometry helpers
 * ------------------------------------------------------------------ */

/** Small Y offsets to avoid z-fighting with the ground planes (Y=0). */
const Y_ROAD = 0.02;
const Y_MARKING = 0.04;
const Y_SIDEWALK = 0.15;

/** City road width (NS + EW). */
const CITY_ROAD_WIDTH = 10;
/** Town road width (narrower, residential). */
const TOWN_ROAD_WIDTH = 7;
/** Sidewalk width on each side of a city road. */
const SIDEWALK_WIDTH = 3;
/** Raised curb height — the vertical face that reads as a curb. */
const CURB_HEIGHT = 0.3;
/** Center-line marking width. */
const MARKING_WIDTH = 0.35;
/** Dash / gap lengths for center lines. */
const DASH_LEN = 3;
const DASH_GAP = 3;

/** Crosswalk zebra-stripe dimensions. */
const CROSSWALK_STRIPE_WIDTH = 0.35;
const CROSSWALK_STRIPE_GAP = 1.5;
const CROSSWALK_STRIPE_COUNT = 6;
/** Solid stop line width (along the travel direction). */
const STOP_LINE_WIDTH = 0.5;
/** Gap from the intersection edge to the crosswalk / stop line. */
const INTERSECTION_GAP = 0.3;

/** World units per asphalt texture tile (along the road length). */
const ASPHALT_TILE = 8;
/** World units per sidewalk scoring tile. */
const SIDEWALK_SCORE = 4;

/** Warm-white center line (reuses the city neon warm-white). */
const MARKING_COLOR = CITY_PALETTE.neonWarmWhite;
/** Warmer asphalt for the town — earthy, residential. */
const TOWN_ASPHALT = "#3d342a";
/** White used for crosswalk / stop-line / edge markings. */
const WHITE_MARKING = "#e8e8e8";

/**
 * Build a flat ribbon (a thin strip lying in the XZ plane, facing +Y)
 * between two world-space points. `width` is perpendicular to the line,
 * `y` is the elevation. `uvS` / `uvT` scale the texture coordinates so a
 * repeating texture tiles at a consistent world scale (u across the width,
 * v along the length). The returned geometry is already transformed into
 * world space so it can be merged directly with other ribbons.
 */
function ribbon(
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  width: number,
  y: number,
  uvS = 1,
  uvT = 1,
): THREE.BufferGeometry {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  const geo = new THREE.PlaneGeometry(width, len);
  // PlaneGeometry lives in the XY plane facing +Z. Rotate -90° about X so
  // it lies flat with the normal facing +Y (visible from above).
  geo.rotateX(-Math.PI / 2);
  // Orient the +Z length axis toward (dx, dz).
  geo.rotateY(Math.atan2(dx, dz));
  geo.translate((x1 + x2) / 2, y, (z1 + z2) / 2);
  if (uvS !== 1 || uvT !== 1) scaleGeoUV(geo, uvS, uvT);
  return geo;
}

/** Scale the UV attribute of a geometry by (su, sv) in place. */
function scaleGeoUV(geo: THREE.BufferGeometry, su: number, sv: number): void {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  uv.needsUpdate = true;
}

/**
 * Build a dashed center line along a segment as an array of short ribbon
 * geometries (one per dash). The caller merges them into the markings mesh.
 */
function dashedLine(
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  y: number,
  dashLen = DASH_LEN,
  gapLen = DASH_GAP,
  width = MARKING_WIDTH,
): THREE.BufferGeometry[] {
  const total = Math.hypot(x2 - x1, z2 - z1);
  if (total <= 0) return [];
  const ux = (x2 - x1) / total;
  const uz = (z2 - z1) / total;
  const dashes: THREE.BufferGeometry[] = [];
  let d = 0;
  while (d < total) {
    const s = d;
    const e = Math.min(d + dashLen, total);
    dashes.push(
      ribbon(
        x1 + ux * s,
        z1 + uz * s,
        x1 + ux * e,
        z1 + uz * e,
        width,
        y,
      ),
    );
    d += dashLen + gapLen;
  }
  return dashes;
}

/**
 * Build the zebra-stripe crosswalk and solid stop line for one approach of
 * an intersection. `cx`/`cz` is the intersection center; `alongX` is true
 * for an approach on an east-west road (stripes span Z, traffic along X),
 * false for a north-south road (stripes span X, traffic along Z). `sign`
 * (+1 / -1) picks which side of the intersection the approach sits on.
 */
function buildApproach(
  cx: number,
  cz: number,
  alongX: boolean,
  sign: number,
  out: THREE.BufferGeometry[],
): void {
  const half = CITY_ROAD_WIDTH / 2;
  const pitch = CROSSWALK_STRIPE_WIDTH + CROSSWALK_STRIPE_GAP;
  const depth =
    CROSSWALK_STRIPE_COUNT * CROSSWALK_STRIPE_WIDTH +
    (CROSSWALK_STRIPE_COUNT - 1) * CROSSWALK_STRIPE_GAP;
  // Center of the crosswalk band, just outside the intersection box.
  const bandCenter = half + INTERSECTION_GAP + depth / 2;
  // Stop line sits on the approach side, just past the crosswalk.
  const stopPos = half + INTERSECTION_GAP + depth + INTERSECTION_GAP;

  if (alongX) {
    // East-west road: traffic runs along X, stripes span Z.
    const xc = cx + sign * bandCenter;
    const xs = cx + sign * stopPos;
    for (let i = 0; i < CROSSWALK_STRIPE_COUNT; i++) {
      const off = (i - (CROSSWALK_STRIPE_COUNT - 1) / 2) * pitch;
      out.push(
        ribbon(
          xc + off,
          cz - half,
          xc + off,
          cz + half,
          CROSSWALK_STRIPE_WIDTH,
          Y_MARKING,
        ),
      );
    }
    out.push(
      ribbon(
        xs,
        cz - half,
        xs,
        cz + half,
        STOP_LINE_WIDTH,
        Y_MARKING,
      ),
    );
  } else {
    // North-south road: traffic runs along Z, stripes span X.
    const zc = cz + sign * bandCenter;
    const zs = cz + sign * stopPos;
    for (let i = 0; i < CROSSWALK_STRIPE_COUNT; i++) {
      const off = (i - (CROSSWALK_STRIPE_COUNT - 1) / 2) * pitch;
      out.push(
        ribbon(
          cx - half,
          zc + off,
          cx + half,
          zc + off,
          CROSSWALK_STRIPE_WIDTH,
          Y_MARKING,
        ),
      );
    }
    out.push(
      ribbon(
        cx - half,
        zs,
        cx + half,
        zs,
        STOP_LINE_WIDTH,
        Y_MARKING,
      ),
    );
  }
}

/**
 * Build all crosswalk + stop-line markings for every NS×EW city
 * intersection (4 approaches each). Returns ribbons to merge into the
 * markings mesh.
 */
function buildIntersectionMarkings(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const x of CITY_NS_ROADS) {
    for (const z of CITY_EW_ROADS) {
      // 4 approaches: NS road north/south, EW road east/west.
      buildApproach(x, z, false, -1, out); // south approach on NS road
      buildApproach(x, z, false, +1, out); // north approach on NS road
      buildApproach(x, z, true, -1, out); // west approach on EW road
      buildApproach(x, z, true, +1, out); // east approach on EW road
    }
  }
  return out;
}

/**
 * Merge an array of geometries into one. Returns null only if the input is
 * empty or attributes mismatch; we guard the empty case and trust the rest
 * (all inputs are PlaneGeometry-based, so attributes are compatible).
 */
function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (geos.length === 0) return new THREE.BufferGeometry();
  const merged = mergeGeometries(geos, false);
  if (!merged) {
    throw new Error("RoadNetwork: mergeGeometries returned null — attribute mismatch.");
  }
  return merged;
}

/* ------------------------------------------------------------------ *
 *  Procedural textures
 * ------------------------------------------------------------------ */

/**
 * Tileable road texture: dark asphalt base with surface grain, a baked
 * dashed center line (warm white) and solid white edge lines on both sides.
 * u maps across the road width (0..1, edges at 0/1, center at 0.5); v maps
 * along the road length and is scaled per-ribbon so the dash tiles at a
 * fixed world spacing.
 */
function makeRoadTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  // Base dark asphalt.
  ctx.fillStyle = CITY_PALETTE.asphalt;
  ctx.fillRect(0, 0, size, size);
  // Surface grain — random darker/lighter pixels.
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (Math.random() - 0.5) * 22;
    data[i] = Math.max(0, Math.min(255, data[i] + n));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  // A few hairline cracks for wear.
  ctx.strokeStyle = "rgba(10,8,6,0.35)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    let x = Math.random() * size;
    let y = Math.random() * size;
    ctx.moveTo(x, y);
    for (let j = 0; j < 5; j++) {
      x += (Math.random() - 0.5) * 50;
      y += (Math.random() - 0.5) * 50;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Solid white edge lines at both sides of the road (u ~ 0 and ~ 1).
  const edgeW = 5;
  ctx.fillStyle = WHITE_MARKING;
  ctx.fillRect(0, 0, edgeW, size);
  ctx.fillRect(size - edgeW, 0, edgeW, size);
  // Baked dashed center line at u = 0.5 (warm white).
  const cx = size / 2;
  const cw = 4;
  const dashOn = 28;
  const dashOff = 28;
  ctx.fillStyle = CITY_PALETTE.neonWarmWhite;
  for (let y = 0; y < size; y += dashOn + dashOff) {
    ctx.fillRect(cx - cw / 2, y, cw, dashOn);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1); // tiling driven by per-ribbon UV scaling
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Tileable asphalt normal map — subtle bumps for surface detail. Mirrors
 * the one in Ground.tsx (kept local so RoadNetwork stays self-contained).
 */
function makeRoadNormalMap(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#8080ff";
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (Math.random() - 0.5) * 20;
    data[i] = Math.max(0, Math.min(255, 128 + n));
    data[i + 1] = Math.max(0, Math.min(255, 128 + n));
    data[i + 2] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Tileable sidewalk texture — light concrete with a scoring grid and
 * subtle grain. Scoring lines are drawn at the tile edges so repeated
 * tiling produces an even grid.
 */
function makeSidewalkTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#9aa0a8";
  ctx.fillRect(0, 0, size, size);
  // Concrete grain.
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    data[i] = Math.max(0, Math.min(255, data[i] + n));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  // Scoring lines at the tile edges (form a grid when tiled).
  ctx.strokeStyle = "rgba(60,60,66,0.55)";
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, size, size);
  // A couple of faint expansion joints inside the tile.
  ctx.strokeStyle = "rgba(60,60,66,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2);
  ctx.lineTo(size, size / 2);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1); // tiling driven by per-box UV scaling
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ *
 *  Layer builders
 * ------------------------------------------------------------------ */

/** City road ribbons (5 NS + 4 EW), center-line dashes, crosswalks, stop lines. */
function buildCityRoads(): {
  roads: THREE.BufferGeometry;
  markings: THREE.BufferGeometry;
} {
  const roads: THREE.BufferGeometry[] = [];
  const markings: THREE.BufferGeometry[] = [];

  const nsLen = CITY_Z_END - CITY_Z_START;
  // North-south roads run along Z, from the river bank to the south edge.
  for (const x of CITY_NS_ROADS) {
    roads.push(
      ribbon(x, CITY_Z_START, x, CITY_Z_END, CITY_ROAD_WIDTH, Y_ROAD, 1, nsLen / ASPHALT_TILE),
    );
    markings.push(...dashedLine(x, CITY_Z_START, x, CITY_Z_END, Y_MARKING));
  }

  const ewLen = WORLD_HALF * 2;
  // East-west roads run along X, across the full world width.
  for (const z of CITY_EW_ROADS) {
    roads.push(
      ribbon(-WORLD_HALF, z, WORLD_HALF, z, CITY_ROAD_WIDTH, Y_ROAD, 1, ewLen / ASPHALT_TILE),
    );
    markings.push(...dashedLine(-WORLD_HALF, z, WORLD_HALF, z, Y_MARKING));
  }

  // Crosswalks + stop lines at every NS×EW intersection.
  markings.push(...buildIntersectionMarkings());

  return { roads: mergeAll(roads), markings: mergeAll(markings) };
}

/** Town road ribbons (6 NS + 4 EW), no lane markings. */
function buildTownRoads(): THREE.BufferGeometry {
  const roads: THREE.BufferGeometry[] = [];

  for (const x of TOWN_NS_ROADS) {
    roads.push(ribbon(x, TOWN_Z_START, x, TOWN_Z_END, TOWN_ROAD_WIDTH, Y_ROAD));
  }
  for (const z of TOWN_EW_ROADS) {
    roads.push(ribbon(-WORLD_HALF, z, WORLD_HALF, z, TOWN_ROAD_WIDTH, Y_ROAD));
  }

  return mergeAll(roads);
}

/**
 * Raised curb geometry on both sides of every city road. Each sidewalk is a
 * box (SIDEWALK_WIDTH × CURB_HEIGHT × roadLength) with its top at Y=0.15,
 * so the vertical face reads as a curb. UVs are scaled per box so the
 * concrete scoring texture tiles at a fixed world spacing.
 */
function buildSidewalks(): THREE.BufferGeometry {
  const offset = CITY_ROAD_WIDTH / 2 + SIDEWALK_WIDTH / 2;
  const cy = Y_SIDEWALK - CURB_HEIGHT / 2; // top at Y_SIDEWALK
  const sw: THREE.BufferGeometry[] = [];

  const nsLen = CITY_Z_END - CITY_Z_START;
  const nsCenterZ = (CITY_Z_START + CITY_Z_END) / 2;
  for (const x of CITY_NS_ROADS) {
    for (const sx of [x - offset, x + offset]) {
      const geo = new THREE.BoxGeometry(SIDEWALK_WIDTH, CURB_HEIGHT, nsLen);
      // Top face: u across width (X), v along length (Z).
      scaleGeoUV(geo, SIDEWALK_WIDTH / SIDEWALK_SCORE, nsLen / SIDEWALK_SCORE);
      geo.translate(sx, cy, nsCenterZ);
      sw.push(geo);
    }
  }

  const ewLen = WORLD_HALF * 2;
  for (const z of CITY_EW_ROADS) {
    for (const sz of [z - offset, z + offset]) {
      const geo = new THREE.BoxGeometry(ewLen, CURB_HEIGHT, SIDEWALK_WIDTH);
      // Top face: u along length (X), v across width (Z).
      scaleGeoUV(geo, ewLen / SIDEWALK_SCORE, SIDEWALK_WIDTH / SIDEWALK_SCORE);
      geo.translate(0, cy, sz);
      sw.push(geo);
    }
  }

  return mergeAll(sw);
}

/* ------------------------------------------------------------------ *
 *  Component
 * ------------------------------------------------------------------ */

export function RoadNetwork() {
  const { roads: cityRoadsGeo, markings: cityMarkingsGeo } = useMemo(
    () => buildCityRoads(),
    [],
  );
  const townRoadsGeo = useMemo(() => buildTownRoads(), []);
  const sidewalksGeo = useMemo(() => buildSidewalks(), []);

  // Procedural textures (created once).
  const roadTex = useMemo(() => makeRoadTexture(), []);
  const roadNormal = useMemo(() => makeRoadNormalMap(), []);
  const sidewalkTex = useMemo(() => makeSidewalkTexture(), []);

  return (
    <group>
      {/* City roads — textured asphalt (grain + baked edge/center lines)
          with a normal map for surface detail. The separate markings mesh
          below keeps the dashed center line crisp and adds crosswalks. */}
      <mesh geometry={cityRoadsGeo} receiveShadow>
        <meshStandardMaterial
          map={roadTex}
          normalMap={roadNormal}
          normalScale={new THREE.Vector2(0.4, 0.4)}
          color="#ffffff"
          roughness={0.9}
          metalness={0}
        />
      </mesh>

      {/* City markings — dashed center lines, zebra crosswalks and stop
          lines at intersections. Warm white, lightly emissive so they read
          from above and at dusk. */}
      <mesh geometry={cityMarkingsGeo}>
        <meshStandardMaterial
          color={MARKING_COLOR}
          emissive={MARKING_COLOR}
          emissiveIntensity={0.25}
          roughness={0.7}
          metalness={0}
        />
      </mesh>

      {/* Town roads — warmer, unmarked, with the asphalt normal map for a
          subtle surface without adding lane markings. */}
      <mesh geometry={townRoadsGeo} receiveShadow>
        <meshStandardMaterial
          color={TOWN_ASPHALT}
          normalMap={roadNormal}
          normalScale={new THREE.Vector2(0.3, 0.3)}
          roughness={0.95}
          metalness={0}
        />
      </mesh>

      {/* Sidewalks — raised concrete curbs alongside city roads, textured
          with a concrete scoring pattern. Darker than buildings so they
          read as curbs, not as gray lines on the road. */}
      <mesh geometry={sidewalksGeo} receiveShadow castShadow>
        <meshStandardMaterial
          map={sidewalkTex}
          color="#4a4a50"
          roughness={0.9}
          metalness={0}
        />
      </mesh>
      {/* Note: bridges are built entirely by River.tsx (with railings, piers,
          trusses, and lights). No duplicate bridge geometry here. */}
    </group>
  );
}
