import { Suspense, useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Text, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { CarStatus, LotData, LotEdge } from "../types";
import { useKeyboard } from "../hooks/useKeyboard";
import { creaseSmoothed } from "./Car";
import { rampPoints, slabBounds } from "./geometry";
import type { RoadSegment } from "./roadSegments";
import {
  CAR_Y_OFFSET,
  FLOOR_HEIGHT,
  LANE_WIDTH,
  ROAD_WIDTH,
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
  /** When true the camera is inside the car (POV mode); the procedural
   *  CarInterior provides the visible dashboard/seats/wheel. */
  pov?: boolean;
  /** The bay the backend has reserved for the player, if any. */
  assignedSlot: string | null;
  /** Latest lifecycle status the backend reports for the player. */
  playerStatus: CarStatus;
  /** True once the player has asked to leave and is routed to the exit. */
  leaving: boolean;
  /** Bumped whenever the car should teleport back to its spawn pose. */
  runId: number;
  /** Report the graph node the car is physically at (drives the guidance). */
  onReportNode: (nodeId: string) => void;
  /** Request to vacate the current bay and follow guidance to the exit. */
  onLeaveBay: () => void;
}

/* ------------------------------------------------------------------ *
 *  Driving physics tuning
 * ------------------------------------------------------------------ */
const ACCEL_RATE = 12; // units/sec^2 when pressing W
const BRAKE_RATE = 28; // units/sec^2 when pressing S
const MAX_SPEED = 9; // forward speed cap (parking-appropriate)
const MAX_REVERSE = MAX_SPEED / 2; // reverse speed cap
const TURN_RATE = 1.9; // rad/sec at full steering
/** Speed above which full-lock steering starts to fade back off.
 *  Everything at or below this keeps IDENTICAL authority to before — parking
 *  manoeuvres must not get harder. */
const STEER_FADE_START = 2;
/** Fraction of steering authority removed at MAX_SPEED, ramping linearly
 *  from STEER_FADE_START up. A constant 1.9 rad/s yaw rate at 9 u/s whips the
 *  car through hairpins a real car would sweep; trimming toward high speed
 *  keeps low speeds nimble and high speeds stable. */
const STEER_HIGH_SPEED_FADE = 0.45;
const FRICTION = 0.97; // velocity decay per frame when coasting (at 60fps)
const DRAG = 0.006; // quadratic drag — creates natural acceleration curve
/** Reverse throttle once S has braked all the way to zero. Deliberately much
 *  softer than BRAKE_RATE: the brake pedal and the reverse pedal are not the
 *  same thing, and engaging reverse at -28 u/s^2 from standstill made the
 *  car lurch backwards. */
const REVERSE_ACCEL = 10;
/** Forward speed under which S stops braking and starts reversing. Only has
 *  to cover floating-point residue: the brake clamps to exactly zero. */
const BRAKE_TO_REVERSE_EPSILON = 0.05;
const STEER_SPEED = 6.0; // how fast steering angle ramps (rad/sec)
const STEER_RETURN = 5.0; // how fast steering returns to center (rad/sec)
const MAX_STEER_ANGLE = 0.55; // max steering angle (~31°)
const GRIP = 0.88; // lateral grip: 1 = on rails, 0 = ice (0.85-0.92 sweet spot)
const ROLLING_RESISTANCE = 0.4; // drag while throttling (prevents linear accel)

/* ------------------------------------------------------------------ *
 *  Collision tuning
 * ------------------------------------------------------------------ */

/** Capsule collider for the player car: two discs of this radius centred
 *  ±CAPSULE_DISC_OFFSET along the heading. The body is ~4.5 long and ~1.8
 *  wide; one 1.6-radius circle let the nose and corners clip straight through
 *  parked cars, while two of these discs span 2*(1.1+0.9)=4.0 end to end and
 *  1.8 across — close enough that what you see is what collides. */
const CAPSULE_DISC_RADIUS = 0.9;
const CAPSULE_DISC_OFFSET = 1.1;

/** Collision radius of other cars (parked or AI). They stay point-like:
 *  their half-width is ~0.9, which is everything the player capsule needs to
 *  respect at gameplay level. */
const OTHER_CAR_RADIUS = 0.9;

/** Bounciness of car-vs-car contacts. Only the velocity component along the
 *  contact normal responds; this is how much of it reflects back. Small on
 *  purpose — a parking garage is not a pinball table. */
const COLLISION_RESTITUTION = 0.2;

/** Height of the road surface above the floor slab top (mirrors ParkingLot). */
const ROAD_Y = 0.15;

/** Lift of the blob-shadow disc above the sampled ground height.
 *  Kept rather than deleted: indoors the slab overhead blocks the
 *  shadow-casting skylight and the warm point lights cast none, so this
 *  disc is the only grounding shadow a car in the garage gets. It sits at
 *  +0.007 - above every opaque road surface (the turn ribbons ride highest,
 *  at ROAD_Y + 0.005) and strictly BELOW the FloorPaint marking plane at
 *  ROAD_Y + 0.01. Both of those layers are transparent depthWrite:false and
 *  used to share one plane, strobing as their blend order flipped; with the
 *  shadow below the paint, markings stay crisp and the shadow reads on bare
 *  asphalt between them. */
const SHADOW_LIFT = 0.007;

/** Ramp capture extends only one movement step beyond its 7-unit road.
 *  Invariant: `onRamp` never disables the lot clamp for a car out in space. */
const RAMP_TRIGGER_DIST = ROAD_WIDTH / 2 + 0.35;

/** Vertical gate on ramp candidacy: a ramp whose surface is more than this
 *  far above or below the car's current ground height can never capture it,
 *  no matter how close the XZ distance is.
 *
 *  This kills the spawn teleport: the entrance sits ~1.77 units from the
 *  A->B ramp deck's centreline (well inside RAMP_TRIGGER_DIST) but that deck
 *  passes ~13 units overhead — its surface height gives it away. Legitimate
 *  captures never come close to this limit: the ramp foot eases its grade
 *  in over RAMP_VERTICAL_CURVE, so at the moment of capture the surface is
 *  within a few tenths of the flat floor (measured: ≤0.07 at driving speed).
 *  Generous enough for a full-speed frame step (~0.06 rise), strict enough
 *  to reject any stacked deck a floor up or down. */
const MAX_RAMP_CAPTURE_DELTA = 2.5;

/** How far from a road centreline the car may sit before being clamped
 *  back, shared by the flat-road corridor clamp and the ramp band clamp.
 *  These MUST be the same value: they used to differ by 0.2 (ramps allowed
 *  3.0, flat roads 3.2), which snapped the car sideways whenever it crossed
 *  a ramp boundary near the road edge. */
const ROAD_CORRIDOR_HALF_WIDTH = ROAD_WIDTH / 2 - 0.3;

/** Vertical dead-zone for FLOOR TRANSFER only: how close to a ramp endpoint
 *  the car must get before it is considered to belong to the other storey.
 *  This one has to stay generous, or a car can step past the window in a
 *  single frame and keep the wrong floor for the rest of its drive. */
const RAMP_ENDPOINT_HEIGHT_EPSILON = 0.2;

/** Vertical dead-zone for the FLAT-versus-RAMP decision.
 *
 *  While the ramp surface is within this of the flat floor the car is pinned
 *  to the flat height, and at the threshold it snaps by exactly this much.
 *  The ramp starts and ends flush and eases its grade in, so this only has to
 *  cover floating-point noise; making it larger would pop the car vertically
 *  at every ramp entry and exit. */
const RAMP_FLAT_EPSILON = 0.02;

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

/** Projection of an XZ point onto a polyline: nearest segment index, the
 *  parameter within it, and the distance to it. One shared implementation
 *  for height sampling, pitch sampling, and the ramp edge clamp — the three
 *  near-identical loops this file used to carry. */
interface PolylineProjection {
  index: number;
  t: number;
  dist: number;
}

function projectOnPolyline(
  pts: THREE.Vector3[],
  x: number,
  z: number,
): PolylineProjection {
  let bestIndex = 0;
  let bestT = 0;
  let bestDistSq = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x;
    const az = pts[i].z;
    const bx = pts[i + 1].x;
    const bz = pts[i + 1].z;
    const dx = bx - ax;
    const dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    const t = lenSq < 1e-6 ? 0 : ((x - ax) * dx + (z - az) * dz) / lenSq;
    const tc = Math.max(0, Math.min(1, t));
    const px = ax + tc * dx;
    const pz = az + tc * dz;
    const d = (px - x) ** 2 + (pz - z) ** 2;
    if (d < bestDistSq) {
      bestDistSq = d;
      bestIndex = i;
      bestT = tc;
    }
  }
  return { index: bestIndex, t: bestT, dist: Math.sqrt(bestDistSq) };
}

