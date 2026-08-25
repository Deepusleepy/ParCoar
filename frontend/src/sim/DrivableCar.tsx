import { Suspense, memo, useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { CarStatus, LotData, LotEdge } from "../types";
import { useKeyboard } from "../hooks/useKeyboard";
import { rampPoints, slabBounds } from "./geometry";
import { nodeGap } from "./traffic";
import { updatePlayerPos } from "../hooks/useSimulation";
import type { RoadSegment } from "./roadSegments";
import {
  AISLE_SPACING,
  CAR_Y_OFFSET,
  FLOOR_HEIGHT,
  LANE_WIDTH,
  ROAD_WIDTH,
  SLOT_OFFSET,
  toWorld,
} from "./constants";

/** Key under which the drivable car registers itself in the shared carGroups map. */
export const PLAYER_CAR_KEY = "player";

/** Shared ref shape for communicating live speed to the HUD. */
export interface PlayerSpeedRef {
  speed: number;
  /** Live steering input in [-1, 1] (left..right), for the POV cluster. */
  steer: number;
  /** Live remaining route distance in metres, updated every frame.
   *  Falls back to -1 when no route is available. */
  routeDistance: number;
  /** True when the car has driven past the destination slot. The HUD
   *  shows "behind — turn around" instead of the ahead distance. */
  overshot: boolean;
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
   *  PovCockpit provides the visible dash cowl and steering wheel. */
  pov?: boolean;
  /** The bay the backend has reserved for the player, if any. */
  assignedSlot: string | null;
  /** Ordered list of node ids the player is routed through (from server).
   *  Used to compute the live remaining route distance each frame. */
  routePath: string[];
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
  /** Called when auto-park becomes available/unavailable (player near
   *  assigned slot). The HUD shows a "Press P to park" prompt. */
  onAutoParkAvailable?: (available: boolean) => void;
  /** Called when the player settles in a non-assigned bay. The HUD shows
   *  a "Press L to park here" prompt. Pass the slot id and whether the
   *  prompt is active. */
  onWrongBayPrompt?: (slotId: string | null) => void;
}

/* ------------------------------------------------------------------ *
 *  Driving physics tuning
 * ------------------------------------------------------------------ */
const ACCEL_RATE = 10; // units/sec^2 when pressing W (was 14 — too instant)
const BRAKE_RATE = 22; // units/sec^2 when pressing S (was 28 — too abrupt)
const MAX_SPEED = 9; // forward speed cap (parking-appropriate)
const MAX_REVERSE = MAX_SPEED / 2; // reverse speed cap
const TURN_RATE = 3.0; // rad/sec at full steering
/** Speed above which full-lock steering starts to fade back off.
 *  Everything at or below this keeps IDENTICAL authority to before — parking
 *  manoeuvres must not get harder. */
const STEER_FADE_START = 3;
/** Fraction of steering authority removed at MAX_SPEED, ramping linearly
 *  from STEER_FADE_START up. A constant yaw rate at 9 u/s whips the
 *  car through hairpins a real car would sweep; trimming toward high speed
 *  keeps low speeds nimble and high speeds stable. */
const STEER_HIGH_SPEED_FADE = 0.25;
const FRICTION = 0.997; // velocity decay per frame when coasting (was 0.97 — felt like driving through sand)
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
const STEER_RETURN = 6.0; // how fast steering returns to center (rad/sec)
const MAX_STEER_ANGLE = 0.7; // max steering angle (~40°)
const GRIP = 0.86; // lateral grip: 1 = on rails, 0 = ice (0.85-0.92 sweet spot)
const ROLLING_RESISTANCE = 0.15; // drag while throttling (prevents linear accel)

/* ------------------------------------------------------------------ *
 *  Auto-park tuning
 * ------------------------------------------------------------------ */
/** Distance from the assigned slot within which auto-park is offered. */
const AUTO_PARK_OFFER_RADIUS = 12;
/** Auto-park animation duration (seconds). */
const AUTO_PARK_DURATION = 2.5;
/** Maximum heading difference (radians) for auto-park to be offered. */
const AUTO_PARK_MAX_HEADING_DIFF = Math.PI * 0.75;
/** Grace period (ms) before auto-accepting a wrong bay. The player gets
 *  this long to drive away or press L to accept. */
const WRONG_BAY_GRACE_MS = 10_000;
/** Distance (units) within which a settled car is considered "in a bay". */
const BAY_DETECT_RADIUS = 2.4;

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

/** Disc sign pairs used by the capsule collision check. Hoisted to module
 *  scope so the `[1, -1]` tuple literal is not re-allocated every call. */
const CAPSULE_SIGNS = [1, -1];

/** Reusable contact record for the capsule-vs-car collision pass. The
 *  contacts array is a fixed-capacity pool reset each frame (length = 0) so
 *  the per-frame collision pass never allocates. */
interface CarContact {
  ox: number;
  oz: number;
  pen: number;
}

/** Cell size for the parked-car spatial hash. Covers ~2x the collision radius
 *  (CAPSULE_DISC_RADIUS + OTHER_CAR_RADIUS = 1.8) so a 3x3 cell query around
 *  the player always contains every candidate that can overlap the capsule. */
const COLLISION_CELL_SIZE = 5;

/** Per-floor uniform grid of parked-car indices, rebuilt only when the
 *  parkedCars array changes. Keys are hashed cell coordinates. */
interface FloorGrid {
  cells: Map<number, number[]>;
}


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
const ROAD_CORRIDOR_HALF_WIDTH = ROAD_WIDTH / 2 - 0.1;

/** Hysteresis margin for the flat-road corridor clamp: the incumbent nearest
 *  segment is kept unless another segment beats it by more than this. Stops
 *  the argmin flipping between adjacent polyline edges and crossing aisles
 *  frame-to-frame, which nudged the car in alternating directions. */
const SEGMENT_HYSTERESIS_MARGIN = 0.4;

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
  /** XZ bounding box of the centerline, expanded by RAMP_TRIGGER_DIST so a
   *  cheap bbox-distance test can skip the per-point projectOnPolyline for
   *  ramps that are nowhere near the car. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
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

/** Reusable scratch pair for closestPointOnSegment2D — avoids a fresh
 *  tuple allocation on every call from the per-frame road-corridor argmin. */
const _closestPt: [number, number] = [0, 0];

/** Closest point on segment (a→b) to point (px,pz) in the XZ plane.
 *  Writes into the module-scope `_closestPt` scratch and returns it; callers
 *  must read the values before the next call (destructuring is safe). */
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
  if (lenSq < 1e-6) {
    _closestPt[0] = ax;
    _closestPt[1] = az;
    return _closestPt;
  }
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  _closestPt[0] = ax + t * dx;
  _closestPt[1] = az + t * dz;
  return _closestPt;
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

/** Reusable scratch for projectOnPolyline. The returned reference is the SAME
 *  object every call — callers must read index/t/dist before invoking
 *  projectOnPolyline (or anything that calls it) again. This eliminates the
 *  per-frame {index,t,dist} allocations on the hot driving path. */
const _polylineProj: PolylineProjection = { index: 0, t: 0, dist: 0 };

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
  _polylineProj.index = bestIndex;
  _polylineProj.t = bestT;
  _polylineProj.dist = Math.sqrt(bestDistSq);
  return _polylineProj;
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
      // Precompute the XZ bbox expanded by the trigger distance so the
      // per-frame ramp loop can reject far ramps with a single bbox test
      // instead of running projectOnPolyline over every centerline point.
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
      curves.push({
        points: pts,
        fromFloor: from.floor,
        toFloor: to.floor,
        minX: minX - RAMP_TRIGGER_DIST,
        maxX: maxX + RAMP_TRIGGER_DIST,
        minZ: minZ - RAMP_TRIGGER_DIST,
        maxZ: maxZ + RAMP_TRIGGER_DIST,
      });
    }
  }
  return curves;
}

