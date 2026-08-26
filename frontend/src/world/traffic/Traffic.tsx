import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  CITY_EW_ROADS,
  CITY_NS_ROADS,
  TOWN_EW_ROADS,
  TOWN_NS_ROADS,
} from "../constants";
import { useDayNightState } from "../DayNight";
import { hashSeed, makeRng } from "../CityDistrict";
import { groundHeight } from "../groundHeight";
import { runtime } from "../runtime";

/**
 * Traffic — ambient AI cars driving the city + town road grids.
 *
 * Purely visual: no physics, no player collision. Cars follow road
 * centerlines with a right-hand lane offset, choose straight/left/right
 * at intersections, and cross the river only on the two bridge corridors
 * (city NS road x=50 and town NS road x=-48 — the grid wiring makes any
 * other approach impossible). Height comes from groundHeight() so bridge
 * crossings climb the deck exactly like the player's car does.
 *
 * Rendering is 3 draw calls total:
 *   1. One InstancedMesh of merged box cars (body + cabin + tire strip)
 *      with baked vertex colors; per-instance body paint via instanceColor
 *      multiplies the white body while keeping glass/tires dark.
 *   2. Headlight quads (HDR warm white, toneMapped=false so bloom catches).
 *   3. Taillight quads (HDR red). Both fade with streetlightIntensity.
 *
 * Cars farther than RECYCLE_DIST from the player teleport onto a road point
 * 120-200 units away so density stays around the action. Placement is
 * seeded (mulberry32 via CityDistrict.makeRng), so initial layout is
 * identical every reload.
 */

/* ------------------------------------------------------------------ *
 *  Tuned constants
 * ------------------------------------------------------------------ */

/** Number of AI cars. */
const CAR_COUNT = 24;
/** Right-hand lane offset from the road centerline. */
const LANE_OFFSET = 2.2;
/** Car speed range (units/second), constant per car. */
const SPEED_MIN = 8;
const SPEED_MAX = 14;
/** Beyond this distance from the player a car teleports closer. */
const RECYCLE_DIST = 260;
/** Respawn band: fresh road points sit this far from the player. */
const RESPAWN_MIN = 120;
const RESPAWN_MAX = 200;
/** Never place a car within this radius of the player spawn (0,120). */
const SPAWN_KEEP_OUT = 15;
/** Minimum gap between cars at spawn time. */
const SPAWN_GAP = 12;

/** Body palette: Tokyo street mix including one taxi yellow. */
const BODY_COLORS = ["#e6e8ea", "#9aa2ac", "#b83636", "#24406e", "#d9a022"];

const UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);

/* ------------------------------------------------------------------ *
 *  Road graph
 * ------------------------------------------------------------------ */

interface GNode {
  x: number;
  z: number;
  out: GEdge[];
}

/** A directed straight segment. Two-way roads register both directions. */
interface GEdge {
  a: GNode;
  b: GNode;
  len: number;
}