/** Y of the ramp surface at an XZ position (before the ROAD_Y lift). */
function rampHeightAt(curve: RampCurve, x: number, z: number): number {
  const { index, t } = projectOnPolyline(curve.points, x, z);
  const p0 = curve.points[index];
  const p1 = curve.points[index + 1] ?? p0;
  return p0.y + (p1.y - p0.y) * t;
}

/** Pitch matching the ramp slope at an XZ position: walks `lookAhead` units
 *  ALONG the ramp centreline from the car's projection and takes the
 *  arctangent of the rise over that run. Positive when climbing.
 *
 *  The previous version ray-cast a straight look-ahead point along the car's
 *  heading; on the ramp's rounded corners that ray leaves the deck entirely
 *  and lands on an unrelated segment, kicking the nose up or down mid-corner.
 *  Following the curve parameter is just as cheap (points are spaced 0.5
 *  apart, so this walks a handful of segments) and is exact by construction. */
function rampPitchAlongCurve(
  curve: RampCurve,
  x: number,
  z: number,
  lookAhead: number,
): number {
  const pts = curve.points;
  const { index, t } = projectOnPolyline(pts, x, z);
  const p0 = pts[index];
  const p1 = pts[index + 1] ?? pts[index];
  const yHere = p0.y + (p1.y - p0.y) * t;

  // Walk forward from the projection point, accumulating segment lengths,
  // until `lookAhead` is consumed; interpolate Y inside the landing segment.
  let remaining = lookAhead;
  let from = p0;
  let to = p1;
  // Distance still to travel inside the current (partially consumed) segment.
  let segRoom = Math.hypot(to.x - from.x, to.z - from.z) * (1 - t);
  let i = index;
  while (remaining > segRoom && i < pts.length - 1) {
    remaining -= segRoom;
    i++;
    from = pts[i];
    to = pts[i + 1] ?? pts[i];
    segRoom = Math.hypot(to.x - from.x, to.z - from.z);
  }
  const segLen = Math.hypot(to.x - from.x, to.z - from.z);
  const f = segLen > 1e-6 ? Math.min(1, remaining / segLen) : 0;
  const yAhead = from.y + (to.y - from.y) * f;
  return Math.atan2(yAhead - yHere, lookAhead);
}

/** Push a position back inside the ramp road band (ROAD_CORRIDOR_HALF_WIDTH
 *  of the centreline) and return the ramp surface Y at the clamped position.
 *
 *  Runs twice per frame on purpose: once BEFORE height/pitch sampling (so
 *  the sampled surface belongs to the deck the car will actually stand on),
 *  and once AFTER collisions as part of the final boundary pass (so a car
 *  shoved sideways by contact can never end the frame hanging off the deck).
 *  Sharing one implementation also guarantees both passes use the same band
 *  width as the flat-road clamp — see ROAD_CORRIDOR_HALF_WIDTH. */
