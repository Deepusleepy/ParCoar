import * as THREE from "three";
import type { LotData } from "../types";
import {
  AISLE_SPACING,
  FLOOR_HEIGHT,
  RAMP_CORNER_RADIUS,
  RAMP_OUTSET,
  SLAB_PAD_X,
  SLAB_PAD_Z,
} from "./constants";

/*
 * Shared road curve generators.
 *
 * The road mesh (ParkingLot), the AI car paths (paths.ts) and the player car's
 * height sampling (DrivableCar) must all follow the EXACT same curves, or cars
 * float above the tarmac and clip through guardrails. They live here so there
 * is one definition of each.
 */

/** Aisle index from a junction id, "J{floor}_{aisle}_{n}". Null for anything
 *  that is not a junction. */
export function aisleOf(id: string): number | null {
  const m = id.match(/^J\d+_(\d+)_\d+$/);
  return m ? Number(m[1]) : null;
}

/** Footprint of one floor slab in world X and Z. */
export interface SlabBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Footprint of the floor slabs: the structural nodes plus the padding the
 * turn loops and bays need. Shared by the 3D geometry and the player car's
 * position clamp so the two cannot drift apart.
 */
export function slabBounds(lot: LotData): SlabBounds {
  const structural = Object.values(lot.nodes).filter(
    (n) => !["approach", "entry", "exit"].includes(n.type),
  );
  const xs = structural.map((n) => n.x);
  const ys = structural.map((n) => n.y);
  return {
    minX: Math.min(...xs) - SLAB_PAD_X,
    maxX: Math.max(...xs) + SLAB_PAD_X,
    minZ: Math.min(...ys) - SLAB_PAD_Z,
    maxZ: Math.max(...ys) + SLAB_PAD_Z,
  };
}

/** A BoxGeometry moved so its centre sits at (x, y, z). */
export function makeBox(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.applyMatrix4(new THREE.Matrix4().setPosition(x, y, z));
  return g;
}

/** Points for a 180° semicircle joining two junctions at the same x.
 *
 *  `ax` is the x of the turn node, `ay`/`by` the aisle centrelines being
 *  joined, and `bulgeDir` which way the curve bows out (+1 = toward +x). */
export function semicirclePoints(
  ax: number,
  ay: number,
  by: number,
  bulgeDir: number,
  floor: number,
  segments = 32,
): THREE.Vector3[] {
  const cy = (ay + by) / 2;
  const r = Math.abs(by - ay) / 2;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const ang = -Math.PI / 2 + t * Math.PI;
    pts.push(
      new THREE.Vector3(
        ax + bulgeDir * r * Math.cos(ang),
        floor * FLOOR_HEIGHT,
        cy + r * Math.sin(ang),
      ),
    );
  }
  return pts;
}

/**
 * Replace the sharp corner at B (between segments A->B and B->C) with a
 * circular arc of radius `r` tangent to both. Returns the arc's points,
 * excluding neither endpoint, so callers can concatenate straight runs
 * around it. All maths is in the horizontal X-Z plane.
 */
function roundedCorner(
  a: THREE.Vector2,
  b: THREE.Vector2,
  c: THREE.Vector2,
  r: number,
  segments = 12,
): { points: THREE.Vector2[]; tangentIn: THREE.Vector2; tangentOut: THREE.Vector2 } {
  const u = new THREE.Vector2().subVectors(a, b).normalize(); // B -> A
  const v = new THREE.Vector2().subVectors(c, b).normalize(); // B -> C
  // Interior angle at B, and how far back along each leg the arc starts.
  const theta = Math.acos(THREE.MathUtils.clamp(u.dot(v), -1, 1));
  const half = theta / 2;
  const back = r / Math.tan(half); // distance from B to each tangent point
  const toCentre = r / Math.sin(half); // distance from B to the arc centre

  const tangentIn = new THREE.Vector2().copy(b).addScaledVector(u, back);
  const tangentOut = new THREE.Vector2().copy(b).addScaledVector(v, back);
  const bisector = new THREE.Vector2().addVectors(u, v).normalize();
  const centre = new THREE.Vector2().copy(b).addScaledVector(bisector, toCentre);

  const a0 = Math.atan2(tangentIn.y - centre.y, tangentIn.x - centre.x);
  let a1 = Math.atan2(tangentOut.y - centre.y, tangentOut.x - centre.x);
  // Sweep the short way around.
  while (a1 - a0 > Math.PI) a1 -= Math.PI * 2;
  while (a1 - a0 < -Math.PI) a1 += Math.PI * 2;

  const points: THREE.Vector2[] = [];
  for (let i = 0; i <= segments; i++) {
    const ang = a0 + (a1 - a0) * (i / segments);
    points.push(
      new THREE.Vector2(centre.x + r * Math.cos(ang), centre.y + r * Math.sin(ang)),
    );
  }
  return { points, tangentIn, tangentOut };
}

