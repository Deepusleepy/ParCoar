import { Suspense, useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Text, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { LotData, LotEdge, NodeType } from "../types";
import { useKeyboard } from "../hooks/useKeyboard";
import { rampPoints, semicirclePoints } from "./geometry";
import {
  AISLE_SPACING,
  CAR_Y_OFFSET,
  FLOOR_HEIGHT,
  LANE_WIDTH,
  ROAD_WIDTH,
  SLOT_DEPTH,
  SLOT_WIDTH,
  toWorld,
} from "./constants";

/** Key under which the drivable car registers itself in the shared carGroups map. */
export const PLAYER_CAR_KEY = "player";

/** Shared ref shape for communicating live speed to the HUD. */
export interface PlayerSpeedRef {
  speed: number;
}

/** World-space position of a parked car, for collision checks. */
export interface ParkedCarPos {
  x: number;
  y: number;
  z: number;
}

interface DrivableCarProps {
  lot: LotData;
  /** Shared map (id -> Group) that the camera rig reads for follow/POV. */
  carGroupsRef: React.MutableRefObject<Map<string, THREE.Group>>;
  /** Optional ref to publish live speed for the HUD. */
  speedRef?: React.MutableRefObject<PlayerSpeedRef>;
  /** Parked car world positions for collision avoidance. */
  parkedCars: ParkedCarPos[];
  /** Road centerline segments for road-edge clamping (guardrails/dividers). */
  roadSegments: RoadSegment[];
  /** When true the camera is inside the car (POV mode); the exterior GLTF
   *  body is hidden so its opaque panels don't block the cockpit view. The
   *  procedural CarInterior provides the visible dashboard/seats/wheel. */
  pov?: boolean;
}

/* ------------------------------------------------------------------ *
 *  Driving physics tuning
 * ------------------------------------------------------------------ */
const ACCEL_RATE = 12; // units/sec^2 when pressing W
const BRAKE_RATE = 28; // units/sec^2 when pressing S
const MAX_SPEED = 9; // forward speed cap (parking-appropriate)
const MAX_REVERSE = MAX_SPEED / 2; // reverse speed cap
const TURN_RATE = 1.6; // rad/sec at full steering
const FRICTION = 0.97; // velocity decay per frame when coasting (at 60fps)
const DRAG = 0.006; // quadratic drag — creates natural acceleration curve
const STEER_SPEED = 4.0; // how fast steering angle ramps (rad/sec)
const STEER_RETURN = 5.0; // how fast steering returns to center (rad/sec)
const MAX_STEER_ANGLE = 0.55; // max steering angle (~31°)
const GRIP = 0.88; // lateral grip: 1 = on rails, 0 = ice (0.85-0.92 sweet spot)
const ROLLING_RESISTANCE = 0.4; // drag while throttling (prevents linear accel)

/** Height of the road surface above the floor slab top (mirrors ParkingLot). */
const ROAD_Y = 0.15;

/** Lane shift to the right of the travel direction (mirrors paths.ts). */
const LANE_SHIFT = -LANE_WIDTH / 2;

/* ------------------------------------------------------------------ *
 *  Ramp curve precomputation
 * ------------------------------------------------------------------ */
interface RampCurve {
  /** Sampled centerline points (raw, no lane offset). */
  points: THREE.Vector3[];
  /** Floor the ramp starts on (ramp_up node's floor). */
  fromFloor: number;
  /** Floor the ramp ends on (ramp_in node's floor). */
  toFloor: number;
}

/** Distance from point (px,pz) to segment (a→b) in the XZ plane. */
function distToSegment2D(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-6) return Math.hypot(px - ax, pz - az);
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** Closest point on segment (a→b) to point (px,pz) in the XZ plane. */
function closestPointOnSegment2D(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): [number, number] {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-6) return [ax, az];
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return [ax + t * dx, az + t * dz];
}

/** Build a sampled centerline + from/to floors for every ramp_up -> ramp_in edge. */
function buildRampCurves(lot: LotData): RampCurve[] {
  const curves: RampCurve[] = [];
  for (const [fromId, edges] of Object.entries(lot.edges)) {
    const from = lot.nodes[fromId];
    if (!from || from.type !== "ramp_up") continue;
    for (const edge of edges as LotEdge[]) {
      if (edge.dir !== "up") continue;
      const to = lot.nodes[edge.to];
      if (!to || to.type !== "ramp_in") continue;
      const fromW = toWorld(from.x, from.y, from.floor);
      const toW = toWorld(to.x, to.y, to.floor);
      const pts = rampPoints(fromW, toW);
      curves.push({
        points: pts,
        fromFloor: from.floor,
        toFloor: to.floor,
      });
    }
  }
  return curves;
}

/* ------------------------------------------------------------------ *
 *  Road centerline segments (for road-edge clamping)
 * ------------------------------------------------------------------ */

/** A road centerline segment in world XZ coordinates, on a specific floor. */
export interface RoadSegment {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  floor: number;
}

/** Parse the aisle index from a junction id "J{floor}_{aisle}_{n}". */
function aisleOf(id: string): number | null {
  const m = id.match(/^J\d+_(\d+)_\d+$/);
  return m ? Number(m[1]) : null;
}

/** Build road centerline segments from the lot graph for road-edge clamping.
 *  Includes aisle centerlines and turn semicircle paths. Ramps are excluded
 *  (they have their own edge clamp in the DrivableCar useFrame loop). */
export function buildRoadSegments(lot: LotData): RoadSegment[] {
  const segs: RoadSegment[] = [];
  const nodes = lot.nodes;

  // --- Aisles: group junctions by (floor, aisle) ---
  const aisleMap = new Map<string, { floor: number; y: number; xs: number[] }>();
  for (const [id, node] of Object.entries(nodes)) {
    if (node.type !== "junction") continue;
    const aisle = aisleOf(id);
    if (aisle === null) continue;
    const key = `${node.floor}:${aisle}`;
    const entry = aisleMap.get(key) ?? { floor: node.floor, y: node.y, xs: [] };
    entry.xs.push(node.x);
    aisleMap.set(key, entry);
  }
  // Include entry/exit/ramp nodes that sit on an aisle centreline so the
  // road segment covers the gap between the first junction and the portal.
  const connectionTypes = new Set<NodeType>(["entry", "exit", "ramp_up", "ramp_in"]);
  for (const node of Object.values(nodes)) {
    if (!connectionTypes.has(node.type)) continue;
    const aisle = Math.round(node.y / AISLE_SPACING);
    const entry = aisleMap.get(`${node.floor}:${aisle}`);
    if (entry) entry.xs.push(node.x);
  }
  for (const { floor, y, xs } of aisleMap.values()) {
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    segs.push({ x1: x0, z1: y, x2: x1, z2: y, floor });
  }

  // --- Turns: semicircle paths (where guardrails are) ---
  const incomingOf = new Map<string, string>();
  for (const [fromId, edgeList] of Object.entries(lot.edges)) {
    for (const edge of edgeList) {
      const target = nodes[edge.to];
      if (target?.type === "turn") incomingOf.set(edge.to, fromId);
    }
  }
  for (const [id, node] of Object.entries(nodes)) {
    if (node.type !== "turn") continue;
    const inId = incomingOf.get(id);
    const outId = lot.edges[id]?.[0]?.to;
    const a = inId ? nodes[inId] : undefined;
    const b = outId ? nodes[outId] : undefined;
    if (!a || !b) continue;
    const bulgeDir = node.x >= a.x ? 1 : -1;
    const semi = semicirclePoints(node.x, a.y, b.y, bulgeDir, node.floor);
    for (let i = 0; i < semi.length - 1; i++) {
      segs.push({
        x1: semi[i].x,
        z1: semi[i].z,
        x2: semi[i + 1].x,
        z2: semi[i + 1].z,
        floor: node.floor,
      });
    }
  }

  return segs;
}