function clampIntoRampBand(ramp: RampCurve, pos: THREE.Vector3): number {
  const projection = projectOnPolyline(ramp.points, pos.x, pos.z);
  const a = ramp.points[projection.index];
  const b = ramp.points[projection.index + 1] ?? a;
  const nearestX = a.x + (b.x - a.x) * projection.t;
  const nearestZ = a.z + (b.z - a.z) * projection.t;
  if (projection.dist > ROAD_CORRIDOR_HALF_WIDTH) {
    const dxn = (nearestX - pos.x) / projection.dist;
    const dzn = (nearestZ - pos.z) / projection.dist;
    pos.x = nearestX - dxn * ROAD_CORRIDOR_HALF_WIDTH;
    pos.z = nearestZ - dzn * ROAD_CORRIDOR_HALF_WIDTH;
  }
  return rampHeightAt(ramp, pos.x, pos.z) + ROAD_Y;
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
 *  Car interior materials + shared geometry
 * ------------------------------------------------------------------ */
const MAT = {
  dash: new THREE.MeshStandardMaterial({ color: "#17191e", roughness: 0.72, metalness: 0.08 }),
  dashTrim: new THREE.MeshStandardMaterial({ color: "#08090c", roughness: 0.82, metalness: 0.12 }),
  leather: new THREE.MeshStandardMaterial({ color: "#09090b", roughness: 0.48, metalness: 0.08 }),
  alcantara: new THREE.MeshStandardMaterial({ color: "#202126", roughness: 0.96, metalness: 0 }),
  fabric: new THREE.MeshStandardMaterial({ color: "#292b31", roughness: 0.9, metalness: 0 }),
  carpet: new THREE.MeshStandardMaterial({ color: "#0c0d10", roughness: 1, metalness: 0 }),
  liner: new THREE.MeshStandardMaterial({ color: "#24262b", roughness: 0.95, metalness: 0 }),
  vent: new THREE.MeshStandardMaterial({ color: "#030406", roughness: 0.7, metalness: 0.3 }),
  button: new THREE.MeshStandardMaterial({ color: "#31343b", roughness: 0.55, metalness: 0.22 }),
  glass: new THREE.MeshPhysicalMaterial({
    color: "#17202b",
    metalness: 0,
    roughness: 0.08,
    transparent: true,
    opacity: 0.2,
    ior: 1.45,
    envMapIntensity: 1.25,
    depthWrite: false,
  }),
  displayGlass: new THREE.MeshPhysicalMaterial({
    color: "#07101a",
    metalness: 0.15,
    roughness: 0.08,
    transparent: true,
    opacity: 0.68,
    ior: 1.4,
    envMapIntensity: 1.5,
  }),
  mirror: new THREE.MeshStandardMaterial({ color: "#728397", roughness: 0.08, metalness: 0.85 }),
  screen: new THREE.MeshStandardMaterial({
    color: "#061018",
    emissive: new THREE.Color("#123b61"),
    emissiveIntensity: 0.72,
    roughness: 0.25,
    metalness: 0.12,
  }),
  tft: new THREE.MeshStandardMaterial({
    color: "#02070d",
    emissive: new THREE.Color("#163e5f"),
    emissiveIntensity: 0.5,
    roughness: 0.2,
    metalness: 0.12,
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

/** The cockpit reuses these module-scope geometries; React never allocates them per render or frame. */
const INTERIOR_GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cylinder: new THREE.CylinderGeometry(1, 1, 1, 20),
  sphere: new THREE.SphereGeometry(1, 16, 10),
  plane: new THREE.PlaneGeometry(1, 1),
  speakerDisc: new THREE.CylinderGeometry(1, 1, 0.025, 28),
  speakerRing: new THREE.TorusGeometry(1, 0.055, 8, 28),
  cupRing: new THREE.TorusGeometry(1, 0.09, 8, 24),
  seatBolster: new THREE.CapsuleGeometry(0.075, 0.42, 4, 10),
};

function makeDashboardShell(): THREE.ExtrudeGeometry {
  // The X/Y profile gives the dash a rolled lower fascia and a rising upper
  // surface instead of presenting the driver with one axis-aligned slab.
  const profile = new THREE.Shape();
  profile.moveTo(0.91, 0.72);
  profile.lineTo(1.46, 0.72);
  profile.quadraticCurveTo(1.58, 0.76, 1.58, 0.88);
  profile.lineTo(1.56, 0.98);
  profile.quadraticCurveTo(1.5, 1.09, 1.34, 1.12);
  profile.quadraticCurveTo(1.13, 1.09, 0.95, 0.97);
  profile.quadraticCurveTo(0.89, 0.85, 0.91, 0.72);
  const geometry = new THREE.ExtrudeGeometry(profile, {
    depth: 1.76,
    steps: 1,
    curveSegments: 18,
    bevelEnabled: true,
    bevelSize: 0.018,
    bevelThickness: 0.018,
    bevelSegments: 3,
  });
  geometry.translate(0, 0, -0.88);
  return geometry;
}

function makeTube(
  points: THREE.Vector3[],
  radius: number,
  closed = false,
  tubularSegments = 48,
): THREE.TubeGeometry {
  return new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3(points, closed, "centripetal"),
    tubularSegments,
    radius,
    10,
    closed,
  );
}

const DASH_SHELL_GEO = makeDashboardShell();
const DASH_COWL_GEO = makeTube(
  [
    new THREE.Vector3(0.93, 1.015, 0.79),
    new THREE.Vector3(0.94, 1.035, 0.34),
    new THREE.Vector3(0.925, 1.07, -0.1),
    new THREE.Vector3(0.89, 1.13, -0.45),
    new THREE.Vector3(0.93, 1.045, -0.79),
  ],
  0.038,
);
const DASH_STITCH_GEO = makeTube(
  [
    new THREE.Vector3(0.889, 0.955, 0.78),
    new THREE.Vector3(0.895, 0.97, 0.28),
    new THREE.Vector3(0.884, 0.995, -0.12),
    new THREE.Vector3(0.865, 1.025, -0.47),
    new THREE.Vector3(0.892, 0.975, -0.78),
  ],
  0.006,
  false,
  56,
);
const BINNACLE_HOOD_GEO = makeTube(
  [
    new THREE.Vector3(-0.29, -0.1, 0),
    new THREE.Vector3(-0.285, 0.09, 0),
    new THREE.Vector3(-0.21, 0.17, 0),
    new THREE.Vector3(0, 0.195, 0),
    new THREE.Vector3(0.21, 0.17, 0),
    new THREE.Vector3(0.285, 0.09, 0),
    new THREE.Vector3(0.29, -0.1, 0),
  ],
  0.031,
  false,
  44,
);
const STEERING_RIM_GEO = makeTube(
  [
    new THREE.Vector3(-0.13, -0.17, 0),
    new THREE.Vector3(-0.19, -0.11, 0),
    new THREE.Vector3(-0.22, 0.02, 0),
    new THREE.Vector3(-0.18, 0.15, 0),
    new THREE.Vector3(-0.08, 0.215, 0),
    new THREE.Vector3(0.08, 0.215, 0),
    new THREE.Vector3(0.18, 0.15, 0),
    new THREE.Vector3(0.22, 0.02, 0),
    new THREE.Vector3(0.19, -0.11, 0),
    new THREE.Vector3(0.13, -0.17, 0),
    new THREE.Vector3(0, -0.172, 0),
  ],
  0.027,
  true,
  64,
);
const REV_ARC_GEO = new THREE.TorusGeometry(0.087, 0.006, 7, 28, Math.PI * 1.55);

const REV_TICKS = Array.from({ length: 7 }, (_, index) => {
  const angle = Math.PI * (0.15 + index * 0.205);
  return {
    position: [Math.cos(angle) * 0.087, Math.sin(angle) * 0.087, 0.024] as const,
    rotation: angle + Math.PI / 2,
    red: index >= 5,
  };
});

const CLIMATE_BUTTONS = [-0.12, -0.04, 0.04, 0.12] as const;
const VENT_SLATS = [-0.035, 0.035] as const;
const STEERING_BUTTONS: readonly [number, number][] = [
  [-0.11, 0.055],
  [-0.075, 0.085],
  [0.075, 0.085],
  [0.11, 0.055],
];

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
}

/** Loads the GLTF body, removes wheel nodes, recolors with race-red clearcoat. */
function CarExteriorInner({ wheelRefs, steerRefs }: CarExteriorProps) {
  const { scene } = useGLTF(PLAYER_MODEL_PATH);

  const { bodyMat, glassMat, scene: cloned } = useMemo(() => {
    const s = scene.clone();

    // Race-red clearcoat paint, distinct from AI car colours. FrontSide on
    // purpose: in POV the camera sits INSIDE this shell, and DoubleSide made
    // the opaque body panels wall off the cabin. With front-side culling the
    // body renders solidly from outside and vanishes from inside, where the
    // procedural CarInterior supplies every surface the driver sees.
    const body = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color("#e0141b"),
      metalness: 0.6,
      roughness: 0.35,
      clearcoat: 1.0,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.2,
    });
    // Tinted near-opaque glass, matched to the AI cars' replacement glass in
    // Car.tsx: fully opaque #1a1d24 at low roughness reads as dark tinted
    // glass through its reflections alone. The old 0.5-alpha pane blended
    // the ground markings straight through the shell - exactly what the
    // "mirror is transparent" report described.
    const glass = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color("#1a1d24"),
      metalness: 0.1,
      roughness: 0.08,
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
      // Same crease-aware smoothing as the AI cars, sharing Car.tsx's
      // cached conversion so player and traffic shade identically.
      obj.geometry = creaseSmoothed(obj.geometry);
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
      <primitive object={cloned} rotation={[0, PLAYER_FORWARD_ROT, 0]} scale={PLAYER_MODEL_SCALE} />

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
 *  CarInterior — hand-built Octavia VRS-inspired cockpit
 *
 *  Local space: +X = forward, +Y = up, -Z = driver side. The composition is
 *  framed for the fixed driver's eye at (-0.10, 1.42, -0.42) looking down
 *  +X — headrest height, above the wheel rim and dash crest so the road and
 *  a wide slice of exterior stay visible (CameraRig matches this eye).
 * ------------------------------------------------------------------ */
interface InteriorInstrumentProps {
  speedoRef: React.MutableRefObject<THREE.Mesh | null>;
}

function InstrumentCluster({ speedoRef }: InteriorInstrumentProps) {
  return (
    <group position={[0.885, 1.055, -0.42]} rotation={[0, -Math.PI / 2, 0]}>
      {/* Deep bezel, illuminated panel, and reflective cover read as one recessed display. */}
      <mesh geometry={INTERIOR_GEO.box} scale={[0.57, 0.28, 0.045]}>
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>
      <mesh position={[0, 0, 0.027]} geometry={INTERIOR_GEO.box} scale={[0.52, 0.235, 0.018]}>
        <primitive object={MAT.tft} attach="material" />
      </mesh>
      <mesh position={[0, 0, 0.039]} geometry={INTERIOR_GEO.box} scale={[0.525, 0.24, 0.008]}>
        <primitive object={MAT.displayGlass} attach="material" />
      </mesh>

      {/* The padded U-shaped hood follows the display rather than sitting above it as a slab. */}
      <mesh position={[0, 0.005, 0.006]} geometry={BINNACLE_HOOD_GEO}>
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>
      <mesh position={[0, 0.165, -0.025]} geometry={INTERIOR_GEO.box} scale={[0.46, 0.045, 0.13]}>
        <primitive object={MAT.dash} attach="material" />
      </mesh>

      {/* Static rev-counter arc and ticks keep the virtual cockpit legible at zero speed. */}
      <group position={[-0.135, -0.005, 0.043]}>
        <mesh geometry={REV_ARC_GEO} rotation={[0, 0, 0.22]}>
          <primitive object={MAT.chromeTrim} attach="material" />
        </mesh>
        {REV_TICKS.map((tick, index) => (
          <mesh
            key={index}
            position={tick.position}
            rotation={[0, 0, tick.rotation]}
            geometry={INTERIOR_GEO.box}
            scale={[0.018, 0.004, 0.006]}
          >
            <primitive object={tick.red ? MAT.vrsRed : MAT.chromeTrim} attach="material" />
          </mesh>
        ))}
      </group>

      {/* Live speed text retained from the previous cockpit implementation. */}
      <Text
        ref={speedoRef}
        position={[0.09, 0.015, 0.052]}
        fontSize={0.14}
        color="#e7f4ff"
        anchorX="center"
        anchorY="middle"
      >
        0
      </Text>
      <Text
        position={[0.09, -0.075, 0.052]}
        fontSize={0.035}
        color="#78a8c8"
        anchorX="center"
        anchorY="middle"
      >
        km/h
      </Text>
      <Text
        position={[-0.135, -0.085, 0.052]}
        fontSize={0.035}
        color="#ef2028"
        anchorX="center"
        anchorY="middle"
      >
        VRS
      </Text>
    </group>
  );
}

function DashboardVent({ x }: { x: number }) {
  return (
    <group position={[x, 0.02, 0.04]}>
      <mesh geometry={INTERIOR_GEO.box} scale={[0.13, 0.135, 0.04]}>
        <primitive object={MAT.vent} attach="material" />
      </mesh>
      {VENT_SLATS.map((y) => (
        <mesh
          key={y}
          position={[0, y, 0.026]}
          geometry={INTERIOR_GEO.box}
          scale={[0.105, 0.009, 0.022]}
        >
          <primitive object={MAT.chrome} attach="material" />
        </mesh>
      ))}
    </group>
  );
}

function CenterStack() {
  return (
    <group position={[0.925, 0.885, 0.08]} rotation={[0, -Math.PI / 2 - 0.12, 0]}>
      {/* Landscape display and bezel are yawed toward the right-hand driver. */}
      <mesh geometry={INTERIOR_GEO.box} scale={[0.54, 0.255, 0.055]}>
        <primitive object={MAT.glossBlack} attach="material" />
      </mesh>
      <mesh position={[0, 0.015, 0.034]} geometry={INTERIOR_GEO.box} scale={[0.47, 0.19, 0.018]}>
        <primitive object={MAT.screen} attach="material" />
      </mesh>
      <mesh position={[-0.1, 0.02, 0.047]} geometry={INTERIOR_GEO.box} scale={[0.018, 0.13, 0.008]}>
        <primitive object={MAT.redAccent} attach="material" />
      </mesh>
      <mesh position={[0.08, 0.045, 0.047]} geometry={INTERIOR_GEO.box} scale={[0.21, 0.025, 0.008]}>
        <primitive object={MAT.chromeTrim} attach="material" />
      </mesh>

      <DashboardVent x={-0.35} />
      <DashboardVent x={0.35} />

      {/* Climate strip, rotary temperature controls, and physical shortcut keys. */}
      <mesh position={[0, -0.185, 0]} geometry={INTERIOR_GEO.box} scale={[0.48, 0.095, 0.055]}>
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>
      {[-0.19, 0.19].map((x) => (
        <mesh
          key={x}
          position={[x, -0.185, 0.044]}
          rotation={[Math.PI / 2, 0, 0]}
          geometry={INTERIOR_GEO.cylinder}
          scale={[0.028, 0.018, 0.028]}
        >
          <primitive object={MAT.chrome} attach="material" />
        </mesh>
      ))}
      {CLIMATE_BUTTONS.map((x) => (
        <mesh
          key={x}
          position={[x, -0.185, 0.044]}
          geometry={INTERIOR_GEO.box}
          scale={[0.045, 0.026, 0.018]}
        >
          <primitive object={MAT.button} attach="material" />
        </mesh>
      ))}
      <mesh position={[0, -0.185, 0.058]} geometry={INTERIOR_GEO.box} scale={[0.025, 0.014, 0.01]}>
        <primitive object={MAT.vrsRed} attach="material" />
      </mesh>
    </group>
  );
}

function SteeringWheel({ wheelRef }: { wheelRef: React.RefObject<THREE.Group | null> }) {
  return (
    <group position={[0.655, 1.0, -0.42]} rotation={[0, Math.PI / 2, 0]}>
      {/* Column and cowling stay outside the animated group; wheel rotation remains isolated. */}
      <mesh position={[0, -0.015, 0.13]} rotation={[Math.PI / 2, 0, 0]} geometry={INTERIOR_GEO.cylinder} scale={[0.035, 0.16, 0.035]}>
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>
      <mesh position={[0, -0.055, 0.19]} geometry={INTERIOR_GEO.box} scale={[0.2, 0.13, 0.16]}>
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>

      <group ref={wheelRef} rotation={[-0.16, 0, 0]}>
        <mesh geometry={STEERING_RIM_GEO}>
          <primitive object={MAT.leather} attach="material" />
        </mesh>
        {/* Three structural spokes meet a compact round hub. */}
        <mesh position={[-0.105, 0.03, 0]} rotation={[0, 0, -0.28]} geometry={INTERIOR_GEO.box} scale={[0.16, 0.045, 0.035]}>
          <primitive object={MAT.chrome} attach="material" />
        </mesh>
        <mesh position={[0.105, 0.03, 0]} rotation={[0, 0, 0.28]} geometry={INTERIOR_GEO.box} scale={[0.16, 0.045, 0.035]}>
          <primitive object={MAT.chrome} attach="material" />
        </mesh>
        <mesh position={[0, -0.09, 0]} geometry={INTERIOR_GEO.box} scale={[0.05, 0.15, 0.035]}>
          <primitive object={MAT.chrome} attach="material" />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]} geometry={INTERIOR_GEO.cylinder} scale={[0.075, 0.04, 0.075]}>
          <primitive object={MAT.leather} attach="material" />
        </mesh>
        {/* Red VRS badge is on the driver-facing side of the hub. */}
        <mesh position={[0.015, -0.012, -0.048]} geometry={INTERIOR_GEO.box} scale={[0.065, 0.025, 0.012]}>
          <primitive object={MAT.vrsRed} attach="material" />
        </mesh>
        {STEERING_BUTTONS.map(([x, y]) => (
          <mesh key={`${x}:${y}`} position={[x, y, -0.025]} geometry={INTERIOR_GEO.sphere} scale={[0.014, 0.014, 0.009]}>
            <primitive object={MAT.button} attach="material" />
          </mesh>
        ))}
        <mesh position={[0, 0.214, 0]} geometry={INTERIOR_GEO.box} scale={[0.018, 0.025, 0.032]}>
          <primitive object={MAT.vrsRed} attach="material" />
        </mesh>
      </group>
    </group>
  );
}