/**
 * The inter-floor ramp: an L-shaped run that leaves the west face of the
 * building, climbs along the outside of it, and turns back in one floor up.
 *
 * Geometry: a car leaves `from` heading -x (it has just finished the last
 * aisle, which runs right to left), turns south to run parallel to the west
 * wall, then turns back east to arrive at `to` heading +x, which is the
 * direction the next floor's first aisle runs. Both corners are rounded so a
 * car can actually drive it. Height rises linearly with distance travelled,
 * so the gradient is constant end to end rather than all in the middle.
 */
/** Length of the parabolic vertical curve at each end of a ramp. */
const RAMP_VERTICAL_CURVE = 6;

/**
 * Fraction of the total rise reached after travelling `d` of `total` along a
 * ramp, with a parabolic vertical curve at each end.
 *
 * A linear rise is right in the middle and wrong at the ends, where the grade
 * would step straight from 0% on the flat deck to the ramp grade. A real ramp
 * eases in and out over a few metres, and so does a car.
 *
 * Grade is zero at both ends, rises smoothly over RAMP_VERTICAL_CURVE, and is
 * constant across the middle. Easing costs a slightly steeper middle for the
 * same rise over the same run.
 */
function heightFraction(d: number, total: number): number {
  const lc = Math.min(RAMP_VERTICAL_CURVE, total / 2 - 1e-3);
  if (lc <= 0) return d / total;
  // Grade of the constant-grade middle, chosen so the whole profile sums to 1.
  const grade = 1 / (total - lc);
  if (d <= lc) return (grade * d * d) / (2 * lc);
  if (d >= total - lc) {
    const remaining = total - d;
    return 1 - (grade * remaining * remaining) / (2 * lc);
  }
  return grade * (d - lc / 2);
}

export function rampPoints(
  from: [number, number, number],
  to: [number, number, number],
): THREE.Vector3[] {
  const [x0, y0, z0] = from;
  const [x1, y1, z1] = to;

  // Corner points of the L, in the horizontal plane.
  const start = new THREE.Vector2(x0, z0);
  const cornerA = new THREE.Vector2(x0 - RAMP_OUTSET, z0); // out to the west face
  const cornerB = new THREE.Vector2(x1 - RAMP_OUTSET, z1); // south along the face
  const end = new THREE.Vector2(x1, z1);

  // 32 segments, not 12: the resample below runs at 0.5, and a 12-segment
  // 90-degree arc of radius 7 has a chord of ~0.92, nearly twice the resample
  // spacing, so the arc would be decimated to about six chords and the ramp
  // deck would read as a hexagon.
  const a = roundedCorner(start, cornerA, cornerB, RAMP_CORNER_RADIUS, 32);
  const b = roundedCorner(cornerA, cornerB, end, RAMP_CORNER_RADIUS, 32);

  // Straight run out, arc, straight run along the face, arc, straight run in.
  const flat: THREE.Vector2[] = [
    start,
    ...a.points,
    ...b.points,
    end,
  ];

  // Distance along the path. Height follows heightFraction, which eases the
  // grade in and out at the two ends.
  const cum: number[] = [0];
  for (let i = 1; i < flat.length; i++) {
    cum.push(cum[i - 1] + flat[i].distanceTo(flat[i - 1]));
  }
  const total = cum[cum.length - 1] || 1;

  // Resample at a fixed spacing. The corners come out dense and the straight
  // runs come out as one enormous segment, and consumers assume the points are
  // reasonably close together: DrivableCar keeps the player on the ramp by
  // snapping to the nearest centreline POINT, so a 37-unit gap would yank a
  // car sideways in the middle of the straight. Even spacing also gives the
  // road ribbon and the guardrails a consistent look.
  const step = 0.5;
  const count = Math.max(2, Math.ceil(total / step));
  const out: THREE.Vector3[] = [];
  let seg = 1;
  for (let i = 0; i <= count; i++) {
    const d = (total * i) / count;
    while (seg < cum.length - 1 && cum[seg] < d) seg++;
    const segLen = cum[seg] - cum[seg - 1];
    const t = segLen > 0 ? (d - cum[seg - 1]) / segLen : 0;
    const p = new THREE.Vector2().lerpVectors(flat[seg - 1], flat[seg], t);
    out.push(new THREE.Vector3(p.x, y0 + (y1 - y0) * heightFraction(d, total), p.y));
  }
  return out;
}

/** Steepest gradient anywhere on the ramp, as a fraction (0.15 = 15%). */
export function rampGradient(): number {
  const pts = rampPoints([0, 0, (4 - 1) * AISLE_SPACING], [0, FLOOR_HEIGHT, 0]);
  let worst = 0;
  for (let i = 1; i < pts.length; i++) {
    const run = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    if (run > 1e-6) worst = Math.max(worst, Math.abs(pts[i].y - pts[i - 1].y) / run);
  }
  return worst;
}