/** Find the Y of the nearest centerline point to a given XZ position.
 *  Projects the car position onto the nearest segment of the ramp centerline
 *  and linearly interpolates Y along that segment for smooth height follow. */
function rampHeightAt(curve: RampCurve, x: number, z: number): number {
  const pts = curve.points;
  let bestI = 0;
  let bestDistSq = Infinity;
  let bestT = 0;
  // Find the nearest segment (i, i+1) by computing the distance from the
  // car position to each segment, then interpolate Y along that segment.
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x, az = pts[i].z;
    const bx = pts[i + 1].x, bz = pts[i + 1].z;
    const dx = bx - ax, dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    let t = lenSq < 1e-6 ? 0 : ((x - ax) * dx + (z - az) * dz) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, pz = az + t * dz;
    const d = (px - x) ** 2 + (pz - z) ** 2;
    if (d < bestDistSq) {
      bestDistSq = d;
      bestI = i;
      bestT = t;
    }
  }
  const p0 = pts[bestI];
  const p1 = pts[bestI + 1] ?? p0;
  return p0.y + (p1.y - p0.y) * bestT;
}

/** Compute the pitch angle (rotation about the car's local X axis) that
 *  matches the ramp slope at a given XZ position. Samples the ramp height
 *  at the car position and a small look-ahead point along the heading,
 *  then returns the arctangent of the height difference over the distance. */
function rampPitchAt(
  curve: RampCurve,
  x: number,
  z: number,
  heading: number,
  lookAhead: number,
): number {
  const pts = curve.points;
  // Find nearest segment index + t (reuse the same projection logic).
  let bestI = 0;
  let bestT = 0;
  let bestDistSq = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x, az = pts[i].z;
    const bx = pts[i + 1].x, bz = pts[i + 1].z;
    const dx = bx - ax, dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    let t = lenSq < 1e-6 ? 0 : ((x - ax) * dx + (z - az) * dz) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, pz = az + t * dz;
    const d = (px - x) ** 2 + (pz - z) ** 2;
    if (d < bestDistSq) {
      bestDistSq = d;
      bestI = i;
      bestT = t;
    }
  }
  // Sample height at current position.
  const p0 = pts[bestI];
  const p1 = pts[bestI + 1] ?? p0;
  const yHere = p0.y + (p1.y - p0.y) * bestT;
  // Sample height at a look-ahead point along the car's heading direction.
  const fwdX = Math.cos(heading);
  const fwdZ = -Math.sin(heading);
  const laX = x + fwdX * lookAhead;
  const laZ = z + fwdZ * lookAhead;
  let yAhead = yHere;
  let bestLaI = 0;
  let bestLaT = 0;
  let bestLaDistSq = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x, az = pts[i].z;
    const bx = pts[i + 1].x, bz = pts[i + 1].z;
    const dx = bx - ax, dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    let t = lenSq < 1e-6 ? 0 : ((laX - ax) * dx + (laZ - az) * dz) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, pz = az + t * dz;
    const d = (px - laX) ** 2 + (pz - laZ) ** 2;
    if (d < bestLaDistSq) {
      bestLaDistSq = d;
      bestLaI = i;
      bestLaT = t;
    }
  }
  const la0 = pts[bestLaI];
  const la1 = pts[bestLaI + 1] ?? la0;
  yAhead = la0.y + (la1.y - la0.y) * bestLaT;
  // Pitch = atan(dy / dx). Positive when climbing (nose up).
  return Math.atan2(yAhead - yHere, lookAhead);
}

/* ------------------------------------------------------------------ *
 *  Lot bounds (mirrors computeBounds in ParkingLot.tsx)
 * ------------------------------------------------------------------ */
interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function computeBounds(lot: LotData): Bounds {
  const structural = Object.values(lot.nodes).filter(
    (n) => !["approach", "entry", "exit"].includes(n.type),
  );
  const xs = structural.map((n) => n.x);
  const ys = structural.map((n) => n.y);
  return {
    minX: Math.min(...xs) - AISLE_SPACING / 2 - 1,
    maxX: Math.max(...xs) + AISLE_SPACING / 2 + 1,
    minZ: Math.min(...ys) - SLOT_DEPTH - 2,
    maxZ: Math.max(...ys) + SLOT_DEPTH + 2,
  };
}

/* ------------------------------------------------------------------ *
 *  Car interior materials (shared, memoised at module scope)
 * ------------------------------------------------------------------ */
const MAT = {
  dash: new THREE.MeshStandardMaterial({ color: "#16181d", roughness: 0.6, metalness: 0.15 }),
  dashTrim: new THREE.MeshStandardMaterial({ color: "#0c0d10", roughness: 0.9, metalness: 0.05 }),
  leather: new THREE.MeshStandardMaterial({ color: "#0a0a0c", roughness: 0.45, metalness: 0.2 }),
  fabric: new THREE.MeshStandardMaterial({ color: "#2a2c33", roughness: 0.85, metalness: 0 }),
  carpet: new THREE.MeshStandardMaterial({ color: "#0e0f12", roughness: 1, metalness: 0 }),
  glass: new THREE.MeshPhysicalMaterial({
    color: "#1a2030",
    metalness: 0,
    roughness: 0.05,
    transparent: true,
    opacity: 0.18,
    ior: 1.45,
    envMapIntensity: 1.5,
  }),
  screen: new THREE.MeshStandardMaterial({
    color: "#061018",
    emissive: new THREE.Color("#1e6fff"),
    emissiveIntensity: 0.55,
    roughness: 0.3,
    metalness: 0.1,
  }),
  tft: new THREE.MeshStandardMaterial({
    color: "#020a12",
    emissive: new THREE.Color("#9fd6ff"),
    emissiveIntensity: 0.7,
    roughness: 0.25,
    metalness: 0.1,
  }),
  chrome: new THREE.MeshStandardMaterial({ color: "#9aa0aa", roughness: 0.25, metalness: 0.9 }),
  // Octavia VRS "Race Blue" performance paint — metallic, glossy.
  bodyPaint: new THREE.MeshStandardMaterial({ color: "#11264f", roughness: 0.3, metalness: 0.6 }),
  bodyDark: new THREE.MeshStandardMaterial({ color: "#0a0c12", roughness: 0.5, metalness: 0.4 }),
  glossBlack: new THREE.MeshStandardMaterial({ color: "#05060a", roughness: 0.35, metalness: 0.5 }),
  chromeTrim: new THREE.MeshStandardMaterial({ color: "#c8ccd4", roughness: 0.2, metalness: 0.95 }),
  tire: new THREE.MeshStandardMaterial({ color: "#0a0a0a", roughness: 0.95, metalness: 0 }),
  rim: new THREE.MeshStandardMaterial({ color: "#b8bdc6", roughness: 0.3, metalness: 0.85 }),
  headlight: new THREE.MeshStandardMaterial({
    color: "#fffbe6",
    emissive: new THREE.Color("#fff4cc"),
    emissiveIntensity: 0.8,
    roughness: 0.2,
  }),
  drl: new THREE.MeshStandardMaterial({
    color: "#eaf6ff",
    emissive: new THREE.Color("#bcdcff"),
    emissiveIntensity: 1.2,
    roughness: 0.2,
  }),
  taillight: new THREE.MeshStandardMaterial({
    color: "#ff2a2a",
    emissive: new THREE.Color("#ff1010"),
    emissiveIntensity: 0.6,
    roughness: 0.3,
  }),
  vrsRed: new THREE.MeshStandardMaterial({
    color: "#e0141b",
    emissive: new THREE.Color("#b80c12"),
    emissiveIntensity: 0.5,
    roughness: 0.4,
    metalness: 0.3,
  }),
  redAccent: new THREE.MeshStandardMaterial({
    color: "#ff1a22",
    emissive: new THREE.Color("#ff0a12"),
    emissiveIntensity: 0.9,
    roughness: 0.4,
  }),
  exhaust: new THREE.MeshStandardMaterial({ color: "#9aa0aa", roughness: 0.4, metalness: 0.7 }),
};