/** Sculpted sport seat with separate cushion/back bolsters and fine red seams. */
function Seat({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh position={[0, 0.47, 0]} rotation={[0, 0, -0.025]} geometry={INTERIOR_GEO.box} scale={[0.68, 0.14, 0.48]} castShadow>
        <primitive object={MAT.alcantara} attach="material" />
      </mesh>
      {[-0.235, 0.235].map((z) => (
        <mesh key={z} position={[0, 0.55, z]} rotation={[0, 0, Math.PI / 2]} geometry={INTERIOR_GEO.seatBolster}>
          <primitive object={MAT.leather} attach="material" />
        </mesh>
      ))}
      <mesh position={[0.035, 0.545, 0]} geometry={INTERIOR_GEO.box} scale={[0.42, 0.012, 0.29]}>
        <primitive object={MAT.fabric} attach="material" />
      </mesh>

      <group position={[-0.43, 0.88, 0]} rotation={[0, 0, 0.13]}>
        <mesh geometry={INTERIOR_GEO.box} scale={[0.13, 0.6, 0.47]} castShadow>
          <primitive object={MAT.alcantara} attach="material" />
        </mesh>
        <mesh position={[0.073, 0, 0]} geometry={INTERIOR_GEO.box} scale={[0.018, 0.42, 0.25]}>
          <primitive object={MAT.fabric} attach="material" />
        </mesh>
        {[-0.225, 0.225].map((z) => (
          <mesh key={z} position={[0.02, 0, z]} geometry={INTERIOR_GEO.seatBolster}>
            <primitive object={MAT.leather} attach="material" />
          </mesh>
        ))}
        {[-0.095, 0.095].map((z) => (
          <mesh key={z} position={[0.085, 0, z]} geometry={INTERIOR_GEO.box} scale={[0.008, 0.4, 0.009]}>
            <primitive object={MAT.vrsRed} attach="material" />
          </mesh>
        ))}
        <mesh position={[0.087, 0.13, 0]} geometry={INTERIOR_GEO.box} scale={[0.01, 0.055, 0.09]}>
          <primitive object={MAT.vrsRed} attach="material" />
        </mesh>
      </group>

      <mesh position={[-0.505, 1.23, 0]} rotation={[0, 0, 0.08]} geometry={INTERIOR_GEO.box} scale={[0.14, 0.18, 0.3]} castShadow>
        <primitive object={MAT.leather} attach="material" />
      </mesh>
      <mesh position={[-0.43, 1.23, 0]} rotation={[0, 0, 0.08]} geometry={INTERIOR_GEO.box} scale={[0.012, 0.11, 0.19]}>
        <primitive object={MAT.alcantara} attach="material" />
      </mesh>
    </group>
  );
}