/** Capsule-vs-point collision test. Pushes a contact into `contacts` if either
 *  disc overlaps the obstacle at (ox,oz). Hoisted to module scope so the
 *  per-frame collision pass does not allocate a fresh closure, and uses the
 *  precomputed cosH/sinH instead of re-deriving them from heading. */
function pushContact(
  contacts: CarContact[],
  posX: number,
  posZ: number,
  cosH: number,
  sinH: number,
  ox: number,
  oz: number,
): void {
  for (let s = 0; s < 2; s++) {
    const sign = CAPSULE_SIGNS[s];
    const discX = posX + cosH * CAPSULE_DISC_OFFSET * sign;
    const discZ = posZ - sinH * CAPSULE_DISC_OFFSET * sign;
    const dist = Math.hypot(discX - ox, discZ - oz);
    const pen = CAPSULE_DISC_RADIUS + OTHER_CAR_RADIUS - dist;
    if (pen > 0) {
      contacts.push({ ox, oz, pen });
      return;
    }
  }
}

/** Lateral velocity dead-zone. The grip decay `Math.pow(1-GRIP, dt*60)` leaves
 *  a steady-state lateral of only ~0.04 at 60fps / ~0.07 at 120fps, so the old
 *  0.12 deadzone was an absorbing trap that zeroed legitimate drift every
 *  frame and then let post-collision / post-corridor-clamp writes inject raw
 *  lateral that survived a full frame. 0.02 sits just above the steady-state
 *  noise floor so genuine drift reads through while float residue is clamped. */
const LATERAL_DEADZONE = 0.02;

/** Apply tire grip decay + lag-spike clamp + deadzone to a lateral velocity.
 *  Hoisted to module scope so the per-frame grip pass AND the post-collision /
 *  post-corridor-clamp lateral writes all go through the SAME treatment — a
 *  raw write after the grip pass used to bypass all three and kick the car
 *  sideways for a frame. latMax is scaled by dt (not a fixed 1/30) so the
 *  single-frame injection cap is frame-rate aware: it bounds the lateral a
 *  max-lock turn could bleed in THIS frame, no more. */
function applyLateralGrip(lat: number, fwdSpeed: number, dt: number): number {
  lat *= Math.pow(1 - GRIP, dt * 60);
  const dTurnMax = TURN_RATE * MAX_STEER_ANGLE * dt;
  const latMax = Math.abs(fwdSpeed) * Math.sin(dTurnMax);
  if (lat > latMax) lat = latMax;
  else if (lat < -latMax) lat = -latMax;
  if (Math.abs(lat) < LATERAL_DEADZONE) lat = 0;
  return lat;
}

/** Stable comparator for the contacts pool sort (shallowest penetration first).
 *  Hoisted to module scope so contacts.sort does not allocate a fresh closure
 *  every frame there is a contact. */
function compareContactPen(a: CarContact, b: CarContact): number {
  return a.pen - b.pen;
}

/** Scratch state for the AI-car collision forEach callback. Set before the
 *  forEach call so the module-scope callback can read the player's pose and
 *  contacts array without a per-frame closure or per-entry destructuring
 *  arrays (Map.forEach passes value+key as args, not as a tuple). */
const _aiCollisionScratch = {
  posY: 0,
  posX: 0,
  posZ: 0,
  cosH: 0,
  sinH: 0,
  contacts: null as CarContact[] | null,
};

/** Module-scope forEach callback for the AI-car collision pass. Reads the
 *  player pose from _aiCollisionScratch, which is set immediately before the
 *  forEach call in useFrame. */
function _aiCollisionCallback(otherGroup: THREE.Group, id: string): void {
  if (id === PLAYER_CAR_KEY) return;
  const s = _aiCollisionScratch;
  if (Math.abs(s.posY - otherGroup.position.y) > 2.0) return;
  pushContact(
    s.contacts as CarContact[],
    s.posX,
    s.posZ,
    s.cosH,
    s.sinH,
    otherGroup.position.x,
    otherGroup.position.z,
  );
}

/** Build a per-floor uniform grid indexing parked-car positions. Rebuilt only
 *  when the parkedCars array changes (memoized in the component). The player's
 *  collision pass queries the 3x3 cells around each of its two discs on the
 *  current floor, reducing candidate count from O(all parked cars) to ~5-10. */
function buildParkedCarGrid(
  parkedCars: ParkedCarPos[],
): Map<number, FloorGrid> {
  const byFloor = new Map<number, FloorGrid>();
  for (let i = 0; i < parkedCars.length; i++) {
    const pc = parkedCars[i];
    const floor = Math.round(pc.y / FLOOR_HEIGHT);
    let grid = byFloor.get(floor);
    if (!grid) {
      grid = { cells: new Map() };
      byFloor.set(floor, grid);
    }
    const cx = Math.floor(pc.x / COLLISION_CELL_SIZE);
    const cz = Math.floor(pc.z / COLLISION_CELL_SIZE);
    // Numeric cell key; cell coords are bounded by lot size so this is unique.
    const key = cx * 1000003 + cz;
    let bucket = grid.cells.get(key);
    if (!bucket) {
      bucket = [];
      grid.cells.set(key, bucket);
    }
    bucket.push(i);
  }
  return byFloor;
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
  // Ultra-low minimalist EV dash: crest at Y=0.85, well below the driver's
  // eye at 1.42. The thin fascia maximizes windscreen viewing area.
  const profile = new THREE.Shape();
  profile.moveTo(0.91, 0.72);
  profile.lineTo(1.46, 0.72);
  profile.quadraticCurveTo(1.58, 0.76, 1.58, 0.80);
  profile.lineTo(1.56, 0.82);
  profile.quadraticCurveTo(1.5, 0.85, 1.34, 0.85);
  profile.quadraticCurveTo(1.13, 0.83, 0.95, 0.80);
  profile.quadraticCurveTo(0.89, 0.76, 0.91, 0.72);
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
    new THREE.Vector3(0.93, 0.9, 0.79),
    new THREE.Vector3(0.94, 0.92, 0.34),
    new THREE.Vector3(0.925, 0.96, -0.1),
    new THREE.Vector3(0.89, 1.0, -0.45),
    new THREE.Vector3(0.93, 0.93, -0.79),
  ],
  0.03,
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
  /** When true, hide the opaque GLTF body panels so they don't block the
   *  driver's-eye view from inside the cabin. Wheels remain visible. */
  pov?: boolean;
}