function buildRoadGraph(): { edges: GEdge[]; nearEdges: GEdge[] } {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const nearEdges: GEdge[] = [];
  const map = new Map<string, GNode>();

  const node = (x: number, z: number): GNode => {
    const key = `${x}|${z}`;
    let n = map.get(key);
    if (!n) {
      n = { x, z, out: [] };
      map.set(key, n);
      nodes.push(n);
    }
    return n;
  };

  const dir = (a: GNode, b: GNode): void => {
    const e: GEdge = { a, b, len: Math.hypot(b.x - a.x, b.z - a.z) };
    edges.push(e);
    // City-side edges (incl. bridge corridors) form the high-traffic pool.
    if ((a.z + b.z) / 2 > -20) nearEdges.push(e);
    a.out.push(e);
  };

  const link = (ax: number, az: number, bx: number, bz: number): void => {
    const a = node(ax, az);
    const b = node(bx, bz);
    dir(a, b);
    dir(b, a);
  };

  // --- City grid ---
  const cityNs = [...CITY_NS_ROADS].sort((p, q) => p - q);
  const cityEw = [...CITY_EW_ROADS].sort((p, q) => p - q);
  for (const x of cityNs) {
    for (let i = 0; i < cityEw.length - 1; i++) {
      link(x, cityEw[i], x, cityEw[i + 1]);
    }
    // South stub, capped so cars stay near the action.
    link(x, cityEw[cityEw.length - 1], x, 260);
  }
  for (const z of cityEw) {
    for (let i = 0; i < cityNs.length - 1; i++) {
      link(cityNs[i], z, cityNs[i + 1], z);
    }
    // East/west stubs (capped; the roads themselves run wider).
    link(-200, z, cityNs[0], z);
    link(cityNs[cityNs.length - 1], z, 200, z);
  }

  // --- Town grid ---
  const townNs = [...TOWN_NS_ROADS].sort((p, q) => p - q);
  const townEw = [...TOWN_EW_ROADS].sort((p, q) => p - q);
  for (const x of townNs) {
    for (let i = 0; i < townEw.length - 1; i++) {
      link(x, townEw[i], x, townEw[i + 1]);
    }
    // North stub, capped before the race track so cars stay central.
    link(x, townEw[0], x, -220);
    // Bank stub: every town NS road runs down to the river bank at z=-20.
    link(x, townEw[townEw.length - 1], x, -20);
  }
  for (const z of townEw) {
    for (let i = 0; i < townNs.length - 1; i++) {
      link(townNs[i], z, townNs[i + 1], z);
    }
    link(-200, z, townNs[0], z);
    link(townNs[townNs.length - 1], z, 200, z);
  }

  // --- Bridge corridors (only these lines reach across the river) ---
  // Modern bridge: city NS road x=50 lands on the town grid at (48,-40),
  // drifting 2 units west over the 60-unit span (reads as lane keeping).
  link(50, 20, 48, -40);
  // Steel truss bridge: town NS road x=-48 lands on the city grid at
  // (-50,20), right at the bank-road intersection.
  link(-48, -20, -50, 20);

  return { edges, nearEdges };
}

/* ------------------------------------------------------------------ *
 *  Car state + sampling helpers
 * ------------------------------------------------------------------ */

interface Car {
  edge: GEdge;
  /** Distance traveled along the current edge. */
  d: number;
  speed: number;
  /** Smoothed visual heading (radians; forward +Z at yaw 0). */
  yaw: number;
}

interface Spot {
  edge: GEdge;
  d: number;
  x: number;
  z: number;
}

/**
 * Find a legal spawn point: on a road, outside the river band, within the
 * requested distance ring around (refX,refZ), clear of the world spawn,
 * and not stacked on another car. Picks the candidate closest to the ring
 * center; returns null after 60 tries.
 */