/* ------------------------------------------------------------------ *
 *  Player car GLTF model config
 *  Reuses the same car_sport.glb as the AI "small" cars, but with a
 *  distinct race-red clearcoat so the player car stands out.
 *  Local space: +X = forward, +Y = up, ±Z = width.
 * ------------------------------------------------------------------ */

/** GLTF model path (same asset as AI small cars). */
const PLAYER_MODEL_PATH = "/models/car_sport.glb";

/** Natural model length along Z (from bounding box). */
const PLAYER_MODEL_LENGTH = 3.93;

/** Uniform scale so the model length matches the player car (4.5 units). */
const PLAYER_MODEL_SCALE = 4.5 / PLAYER_MODEL_LENGTH;

/** GLTF cars face +Z; the sim expects +X as forward. Rotate π/2 around Y. */
const PLAYER_FORWARD_ROT = Math.PI / 2;

/** GLTF node names for the wheels — removed from the clone and replaced with
 *  procedural wheels that have animation refs for spin. */
const WHEEL_NODE_NAMES = new Set([
  "SportsCar2_BackWheels_Cylinder.002",
  "SportsCar2_FrontLeftWheel_Cylinder.017",
  "SportsCar2_FrontRightWheel_Cylinder.018",
]);

/** Material names that are NOT body paint (keep as-is from the GLTF). */
const PLAYER_NON_BODY = new Set(["Windows", "Black", "Grey", "Headlights", "TailLights"]);

// Preload so the model is cached before first render.
useGLTF.preload(PLAYER_MODEL_PATH);

/** Procedural wheel positions [x, y, z] in player-car local space (+X fwd). */
const WHEEL_POSITIONS: [number, number, number][] = [
  [1.55, 0.34, 0.82],
  [1.55, 0.34, -0.82],
  [-1.55, 0.34, 0.82],
  [-1.55, 0.34, -0.82],
];

interface CarExteriorProps {
  /** Refs to the 4 wheel spin groups (animated in DrivableCar's useFrame).
   *  Spin is applied as a rotation about the spin group's local Y, which
   *  maps to the axle direction after the axle-orienting parent rotation. */
  wheelRefs: React.MutableRefObject<(THREE.Group | null)[]>;
  /** Refs to the 4 wheel steer groups (outermost; only the front two are
   *  animated). Steering is applied as a rotation about world Y, separate
   *  from the spin group so the two rotations never share an object. */
  steerRefs: React.MutableRefObject<(THREE.Group | null)[]>;
  /** When false the GLTF body mesh is hidden (POV mode — the procedural
   *  interior provides the visible cockpit). Wheels remain visible. */
  bodyVisible?: boolean;
}

/** Loads the GLTF body, removes wheel nodes, recolors with race-red clearcoat. */
function CarExteriorInner({ wheelRefs, steerRefs, bodyVisible = true }: CarExteriorProps) {
  const { scene } = useGLTF(PLAYER_MODEL_PATH);

  const { bodyMat, glassMat, scene: cloned } = useMemo(() => {
    const s = scene.clone();

    // Race-red clearcoat paint — distinct from AI car colours.
    const body = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color("#e0141b"),
      metalness: 0.6,
      roughness: 0.35,
      clearcoat: 1.0,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.2,
    });
    // Tinted transparent glass.
    const glass = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color("#0a0e14"),
      metalness: 0.0,
      roughness: 0.05,
      transparent: true,
      opacity: 0.5,
      ior: 1.45,
      envMapIntensity: 1.5,
    });

    // Remove wheel nodes (replaced by procedural wheels with spin refs).
    const toRemove: THREE.Object3D[] = [];
    s.traverse((obj: THREE.Object3D) => {
      if (WHEEL_NODE_NAMES.has(obj.name)) {
        toRemove.push(obj);
        return;
      }
      if (!(obj instanceof THREE.Mesh)) return;
      obj.castShadow = true;
      obj.receiveShadow = true;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      const replaced = mats.map((m) => {
        if (!(m instanceof THREE.Material)) return m;
        if (m.name === "Windows") return glass;
        if (PLAYER_NON_BODY.has(m.name)) return m; // keep trim / lights
        return body; // everything else = body paint
      });
      obj.material = replaced.length === 1 ? replaced[0] : replaced;
    });
    for (const obj of toRemove) {
      obj.parent?.remove(obj);
    }

    return { bodyMat: body, glassMat: glass, scene: s };
  }, [scene]);

  // Dispose GPU materials when the model unmounts.
  useEffect(() => {
    return () => {
      bodyMat.dispose();
      glassMat.dispose();
    };
  }, [bodyMat, glassMat]);

  // Shared procedural wheel geometry (VRS-style alloy).
  const tireGeo = useMemo(() => new THREE.CylinderGeometry(0.34, 0.34, 0.28, 32), []);
  const rimGeo = useMemo(() => new THREE.CylinderGeometry(0.22, 0.22, 0.3, 28), []);

  // Dispose GPU geometries when the model unmounts.
  useEffect(() => {
    return () => {
      tireGeo.dispose();
      rimGeo.dispose();
    };
  }, [tireGeo, rimGeo]);

  return (
    <group>
      {/* GLTF body — rotated to face +X, scaled to 4.5 length.
          Hidden in POV mode so its opaque panels don't block the cockpit
          view; the procedural CarInterior provides the visible dashboard. */}
      <primitive object={cloned} visible={bodyVisible} rotation={[0, PLAYER_FORWARD_ROT, 0]} scale={PLAYER_MODEL_SCALE} />

      {/* Procedural wheels with spin + steer refs (animated in DrivableCar
          useFrame). Three nested groups keep the three rotations on separate
          objects so Euler coupling can't make the front wheels tumble:
            steer group  — rotates about world Y (front wheels only)
            axle group   — fixed [π/2,0,0], orients the cylinder axle along Z
            spin group   — rotates about local Y (the axle), rolls the wheel */}
      {WHEEL_POSITIONS.map((p, i) => (
        <group key={i} ref={(el) => { steerRefs.current[i] = el; }} position={p}>
          <group rotation={[Math.PI / 2, 0, 0]}>
            <group ref={(el) => { wheelRefs.current[i] = el; }}>
              {/* Tire */}
              <mesh geometry={tireGeo} castShadow>
                <primitive object={MAT.tire} attach="material" />
              </mesh>
              {/* Rim disc */}
              <mesh geometry={rimGeo}>
                <primitive object={MAT.rim} attach="material" />
              </mesh>
              {/* 5 spokes */}
              {Array.from({ length: 5 }).map((_, s) => (
                <mesh key={s} rotation={[0, 0, (s * Math.PI * 2) / 5]}>
                  <boxGeometry args={[0.04, 0.36, 0.05]} />
                  <primitive object={MAT.rim} attach="material" />
                </mesh>
              ))}
            </group>
          </group>
        </group>
      ))}
    </group>
  );
}