/** Loads the GLTF body, removes wheel nodes, recolors with race-red clearcoat. */
function CarExteriorInner({ wheelRefs, steerRefs, pov = false }: CarExteriorProps) {
  const { scene } = useGLTF(PLAYER_MODEL_PATH);

  const { bodyMat, glassMat, scene: cloned } = useMemo(() => {
    const s = scene.clone();

    // Race-red clearcoat paint, distinct from AI car colours. FrontSide on
    // purpose: in POV the camera sits INSIDE this shell, and DoubleSide made
    // the opaque body panels wall off the cabin. With front-side culling the
    // body renders solidly from outside and vanishes from inside, where the
    // procedural PovCockpit supplies every surface the driver sees.
    const body = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color("#e0141b"),
      metalness: 0.45,
      roughness: 0.45,
      clearcoat: 0.8,
      clearcoatRoughness: 0.15,
      envMapIntensity: 0.7,
    });
    // Tinted near-opaque glass, matched to the AI cars' replacement glass in
    // Car.tsx: fully opaque #1a1d24 at low roughness reads as dark tinted
    // glass through its reflections alone. The old 0.5-alpha pane blended
    // the ground markings straight through the shell - exactly what the
    // "mirror is transparent" report described.
    const glass = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color("#1a1d24"),
      metalness: 0.1,
      roughness: 0.1,
      envMapIntensity: 0.8,
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
          view; the procedural PovCockpit provides the visible dashboard. */}
      <primitive object={cloned} rotation={[0, PLAYER_FORWARD_ROT, 0]} scale={PLAYER_MODEL_SCALE} visible={!pov} />

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
 *  PovCockpit — the minimal cockpit framed for the rigid POV eye
 *
 *  Local space: +X = forward, +Y = up, -Z = driver side (RHD). The camera
 *  sits rigidly at (0.30, 1.38, -0.42) looking down +X (CameraRig owns the
 *  exact placement). Everything here is composed so the road stays clear:
 *  the dash reads as a low dark cowl along the bottom of the frame and only
 *  the steering wheel rim's top arc enters at the bottom right. The full
 *  seats/doors/console interior was removed — it never read as premium at
 *  this art scale, and every surface in view competes with the road.
 *  Speed, guidance and steering live in the HTML PovCluster overlay.
 * ------------------------------------------------------------------ */
interface PovCockpitProps {
  /** Live steering input in [-1, 1]; drives the wheel rim animation. */
  steerRef: React.MutableRefObject<number>;
}

