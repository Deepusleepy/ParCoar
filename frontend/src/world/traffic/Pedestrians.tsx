import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  CITY_EW_ROADS,
  CITY_NS_ROADS,
} from "../constants";
import { useDayNightState } from "../DayNight";
import { hashSeed, makeRng } from "../CityDistrict";
import { runtime } from "../runtime";

/**
 * Pedestrians — crossing crowds at city intersections.
 *
 * At every CITY_NS × CITY_EW intersection (minus the player spawn and the
 * two bridge-foot intersections, whose crosswalks are swallowed by the
 * ramp corridors), 6-10 billboard walkers shuffle back and forth across
 * the road exactly on the painted zebra bands (band center 10.1 units off
 * the intersection center, matching RoadNetwork's crosswalk layout).
 *
 * Each walker is one instance of a single InstancedMesh — 1 draw call:
 *  - Geometry: a camera-billboarded plane (origin at the feet).
 *  - Texture: one canvas atlas, 2 columns (leg frames) x 3 rows (body
 *    variants), white silhouettes tinted per-instance via instanceColor.
 *  - Per-instance atlas cell selection via a small shader patch that adds
 *    an `aUvOff` attribute onto vMapUv; the column flips as the walker
 *    steps, giving a cheap 2-frame walk cycle.
 *
 * Ground Y follows the curb profile (road surface -> sidewalk top), so
 * walkers step up/down at the curb instead of floating. If the player car
 * closes within SCATTER_DIST while moving faster than SCATTER_KMH, walkers
 * jump back to the sidewalk edge — the car never visibly plows a person.
 */

/* ------------------------------------------------------------------ *
 *  Tuned constants (match RoadNetwork's layout)
 * ------------------------------------------------------------------ */

/** Sidewalk centerline offset from a road center (5 half-road + 1.5). */
const HALF_PATH = 6.5;
/** Crosswalk band center offset from the intersection center. */
const CROSSWALK_BAND = 10.1;
/** Full crossing length. */
const PATH_LEN = HALF_PATH * 2;

/** Surface heights under the feet (RoadNetwork: sidewalk top 0.15). */
const SIDEWALK_Y = 0.15;
const ROAD_Y = 0.04;

/** Walker speed range (units/second). */
const SPEED_MIN = 1.1;
const SPEED_RANGE = 0.9;
/** Stride length for the 2-frame leg swap. */
const STRIDE = 0.55;
/** Wait time range between crossings. */
const WAIT_MIN = 1.5;
const WAIT_RANGE = 4;

/** Scatter trigger: closer than this AND faster than this. */
const SCATTER_DIST_SQ = 7 * 7;
const SCATTER_KMH = 15;

/** Muted Tokyo crowd palette (tints the white silhouette). */
const TINTS = ["#ddd8ce", "#b0433a", "#33415a", "#c8a04a", "#687a66", "#3a3a40"];

/* ------------------------------------------------------------------ *
 *  Walker silhouette atlas (canvas-generated)
 * ------------------------------------------------------------------ */

const ATLAS_COLS = 2; // leg frames
const ATLAS_ROWS = 3; // body variants
const CELL_W = 128;
const CELL_H = 240;

/**
 * Draw one flat person silhouette into an atlas cell: head, shoulder/arms,
 * body, legs. Frame 0 = legs apart, frame 1 = legs together. Everything is
 * pure white — instanceColor supplies the clothing tint.
 */
function drawWalker(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  variant: number,
  frame: number,
): void {
  const cx = ox + CELL_W / 2;
  ctx.fillStyle = "#ffffff";

  // Head.
  const headR = variant === 2 ? 10 : 11;
  ctx.beginPath();
  ctx.arc(cx, oy + 28, headR, 0, Math.PI * 2);
  ctx.fill();

  // Arms (read as shoulder width).
  ctx.fillRect(cx - 27, oy + 50, 9, 56);
  ctx.fillRect(cx + 18, oy + 50, 9, 56);

  const legs = (topY: number, botY: number, spread: number, w: number): void => {
    const off = frame === 0 ? spread : spread * 0.35;
    ctx.fillRect(cx - off - w, oy + topY, w, botY - topY);
    ctx.fillRect(cx + off - w + 1, oy + topY, w, botY - topY);
  };

  if (variant === 1) {
    // Dress/skirt.
    ctx.fillRect(cx - 16, oy + 44, 32, 62);
    ctx.beginPath();
    ctx.moveTo(cx - 19, oy + 100);
    ctx.lineTo(cx + 19, oy + 100);
    ctx.lineTo(cx + 24, oy + 168);
    ctx.lineTo(cx - 24, oy + 168);
    ctx.closePath();
    ctx.fill();
    legs(166, 224, 7, 10);
  } else if (variant === 2) {
    // Long coat.
    ctx.fillRect(cx - 21, oy + 42, 42, 146);
    legs(186, 224, 6, 11);
  } else {
    // Standard jacket + pants.
    ctx.fillRect(cx - 18, oy + 44, 36, 74);
    legs(116, 228, 9, 13);
  }
}

function makeWalkerAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = CELL_W * ATLAS_COLS;
  canvas.height = CELL_H * ATLAS_ROWS;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let row = 0; row < ATLAS_ROWS; row++) {
    for (let col = 0; col < ATLAS_COLS; col++) {
      drawWalker(ctx, col * CELL_W, row * CELL_H, row, col);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ *
 *  Walker simulation state
 * ------------------------------------------------------------------ */

interface Walker {
  /** Home intersection. */
  cx: number;
  cz: number;
  /** 0 = crossing the NS road (walking along X), 1 = crossing EW (along Z). */
  axis: 0 | 1;
  /** Which zebra band (+/-1). */
  band: 1 | -1;
  /** Travel direction along the movement axis (+/-1). */
  dir: 1 | -1;
  /** Some walkers take the perpendicular crosswalk on their return trip. */
  switches: boolean;
  mode: 0 | 1; // 0 waiting, 1 crossing
  timer: number;
  dist: number;
  speed: number;
  /** Atlas row (body variant), fixed per walker. */
  row: number;
  /** Per-walker random phase in [0,1), keeps timing loops deterministic. */
  jitter: number;
}

/** Current planar position of a walker (into out). */
function walkerXZ(w: Walker, out: { x: number; z: number }): number {
  const u = w.dir * (w.dist - HALF_PATH);
  if (w.axis === 0) {
    out.x = w.cx + u;
    out.z = w.cz + w.band * CROSSWALK_BAND;
  } else {
    out.x = w.cx + w.band * CROSSWALK_BAND;
    out.z = w.cz + u;
  }
  return Math.abs(u);
}

/* Scratch objects shared across frames. */
const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _xz = { x: 0, z: 0 };

/* ------------------------------------------------------------------ *
 *  Component
 * ------------------------------------------------------------------ */

export function Pedestrians() {
  const dayRef = useDayNightState();
  const meshRef = useRef<THREE.InstancedMesh>(null);

  const { walkers, geometry, texture, uvOffsets } = useMemo(() => {
    const list: Walker[] = [];

    for (const cx of CITY_NS_ROADS) {
      for (const cz of CITY_EW_ROADS) {
        // Player spawn intersection stays empty.
        if (cx === 0 && cz === 120) continue;
        // Bridge-foot intersections: their crosswalks sit inside the ramp
        // corridors, so keep crowds off them.
        if (cz < 60 && (Math.abs(cx - 50) < 14 || Math.abs(cx + 48) < 14)) continue;

        // Bank intersections (z=20): everything south of the road is river,
        // so crowds only cross the NS road on its north crosswalk.
        const bank = cz === 20;

        const siteRng = makeRng(hashSeed(Math.round(cx * 3 + 7), Math.round(cz * 5 + 11)));
        const count = 6 + Math.floor(siteRng() * 5); // 6..10
        for (let i = 0; i < count; i++) {
          list.push({
            cx,
            cz,
            axis: bank ? 0 : siteRng() < 0.5 ? 0 : 1,
            band: bank ? 1 : siteRng() < 0.5 ? 1 : -1,
            dir: siteRng() < 0.5 ? 1 : -1,
            switches: !bank && siteRng() < 0.35,
            mode: 0,
            timer: siteRng() * WAIT_RANGE,
            dist: 0,
            speed: SPEED_MIN + siteRng() * SPEED_RANGE,
            row: Math.floor(siteRng() * ATLAS_ROWS) % ATLAS_ROWS,
            jitter: siteRng(),
          });
        }
      }
    }

    // Plane facing +Z with its origin at the feet.
    const geo = new THREE.PlaneGeometry(0.95, 1.75);
    geo.translate(0, 0.875, 0);

    const tex = makeWalkerAtlas();

    const offs = new Float32Array(list.length * 2);
    return { walkers: list, geometry: geo, texture: tex, uvOffsets: offs };
  }, []);

  useFrame((state, rawDt) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dt = Math.min(rawDt, 0.05);
    const dn = dayRef.current;

    const cam = state.camera;
    const mat = mesh.material as THREE.MeshBasicMaterial;

    // Crowd brightness keys off windowGlow (night factor): slightly dimmed
    // and warm-shifted so white silhouettes don't glow like lamps.
    const k = 1 - dn.windowGlow * 0.45;
    mat.color.setRGB(k, k * 0.985, k * 0.96);

    const playerFast = runtime.carSpeedKmh > SCATTER_KMH;

    for (let i = 0; i < walkers.length; i++) {
      const w = walkers[i];

      if (w.mode === 0) {
        w.timer -= dt;
        if (w.timer <= 0) {
          // Return trip; some walkers take the perpendicular crosswalk.
          if (w.switches) {
            w.axis = w.axis === 0 ? 1 : 0;
            w.band = w.band === 1 ? -1 : 1;
          }
          w.dist = 0;
          w.mode = 1;
        }
      } else {
        w.dist += w.speed * dt;
        if (w.dist >= PATH_LEN) {
          w.dist = PATH_LEN;
          w.mode = 0;
          w.dir = (w.dir === 1 ? -1 : 1) as 1 | -1;
          w.timer = WAIT_MIN + w.jitter * WAIT_RANGE;
        }

        // Safety scatter: jump back to the nearest sidewalk edge when the
        // player car bears down on the crosswalk.
        const gx = w.axis === 0 ? w.cx + w.dir * (w.dist - HALF_PATH) : w.cx + w.band * CROSSWALK_BAND;
        const gz = w.axis === 0 ? w.cz + w.band * CROSSWALK_BAND : w.cz + w.dir * (w.dist - HALF_PATH);
        const pdx = gx - runtime.carX;
        const pdz = gz - runtime.carZ;
        if (playerFast && pdx * pdx + pdz * pdz < SCATTER_DIST_SQ) {
          const u = w.dir * (w.dist - HALF_PATH);
          w.dist = u >= 0 ? PATH_LEN : 0;
          w.mode = 0;
          w.timer = 1 + w.jitter * 2.5;
        }
      }

      const groundE = walkerXZ(w, _xz);
      // Curb profile: road surface mid-road, sidewalk top past the curb,
      // blended over the curb band so nobody floats or clips.
      const curbK = THREE.MathUtils.smoothstep(groundE, 4.6, 5.5);
      const bob = Math.abs(Math.sin(w.dist * 2.6 / STRIDE)) * 0.045 * (w.mode === 1 ? 1 : 0);
      _pos.set(_xz.x, THREE.MathUtils.lerp(ROAD_Y, SIDEWALK_Y, curbK) + bob, _xz.z);

      // Billboard: face the camera around Y.
      _q.setFromAxisAngle(UP, Math.atan2(cam.position.x - _xz.x, cam.position.z - _xz.z));
      _m.compose(_pos, _q, ONE);
      mesh.setMatrixAt(i, _m);

      // Atlas cell: column flips with the step cycle, row is fixed.
      const frame = w.mode === 1 ? Math.floor(w.dist / STRIDE) % ATLAS_COLS : 0;
      uvOffsets[i * 2] = frame / ATLAS_COLS;
      uvOffsets[i * 2 + 1] = w.row / ATLAS_ROWS;
    }

    mesh.instanceMatrix.needsUpdate = true;
    const attr = mesh.geometry.getAttribute("aUvOff") as THREE.InstancedBufferAttribute;
    attr.needsUpdate = true;
  });

  // Attach the UV-offset attribute + material patch once the mesh exists.
  const initMesh = (mesh: THREE.InstancedMesh | null): void => {
    if (!mesh || mesh.geometry.getAttribute("aUvOff")) return;
    const attr = new THREE.InstancedBufferAttribute(uvOffsets, 2);
    attr.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute("aUvOff", attr);

    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uAtlasCell = { value: new THREE.Vector2(1 / ATLAS_COLS, 1 / ATLAS_ROWS) };
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nattribute vec2 aUvOff;\nuniform vec2 uAtlasCell;",
        )
        .replace(
          "#include <uv_vertex>",
          // Plane UVs are exactly 0..1, so no fract() is needed to keep the
          // scaled UV inside the atlas cell. (fract() here misrenders on
          // ANGLE/Metal — verified — so it must stay out.)
          "#include <uv_vertex>\n#ifdef USE_MAP\n\tvMapUv = vMapUv * uAtlasCell + aUvOff;\n#endif",
        );
    };
    mat.needsUpdate = true;

    // Compose initial matrices so frame zero doesn't flash a pile at origin.
    for (let i = 0; i < walkers.length; i++) {
      walkerXZ(walkers[i], _xz);
      _pos.set(_xz.x, SIDEWALK_Y, _xz.z);
      _q.setFromAxisAngle(UP, 0);
      _m.compose(_pos, _q, ONE);
      mesh.setMatrixAt(i, _m);
      uvOffsets[i * 2] = 0;
      uvOffsets[i * 2 + 1] = walkers[i].row / ATLAS_ROWS;
    }
    mesh.instanceMatrix.needsUpdate = true;
    attr.needsUpdate = true;
  };

  const tintColor = useMemo(() => new THREE.Color(), []);
  const initTints = (mesh: THREE.InstancedMesh | null): void => {
    if (!mesh || mesh.instanceColor) return;
    const rng = makeRng(hashSeed(20260824, 808));
    const colors = new Float32Array(walkers.length * 3);
    for (let i = 0; i < walkers.length; i++) {
      tintColor.set(TINTS[Math.floor(rng() * TINTS.length)]);
      colors[i * 3] = tintColor.r;
      colors[i * 3 + 1] = tintColor.g;
      colors[i * 3 + 2] = tintColor.b;
    }
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
  };

  return (
    <instancedMesh
      ref={(m) => {
        meshRef.current = m;
        initMesh(m);
        initTints(m);
      }}
      args={[geometry, undefined, walkers.length]}
      frustumCulled={false}
    >
      <meshBasicMaterial map={texture} alphaTest={0.4} transparent={false} />
    </instancedMesh>
  );
}