/** CarExterior — GLTF body + procedural animated wheels (wrapped in Suspense). */
function CarExterior(props: CarExteriorProps) {
  return (
    <Suspense fallback={null}>
      <CarExteriorInner {...props} />
    </Suspense>
  );
}

/* ------------------------------------------------------------------ *
 *  CarInterior — modern VRS cockpit visible from the POV camera
 *
 *  Local space: +X = forward, +Y = up, -Z = driver side (right-hand
 *  drive, so the driver/steering wheel sit at negative Z).
 * ------------------------------------------------------------------ */
function CarInterior({
  steerRef,
  speedRef,
}: {
  steerRef: React.MutableRefObject<number>;
  /** Ref holding the live forward speed (units/sec) for the speedometer. */
  speedRef: React.MutableRefObject<number>;
}) {
  // (speedRef shape kept as a plain number ref; see DrivableCar for the
  //  PlayerSpeedRef bridge that feeds the external HUD.)
  const wheelRef = useRef<THREE.Group>(null);
  const speedoRef = useRef<THREE.Mesh>(null);
  const smoothSteer = useRef(0);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 30);
    // Smooth the steering wheel rotation toward the live input.
    const target = steerRef.current * 2.2; // exaggerate for visible turn
    smoothSteer.current += (target - smoothSteer.current) * Math.min(1, dt * 12);
    if (wheelRef.current) {
      wheelRef.current.rotation.z = smoothSteer.current;
    }
    // Update the digital speedometer readout on the Virtual Cockpit TFT.
    if (speedoRef.current) {
      const mesh = speedoRef.current as unknown as { text: string };
      const kph = Math.round(Math.abs(speedRef.current) * 10);
      mesh.text = `${kph}`;
    }
  });

  return (
    <group>
      {/* Interior fill light so the cockpit is visible from the POV camera.
          The scene's overhead lights are above the roof, so without this the
          cabin reads as near-black. Low intensity + short range = cabin only. */}
      <pointLight position={[0.3, 1.3, 0]} intensity={6} distance={4} decay={2} color="#dfe8f5" />

      {/* --- Cabin floor carpet --- */}
      <mesh position={[0.1, 0.26, 0]}>
        <boxGeometry args={[3.0, 0.04, 1.5]} />
        <primitive object={MAT.carpet} attach="material" />
      </mesh>

      {/* --- Dashboard top (angled slightly toward windshield) --- */}
      <mesh position={[1.3, 0.95, 0]} rotation={[0, 0, 0.09]}>
        <boxGeometry args={[0.6, 0.22, 1.55]} />
        <primitive object={MAT.dash} attach="material" />
      </mesh>
      {/* Dashboard front lip (toward windshield) */}
      <mesh position={[1.55, 1.06, 0]}>
        <boxGeometry args={[0.1, 0.14, 1.55]} />
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>

      {/* --- Red accent strip along dashboard top --- */}
      <mesh position={[1.42, 1.07, 0]}>
        <boxGeometry args={[0.04, 0.02, 1.4]} />
        <primitive object={MAT.redAccent} attach="material" />
      </mesh>

      {/* --- Virtual Cockpit: wide TFT screen + binnacle hood --- */}
      <mesh position={[1.2, 1.04, -0.42]} rotation={[0, 0, 0.12]}>
        <boxGeometry args={[0.06, 0.25, 0.5]} />
        <primitive object={MAT.tft} attach="material" />
      </mesh>
      {/* Binnacle hood above the TFT */}
      <mesh position={[1.16, 1.18, -0.42]}>
        <boxGeometry args={[0.18, 0.1, 0.56]} />
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>

      {/* --- Digital speedometer on the TFT --- */}
      <Text
        ref={speedoRef}
        position={[1.16, 1.05, -0.42]}
        rotation={[0, -Math.PI / 2, 0]}
        fontSize={0.16}
        color="#9fd6ff"
        anchorX="center"
        anchorY="middle"
      >
        0
      </Text>
      <Text
        position={[1.16, 0.9, -0.42]}
        rotation={[0, -Math.PI / 2, 0]}
        fontSize={0.05}
        color="#5a8fb0"
        anchorX="center"
        anchorY="middle"
      >
        km/h
      </Text>

      {/* --- Center infotainment screen (landscape, angled toward driver) --- */}
      <mesh position={[1.32, 0.82, 0.05]} rotation={[0, 0.18, 0.12]}>
        <boxGeometry args={[0.06, 0.1, 0.62]} />
        <primitive object={MAT.screen} attach="material" />
      </mesh>
      {/* Screen bezel */}
      <mesh position={[1.29, 0.82, 0.05]} rotation={[0, 0.18, 0.12]}>
        <boxGeometry args={[0.04, 0.14, 0.68]} />
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>

      {/* --- Air vents (left + right of the screen) --- */}
      <mesh position={[1.32, 0.98, 0.45]}>
        <boxGeometry args={[0.05, 0.1, 0.16]} />
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>
      <mesh position={[1.32, 0.98, -0.45]}>
        <boxGeometry args={[0.05, 0.1, 0.16]} />
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>

      {/* --- Steering column cowling (below wheel) --- */}
      <mesh position={[0.72, 0.98, -0.42]} rotation={[0, 0, -0.4]}>
        <boxGeometry args={[0.22, 0.12, 0.3]} />
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>

      {/* --- Flat-bottom steering wheel (RIGHT SIDE, driver at -Z) ---
          Outer group orients the wheel axis along +X (facing the driver);
          inner group applies the live steering rotation about X.
          The rim is a partial torus (arc = PI*1.6) for a flat bottom. */}
      <group position={[0.55, 1.12, -0.42]} rotation={[0, Math.PI / 2, 0]}>
        {/* Steering column */}
        <mesh position={[0.12, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.035, 0.035, 0.24, 12]} />
          <primitive object={MAT.dashTrim} attach="material" />
        </mesh>
        <group ref={wheelRef} rotation={[-0.4, 0, 0]}>
          {/* Rim — partial torus (flat bottom). arc spans PI*1.6, rotated so
              the gap sits at the bottom. */}
          <mesh rotation={[0, 0, -Math.PI * 0.3]}>
            <torusGeometry args={[0.18, 0.028, 16, 40, Math.PI * 1.6]} />
            <primitive object={MAT.leather} attach="material" />
          </mesh>
          {/* Flat bottom bar */}
          <mesh position={[0, -0.18, 0]}>
            <boxGeometry args={[0.3, 0.04, 0.04]} />
            <primitive object={MAT.leather} attach="material" />
          </mesh>
          {/* Red stitching detail on the flat bottom */}
          <mesh position={[0, -0.2, 0]}>
            <boxGeometry args={[0.28, 0.012, 0.02]} />
            <primitive object={MAT.vrsRed} attach="material" />
          </mesh>
          {/* Left spoke */}
          <mesh position={[-0.1, 0.05, 0]} rotation={[0, 0, Math.PI / 2]}>
            <boxGeometry args={[0.04, 0.16, 0.03]} />
            <primitive object={MAT.leather} attach="material" />
          </mesh>
          {/* Right spoke */}
          <mesh position={[0.1, 0.05, 0]} rotation={[0, 0, Math.PI / 2]}>
            <boxGeometry args={[0.04, 0.16, 0.03]} />
            <primitive object={MAT.leather} attach="material" />
          </mesh>
          {/* Hub */}
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.055, 0.055, 0.05, 16]} />
            <primitive object={MAT.leather} attach="material" />
          </mesh>
          {/* VRS red badge at hub */}
          <mesh position={[0, 0, 0.03]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.03, 0.03, 0.02, 16]} />
            <primitive object={MAT.vrsRed} attach="material" />
          </mesh>
        </group>
      </group>

      {/* --- Sport seats --- */}
      <Seat position={[-0.25, 0, -0.42]} />
      <Seat position={[-0.25, 0, 0.42]} />

      {/* --- Center console between the seats --- */}
      <mesh position={[-0.25, 0.55, 0]}>
        <boxGeometry args={[0.7, 0.3, 0.18]} />
        <primitive object={MAT.dash} attach="material" />
      </mesh>
      {/* Red ambient strip on console */}
      <mesh position={[-0.25, 0.7, 0]}>
        <boxGeometry args={[0.6, 0.015, 0.16]} />
        <primitive object={MAT.redAccent} attach="material" />
      </mesh>
      {/* Gear shifter */}
      <mesh position={[-0.1, 0.72, 0]}>
        <sphereGeometry args={[0.05, 12, 12]} />
        <primitive object={MAT.chrome} attach="material" />
      </mesh>
      <mesh position={[-0.1, 0.66, 0]}>
        <cylinderGeometry args={[0.018, 0.018, 0.12, 8]} />
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>

      {/* --- A-pillars: angled boxes from dash corners to roof --- */}
      <mesh position={[1.25, 1.2, -0.78]} rotation={[0, 0, 0.5]}>
        <boxGeometry args={[0.06, 0.5, 0.06]} />
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>
      <mesh position={[1.25, 1.2, 0.78]} rotation={[0, 0, 0.5]}>
        <boxGeometry args={[0.06, 0.5, 0.06]} />
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>

      {/* --- Windshield (front cabin face, semi-transparent) --- */}
      <mesh position={[1.55, 1.08, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[1.5, 0.66]} />
        <primitive object={MAT.glass} attach="material" />
      </mesh>
      {/* Side windows */}
      <mesh position={[0.1, 1.12, -0.82]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[2.0, 0.5]} />
        <primitive object={MAT.glass} attach="material" />
      </mesh>
      <mesh position={[0.1, 1.12, 0.82]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[2.0, 0.5]} />
        <primitive object={MAT.glass} attach="material" />
      </mesh>
      {/* Rear window */}
      <mesh position={[-1.35, 1.12, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[1.5, 0.5]} />
        <primitive object={MAT.glass} attach="material" />
      </mesh>

      {/* --- Door panels with pull handle, ambient strip, window switches --- */}
      <DoorPanel side={-1} />
      <DoorPanel side={1} />

      {/* --- Rearview mirror --- */}
      <mesh position={[1.35, 1.36, 0]}>
        <boxGeometry args={[0.22, 0.07, 0.04]} />
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>
      <mesh position={[1.35, 1.34, 0]}>
        <boxGeometry args={[0.18, 0.05, 0.01]} />
        <meshStandardMaterial color="#20242c" roughness={0.1} metalness={0.8} />
      </mesh>

      {/* --- Roof liner --- */}
      <mesh position={[0.1, 1.34, 0]}>
        <boxGeometry args={[2.2, 0.04, 1.5]} />
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>
    </group>
  );
}