/** Door card mirrored toward the cabin, with a real pull, speaker, and switch bank. */
function DoorPanel({ side }: { side: 1 | -1 }) {
  return (
    <group position={[0, 0.67, 0.94 * side]} scale={[1, 1, -side]}>
      <mesh geometry={INTERIOR_GEO.box} scale={[2.15, 0.58, 0.055]}>
        <primitive object={MAT.dash} attach="material" />
      </mesh>
      <mesh position={[0.08, 0.06, 0.038]} rotation={[0, 0, -0.055]} geometry={INTERIOR_GEO.box} scale={[1.28, 0.25, 0.03]}>
        <primitive object={MAT.alcantara} attach="material" />
      </mesh>
      <mesh position={[0.05, 0.205, 0.075]} geometry={INTERIOR_GEO.box} scale={[1.7, 0.055, 0.09]}>
        <primitive object={MAT.leather} attach="material" />
      </mesh>
      <mesh position={[0.16, 0.07, 0.095]} rotation={[0, 0, -0.08]} geometry={INTERIOR_GEO.box} scale={[0.34, 0.045, 0.045]}>
        <primitive object={MAT.chrome} attach="material" />
      </mesh>
      <mesh position={[0.02, 0.155, 0.102]} geometry={INTERIOR_GEO.box} scale={[1.5, 0.009, 0.014]}>
        <primitive object={MAT.redAccent} attach="material" />
      </mesh>

      <group position={[-0.66, -0.12, 0.09]}>
        <mesh rotation={[Math.PI / 2, 0, 0]} geometry={INTERIOR_GEO.speakerDisc} scale={[0.14, 1, 0.14]}>
          <primitive object={MAT.vent} attach="material" />
        </mesh>
        {[0.075, 0.12].map((radius) => (
          <mesh key={radius} geometry={INTERIOR_GEO.speakerRing} scale={radius}>
            <primitive object={MAT.chrome} attach="material" />
          </mesh>
        ))}
      </group>

      <mesh position={[0.53, 0.13, 0.105]} geometry={INTERIOR_GEO.box} scale={[0.2, 0.04, 0.1]}>
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>
      {[-0.045, 0.045].map((x) => (
        <mesh key={x} position={[0.53 + x, 0.151, 0.11]} geometry={INTERIOR_GEO.box} scale={[0.055, 0.014, 0.05]}>
          <primitive object={MAT.button} attach="material" />
        </mesh>
      ))}
    </group>
  );
}