function findSpot(
  edges: GEdge[],
  rng: () => number,
  refX: number,
  refZ: number,
  minD: number,
  maxD: number,
  placed: Spot[],
): Spot | null {
  let best: Spot | null = null;
  let bestScore = Infinity;
  const midD = (minD + maxD) / 2;
  for (let tryI = 0; tryI < 60; tryI++) {
    const edge = edges[Math.floor(rng() * edges.length)];
    const d = rng() * edge.len;
    const t = d / edge.len;
    const cx = edge.a.x + (edge.b.x - edge.a.x) * t;
    const cz = edge.a.z + (edge.b.z - edge.a.z) * t;
    // Right-hand lane offset: right of travel direction is (-dz, dx).
    const dxn = (edge.b.x - edge.a.x) / edge.len;
    const dzn = (edge.b.z - edge.a.z) / edge.len;
    const x = cx - dzn * LANE_OFFSET;
    const z = cz + dxn * LANE_OFFSET;

    const distRef = Math.hypot(x - refX, z - refZ);
    if (distRef < minD || distRef > maxD) continue;
    // Never on/near the water: skip points in the river band unless they
    // sit inside one of the two bridge corridors.
    if (Math.abs(z) < 30 && Math.abs(x - 50) > 9 && Math.abs(x + 48) > 9) continue;
    if (Math.hypot(x, z - 120) < SPAWN_KEEP_OUT) continue;
    let clear = true;
    for (const p of placed) {
      if (Math.hypot(p.x - x, p.z - z) < SPAWN_GAP) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;

    const score = Math.abs(distRef - midD);
    if (score < bestScore) {
      bestScore = score;
      best = { edge, d, x, z };
      if (tryI > 24) break; // good enough — don't burn the RNG stream
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 *  Merged low-poly car geometry (vertex-colored; instanceColor tints it)
 * ------------------------------------------------------------------ */

/** Non-indexed copy of `geo` with every vertex set to a constant RGB. */
function fillVertexColor(
  geo: THREE.BufferGeometry,
  r: number,
  g: number,
  b: number,
): THREE.BufferGeometry {
  const g2 = geo.toNonIndexed();
  g2.deleteAttribute("uv");
  const n = g2.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = r;
    arr[i * 3 + 1] = g;
    arr[i * 3 + 2] = b;
  }
  g2.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g2;
}

/**
 * One merged geometry per silhouette: white body (instanceColor supplies
 * the paint), dark glass cabin, near-black tire strip implied at the base.
 * Forward is +Z. Vertex colors multiply instanceColor in the shader, so
 * glass and tires stay dark under any paint.
 */
function buildCarGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(1.9, 0.55, 4.3);
  body.translate(0, 0.62, 0);
  const cabin = new THREE.BoxGeometry(1.62, 0.5, 2.05);
  cabin.translate(0, 1.14, -0.35);
  const tires = new THREE.BoxGeometry(2.02, 0.28, 3.5);
  tires.translate(0, 0.14, 0);

  const parts = [
    fillVertexColor(body, 1, 1, 1),
    fillVertexColor(cabin, 0.16, 0.19, 0.24),
    fillVertexColor(tires, 0.05, 0.05, 0.06),
  ];
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error("Traffic: car geometry merge failed");
  return merged;
}

/* Shared light quad + scratch objects (module scope, allocated once). */
const LIGHT_GEO = new THREE.PlaneGeometry(0.38, 0.22);
const ONE = new THREE.Vector3(1, 1, 1);
const FLIP_Y = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qf = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _off = new THREE.Vector3();

/* ------------------------------------------------------------------ *
 *  Component
 * ------------------------------------------------------------------ */

export function Traffic() {
  const dayRef = useDayNightState();

  const bodyRef = useRef<THREE.InstancedMesh>(null);
  const headRef = useRef<THREE.InstancedMesh>(null);
  const tailRef = useRef<THREE.InstancedMesh>(null);

  const edges = useMemo(buildRoadGraph, []);
  const carGeo = useMemo(buildCarGeometry, []);
  const palette = useMemo(() => BODY_COLORS.map((c) => new THREE.Color(c)), []);

  // Deterministic initial placement (seeded once per mount).
  const sim = useMemo(() => {
    const rng = makeRng(hashSeed(20260824, 77));
    const cars: Car[] = [];
    const placed: Spot[] = [];
    for (let i = 0; i < CAR_COUNT; i++) {
      const spot =
        findSpot(edges, rng, runtime.carX, runtime.carZ, 30, 240, placed) ??
        findSpot(edges, rng, runtime.carX, runtime.carZ, 20, 260, placed);
      if (!spot) continue;
      placed.push(spot);
      cars.push({
        edge: spot.edge,
        d: spot.d,
        speed: SPEED_MIN + rng() * (SPEED_MAX - SPEED_MIN),
        yaw: Math.atan2(
          spot.edge.b.x - spot.edge.a.x,
          spot.edge.b.z - spot.edge.a.z,
        ),
      });
    }
    return { rng, cars };
  }, [edges]);

  useFrame((_state, rawDt) => {
    const body = bodyRef.current;
    const head = headRef.current;
    const tail = tailRef.current;
    if (!body || !head || !tail) return;

    const dt = Math.min(rawDt, 0.05);
    const nightK = dayRef.current.streetlightIntensity;
    const { rng, cars } = sim;

    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];

      // Advance; hand over to a random non-reverse edge at each node.
      car.d += car.speed * dt;
      let hops = 0;
      let deadEnd = false;
      while (car.d >= car.edge.len && hops++ < 4) {
        const arrived = car.edge.b;
        const prev = car.edge.a;
        const opts = arrived.out.filter((e) => e.b !== prev);
        if (opts.length === 0) {
          deadEnd = true;
          break;
        }
        const next = opts[Math.floor(rng() * opts.length)];
        car.d -= car.edge.len;
        car.edge = next;
      }

      // Recycle dead ends and cars that drifted far from the player.
      let far = false;
      if (!deadEnd) {
        const ce = car.edge;
        const ct = Math.min(car.d / ce.len, 1);
        const px = ce.a.x + (ce.b.x - ce.a.x) * ct - runtime.carX;
        const pz = ce.a.z + (ce.b.z - ce.a.z) * ct - runtime.carZ;
        far = px * px + pz * pz > RECYCLE_DIST * RECYCLE_DIST;
      }

      if (deadEnd || far) {
        const spot =
          findSpot(edges, rng, runtime.carX, runtime.carZ, RESPAWN_MIN, RESPAWN_MAX, []) ??
          findSpot(edges, rng, runtime.carX, runtime.carZ, 90, 240, []);
        if (spot) {
          car.edge = spot.edge;
          car.d = spot.d;
          car.speed = SPEED_MIN + rng() * (SPEED_MAX - SPEED_MIN);
          car.yaw = Math.atan2(
            spot.edge.b.x - spot.edge.a.x,
            spot.edge.b.z - spot.edge.a.z,
          );
        }
        // No free spot: keep the old position this frame and retry later.
      }

      // Position on the centerline + right-hand lane offset.
      const e = car.edge;
      const t = Math.min(car.d / e.len, 1);
      const cx = e.a.x + (e.b.x - e.a.x) * t;
      const cz = e.a.z + (e.b.z - e.a.z) * t;
      const len = e.len;
      const dxn = (e.b.x - e.a.x) / len;
      const dzn = (e.b.z - e.a.z) / len;
      const lx = cx - dzn * LANE_OFFSET;
      const lz = cz + dxn * LANE_OFFSET;

      // Heading smoothing turns the instant grid snap into a tight corner.
      const targetYaw = Math.atan2(dxn, dzn);
      let dyaw = targetYaw - car.yaw;
      dyaw = (((dyaw + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      car.yaw += dyaw * Math.min(1, dt * 9);

      _pos.set(lx, groundHeight(lx, lz), lz);
      _q.setFromAxisAngle(UP, car.yaw);
      _m.compose(_pos, _q, ONE);
      body.setMatrixAt(i, _m);

      // Twin light quads front (white) and rear (red), facing outward.
      _qf.multiplyQuaternions(_q, FLIP_Y);
      for (let s = -1; s <= 1; s += 2) {
        const li = i * 2 + (s > 0 ? 1 : 0);
        _off.set(0.62 * s, 0.58, 2.16).applyQuaternion(_q).add(_pos);
        _m.compose(_off, _q, ONE);
        head.setMatrixAt(li, _m);
        _off.set(0.62 * s, 0.72, -2.16).applyQuaternion(_q).add(_pos);
        _m.compose(_off, _qf, ONE);
        tail.setMatrixAt(li, _m);
      }
    }

    body.instanceMatrix.needsUpdate = true;
    head.instanceMatrix.needsUpdate = true;
    tail.instanceMatrix.needsUpdate = true;

    // Night lights fade with the streetlights; HDR colors bloom at night.
    const headMat = head.material as THREE.MeshBasicMaterial;
    const tailMat = tail.material as THREE.MeshBasicMaterial;
    headMat.opacity = nightK;
    tailMat.opacity = nightK;
    head.visible = nightK > 0.02;
    tail.visible = nightK > 0.02;
  });

  // Assign body paints once (kept across respawns). Written as one
  // InstancedBufferAttribute so the shader picks up USE_INSTANCING_COLOR.
  const initColors = (mesh: THREE.InstancedMesh | null): void => {
    if (!mesh || mesh.instanceColor) return;
    const rng = makeRng(hashSeed(20260824, 991));
    const colors = new Float32Array(CAR_COUNT * 3);
    const c = new THREE.Color();
    for (let i = 0; i < CAR_COUNT; i++) {
      c.set(palette[Math.floor(rng() * palette.length)]);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
  };

  return (
    <group>
      {/* All car bodies: 1 draw call, per-instance paint. */}
      <instancedMesh
        ref={(m) => {
          bodyRef.current = m;
          initColors(m);
        }}
        args={[carGeo, undefined, CAR_COUNT]}
        castShadow
        frustumCulled={false}
      >
        <meshStandardMaterial vertexColors roughness={0.5} metalness={0.15} />
      </instancedMesh>

      {/* Headlights — HDR warm white, toneMapped=false so bloom catches. */}
      <instancedMesh
        ref={headRef}
        args={[LIGHT_GEO, undefined, CAR_COUNT * 2]}
        frustumCulled={false}
      >
        <meshBasicMaterial
          color={[2.6, 2.4, 1.9]}
          toneMapped={false}
          transparent
          opacity={0}
          depthWrite={false}
        />
      </instancedMesh>

      {/* Taillights — HDR red. */}
      <instancedMesh
        ref={tailRef}
        args={[LIGHT_GEO, undefined, CAR_COUNT * 2]}
        frustumCulled={false}
      >
        <meshBasicMaterial
          color={[3.0, 0.18, 0.12]}
          toneMapped={false}
          transparent
          opacity={0}
          depthWrite={false}
        />
      </instancedMesh>
    </group>
  );
}