/** A door panel: main card, pull handle, red ambient strip, window switches. */
function DoorPanel({ side }: { side: 1 | -1 }) {
  const z = 0.80 * side;
  return (
    <group>
      {/* Main door card */}
      <mesh position={[0.1, 0.6, z]}>
        <boxGeometry args={[2.0, 0.7, 0.05]} />
        <primitive object={MAT.dash} attach="material" />
      </mesh>
      {/* Door pull handle */}
      <mesh position={[0.1, 0.78, z - 0.04 * side]}>
        <boxGeometry args={[0.3, 0.05, 0.06]} />
        <primitive object={MAT.leather} attach="material" />
      </mesh>
      {/* Red ambient lighting strip */}
      <mesh position={[0.1, 0.92, z]}>
        <boxGeometry args={[1.6, 0.015, 0.03]} />
        <primitive object={MAT.redAccent} attach="material" />
      </mesh>
      {/* Window switch cluster */}
      <mesh position={[0.5, 0.78, z - 0.04 * side]}>
        <boxGeometry args={[0.12, 0.03, 0.1]} />
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>
    </group>
  );
}

/** A single sport seat: base, reclined backrest with bolsters, angular headrest. */
function Seat({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      {/* Base */}
      <mesh position={[0, 0.5, 0]} castShadow>
        <boxGeometry args={[0.6, 0.18, 0.6]} />
        <primitive object={MAT.fabric} attach="material" />
      </mesh>
      {/* Backrest (reclined) */}
      <mesh position={[-0.28, 0.85, 0]} rotation={[0.2, 0, 0]} castShadow>
        <boxGeometry args={[0.16, 0.72, 0.6]} />
        <primitive object={MAT.fabric} attach="material" />
      </mesh>
      {/* Angular headrest */}
      <mesh position={[-0.3, 1.24, 0]} rotation={[0.1, 0, 0]} castShadow>
        <boxGeometry args={[0.14, 0.18, 0.26]} />
        <primitive object={MAT.fabric} attach="material" />
      </mesh>
      {/* Pronounced side bolsters (taller, angled inward) — base */}
      <mesh position={[0, 0.56, 0.26]} rotation={[0, 0.15, 0]}>
        <boxGeometry args={[0.6, 0.3, 0.08]} />
        <primitive object={MAT.fabric} attach="material" />
      </mesh>
      <mesh position={[0, 0.56, -0.26]} rotation={[0, -0.15, 0]}>
        <boxGeometry args={[0.6, 0.3, 0.08]} />
        <primitive object={MAT.fabric} attach="material" />
      </mesh>
      {/* Pronounced side bolsters — backrest */}
      <mesh position={[-0.26, 0.9, 0.26]} rotation={[0.2, 0, 0.15]}>
        <boxGeometry args={[0.16, 0.6, 0.08]} />
        <primitive object={MAT.fabric} attach="material" />
      </mesh>
      <mesh position={[-0.26, 0.9, -0.26]} rotation={[0.2, 0, -0.15]}>
        <boxGeometry args={[0.16, 0.6, 0.08]} />
        <primitive object={MAT.fabric} attach="material" />
      </mesh>
      {/* Red stitching on backrest */}
      <mesh position={[-0.19, 0.85, 0]} rotation={[0.2, 0, 0]}>
        <boxGeometry args={[0.02, 0.5, 0.5]} />
        <primitive object={MAT.vrsRed} attach="material" />
      </mesh>
    </group>
  );
}