function CarInterior({
  steerRef,
  speedRef,
}: {
  steerRef: React.MutableRefObject<number>;
  /** Ref holding the live forward speed (units/sec) for the speedometer. */
  speedRef: React.MutableRefObject<number>;
}) {
  const wheelRef = useRef<THREE.Group>(null);
  const speedoRef = useRef<THREE.Mesh>(null);
  const smoothSteer = useRef(0);
  const displayedSpeed = useRef(0);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 30);
    const target = steerRef.current * 2.2;
    smoothSteer.current += (target - smoothSteer.current) * Math.min(1, dt * 12);
    if (wheelRef.current) wheelRef.current.rotation.z = smoothSteer.current;

    // Troika text only resyncs when the rounded value changes, not every frame.
    const nextSpeed = Math.round(Math.abs(speedRef.current) * 10);
    if (speedoRef.current && nextSpeed !== displayedSpeed.current) {
      const textMesh = speedoRef.current as unknown as { text: string; sync?: () => void };
      textMesh.text = String(nextSpeed);
      textMesh.sync?.();
      displayedSpeed.current = nextSpeed;
    }
  });

  return (
    <group>
      {/* Short-range fill light reveals dark trim without lighting the garage. */}
      <pointLight position={[0.25, 1.27, 0.15]} intensity={5} distance={3.5} decay={2} color="#dce7f5" />

      <mesh position={[0.05, 0.27, 0]} geometry={INTERIOR_GEO.box} scale={[2.75, 0.04, 1.68]}>
        <primitive object={MAT.carpet} attach="material" />
      </mesh>
      <mesh position={[0.02, 0.39, 0]} geometry={INTERIOR_GEO.box} scale={[1.45, 0.2, 0.24]}>
        <primitive object={MAT.carpet} attach="material" />
      </mesh>

      {/* One extruded shell supplies the rolled fascia and windscreen-facing upper curve. */}
      <mesh geometry={DASH_SHELL_GEO}>
        <primitive object={MAT.dash} attach="material" />
      </mesh>
      <mesh geometry={DASH_COWL_GEO}>
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>
      <mesh geometry={DASH_STITCH_GEO}>
        <primitive object={MAT.vrsRed} attach="material" />
      </mesh>
      <mesh position={[0.895, 0.835, 0]} rotation={[0, 0, -0.08]} geometry={INTERIOR_GEO.box} scale={[0.035, 0.18, 1.62]}>
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>
      <mesh position={[0.874, 0.895, 0.43]} geometry={INTERIOR_GEO.box} scale={[0.018, 0.17, 0.52]}>
        <primitive object={MAT.alcantara} attach="material" />
      </mesh>

      <InstrumentCluster speedoRef={speedoRef} />
      <CenterStack />
      <SteeringWheel wheelRef={wheelRef} />

      {/* Centre tunnel, selector, electronic brake, and twin cup holders. */}
      <mesh position={[0.08, 0.5, 0]} geometry={INTERIOR_GEO.box} scale={[1.15, 0.28, 0.3]}>
        <primitive object={MAT.dash} attach="material" />
      </mesh>
      <mesh position={[0.12, 0.65, 0]} rotation={[0, 0, -0.03]} geometry={INTERIOR_GEO.box} scale={[0.98, 0.055, 0.27]}>
        <primitive object={MAT.glossBlack} attach="material" />
      </mesh>
      <mesh position={[0.11, 0.682, -0.135]} geometry={INTERIOR_GEO.box} scale={[0.82, 0.008, 0.01]}>
        <primitive object={MAT.redAccent} attach="material" />
      </mesh>
      <mesh position={[0.38, 0.7, 0]} geometry={INTERIOR_GEO.box} scale={[0.14, 0.08, 0.12]}>
        <primitive object={MAT.leather} attach="material" />
      </mesh>
      <mesh position={[0.39, 0.77, 0]} geometry={INTERIOR_GEO.cylinder} scale={[0.018, 0.09, 0.018]}>
        <primitive object={MAT.chrome} attach="material" />
      </mesh>
      <mesh position={[0.385, 0.84, 0]} rotation={[0, 0, -0.18]} geometry={INTERIOR_GEO.sphere} scale={[0.065, 0.09, 0.055]}>
        <primitive object={MAT.leather} attach="material" />
      </mesh>
      <mesh position={[0.35, 0.844, -0.05]} geometry={INTERIOR_GEO.box} scale={[0.035, 0.018, 0.01]}>
        <primitive object={MAT.vrsRed} attach="material" />
      </mesh>
      <mesh position={[-0.31, 0.72, -0.08]} rotation={[0, 0, -0.12]} geometry={INTERIOR_GEO.box} scale={[0.28, 0.06, 0.065]}>
        <primitive object={MAT.leather} attach="material" />
      </mesh>
      <mesh position={[-0.2, 0.735, -0.08]} geometry={INTERIOR_GEO.box} scale={[0.045, 0.02, 0.07]}>
        <primitive object={MAT.button} attach="material" />
      </mesh>
      {[-0.08, -0.27].map((x) => (
        <mesh key={x} position={[x, 0.687, 0.055]} rotation={[Math.PI / 2, 0, 0]} geometry={INTERIOR_GEO.cupRing} scale={0.07}>
          <primitive object={MAT.chrome} attach="material" />
        </mesh>
      ))}

      <Seat position={[-0.18, 0, -0.44]} />
      <Seat position={[-0.18, 0, 0.44]} />
      <DoorPanel side={-1} />
      <DoorPanel side={1} />

      {/* Glazing, pillars, and headliner close the cabin without crossing the body shell. */}
      {[-0.87, 0.87].map((z) => (
        <mesh key={z} position={[1.32, 1.30, z]} rotation={[0, 0, 0.94]} geometry={INTERIOR_GEO.box} scale={[0.06, 0.8, 0.07]}>
          <primitive object={MAT.liner} attach="material" />
        </mesh>
      ))}
      <group position={[1.32, 1.30, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <mesh rotation={[0.94, 0, 0]} geometry={INTERIOR_GEO.plane} scale={[1.72, 0.95, 1]}>
          <primitive object={MAT.glass} attach="material" />
        </mesh>
      </group>
      {([-1, 1] as const).map((side) => (
        <mesh
          key={side}
          position={[0.06, 1.16, 0.915 * side]}
          rotation={[0, side === 1 ? Math.PI : 0, 0]}
          geometry={INTERIOR_GEO.plane}
          scale={[2.05, 0.31, 1]}
        >
          <primitive object={MAT.glass} attach="material" />
        </mesh>
      ))}
      <mesh position={[-1.05, 1.15, 0]} rotation={[0, Math.PI / 2, 0]} geometry={INTERIOR_GEO.plane} scale={[1.65, 0.29, 1]}>
        <primitive object={MAT.glass} attach="material" />
      </mesh>
      <mesh position={[0.04, 1.534, 0]} geometry={INTERIOR_GEO.box} scale={[2.0, 0.025, 1.72]}>
        <primitive object={MAT.liner} attach="material" />
      </mesh>
      {[-0.48, 0.48].map((z) => (
        <mesh key={z} position={[0.78, 1.505, z]} rotation={[0, 0, -0.08]} geometry={INTERIOR_GEO.box} scale={[0.42, 0.025, 0.3]}>
          <primitive object={MAT.liner} attach="material" />
        </mesh>
      ))}
      <mesh position={[1.05, 1.5, 0]} geometry={INTERIOR_GEO.cylinder} scale={[0.012, 0.065, 0.012]}>
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>
      <mesh position={[1.0, 1.455, 0]} geometry={INTERIOR_GEO.box} scale={[0.045, 0.095, 0.29]}>
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>
      <mesh position={[0.974, 1.455, 0]} geometry={INTERIOR_GEO.box} scale={[0.009, 0.07, 0.245]}>
        <primitive object={MAT.mirror} attach="material" />
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
export function DrivableCar({
  lot,
  carGroupsRef,
  speedRef,
  parkedCars,
  roadSegments,
  pov = false,
  assignedSlot,
  playerStatus,
  leaving,
  runId,
  onReportNode,
  onLeaveBay,
}: DrivableCarProps) {
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
  // Node bookkeeping: which node was last reported to the sim, when the area
  // scan last ran, and how long the car has been nearly stopped (parking).
  const reportedNodeRef = useRef<string | null>(null);
  const nodeScanAtRef = useRef(0);
  const slowSinceRef = useRef<number | null>(null);
  const keys = useKeyboard();

  // Pre-compute ramp curves for height sampling.
  const rampCurves = useMemo(() => buildRampCurves(lot), [lot]);

  // Lot bounds for collision clamping.
  const bounds = useMemo(() => slabBounds(lot), [lot]);
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

  // World-space XZ positions of every non-slot node per floor, for reporting
  // where the car physically is. Slots are handled separately so that only
  // the player's own assigned bay can ever be reported as a slot node.
  const guideNodes = useMemo(() => {
    const out: { id: string; x: number; z: number; floor: number; type: string }[] = [];
    for (const [id, node] of Object.entries(lot.nodes)) {
      if (node.type === "slot" || node.type === "approach") continue;
      const [x, , z] = toWorld(node.x, node.y, node.floor);
      out.push({ id, x, z, floor: node.floor, type: node.type });
    }
    return out;
  }, [lot]);

  const exitNodeId = useMemo(
    () =>
      Object.entries(lot.nodes).find(([, node]) => node.type === "exit")?.[0] ?? null,
    [lot],
  );
  const assignedSlotPos = useMemo(() => {
    if (!assignedSlot) return null;
    const node = lot.nodes[assignedSlot];
    if (!node) return null;
    const [x, , z] = toWorld(node.x, node.y, node.floor);
    return { x, z, floor: node.floor };
  }, [assignedSlot, lot]);

  // Spawn behind the entry gate on the approach road, in the lane the entry
  // aisle flows (+x traffic at z = centreline - LANE_WIDTH/2), facing the
  // portal. The approach segment is covered by roadSegments (which includes
  // approach nodes) and sits inside the slab bounds clamp, so the first
  // clamped frame does not move the car.
  const spawn = useMemo(() => {
    const approach = lot.nodes["ENTRY_ROAD"] ?? lot.nodes["E0"];
    const [x, y, z] = toWorld(approach.x, approach.y, approach.floor);
    const spawnX = Math.max(x, bounds.minX + 1);
    return {
      pos: [spawnX, y + ROAD_Y + CAR_Y_OFFSET, z + LANE_SHIFT] as [number, number, number],
      heading: 0,
    };
  }, [lot, bounds]);

  /** Reset pose + physics to the spawn state. Used on mount and whenever a
   *  new run starts (entering the garage, respawn after exiting, reset). */
  const teleportToSpawn = () => {
    const g = groupRef.current;
    if (!g) return;
    g.position.set(spawn.pos[0], spawn.pos[1], spawn.pos[2]);
    g.rotation.set(0, spawn.heading, 0);
    headingRef.current = spawn.heading;
    prevHeadingRef.current = spawn.heading;
    velocityRef.current = 0;
    lateralVelRef.current = 0;
    steerAngleRef.current = 0;
    floorRef.current = 0;
    reportedNodeRef.current = null;
    slowSinceRef.current = null;
    if (shadowRef.current) {
      shadowRef.current.position.set(spawn.pos[0], spawn.pos[1] - CAR_Y_OFFSET - ROAD_Y + SHADOW_LIFT, spawn.pos[2]);
    }
  };

  useEffect(() => {
    teleportToSpawn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every run bump (entering drive mode, respawn at the entry, garage reset)
  // puts the car back on the approach road.
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false;
      return;
    }
    teleportToSpawn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // L vacates the current bay and asks the backend for exit guidance. Only
  // meaningful once the backend agrees the car is parked.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "KeyL") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (playerStatus !== "parked") return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) return;
      onLeaveBay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onLeaveBay, playerStatus]);

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

    // Register this car every frame so the camera rig can find it. The group
    // is also named so scene-graph probes can find it by id.
    carGroupsRef.current.set(PLAYER_CAR_KEY, g);
    if (g.name !== PLAYER_CAR_KEY) g.name = PLAYER_CAR_KEY;

    // --- Input (WASD + arrow keys) ---
    const accel = keys.current["KeyW"] || keys.current["ArrowUp"] ? 1 : 0;
    const brake = keys.current["KeyS"] || keys.current["ArrowDown"] ? 1 : 0;
    const steerLeft = keys.current["KeyA"] || keys.current["ArrowLeft"] ? 1 : 0;
    const steerRight = keys.current["KeyD"] || keys.current["ArrowRight"] ? 1 : 0;

    // --- Longitudinal physics with drag + rolling resistance ---
    // S is a brake first and a reverse throttle second: while rolling forward
    // it decelerates toward zero, and only from (almost) standstill does it
    // start driving backwards — with a gentler pedal than the brake. The old
    // code applied -28 u/s^2 the instant S went down, so tapping S at rest
    // lurched the car straight into reverse.
    if (accel) velocityRef.current += ACCEL_RATE * dt;
    if (brake) {
      if (velocityRef.current > BRAKE_TO_REVERSE_EPSILON) {
        // Braking phase: clamp at zero so one long frame can't overshoot
        // into reverse without the dead band being honoured.
        velocityRef.current = Math.max(0, velocityRef.current - BRAKE_RATE * dt);
      } else {
        velocityRef.current -= REVERSE_ACCEL * dt;
      }
    }
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
    // Full steering authority arrives at 1.5 u/s instead of 3, so creeping
    // into a bay still steers. The old /3 divisor made low-speed turns feel
    // dead and then suddenly grab.
    // Above STEER_FADE_START the authority bleeds back off linearly, removing
    // up to STEER_HIGH_SPEED_FADE of it at MAX_SPEED — otherwise the yaw rate
    // is identical at a crawl and at flat out, which reads as the car
    // pirouetting on its own axis at speed.
    const speedFactor = Math.min(1, speed / 1.5);
    const fadeT = Math.min(
      1,
      Math.max(0, (speed - STEER_FADE_START) / (MAX_SPEED - STEER_FADE_START)),
    );
    const highSpeedFactor = 1 - STEER_HIGH_SPEED_FADE * fadeT;
    const turn =
      steerAngleRef.current * TURN_RATE * dt * speedFactor * highSpeedFactor;
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
    const flatFloorY = floorRef.current * FLOOR_HEIGHT + ROAD_Y;
    let groundY = flatFloorY;
    let bestRamp: RampCurve | null = null;
    let bestRampDist = Infinity;
    let bestRampSurfaceY = flatFloorY;
    let bestRampVerticalDelta = Infinity;

    for (const ramp of rampCurves) {
      if (ramp.fromFloor !== floorRef.current && ramp.toFloor !== floorRef.current) continue;

      const rampDist = projectOnPolyline(ramp.points, g.position.x, g.position.z).dist;
      if (rampDist >= RAMP_TRIGGER_DIST) continue;

      const rampSurfaceY = rampHeightAt(ramp, g.position.x, g.position.z) + ROAD_Y;
      // Ground-to-ground delta (g.position.y carries CAR_Y_OFFSET; the ramp
      // surface does not).
      const verticalDelta = Math.abs(rampSurfaceY - (g.position.y - CAR_Y_OFFSET));
      // A deck floating more than MAX_RAMP_CAPTURE_DELTA above or below the
      // car is scenery, not road — most importantly the A->B ramp passing
      // ~13 units over the entrance, which used to yank the freshly spawned
      // car up onto it on frame one because candidacy only checked floors.
      if (verticalDelta >= MAX_RAMP_CAPTURE_DELTA) continue;
      // Stacked ramps have identical XZ paths. Vertical continuity, then XZ
      // distance, makes the ramp touching the car the only valid candidate.
      // Invariant: floor 1's upper ramp can never sample floor 0's ramp height.
      if (
        verticalDelta < bestRampVerticalDelta - 1e-4 ||
        (Math.abs(verticalDelta - bestRampVerticalDelta) <= 1e-4 && rampDist < bestRampDist)
      ) {
        bestRamp = ramp;
        bestRampDist = rampDist;
        bestRampSurfaceY = rampSurfaceY;
        bestRampVerticalDelta = verticalDelta;
      }
    }

    // Only the genuinely sloped portion captures the car. The much smaller
    // rescaled tolerance removes the old one-unit dead zone while keeping the
    // shared flat endpoint free of ramp clamping.
    const onRamp =
      bestRamp != null && Math.abs(bestRampSurfaceY - flatFloorY) > RAMP_FLAT_EPSILON;

    // --- Ramp edge clamp: keep the car within the road width of the ramp
    // centerline so it can't drive off the side and teleport/clip. Done
    // after ramp detection (which sets onRamp/bestRamp) but before the
    // height/pitch sampling so the sampled height is valid.
    if (onRamp && bestRamp) {
      // Segment-accurate projection + push-back inside the shared band
      // width; returns the surface Y at the clamped spot for sampling below.
      bestRampSurfaceY = clampIntoRampBand(bestRamp, g.position);
    }

    let targetPitch = 0;
    if (onRamp && bestRamp) {
      groundY = bestRampSurfaceY;
      // Compute pitch from the ramp slope: walk a look-ahead run ALONG the
      // centreline curve, then set rotation.z to match the rise over run.
      // The car model faces +X, so pitch is rotation about the Z axis.
      // In three.js, a positive rotation.z tilts the nose UP for a +X-facing
      // car, and rampPitchAlongCurve returns positive when climbing, so no
      // negation.
      const lookAhead = 2.0;
      targetPitch = rampPitchAlongCurve(bestRamp, g.position.x, g.position.z, lookAhead);

      const fromFloorY = bestRamp.fromFloor * FLOOR_HEIGHT + ROAD_Y;
      const toFloorY = bestRamp.toFloor * FLOOR_HEIGHT + ROAD_Y;
      // Floor ownership transfers only at a flush ramp endpoint, never at the
      // geometric midpoint. Invariant: one ramp remains selected for the whole climb.
      if (
        floorRef.current === bestRamp.fromFloor &&
        Math.abs(groundY - toFloorY) <= RAMP_ENDPOINT_HEIGHT_EPSILON
      ) {
        floorRef.current = bestRamp.toFloor;
      } else if (
        floorRef.current === bestRamp.toFloor &&
        Math.abs(groundY - fromFloorY) <= RAMP_ENDPOINT_HEIGHT_EPSILON
      ) {
        floorRef.current = bestRamp.fromFloor;
      }
    } else {
      groundY = flatFloorY;
    }
    g.position.y = groundY + CAR_Y_OFFSET;

    // Keep the blob shadow flat on the floor surface beneath the car
    // (independent of the car's pitch so it never tilts on ramps). The
    // height is SHADOW_LIFT, chosen below the FloorPaint plane - see the
    // constant's comment.
    if (shadowRef.current) {
      shadowRef.current.position.set(g.position.x, groundY + SHADOW_LIFT, g.position.z);
    }

    // --- Pitch (inclination): smoothly interpolate toward target ---
    // On flat ground targetPitch is 0, so the car levels out. On the ramp
    // it tilts to match the slope. We lerp for smooth transitions at the
    // ramp entry/exit so the car doesn't snap.
    const pitchLerp = 1 - Math.pow(0.001, dt);
    g.rotation.z += (targetPitch - g.rotation.z) * pitchLerp;

    // --- Collision: clamp to lot bounds + vertical limits ---
    // Skip the XZ clamp only inside the tightly captured ramp envelope. The
    // rebuilt ramp reaches x≈-11 outside the slab, so the lot clamp would cut
    // it off; the ramp edge clamp above remains the controlling boundary.
    if (!onRamp) {
      g.position.x = Math.max(bounds.minX, Math.min(bounds.maxX, g.position.x));
      g.position.z = Math.max(bounds.minZ, Math.min(bounds.maxZ, g.position.z));
    }
    g.position.y = Math.max(
      CAR_Y_OFFSET,
      Math.min(maxFloor * FLOOR_HEIGHT + ROAD_Y + CAR_Y_OFFSET, g.position.y),
    );

    // --- Collision: two-disc capsule vs other cars -------------------------
    // The old single circle (r=1.6) sat at the car centre, so the 4.5-long
    // body's nose and corners clipped straight through parked cars while its
    // flanks could not reach gaps the car visibly fits through. Two discs of
    // r=0.9 at ±1.1 along the heading track the body instead. Response is
    // resolved nearest-penetration-first; each correction moves the car out
    // by exactly the penetration depth along the contact normal (no
    // teleporting to a fixed radius), and only the velocity component along
    // that normal responds — tangential momentum survives, so scraping along
    // a row of cars scrubs speed honestly instead of the old blanket
    // *= 0.3 stop.
    interface CarContact {
      ox: number;
      oz: number;
      pen: number;
    }
    const contacts: CarContact[] = [];
    const consider = (ox: number, oz: number) => {
      for (const sign of [1, -1] as const) {
        const discX = g.position.x + Math.cos(heading) * CAPSULE_DISC_OFFSET * sign;
        const discZ = g.position.z - Math.sin(heading) * CAPSULE_DISC_OFFSET * sign;
        const dist = Math.hypot(discX - ox, discZ - oz);
        const pen = CAPSULE_DISC_RADIUS + OTHER_CAR_RADIUS - dist;
        if (pen > 0) {
          contacts.push({ ox, oz, pen });
          return;
        }
      }
    };
    for (const [id, otherGroup] of carGroupsRef.current) {
      if (id === PLAYER_CAR_KEY) continue;
      // Skip cars on a different floor (cross-floor false collisions).
      if (Math.abs(g.position.y - otherGroup.position.y) > 2.0) continue;
      consider(otherGroup.position.x, otherGroup.position.z);
    }
    for (const pc of parkedCars) {
      // Skip parked cars on a different floor (cross-floor false collisions).
      if (Math.abs(g.position.y - pc.y) > 2.0) continue;
      consider(pc.x, pc.z);
    }

    if (contacts.length > 0) {
      // Shallowest penetration first: resolving glancing contacts before
      // deep ones keeps the push-out direction stable when several cars
      // overlap the capsule.
      contacts.sort((a, b) => a.pen - b.pen);

      // World velocity in the CURRENT heading basis (prevHeadingRef was set
      // to `heading` after the move above, so this is exact).
      let worldVx = cosH * velocityRef.current + sinH * lateralVelRef.current;
      let worldVz = -sinH * velocityRef.current + cosH * lateralVelRef.current;

      for (const contact of contacts) {
        // Nearest own disc to this obstacle — the contact lives on it.
        const d0X = g.position.x + cosH * CAPSULE_DISC_OFFSET;
        const d0Z = g.position.z - sinH * CAPSULE_DISC_OFFSET;
        const d1X = g.position.x - cosH * CAPSULE_DISC_OFFSET;
        const d1Z = g.position.z + sinH * CAPSULE_DISC_OFFSET;
        const dist0 = Math.hypot(d0X - contact.ox, d0Z - contact.oz);
        const dist1 = Math.hypot(d1X - contact.ox, d1Z - contact.oz);
        const discX = dist0 <= dist1 ? d0X : d1X;
        const discZ = dist0 <= dist1 ? d0Z : d1Z;
        const dist = Math.min(dist0, dist1);
        if (dist < 1e-4) continue; // dead centre overlap; no sane normal exists
        const nx = (discX - contact.ox) / dist;
        const nz = (discZ - contact.oz) / dist;
        const pen = CAPSULE_DISC_RADIUS + OTHER_CAR_RADIUS - dist;
        if (pen <= 0) continue; // an earlier push already cleared this one

        // Positional correction only up to the penetration depth.
        g.position.x += nx * pen;
        g.position.z += nz * pen;

        // Velocity responds only along the normal; keep tangential flow.
        const vn = worldVx * nx + worldVz * nz;
        if (vn < 0) {
          worldVx -= nx * vn * (1 + COLLISION_RESTITUTION);
          worldVz -= nz * vn * (1 + COLLISION_RESTITUTION);
        }
      }

      velocityRef.current = worldVx * cosH - worldVz * sinH;
      lateralVelRef.current = worldVx * sinH + worldVz * cosH;
    }

    // --- Final boundary pass ----------------------------------------------
    // Runs LAST so the frame can never end outside the corridor: collisions
    // above may shove the car across a guardrail or off the ramp band, and
    // they used to run after these clamps and win. Flat ground re-applies
    // the road-edge corridor; ramps re-apply their band clamp (and re-sample
    // height, since the clamp can move the car along the slope).
    //
    // Road-edge rules: skipped on ramps (they have their own band clamp) and
    // near slot nodes (allows driving into parking bays that extend beyond
    // the road width). Only segments on the current floor are considered.
    // The slot-exception radius is SLOT_WIDTH/2 + 1 (≈2.25) — small enough
    // that it only fires when the car is actually at a slot entrance, not
    // when it's on the aisle (the aisle centerline is SLOT_OFFSET=6 units
    // from the nearest slot, so a radius of 2.25 never fires on the aisle).
    if (onRamp && bestRamp) {
      g.position.y = clampIntoRampBand(bestRamp, g.position) + CAR_Y_OFFSET;
    } else {
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
        if (bestDist > ROAD_CORRIDOR_HALF_WIDTH && bestDist < Infinity) {
          const nx = (bestX - g.position.x) / bestDist;
          const nz = (bestZ - g.position.z) / bestDist;
          g.position.x = bestX - nx * ROAD_CORRIDOR_HALF_WIDTH;
          g.position.z = bestZ - nz * ROAD_CORRIDOR_HALF_WIDTH;
        }
      }
    }

    // Publish speed for the HUD and the interior speedometer.
    liveSpeedRef.current = velocityRef.current;
    if (speedRef) {
      speedRef.current.speed = velocityRef.current;
    }

    // --- Guidance reporting: where is the car on the graph? ---
    // The sim needs a node id to route from. Every ~150 ms, find the nearest
    // non-slot node on the current floor; report it when the car is close
    // enough that "at" is honest. Slot nodes are special: only the player's
    // own assigned bay can be reported as a slot node, and only after the car
    // has sat nearly still inside it briefly — that is what "parked" means.
    const now = performance.now();
    if (now - nodeScanAtRef.current > 150) {
      nodeScanAtRef.current = now;
      let bestId: string | null = null;
      let bestDist = Infinity;
      for (const candidate of guideNodes) {
        if (candidate.floor !== floorRef.current) continue;
        const d = Math.hypot(g.position.x - candidate.x, g.position.z - candidate.z);
        if (d < bestDist) {
          bestDist = d;
          bestId = candidate.id;
        }
      }
      let toReport: string | null = null;
      if (bestId && bestDist < 3.5) {
        toReport = bestId;
      }
      // Parking detection: settled inside the assigned bay.
      if (assignedSlotPos && !leaving) {
        const nearBay =
          assignedSlotPos.floor === floorRef.current &&
          Math.hypot(g.position.x - assignedSlotPos.x, g.position.z - assignedSlotPos.z) < 2.4;
        const settled = Math.abs(velocityRef.current) < 0.4;
        if (nearBay && settled) {
          if (slowSinceRef.current === null) slowSinceRef.current = now;
          else if (now - slowSinceRef.current > 600) toReport = assignedSlot;
        } else {
          slowSinceRef.current = null;
        }
      }
      // Leaving: report the exit node when reached so the backend closes out
      // the run ("left").
      if (leaving && exitNodeId) {
        const exitNode = lot.nodes[exitNodeId];
        if (exitNode.floor === floorRef.current) {
          const [ex, , ez] = toWorld(exitNode.x, exitNode.y, exitNode.floor);
          if (Math.hypot(g.position.x - ex, g.position.z - ez) < 4) {
            toReport = exitNodeId;
          }
        }
      }
      if (toReport && toReport !== reportedNodeRef.current) {
        reportedNodeRef.current = toReport;
        onReportNode(toReport);
      }
    }

    // --- Wheel spin + front wheel steering animation ---
    // Spin and steer live on separate nested groups so they never share an
    // object's Euler angles (which would couple them and make the front
    // wheels tumble). Spin is on the innermost group (local Y = axle after
    // the π/2 X parent); steer is on the outermost group (world Y).
    // Correct angular velocity: v / r. Wheel radius is 0.34.
    const wheelSpin = velocityRef.current / 0.34 * dt;
    // Render the SAME angle the physics steers by. The old *0.6 made the
    // wheels lie about where the car was going.
    const visualSteer = steerAngleRef.current;
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
        <CarExterior wheelRefs={wheelRefs} steerRefs={steerRefs} />
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