function PovCockpit({ steerRef }: PovCockpitProps) {
  const wheelRef = useRef<THREE.Group>(null);
  const smoothSteer = useRef(0);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 30);
    const target = steerRef.current * 2.2;
    smoothSteer.current += (target - smoothSteer.current) * Math.min(1, dt * 12);
    if (wheelRef.current) wheelRef.current.rotation.z = -smoothSteer.current;
  });

  return (
    <group>
      {/* One extruded shell supplies the rolled fascia and windscreen-facing
          upper curve. Crest at Y=0.85 stays well below the 1.38 eye. */}
      <mesh geometry={DASH_SHELL_GEO}>
        <primitive object={MAT.dash} attach="material" />
      </mesh>
      <mesh geometry={DASH_COWL_GEO}>
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>
      {/* Vertical fascia under the dash crest closes the silhouette. */}
      <mesh position={[0.895, 0.835, 0]} rotation={[0, 0, -0.08]} geometry={INTERIOR_GEO.box} scale={[0.035, 0.18, 1.62]}>
        <primitive object={MAT.dashTrim} attach="material" />
      </mesh>

      <SteeringWheel wheelRef={wheelRef} />

      {/* Hood: a dark surface extending forward from the dashboard top.
          Grounds the bottom of the view in the car's physical extent. */}
      <mesh position={[2.0, 0.78, 0]} rotation={[0, 0, -0.06]} geometry={INTERIOR_GEO.box} scale={[1.2, 0.04, 1.7]}>
        <primitive object={MAT.dash} attach="material" />
      </mesh>

      {/* Glazing and ultra-thin pillars: enclosure at the frame edges. */}
      {[-0.87, 0.87].map((z) => (
        <mesh key={z} position={[1.32, 1.28, z]} rotation={[0, 0, 0.94]} geometry={INTERIOR_GEO.box} scale={[0.02, 0.7, 0.02]}>
          <primitive object={MAT.liner} attach="material" />
        </mesh>
      ))}
      <group position={[1.32, 1.28, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <mesh rotation={[0.94, 0, 0]} geometry={INTERIOR_GEO.plane} scale={[1.72, 1.1, 1]}>
          <primitive object={MAT.glass} attach="material" />
        </mesh>
      </group>
      {([-1, 1] as const).map((side) => (
        <mesh
          key={side}
          position={[0.06, 1.12, 0.915 * side]}
          rotation={[0, side === 1 ? Math.PI : 0, 0]}
          geometry={INTERIOR_GEO.plane}
          scale={[2.05, 0.36, 1]}
        >
          <primitive object={MAT.glass} attach="material" />
        </mesh>
      ))}
    </group>
  );
}

function SteeringWheel({ wheelRef }: { wheelRef: React.RefObject<THREE.Group | null> }) {
  return (
    /* Positioned so only the rim's top arc rises into the bottom-right of
       the POV frame: rim top ≈ 1.10 vs the 1.38 eye at ~0.5 ahead puts the
       arc ~28° below the horizon, and z sits right of the eye (the car
       projects -z to the left, so RHD means z closer to 0). */
    <group position={[0.82, 0.9, -0.28]} rotation={[0, Math.PI / 2, 0]}>
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
        {/* Two slim spokes meet a compact round hub; only the rim and spoke
            tops are ever visible from the eye. */}
        <mesh position={[-0.105, 0.03, 0]} rotation={[0, 0, -0.28]} geometry={INTERIOR_GEO.box} scale={[0.16, 0.045, 0.035]}>
          <primitive object={MAT.dashTrim} attach="material" />
        </mesh>
        <mesh position={[0.105, 0.03, 0]} rotation={[0, 0, 0.28]} geometry={INTERIOR_GEO.box} scale={[0.16, 0.045, 0.035]}>
          <primitive object={MAT.dashTrim} attach="material" />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]} geometry={INTERIOR_GEO.cylinder} scale={[0.075, 0.04, 0.075]}>
          <primitive object={MAT.leather} attach="material" />
        </mesh>
      </group>
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
 * a minimal dash cowl + steering wheel (visible from the POV camera).
 */
export const DrivableCar = memo(function DrivableCar({
  lot,
  carGroupsRef,
  speedRef,
  parkedCars,
  roadSegments,
  pov = false,
  assignedSlot,
  routePath,
  playerStatus,
  leaving,
  runId,
  onReportNode,
  onLeaveBay,
  onAutoParkAvailable,
  onWrongBayPrompt,
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
  // Body roll angle (rotation.x) — the car leans into turns like a real
  // car on suspension. Smoothed toward a target derived from lateral
  // acceleration (steerAngle × velocity). Without this the car feels like
  // a hovercraft — no weight transfer cues at all.
  const bodyRollRef = useRef(0);
  const steerInputRef = useRef(0); // live steering input for the wheel visual
  const steerAngleRef = useRef(0); // smoothed steering angle (radians)
  const floorRef = useRef(0); // current floor (for flat-ground height)
  const liveSpeedRef = useRef(0); // numeric speed feed for the HUD
  const wheelRefs = useRef<(THREE.Group | null)[]>([null, null, null, null]);
  const steerRefs = useRef<(THREE.Group | null)[]>([null, null, null, null]);
  // Node bookkeeping: which node was last reported to the sim, when the area
  // scan last ran, and how long the car has been nearly stopped (parking).
  const reportedNodeRef = useRef<string | null>(null);
  const nodeScanAtRef = useRef(0);
  const slowSinceRef = useRef<number | null>(null);
  // Incumbent nearest road segment for the corridor clamp hysteresis. Keeps
  // the argmin from flipping between adjacent polyline edges frame-to-frame.
  const incumbentSegRef = useRef<RoadSegment | null>(null);
  const keys = useKeyboard();

  // --- Auto-park state ---
  // When active, the physics is overridden and the car smoothly interpolates
  // to the assigned slot position and heading. Activated by pressing P when
  // near the slot; cancelled by pressing any movement key.
  const autoParkRef = useRef<{
    active: boolean;
    t: number; // 0..1 progress
    startPos: THREE.Vector3;
    startHeading: number;
    targetPos: THREE.Vector3;
    targetHeading: number;
  } | null>(null);
  const autoParkOfferedRef = useRef(false);
  const onAutoParkAvailableRef = useRef(onAutoParkAvailable);
  // Wrong-bay detection: when the player settles in a non-assigned bay,
  // show a prompt and allow L to accept it. After a grace period, auto-accept.
  const wrongBayRef = useRef<{
    slotId: string;
    settledAt: number; // timestamp when first detected
  } | null>(null);
  const wrongBayPromptRef = useRef(false);
  const onWrongBayPromptRef = useRef(onWrongBayPrompt);
  onWrongBayPromptRef.current = onWrongBayPrompt;
  onAutoParkAvailableRef.current = onAutoParkAvailable;

  // Pre-compute ramp curves for height sampling.
  const rampCurves = useMemo(() => buildRampCurves(lot), [lot]);

  // Ramps bucketed by floor (each ramp appears in both its fromFloor and
  // toFloor buckets) so the per-frame ramp scan only iterates ramps that
  // touch the current floor instead of all ramps every frame.
  const rampsByFloor = useMemo(() => {
    const m = new Map<number, RampCurve[]>();
    for (const r of rampCurves) {
      let b = m.get(r.fromFloor);
      if (!b) { b = []; m.set(r.fromFloor, b); }
      b.push(r);
      if (r.toFloor !== r.fromFloor) {
        let b2 = m.get(r.toFloor);
        if (!b2) { b2 = []; m.set(r.toFloor, b2); }
        b2.push(r);
      }
    }
    return m;
  }, [rampCurves]);

  // Lot bounds for collision clamping.
  const bounds = useMemo(() => slabBounds(lot), [lot]);
  const maxFloor = useMemo(
    () => Math.max(...Object.values(lot.nodes).map((n) => n.floor)),
    [lot],
  );

  // World-space XZ positions of all slot nodes, for the slot-area exception
  // in the road clamp (allows the car to drive off the road into parking bays).
  // Also used for wrong-bay detection (checking all slots, not just assigned).
  // Bucketed by floor so the per-frame slot-exception check only iterates the
  // current floor's slots.
  const slotPositionsByFloor = useMemo(() => {
    const m = new Map<number, { id: string; x: number; z: number; floor: number }[]>();
    for (const [id, node] of Object.entries(lot.nodes)) {
      if (node.type !== "slot") continue;
      const [x, , z] = toWorld(node.x, node.y, node.floor);
      let b = m.get(node.floor);
      if (!b) { b = []; m.set(node.floor, b); }
      b.push({ id, x, z, floor: node.floor });
    }
    return m;
  }, [lot]);

  // World-space XZ positions of every non-slot node, for reporting where the
  // car physically is. Bucketed by floor so the 150ms node scan only iterates
  // the current floor's nodes. Slots are handled separately so that only the
  // player's own assigned bay can ever be reported as a slot node.
  const guideNodesByFloor = useMemo(() => {
    const m = new Map<number, { id: string; x: number; z: number; floor: number; type: string }[]>();
    for (const [id, node] of Object.entries(lot.nodes)) {
      if (node.type === "slot" || node.type === "approach") continue;
      const [x, , z] = toWorld(node.x, node.y, node.floor);
      let b = m.get(node.floor);
      if (!b) { b = []; m.set(node.floor, b); }
      b.push({ id, x, z, floor: node.floor, type: node.type });
    }
    return m;
  }, [lot]);

  // Road segments bucketed by floor so the corridor argmin only iterates the
  // current floor's segments instead of all segments every frame.
  const roadSegmentsByFloor = useMemo(() => {
    const m = new Map<number, RoadSegment[]>();
    for (const seg of roadSegments) {
      let b = m.get(seg.floor);
      if (!b) { b = []; m.set(seg.floor, b); }
      b.push(seg);
    }
    return m;
  }, [roadSegments]);

  // Per-floor spatial hash of parked cars, rebuilt only when parkedCars
  // changes. The collision pass queries the 3x3 cells around each disc,
  // reducing candidate count from O(all parked cars) to ~5-10.
  const parkedCarGrid = useMemo(() => buildParkedCarGrid(parkedCars), [parkedCars]);

  // Precomputed world-space XZ + inter-node gaps for the route path, so the
  // per-frame route-distance scan never calls toWorld() or nodeGap() inside
  // useFrame. Both are indexed by position in routePath.
  const routePathData = useMemo(() => {
    const nodes: { x: number; z: number; floor: number }[] = [];
    for (let i = 0; i < routePath.length; i++) {
      const n = lot.nodes[routePath[i]];
      if (!n) { nodes.push({ x: NaN, z: NaN, floor: -1 }); continue; }
      const [x, , z] = toWorld(n.x, n.y, n.floor);
      nodes.push({ x, z, floor: n.floor });
    }
    const gaps: number[] = [];
    for (let i = 0; i < routePath.length - 1; i++) {
      gaps.push(nodeGap(lot, routePath[i], routePath[i + 1]));
    }
    return { nodes, gaps };
  }, [routePath, lot]);

  const exitNodeId = useMemo(
    () =>
      Object.entries(lot.nodes).find(([, node]) => node.type === "exit")?.[0] ?? null,
    [lot],
  );
  // Precomputed world-space XZ of the exit node, so the 150ms guidance scan
  // does not call toWorld() inside useFrame.
  const exitNodePos = useMemo(() => {
    if (!exitNodeId) return null;
    const node = lot.nodes[exitNodeId];
    if (!node) return null;
    const [x, , z] = toWorld(node.x, node.y, node.floor);
    return { x, z, floor: node.floor };
  }, [exitNodeId, lot]);

  const assignedSlotPos = useMemo(() => {
    if (!assignedSlot) return null;
    const node = lot.nodes[assignedSlot];
    if (!node) return null;
    const [x, , z] = toWorld(node.x, node.y, node.floor);
    return { x, z, floor: node.floor };
  }, [assignedSlot, lot]);

  // Reusable contacts array for the capsule collision pass. Reset (length = 0)
  // each frame instead of allocating a fresh array + closure. CarContact
  // objects are only pushed on actual contact (rare), never on the empty path.
  const contactsRef = useRef<CarContact[]>([]);

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
  // meaningful once the backend agrees the car is parked. Also accepts a
  // wrong-bay parking prompt (press L to park in the current non-assigned bay).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "KeyL") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) return;
      // If a wrong-bay prompt is active, L accepts parking in that bay.
      if (wrongBayRef.current && playerStatus !== "parked") {
        onReportNode(wrongBayRef.current.slotId);
        return;
      }
      if (playerStatus !== "parked") return;
      onLeaveBay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onLeaveBay, onReportNode, playerStatus]);

  // Clean up the carGroups entry on unmount so the camera rig doesn't track
  // a stale group after the user exits POV mode.
  useEffect(() => {
    return () => {
      carGroupsRef.current.delete(PLAYER_CAR_KEY);
      updatePlayerPos(NaN, NaN, -1);
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

    // --- Parked lock: once the backend confirms "parked", snap the car to
    // the assigned slot and freeze it there. The player can press L to leave,
    // which sets status back to "leaving" and re-enables physics. Without this
    // the car keeps responding to collisions and drifts out of the bay. ---
    if (playerStatus === "parked" && assignedSlotPos && !leaving) {
      const slotNode = lot.nodes[assignedSlot!];
      const aisleY = Math.round(slotNode.y / AISLE_SPACING) * AISLE_SPACING;
      const targetYaw = slotNode.y < aisleY ? Math.PI / 2 : -Math.PI / 2;
      g.position.set(
        assignedSlotPos.x,
        floorRef.current * FLOOR_HEIGHT + ROAD_Y + CAR_Y_OFFSET,
        assignedSlotPos.z,
      );
      headingRef.current = targetYaw;
      g.rotation.y = targetYaw;
      velocityRef.current = 0;
      lateralVelRef.current = 0;
      steerAngleRef.current = 0;
      // Keep shadow under the car.
      if (shadowRef.current) {
        shadowRef.current.position.set(
          g.position.x,
          g.position.y - CAR_Y_OFFSET - ROAD_Y + SHADOW_LIFT,
          g.position.z,
        );
      }
      // Update player position for AI awareness.
      updatePlayerPos(g.position.x, g.position.z, floorRef.current);
      if (speedRef) speedRef.current.speed = 0;
      liveSpeedRef.current = 0;
      // Clear auto-park offer if it was active.
      if (autoParkOfferedRef.current) {
        autoParkOfferedRef.current = false;
        onAutoParkAvailableRef.current?.(false);
      }
      // Clear wrong-bay prompt if it was active.
      if (wrongBayPromptRef.current) {
        wrongBayPromptRef.current = false;
        onWrongBayPromptRef.current?.(null);
      }
      wrongBayRef.current = null;
      // Stationary wheels.
      for (let i = 0; i < wheelRefs.current.length; i++) {
        const wr = wheelRefs.current[i];
        if (wr) wr.rotation.y = 0;
        if (i < 2) {
          const sr = steerRefs.current[i];
          if (sr) sr.rotation.y = 0;
        }
      }
      // Reset body roll and pitch so the car sits flat in the bay.
      g.rotation.x = 0;
      g.rotation.z = 0;
      bodyRollRef.current = 0;
      return;
    }

    // --- Input (WASD + arrow keys) ---
    const accel = keys.current["KeyW"] || keys.current["ArrowUp"] ? 1 : 0;
    const brake = keys.current["KeyS"] || keys.current["ArrowDown"] ? 1 : 0;
    const steerLeft = keys.current["KeyA"] || keys.current["ArrowLeft"] ? 1 : 0;
    const steerRight = keys.current["KeyD"] || keys.current["ArrowRight"] ? 1 : 0;
    const parkKey = !!keys.current["KeyP"];

    // --- Auto-park proximity detection ---
    // Check if the player is near the assigned slot and roughly aligned.
    // If so, notify the HUD to show a "Press P to park" prompt.
    if (
      assignedSlotPos &&
      !leaving &&
      playerStatus !== "parked" &&
      !autoParkRef.current?.active
    ) {
      const distToSlot = Math.hypot(
        g.position.x - assignedSlotPos.x,
        g.position.z - assignedSlotPos.z,
      );
      const slotNode = lot.nodes[assignedSlot!];
      const aisleY = Math.round(slotNode.y / AISLE_SPACING) * AISLE_SPACING;
      const targetYaw = slotNode.y < aisleY ? Math.PI / 2 : -Math.PI / 2;
      let headingDiff = Math.abs(headingRef.current - targetYaw);
      while (headingDiff > Math.PI) headingDiff -= Math.PI * 2;
      headingDiff = Math.abs(headingDiff);
      const shouldOffer =
        distToSlot < AUTO_PARK_OFFER_RADIUS &&
        headingDiff < AUTO_PARK_MAX_HEADING_DIFF;
      if (shouldOffer !== autoParkOfferedRef.current) {
        autoParkOfferedRef.current = shouldOffer;
        onAutoParkAvailableRef.current?.(shouldOffer);
      }
    } else if (autoParkOfferedRef.current) {
      autoParkOfferedRef.current = false;
      onAutoParkAvailableRef.current?.(false);
    }

    // --- Auto-park activation (press P) ---
    if (
      parkKey &&
      autoParkOfferedRef.current &&
      !autoParkRef.current?.active
    ) {
      const slotNode = lot.nodes[assignedSlot!];
      const aisleY = Math.round(slotNode.y / AISLE_SPACING) * AISLE_SPACING;
      const targetYaw = slotNode.y < aisleY ? Math.PI / 2 : -Math.PI / 2;
      autoParkRef.current = {
        active: true,
        t: 0,
        startPos: g.position.clone(),
        startHeading: headingRef.current,
        targetPos: new THREE.Vector3(
          assignedSlotPos!.x,
          g.position.y,
          assignedSlotPos!.z,
        ),
        targetHeading: targetYaw,
      };
      // Clear offer state during auto-park.
      autoParkOfferedRef.current = false;
      onAutoParkAvailableRef.current?.(false);
    }

    // --- Auto-park cancellation (any movement key) ---
    if (autoParkRef.current?.active && (accel || brake || steerLeft || steerRight)) {
      autoParkRef.current = null;
    }

    // --- Auto-park animation ---
    if (autoParkRef.current?.active) {
      const ap = autoParkRef.current;
      ap.t += dt / AUTO_PARK_DURATION;
      if (ap.t >= 1) {
        // Snap to target and let parking detection take over.
        ap.t = 1;
        g.position.copy(ap.targetPos);
        headingRef.current = ap.targetHeading;
        g.rotation.y = ap.targetHeading;
        velocityRef.current = 0;
        lateralVelRef.current = 0;
        steerAngleRef.current = 0;
        autoParkRef.current = null;
      } else {
        // Smooth ease-in-out interpolation.
        const e = ap.t * ap.t * (3 - 2 * ap.t); // smoothstep
        g.position.lerpVectors(ap.startPos, ap.targetPos, e);
        // Shortest-arc heading interpolation.
        let dh = ap.targetHeading - ap.startHeading;
        while (dh > Math.PI) dh -= Math.PI * 2;
        while (dh < -Math.PI) dh += Math.PI * 2;
        headingRef.current = ap.startHeading + dh * e;
        g.rotation.y = headingRef.current;
        velocityRef.current = 0;
        lateralVelRef.current = 0;
        steerAngleRef.current = 0;
      }
      // Update player position for AI awareness and skip the rest of
      // the physics (the auto-park controls the car completely).
      updatePlayerPos(g.position.x, g.position.z, floorRef.current);
      if (speedRef) speedRef.current.speed = 0;
      liveSpeedRef.current = 0;
      // Keep shadow under the car.
      if (shadowRef.current) {
        shadowRef.current.position.set(
          g.position.x,
          g.position.y - CAR_Y_OFFSET - ROAD_Y + SHADOW_LIFT,
          g.position.z,
        );
      }
      // Animate wheels (stationary during auto-park).
      const visualSteer = 0;
      for (let i = 0; i < wheelRefs.current.length; i++) {
        const wr = wheelRefs.current[i];
        if (wr) wr.rotation.y = 0;
        if (i < 2) {
          const sr = steerRefs.current[i];
          if (sr) sr.rotation.y = visualSteer;
        }
      }
      // Level out body roll and pitch during auto-park so the car
      // animates into the slot flat, not carrying a stale tilt.
      g.rotation.x *= 0.9;
      g.rotation.z *= 0.9;
      bodyRollRef.current *= 0.9;
      return;
    }

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
      // Return to center. A small deadband snaps residual angle to zero so
      // micro values (e.g. 0.001 rad) don't keep yawing the car each frame.
      if (Math.abs(steerAngleRef.current) < 0.01) {
        steerAngleRef.current = 0;
      } else {
        const ret = STEER_RETURN * dt;
        if (Math.abs(steerAngleRef.current) < ret) {
          steerAngleRef.current = 0;
        } else {
          steerAngleRef.current -= Math.sign(steerAngleRef.current) * ret;
        }
      }
    }

    // --- Apply steering to heading (proportional to speed; can't turn when stopped) ---
    // Full steering authority arrives at 1 u/s instead of 1.5, so creeping
    // into a bay still steers. The old /1.5 divisor made low-speed turns feel
    // dead and then suddenly grab.
    // Above STEER_FADE_START the authority bleeds back off linearly, removing
    // up to STEER_HIGH_SPEED_FADE of it at MAX_SPEED — otherwise the yaw rate
    // is identical at a crawl and at flat out, which reads as the car
    // pirouetting on its own axis at speed.
    const speedFactor = Math.min(1, speed / 1.0);
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
    // Apply grip + lag-spike clamp + deadzone via the shared helper. The same
    // treatment is re-applied after collision and corridor-clamp lateral writes
    // so no un-decayed lateral survives into the next frame's compose/decompose
    // (which used to kick the car sideways for a frame at the corridor edge).
    lateralVelRef.current = applyLateralGrip(
      lateralVelRef.current,
      velocityRef.current,
      dt,
    );

    // Move the car by the combined velocity, using the current heading basis.
    const totalVx = cosH * velocityRef.current + sinH * lateralVelRef.current;
    const totalVz = -sinH * velocityRef.current + cosH * lateralVelRef.current;
    g.position.x += totalVx * dt;
    g.position.z += totalVz * dt;
    g.rotation.y = heading;

    // --- Body roll: lean into turns like a real car on suspension ---
    // Lateral acceleration ≈ steerAngle × forward speed. The car leans
    // outward (away from the turn center), which is rotation.x in the
    // car's local space (nose dips to the outside). Smoothed so it
    // doesn't snap — suspension takes time to settle.
    const lateralAccel = steerAngleRef.current * velocityRef.current;
    const targetRoll = THREE.MathUtils.clamp(-lateralAccel * 0.012, -0.04, 0.04);
    const rollLerp = 1 - Math.pow(0.01, dt);
    bodyRollRef.current += (targetRoll - bodyRollRef.current) * rollLerp;
    g.rotation.x = bodyRollRef.current;

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

    // Only iterate ramps that touch the current floor (floor-bucketed), and
    // skip any whose expanded XZ bbox is farther than RAMP_TRIGGER_DIST before
    // running the per-point projectOnPolyline.
    const floorRamps = rampsByFloor.get(floorRef.current);
    if (floorRamps) {
      for (let ri = 0; ri < floorRamps.length; ri++) {
        const ramp = floorRamps[ri];
        // Cheap bbox-distance reject (bbox already expanded by RAMP_TRIGGER_DIST).
        if (
          g.position.x < ramp.minX || g.position.x > ramp.maxX ||
          g.position.z < ramp.minZ || g.position.z > ramp.maxZ
        ) continue;

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
    }

    // Only the genuinely sloped portion captures the car. The much smaller
    // rescaled tolerance removes the old one-unit dead zone while keeping the
    // shared flat endpoint free of ramp clamping.
    const onRamp =
      bestRamp != null && Math.abs(bestRampSurfaceY - flatFloorY) > RAMP_FLAT_EPSILON;

    // --- Ramp edge clamp prep: sample the surface Y for height/pitch below.
    // The XZ band clamp is deferred to the final boundary pass so the car is
    // only re-projected onto the centreline once per frame (a pre-sample clamp
    // plus a final-pass clamp could land on different segments on ramp corners
    // and jitter XZ). Here we only read the surface Y at the current XZ.
    if (onRamp && bestRamp) {
      bestRampSurfaceY = rampHeightAt(bestRamp, g.position.x, g.position.z) + ROAD_Y;
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
    // Height smoothing factor — hoisted so the single height lerp after the
    // final boundary pass can reuse it. Fast enough (~14%/frame at 60fps,
    // half-life ~58ms) that the car tracks the ground instead of floating,
    // but still smooths segment-switch discontinuities on ramp corners.
    const heightLerp = 1 - Math.pow(0.0001, dt);
    // Track the ground Y the car should settle toward. The final boundary
    // pass may update this (ramp band clamp re-samples after XZ correction),
    // and the single height lerp below applies it.
    let targetGroundY = groundY;

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
    // ramp entry/exit so the car doesn't snap. Pitch and height now share
    // the same settling rate so the nose doesn't lead or lag the body.
    // Add longitudinal weight transfer: nose dives under braking (negative
    // rotation.z = nose down for +X-facing car), rear squats under
    // acceleration (positive rotation.z = nose up). Small angles (1-2°)
    // but they give the car a sense of weight and momentum.
    const accelPitch = accel ? 0.018 : brake ? -0.028 : 0;
    targetPitch += accelPitch;
    const pitchLerp = 1 - Math.pow(0.0001, dt);
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
    //
    // The contacts array is a ref-stable pool reset each frame (length = 0)
    // and the contact-test function is hoisted to module scope (pushContact),
    // so the zero-contact hot path allocates nothing. Parked cars are queried
    // through a per-floor spatial hash (3x3 cells around each disc) instead of
    // a linear scan over every parked car; AI cars are few enough to keep a
    // floor-filtered linear scan.
    const contacts = contactsRef.current;
    contacts.length = 0;

    // AI cars: few enough that a floor-filtered linear scan is cheaper than
    // rebuilding a grid each frame. The y-tolerance handles ramp transitions.
    // Uses Map.forEach with a module-scope callback (_aiCollisionCallback) to
    // avoid both the per-entry destructuring array allocations that
    // `for (const [id, otherGroup] of map)` produces and a per-frame closure.
    const aiScratch = _aiCollisionScratch;
    aiScratch.posY = g.position.y;
    aiScratch.posX = g.position.x;
    aiScratch.posZ = g.position.z;
    aiScratch.cosH = cosH;
    aiScratch.sinH = sinH;
    aiScratch.contacts = contacts;
    carGroupsRef.current.forEach(_aiCollisionCallback);

    // Parked cars: spatial hash on the current floor. Query the 3x3 cells
    // around each of the two capsule discs and test only those candidates.
    const pGrid = parkedCarGrid.get(floorRef.current);
    if (pGrid) {
      const invCell = 1 / COLLISION_CELL_SIZE;
      for (let s = 0; s < 2; s++) {
        const sign = CAPSULE_SIGNS[s];
        const discX = g.position.x + cosH * CAPSULE_DISC_OFFSET * sign;
        const discZ = g.position.z - sinH * CAPSULE_DISC_OFFSET * sign;
        const ccx = Math.floor(discX * invCell);
        const ccz = Math.floor(discZ * invCell);
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const bucket = pGrid.cells.get((ccx + dx) * 1000003 + (ccz + dz));
            if (!bucket) continue;
            for (let bi = 0; bi < bucket.length; bi++) {
              const pc = parkedCars[bucket[bi]];
              pushContact(contacts, g.position.x, g.position.z, cosH, sinH, pc.x, pc.z);
            }
          }
        }
      }
    }

    if (contacts.length > 0) {
      // Shallowest penetration first: resolving glancing contacts before
      // deep ones keeps the push-out direction stable when several cars
      // overlap the capsule. The comparator is a hoisted module-scope function
      // so this sort does not allocate a fresh closure every frame.
      contacts.sort(compareContactPen);

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
      // Route the post-collision lateral through the same grip + deadzone as
      // the main pass so no un-decayed lateral survives into next frame's
      // compose/decompose (which produced a one-frame sideways kick on contact).
      lateralVelRef.current = applyLateralGrip(
        worldVx * sinH + worldVz * cosH,
        velocityRef.current,
        dt,
      );
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
    // The slot-exception radius (see below) fires just before the corridor
    // clamp would stop the car, so the car can transition off the road into
    // the bay. On the aisle the nearest slot is SLOT_OFFSET=6 units away, so
    // the radius (3.1) never fires while driving normally.
    if (onRamp && bestRamp) {
      // XZ band clamp only — the surface Y is fed to the single height lerp
      // below so the car never snaps vertically to the raw sampled Y.
      targetGroundY = clampIntoRampBand(bestRamp, g.position);
    } else {
      let nearSlot = false;
      // The slot exception must fire BEFORE the road corridor clamp stops the
      // car. Slots sit SLOT_OFFSET (6) units off the aisle centreline; the
      // corridor clamp holds the car within ROAD_CORRIDOR_HALF_WIDTH (3.4) of
      // it, so the closest the car can get while clamped is 6 - 3.4 = 2.6 units
      // from the slot. The old radius (SLOT_WIDTH/2 + 1 = 2.3) was smaller than
      // that, so the exception never fired and the car could never enter the
      // bay — a geometric deadlock. This radius (3.1) fires 0.5 units before
      // the clamp limit, giving the car a smooth transition into the slot area.
      const slotExceptionRadius = SLOT_OFFSET - ROAD_CORRIDOR_HALF_WIDTH + 0.5;
      const floorSlots = slotPositionsByFloor.get(floorRef.current);
      if (floorSlots) {
        for (let si = 0; si < floorSlots.length; si++) {
          const s = floorSlots[si];
          if (Math.hypot(g.position.x - s.x, g.position.z - s.z) < slotExceptionRadius) {
            nearSlot = true;
            break;
          }
        }
      }
      if (!nearSlot) {
        // Hysteresis: keep last frame's winning segment unless another beats
        // it by more than SEGMENT_HYSTERESIS_MARGIN. Stops the argmin from
        // flipping between adjacent polyline edges and crossing aisles
        // frame-to-frame, which nudged the car in alternating directions.
        const incumbent = incumbentSegRef.current;
        let incumbentDist = Infinity;
        if (incumbent && incumbent.floor === floorRef.current) {
          incumbentDist = distToSegment2D(
            g.position.x,
            g.position.z,
            incumbent.x1,
            incumbent.z1,
            incumbent.x2,
            incumbent.z2,
          );
          // Fall back to a fresh argmin if the incumbent is far off.
          if (incumbentDist > ROAD_CORRIDOR_HALF_WIDTH + 2) {
            incumbentDist = Infinity;
          }
        }

        let bestDist = Infinity;
        let bestX = 0;
        let bestZ = 0;
        let bestSeg: RoadSegment | null = null;
        // Only iterate the current floor's segments (floor-bucketed) instead
        // of all segments every frame.
        const floorSegs = roadSegmentsByFloor.get(floorRef.current);
        if (floorSegs) {
          for (let si = 0; si < floorSegs.length; si++) {
            const seg = floorSegs[si];
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
              bestSeg = seg;
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
        }

        // Resolve hysteresis: prefer the incumbent unless the fresh best is
        // closer by more than the margin.
        let chosenDist = bestDist;
        let chosenX = bestX;
        let chosenZ = bestZ;
        if (
          incumbent &&
          incumbentDist < Infinity &&
          bestSeg !== incumbent &&
          bestDist >= incumbentDist - SEGMENT_HYSTERESIS_MARGIN
        ) {
          // Keep incumbent — recompute its closest point for this frame.
          chosenDist = incumbentDist;
          [chosenX, chosenZ] = closestPointOnSegment2D(
            g.position.x,
            g.position.z,
            incumbent.x1,
            incumbent.z1,
            incumbent.x2,
            incumbent.z2,
          );
        } else if (bestSeg) {
          incumbentSegRef.current = bestSeg;
        }

        // Deadband: only clamp when clearly past the corridor edge, and clamp
        // to exactly the boundary so the car settles there instead of
        // oscillating across it.
        if (
          chosenDist > ROAD_CORRIDOR_HALF_WIDTH + 0.05 &&
          chosenDist < Infinity
        ) {
          const nx = (chosenX - g.position.x) / chosenDist;
          const nz = (chosenZ - g.position.z) / chosenDist;
          g.position.x = chosenX - nx * ROAD_CORRIDOR_HALF_WIDTH;
          g.position.z = chosenZ - nz * ROAD_CORRIDOR_HALF_WIDTH;
          // Cancel the outward velocity component along the guardrail normal
          // so the lateral-grip drift model stops driving the car back into
          // the rail each frame (prevents steady oscillation against it).
          let worldVx = cosH * velocityRef.current + sinH * lateralVelRef.current;
          let worldVz =
            -sinH * velocityRef.current + cosH * lateralVelRef.current;
          const vn = worldVx * nx + worldVz * nz;
          if (vn < 0) {
            worldVx -= nx * vn;
            worldVz -= nz * vn;
            velocityRef.current = worldVx * cosH - worldVz * sinH;
            // Route the post-corridor-clamp lateral through the same grip +
            // deadzone as the main pass. The corridor deadband lets the car
            // drift back out before the clamp refires; writing lateral raw
            // here used to re-inject a one-frame kick every time the car
            // re-crossed the deadband, producing the periodic edge jitter.
            lateralVelRef.current = applyLateralGrip(
              worldVx * sinH + worldVz * cosH,
              velocityRef.current,
              dt,
            );
          }
        }
      }
    }

    // --- Single height lerp (after the final boundary pass) ---
    // Applied once, toward the final clamped ground Y, so the car never snaps
    // vertically to a raw sampled surface Y (which jittered on ramp corners
    // as the nearest centreline segment flipped frame-to-frame).
    g.position.y += (targetGroundY + CAR_Y_OFFSET - g.position.y) * heightLerp;

    // Publish speed + steering for the HUD and the POV cluster.
    liveSpeedRef.current = velocityRef.current;
    if (speedRef) {
      speedRef.current.speed = velocityRef.current;
      speedRef.current.steer = steerInputRef.current;
    }

    // Publish physical position so AI cars can avoid the player even when
    // stopped between graph nodes.
    updatePlayerPos(g.position.x, g.position.z, floorRef.current);

    // --- Live route distance for the guidance strip ---
    // The server's routeDistance is measured from the last reported node, so
    // it lags by up to one node gap (~3.5 m). Compute the true remaining
    // distance every frame by projecting the car onto the nearest SEGMENT of
    // the route path, then measuring from that projection to the segment's far
    // endpoint plus every precomputed gap after it. Uses routePathData
    // (world-space XZ + inter-node gaps) so no toWorld()/nodeGap() runs here.
    //
    // This replaces the old nearest-NODE scan, which measured from the car to
    // the node AFTER the nearest one. Whenever the car was closer to the AHEAD
    // node of its current leg (i.e. past the segment midpoint), the nearest
    // node flipped to that ahead node and the whole current segment was
    // skipped, so the distance jumped by one node gap at every crossing and
    // read ~one gap too large whenever the car sat near a node (e.g. directly
    // under a signboard). Segment projection is continuous and monotonic.
    if (speedRef && routePath.length >= 2) {
      const rpNodes = routePathData.nodes;
      const rpGaps = routePathData.gaps;
      const px = g.position.x;
      const pz = g.position.z;
      const fl = floorRef.current;
      let liveDist = -1;
      let bestPerp = Infinity;
      // Track whether the car is past the last node (overshot the slot).
      // If so, the distance is reported as negative so the HUD can show
      // "behind" instead of "ahead".
      const lastNode = rpNodes[rpNodes.length - 1];
      const lastSegA = rpNodes[rpNodes.length - 2];
      const lastSegB = lastNode;
      // Direction of the last segment (toward the slot).
      const lastDirX = lastSegB.x - lastSegA.x;
      const lastDirZ = lastSegB.z - lastSegA.z;
      const lastDirLen = Math.hypot(lastDirX, lastDirZ);
      // How far past the last node the car is, projected along the last
      // segment's direction. Positive = past the slot.
      let overshoot = 0;
      if (lastDirLen > 0 && (lastSegA.floor === fl || lastSegB.floor === fl)) {
        overshoot =
          ((px - lastNode.x) * lastDirX + (pz - lastNode.z) * lastDirZ) / lastDirLen;
      }
      for (let i = 0; i < rpNodes.length - 1; i++) {
        const a = rpNodes[i];
        const b = rpNodes[i + 1];
        // Keep the scan on the current floor. A ramp segment is counted when
        // EITHER endpoint is on this floor, so the distance stays continuous
        // through floor transitions instead of snapping when floorRef flips.
        if (a.floor !== fl && b.floor !== fl) continue;
        const segLen = rpGaps[i];
        if (!(segLen > 0)) continue;
        const abx = b.x - a.x;
        const abz = b.z - a.z;
        // Project the car onto segment A->B, clamped to the segment.
        const t = Math.min(
          1,
          Math.max(0, ((px - a.x) * abx + (pz - a.z) * abz) / (segLen * segLen)),
        );
        const qx = a.x + t * abx;
        const qz = a.z + t * abz;
        const perp = Math.hypot(px - qx, pz - qz);
        if (perp >= bestPerp) continue;
        bestPerp = perp;
        // Remaining = projection -> far endpoint, plus every hop after this.
        let rem = (1 - t) * segLen;
        for (let h = i + 1; h < rpNodes.length - 1; h++) rem += rpGaps[h];
        liveDist = rem;
      }
      // No segment on the current floor (e.g. route already advanced to a
      // floor the car hasn't registered): fall back to straight-line distance
      // to the last node so the HUD never freezes at a stale value.
      if (liveDist < 0) {
        const last = rpNodes[rpNodes.length - 1];
        liveDist = Math.hypot(px - last.x, pz - last.z);
      }
      // If the car has driven past the slot (overshoot > 0), report the
      // distance as the overshoot amount and set the overshot flag so the
      // HUD shows "behind — turn around" instead of "ahead".
      if (overshoot > 0.5) {
        speedRef.current.routeDistance = overshoot;
        speedRef.current.overshot = true;
      } else {
        speedRef.current.routeDistance = liveDist;
        speedRef.current.overshot = false;
      }
    } else if (speedRef) {
      speedRef.current.routeDistance = -1;
      speedRef.current.overshot = false;
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
      // Only iterate the current floor's guide nodes (floor-bucketed).
      const floorGuides = guideNodesByFloor.get(floorRef.current);
      if (floorGuides) {
        for (let gi = 0; gi < floorGuides.length; gi++) {
          const candidate = floorGuides[gi];
          const d = Math.hypot(g.position.x - candidate.x, g.position.z - candidate.z);
          if (d < bestDist) {
            bestDist = d;
            bestId = candidate.id;
          }
        }
      }
      let toReport: string | null = null;
      if (bestId && bestDist < 3.5) {
        toReport = bestId;
      }
      // Parking detection: settled inside a bay.
      // Check the assigned slot first (600ms settle time). If not in the
      // assigned slot, check all other slots on the floor for wrong-bay
      // parking — show a prompt and allow L to accept, or auto-accept
      // after a grace period.
      if (!leaving && playerStatus !== "parked") {
        const settled = Math.abs(velocityRef.current) < 0.4;
        // Assigned slot check (existing behavior — fast accept at 600ms).
        if (assignedSlotPos && assignedSlotPos.floor === floorRef.current) {
          const nearAssigned =
            Math.hypot(g.position.x - assignedSlotPos.x, g.position.z - assignedSlotPos.z) < BAY_DETECT_RADIUS;
          if (nearAssigned && settled) {
            if (slowSinceRef.current === null) slowSinceRef.current = now;
            else if (now - slowSinceRef.current > 600) toReport = assignedSlot;
          } else {
            slowSinceRef.current = null;
          }
        }
        // Wrong-bay check: only if not in the assigned slot and not already
        // settled there. Scan all slots on the current floor.
        if (!toReport && settled) {
          const floorSlots = slotPositionsByFloor.get(floorRef.current);
          if (floorSlots) {
            let wrongSlotId: string | null = null;
            for (let si = 0; si < floorSlots.length; si++) {
              const s = floorSlots[si];
              if (s.id === assignedSlot) continue; // skip assigned (handled above)
              if (Math.hypot(g.position.x - s.x, g.position.z - s.z) < BAY_DETECT_RADIUS) {
                wrongSlotId = s.id;
                break;
              }
            }
            if (wrongSlotId) {
              // Track the wrong bay — show prompt, start grace timer.
              if (!wrongBayRef.current || wrongBayRef.current.slotId !== wrongSlotId) {
                wrongBayRef.current = { slotId: wrongSlotId, settledAt: now };
              }
              // Show the prompt immediately.
              if (!wrongBayPromptRef.current) {
                wrongBayPromptRef.current = true;
                onWrongBayPromptRef.current?.(wrongSlotId);
              }
              // Auto-accept after grace period.
              if (now - wrongBayRef.current.settledAt > WRONG_BAY_GRACE_MS) {
                toReport = wrongSlotId;
              }
            } else {
              // Not in any wrong bay — clear the prompt and timer.
              if (wrongBayPromptRef.current) {
                wrongBayPromptRef.current = false;
                onWrongBayPromptRef.current?.(null);
              }
              wrongBayRef.current = null;
            }
          }
        } else if (!settled) {
          // Moving — clear any wrong-bay prompt.
          if (wrongBayPromptRef.current) {
            wrongBayPromptRef.current = false;
            onWrongBayPromptRef.current?.(null);
          }
          wrongBayRef.current = null;
        }
      }
      // Leaving: report the exit node when reached so the backend closes out
      // the run ("left"). Uses the precomputed exit node world position.
      if (leaving && exitNodeId && exitNodePos) {
        if (exitNodePos.floor === floorRef.current) {
          if (Math.hypot(g.position.x - exitNodePos.x, g.position.z - exitNodePos.z) < 4) {
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
        <CarExterior wheelRefs={wheelRefs} steerRefs={steerRefs} pov={pov} />
        {/* The procedural interior exists only to be seen from the driver's-eye
            camera. Rendering it in third person draws the box-model cockpit
            through the GLTF body (roof liner, windows, seats all clip), so it
            is mounted only in POV mode. The steering-wheel animation and the
            speedometer live inside it and are only visible in POV, so they
            unmount safely with it. */}
        {pov && <PovCockpit steerRef={steerInputRef} />}
      </group>
      {/* Blob shadow under the player car (kept flat via shadowRef in useFrame) */}
      <mesh ref={shadowRef} rotation={[-Math.PI / 2, 0, 0]} position={spawn.pos}>
        <circleGeometry args={[1.2, 16]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.35} depthWrite={false} />
      </mesh>
    </>
  );
});