/* ------------------------------------------------------------------ *
 *  DrivableCar
 * ------------------------------------------------------------------ */
/**
 * A player-drivable car that responds to WASD keyboard input in real time.
 * Spawns at the entry node E0 on the right-hand lane, follows ramp height
 * when driving over a spiral ramp, and is clamped to the lot footprint for
 * basic collision. Renders a simple box exterior (visible from outside) and
 * a detailed 3D interior (visible from the POV camera).
 */
export function DrivableCar({ lot, carGroupsRef, speedRef, parkedCars, roadSegments, pov = false }: DrivableCarProps) {
  const groupRef = useRef<THREE.Group>(null);
  const shadowRef = useRef<THREE.Mesh>(null);
  const velocityRef = useRef(0); // forward speed (negative = reverse)
  const lateralVelRef = useRef(0); // lateral velocity for grip/slip model
  const headingRef = useRef(0); // yaw angle (0 = facing +X)
  // Heading from the previous frame. The grip/drift model composes the world
  // velocity from the PREVIOUS heading's basis (where velocityRef/lateralVelRef
  // were last written) and decomposes it onto the CURRENT heading's basis, so
  // a turn bleeds some forward momentum into lateral velocity. Initialised to
  // the spawn heading so the first frame is an identity transform.
  const prevHeadingRef = useRef(0);
  const steerInputRef = useRef(0); // live steering input for the wheel visual
  const steerAngleRef = useRef(0); // smoothed steering angle (radians)
  const floorRef = useRef(0); // current floor (for flat-ground height)
  const liveSpeedRef = useRef(0); // numeric speed feed for the interior speedometer
  const wheelRefs = useRef<(THREE.Group | null)[]>([null, null, null, null]);
  const steerRefs = useRef<(THREE.Group | null)[]>([null, null, null, null]);
  const keys = useKeyboard();

  // Pre-compute ramp curves for height sampling.
  const rampCurves = useMemo(() => buildRampCurves(lot), [lot]);

  // Lot bounds for collision clamping.
  const bounds = useMemo(() => computeBounds(lot), [lot]);
  const maxFloor = useMemo(
    () => Math.max(...Object.values(lot.nodes).map((n) => n.floor)),
    [lot],
  );

  // World-space XZ positions of all slot nodes, for the slot-area exception
  // in the road clamp (allows the car to drive off the road into parking bays).
  const slotPositions = useMemo(() => {
    const out: { x: number; z: number; floor: number }[] = [];
    for (const node of Object.values(lot.nodes)) {
      if (node.type !== "slot") continue;
      const [x, , z] = toWorld(node.x, node.y, node.floor);
      out.push({ x, z, floor: node.floor });
    }
    return out;
  }, [lot]);

  // Spawn at the entry node E0, in the right-hand driving lane, facing +X.
  // We don't spawn on the approach road (ENTRY_ROAD, x=-15) because that node
  // is outside the lot bounds clamp (computeBounds excludes approach/entry/
  // exit nodes, so minX=-13) and isn't covered by road segments — the car
  // would be yanked to x=-13 and then pushed to ~x=-4 by the road-edge clamp
  // on the first frame, producing a visible teleport. E0 is on the entry
  // aisle's road segment, so the spawn position is stable. AI-car overlap at
  // E0 is handled by the push-out collision below.
  const spawn = useMemo(() => {
    const entry = lot.nodes["E0"];
    if (!entry) return { pos: [0, ROAD_Y + CAR_Y_OFFSET, 0] as [number, number, number], heading: 0 };
    const [x, y, z] = toWorld(entry.x, entry.y, entry.floor);
    return { pos: [x, y + ROAD_Y + CAR_Y_OFFSET, z + LANE_SHIFT] as [number, number, number], heading: 0 };
  }, [lot]);

  useEffect(() => {
    headingRef.current = spawn.heading;
    prevHeadingRef.current = spawn.heading;
    floorRef.current = 0;
  }, [spawn.heading]);

  // Clean up the carGroups entry on unmount so the camera rig doesn't track
  // a stale group after the user exits POV mode.
  useEffect(() => {
    return () => {
      carGroupsRef.current.delete(PLAYER_CAR_KEY);
    };
  }, [carGroupsRef]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 30);
    const g = groupRef.current;
    if (!g) return;

    // Register this car every frame so the camera rig can find it.
    carGroupsRef.current.set(PLAYER_CAR_KEY, g);

    // --- Input (WASD + arrow keys) ---
    const accel = keys.current["KeyW"] || keys.current["ArrowUp"] ? 1 : 0;
    const brake = keys.current["KeyS"] || keys.current["ArrowDown"] ? 1 : 0;
    const steerLeft = keys.current["KeyA"] || keys.current["ArrowLeft"] ? 1 : 0;
    const steerRight = keys.current["KeyD"] || keys.current["ArrowRight"] ? 1 : 0;

    // --- Longitudinal physics with drag + rolling resistance ---
    velocityRef.current += accel * ACCEL_RATE * dt;
    velocityRef.current -= brake * BRAKE_RATE * dt;
    // Quadratic drag always applies (creates natural acceleration curve).
    const speed = Math.abs(velocityRef.current);
    velocityRef.current -= velocityRef.current * speed * DRAG * dt;
    // Rolling resistance while throttling (prevents linear accel to cap).
    if (accel || brake) {
      velocityRef.current -= velocityRef.current * ROLLING_RESISTANCE * dt;
    }
    velocityRef.current = Math.max(-MAX_REVERSE, Math.min(MAX_SPEED, velocityRef.current));

    // Friction when coasting (no throttle or brake).
    if (!accel && !brake) {
      velocityRef.current *= Math.pow(FRICTION, dt * 60);
      if (Math.abs(velocityRef.current) < 0.05) velocityRef.current = 0;
    }

    // --- Steering: ramped angle with return-to-center ---
    const steerInput = steerLeft - steerRight; // +1 = left, -1 = right
    steerInputRef.current = steerInput;
    const targetSteer = steerInput * MAX_STEER_ANGLE;
    if (steerInput !== 0) {
      // Ramp toward target steering angle.
      const diff = targetSteer - steerAngleRef.current;
      const maxStep = STEER_SPEED * dt;
      steerAngleRef.current += Math.max(-maxStep, Math.min(maxStep, diff));
    } else {
      // Return to center.
      const ret = STEER_RETURN * dt;
      if (Math.abs(steerAngleRef.current) < ret) {
        steerAngleRef.current = 0;
      } else {
        steerAngleRef.current -= Math.sign(steerAngleRef.current) * ret;
      }
    }

    // --- Apply steering to heading (proportional to speed; can't turn when stopped) ---
    const speedFactor = Math.min(1, speed / 3);
    const turn = steerAngleRef.current * TURN_RATE * dt * speedFactor;
    // Invert steering when reversing (matches real car behaviour).
    headingRef.current += velocityRef.current >= 0 ? turn : -turn;

    // --- Move with lateral grip model ---
    // The car has a forward velocity (along heading) and a lateral velocity
    // (perpendicular). Lateral velocity decays each frame based on GRIP,
    // simulating tire grip. When turning, some forward momentum bleeds into
    // lateral, creating a natural drift/slip feel rather than on-rails.
    //
    // velocityRef and lateralVelRef are stored in the PREVIOUS frame's heading
    // basis (the basis they were last written in). To move correctly after the
    // heading changed this frame, we first compose the world velocity from the
    // PREVIOUS heading's basis, then decompose it onto the CURRENT heading's
    // basis. The component that no longer aligns with the new forward axis
    // becomes lateral velocity — that is the momentum carryover the drift
    // model is meant to provide. (Composing and decomposing with the SAME
    // basis, as the old code did, is an identity transform and produces no
    // lateral velocity at all.)
    const heading = headingRef.current;
    const prevHeading = prevHeadingRef.current;
    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);
    const cosP = Math.cos(prevHeading);
    const sinP = Math.sin(prevHeading);
    // Forward unit vector (car faces +X at yaw 0): (cos, 0, -sin)
    // Right unit vector (perpendicular): (sin, 0, cos)
    // Compose world velocity from the PREVIOUS heading's basis.
    const fwdVx = cosP * velocityRef.current;
    const fwdVz = -sinP * velocityRef.current;
    const latVx = sinP * lateralVelRef.current;
    const latVz = cosP * lateralVelRef.current;
    const worldVx = fwdVx + latVx;
    const worldVz = fwdVz + latVz;
    // Decompose world velocity onto the CURRENT heading's basis. The part of
    // the old forward velocity that is no longer along the new forward axis
    // shows up as lateral velocity — the drift bleed.
    velocityRef.current = worldVx * cosH - worldVz * sinH;
    lateralVelRef.current = worldVx * sinH + worldVz * cosH;
    // Apply grip: lateral velocity decays (tires resist sideways motion).
    lateralVelRef.current *= Math.pow(1 - GRIP, dt * 60);
    if (Math.abs(lateralVelRef.current) < 0.01) lateralVelRef.current = 0;

    // Move the car by the combined velocity, using the current heading basis.
    const totalVx = cosH * velocityRef.current + sinH * lateralVelRef.current;
    const totalVz = -sinH * velocityRef.current + cosH * lateralVelRef.current;
    g.position.x += totalVx * dt;
    g.position.z += totalVz * dt;
    g.rotation.y = heading;
    // Remember this frame's heading as the basis velocityRef/lateralVelRef are
    // now stored in, for next frame's composition.
    prevHeadingRef.current = heading;

    // --- Height: ramp sampling (distance-to-polyline), else flat floor ---
    // Ramps connected to the current floor are considered. We also check the
    // ramp's sampled height at the car's XZ position: if it's approximately
    // equal to the current floor's flat height, the car is at a ramp endpoint
    // on flat ground (not on the incline), so we skip the ramp. This prevents
    // false positives where a car on floor 2 near a ramp endpoint (same XZ as
    // the ramp's start/end) gets falsely classified as on-ramp and trapped.
    const RAMP_TRIGGER_DIST = ROAD_WIDTH / 2 + 1.5;
    const flatFloorY = floorRef.current * FLOOR_HEIGHT + ROAD_Y;
    let groundY = flatFloorY;
    let bestRamp: RampCurve | null = null;
    let bestRampDist = Infinity;
    for (const ramp of rampCurves) {
      if (ramp.fromFloor !== floorRef.current && ramp.toFloor !== floorRef.current) continue;
      for (let i = 0; i < ramp.points.length - 1; i++) {
        const d = distToSegment2D(
          g.position.x,
          g.position.z,
          ramp.points[i].x,
          ramp.points[i].z,
          ramp.points[i + 1].x,
          ramp.points[i + 1].z,
        );
        if (d < bestRampDist) {
          bestRampDist = d;
          bestRamp = ramp;
        }
      }
    }
    // Height check: sample the ramp's Y at the car's XZ. If it's within 1 unit
    // of the current flat floor height, the car is on flat ground at a ramp
    // endpoint, not on the incline — don't treat it as on-ramp.
    let onRamp = bestRamp != null && bestRampDist < RAMP_TRIGGER_DIST;
    if (onRamp && bestRamp) {
      const rampY = rampHeightAt(bestRamp, g.position.x, g.position.z);
      if (Math.abs(rampY - flatFloorY) < 1.0) {
        onRamp = false;
      }
    }

    // --- Ramp edge clamp: keep the car within the road width of the ramp
    // centerline so it can't drive off the side and teleport/clip. Done
    // after ramp detection (which sets onRamp/bestRamp) but before the
    // height/pitch sampling so the sampled height is valid.
    if (onRamp && bestRamp) {
      const centerlinePts = bestRamp.points;
      // Find nearest centerline point and push car toward it if too far.
      let nearestX = 0, nearestZ = 0, nearestDist = Infinity;
      for (const p of centerlinePts) {
        const d = Math.hypot(g.position.x - p.x, g.position.z - p.z);
        if (d < nearestDist) { nearestDist = d; nearestX = p.x; nearestZ = p.z; }
      }
      const maxDist = ROAD_WIDTH / 2 - 0.5;
      if (nearestDist > maxDist) {
        const dxn = (nearestX - g.position.x) / nearestDist;
        const dzn = (nearestZ - g.position.z) / nearestDist;
        g.position.x = nearestX - dxn * maxDist;
        g.position.z = nearestZ - dzn * maxDist;
      }
    }

    let targetPitch = 0;
    if (onRamp && bestRamp) {
      groundY = rampHeightAt(bestRamp, g.position.x, g.position.z) + ROAD_Y;
      // Compute pitch from the ramp slope: sample height at the car and a
      // look-ahead point along the heading, then set rotation.z to match.
      // The car model faces +X, so pitch is rotation about the Z axis.
      // In three.js, a positive rotation.z tilts the nose UP for a +X-facing
      // car, and rampPitchAt returns positive when climbing, so no negation.
      const lookAhead = 2.0;
      targetPitch = rampPitchAt(bestRamp, g.position.x, g.position.z, heading, lookAhead);
      // Update floor when the ramp height crosses a floor boundary.
      const newFloor = Math.round(groundY / FLOOR_HEIGHT);
      if (newFloor !== floorRef.current) floorRef.current = newFloor;
    } else {
      groundY = floorRef.current * FLOOR_HEIGHT + ROAD_Y;
    }
    g.position.y = groundY + CAR_Y_OFFSET;

    // Keep the blob shadow flat on the floor surface beneath the car
    // (independent of the car's pitch so it never tilts on ramps).
    if (shadowRef.current) {
      shadowRef.current.position.set(g.position.x, groundY + 0.01, g.position.z);
    }

    // --- Pitch (inclination): smoothly interpolate toward target ---
    // On flat ground targetPitch is 0, so the car levels out. On the ramp
    // it tilts to match the slope. We lerp for smooth transitions at the
    // ramp entry/exit so the car doesn't snap.
    const pitchLerp = 1 - Math.pow(0.001, dt);
    g.rotation.z += (targetPitch - g.rotation.z) * pitchLerp;

    // --- Collision: clamp to lot bounds + vertical limits ---
    // Skip the XZ clamp while on a ramp — the ramp centerline bulges outside
    // the lot footprint (e.g. to x=-25), so clamping to minX would trap the
    // car at the lot edge and prevent it from following the ramp curve.
    if (!onRamp) {
      g.position.x = Math.max(bounds.minX, Math.min(bounds.maxX, g.position.x));
      g.position.z = Math.max(bounds.minZ, Math.min(bounds.maxZ, g.position.z));
    }
    g.position.y = Math.max(
      CAR_Y_OFFSET,
      Math.min(maxFloor * FLOOR_HEIGHT + ROAD_Y + CAR_Y_OFFSET, g.position.y),
    );

    // --- Road-edge clamp: keep the car on the road surface ---
    // Prevents driving through guardrails and off the road edges on turns.
    // Skipped on ramps (they have their own edge clamp above) and near slot
    // nodes (allows driving into parking bays that extend beyond the road
    // width). Only segments on the current floor are considered.
    // The slot-exception radius is SLOT_WIDTH/2 + 1 (≈2.25) — small enough
    // that it only fires when the car is actually at a slot entrance, not
    // when it's on the aisle (the aisle centerline is SLOT_OFFSET=6 units
    // from the nearest slot, so a radius of 2.25 never fires on the aisle).
    if (!onRamp) {
      let nearSlot = false;
      const slotExceptionRadius = SLOT_WIDTH / 2 + 1;
      for (const s of slotPositions) {
        if (s.floor !== floorRef.current) continue;
        if (Math.hypot(g.position.x - s.x, g.position.z - s.z) < slotExceptionRadius) {
          nearSlot = true;
          break;
        }
      }
      if (!nearSlot) {
        let bestDist = Infinity;
        let bestX = 0;
        let bestZ = 0;
        for (const seg of roadSegments) {
          if (seg.floor !== floorRef.current) continue;
          const d = distToSegment2D(
            g.position.x,
            g.position.z,
            seg.x1,
            seg.z1,
            seg.x2,
            seg.z2,
          );
          if (d < bestDist) {
            bestDist = d;
            [bestX, bestZ] = closestPointOnSegment2D(
              g.position.x,
              g.position.z,
              seg.x1,
              seg.z1,
              seg.x2,
              seg.z2,
            );
          }
        }
        const maxRoadDist = ROAD_WIDTH / 2 - 0.3;
        if (bestDist > maxRoadDist && bestDist < Infinity) {
          const nx = (bestX - g.position.x) / bestDist;
          const nz = (bestZ - g.position.z) / bestDist;
          g.position.x = bestX - nx * maxRoadDist;
          g.position.z = bestZ - nz * maxRoadDist;
        }
      }
    }

    // --- Collision: AI cars (push out + bleed speed) ---
    // Use a capsule-friendly radius: smaller than before (1.4 vs 2.5) so
    // the car can squeeze between parked cars. The OBB would be ideal but
    // a smaller circle is a good quick fix.
    const CAR_RADIUS = 1.6;
    for (const [id, otherGroup] of carGroupsRef.current) {
      if (id === PLAYER_CAR_KEY) continue;
      // Skip cars on a different floor (cross-floor false collisions).
      if (Math.abs(g.position.y - otherGroup.position.y) > 2.0) continue;
      const cdx = g.position.x - otherGroup.position.x;
      const cdz = g.position.z - otherGroup.position.z;
      const cdist = Math.hypot(cdx, cdz);
      if (cdist < CAR_RADIUS && cdist > 1e-4) {
        const nx = cdx / cdist;
        const nz = cdz / cdist;
        g.position.x = otherGroup.position.x + nx * CAR_RADIUS;
        g.position.z = otherGroup.position.z + nz * CAR_RADIUS;
        velocityRef.current *= 0.3;
      }
    }

    // --- Collision: parked cars ---
    for (const pc of parkedCars) {
      // Skip parked cars on a different floor (cross-floor false collisions).
      if (Math.abs(g.position.y - pc.y) > 2.0) continue;
      const pdx = g.position.x - pc.x;
      const pdz = g.position.z - pc.z;
      const pdist = Math.hypot(pdx, pdz);
      if (pdist < CAR_RADIUS && pdist > 1e-4) {
        const nx = pdx / pdist;
        const nz = pdz / pdist;
        g.position.x = pc.x + nx * CAR_RADIUS;
        g.position.z = pc.z + nz * CAR_RADIUS;
        velocityRef.current *= 0.3;
      }
    }

    // Publish speed for the HUD and the interior speedometer.
    liveSpeedRef.current = velocityRef.current;
    if (speedRef) {
      speedRef.current.speed = velocityRef.current;
    }

    // --- Wheel spin + front wheel steering animation ---
    // Spin and steer live on separate nested groups so they never share an
    // object's Euler angles (which would couple them and make the front
    // wheels tumble). Spin is on the innermost group (local Y = axle after
    // the π/2 X parent); steer is on the outermost group (world Y).
    // Correct angular velocity: v / r. Wheel radius is 0.34.
    const wheelSpin = velocityRef.current / 0.34 * dt;
    const visualSteer = steerAngleRef.current * 0.6;
    for (let i = 0; i < wheelRefs.current.length; i++) {
      const wr = wheelRefs.current[i];
      if (wr) wr.rotation.y -= wheelSpin;
      // Front wheels (indices 0, 1) visually steer about world Y.
      if (i < 2) {
        const sr = steerRefs.current[i];
        if (sr) sr.rotation.y = visualSteer;
      }
    }
  });

  return (
    <>
      <group ref={groupRef} position={spawn.pos} rotation={[0, spawn.heading, 0]}>
        <CarExterior wheelRefs={wheelRefs} steerRefs={steerRefs} bodyVisible={!pov} />
        {/* The procedural interior exists only to be seen from the driver's-eye
            camera. Rendering it in third person draws the box-model cockpit
            through the GLTF body (roof liner, windows, seats all clip), so it
            is mounted only in POV mode. The steering-wheel animation and the
            speedometer live inside it and are only visible in POV, so they
            unmount safely with it. */}
        {pov && <CarInterior steerRef={steerInputRef} speedRef={liveSpeedRef} />}
      </group>
      {/* Blob shadow under the player car (kept flat via shadowRef in useFrame) */}
      <mesh ref={shadowRef} rotation={[-Math.PI / 2, 0, 0]} position={spawn.pos}>
        <circleGeometry args={[1.2, 16]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.35} depthWrite={false} />
      </mesh>
    </>
  );
}
