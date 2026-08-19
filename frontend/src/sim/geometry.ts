import * as THREE from "three";
import { AISLE_SPACING, FLOOR_HEIGHT, RAMP_CORNER_RADIUS, RAMP_OUTSET } from "./constants";

/*
 * Shared road curve generators.
 *
 * The road mesh (ParkingLot), the AI car paths (paths.ts) and the player car's
 * height sampling (DrivableCar) must all follow the EXACT same curves, or cars
 * float above the tarmac and clip through guardrails. These used to be three
 * copy-pasted implementations that had already drifted apart. They live here
 * now so there is one definition each.
 */

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
 * This replaces an earlier version that swept diagonally across the entire
 * depth of the garage as a single Catmull-Rom curve, which read as a giant
 * noodle flying through mid-air with no relationship to the building.
 *
 * Geometry: a car leaves `from` heading -x (it has just finished the last
 * aisle, which runs right to left), turns south to run parallel to the west
 * wall, then turns back east to arrive at `to` heading +x, which is the
 * direction the next floor's first aisle runs. Both corners are rounded so a
 * car can actually drive it. Height rises linearly with distance travelled,
 * so the gradient is constant end to end rather than all in the middle.
 */
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

  const a = roundedCorner(start, cornerA, cornerB, RAMP_CORNER_RADIUS);
  const b = roundedCorner(cornerA, cornerB, end, RAMP_CORNER_RADIUS);

  // Straight run out, arc, straight run along the face, arc, straight run in.
  const flat: THREE.Vector2[] = [
    start,
    ...a.points,
    ...b.points,
    end,
  ];

  // Distance along the path, so height can rise at a constant gradient.
  const cum: number[] = [0];
  for (let i = 1; i < flat.length; i++) {
    cum.push(cum[i - 1] + flat[i].distanceTo(flat[i - 1]));
  }
  const total = cum[cum.length - 1] || 1;

  return flat.map(
    (p, i) => new THREE.Vector3(p.x, y0 + (y1 - y0) * (cum[i] / total), p.y),
  );
}

/** Gradient of the ramp as a fraction (0.15 = 15%), for sanity checks. */
export function rampGradient(): number {
  const pts = rampPoints([0, 0, (4 - 1) * AISLE_SPACING], [0, FLOOR_HEIGHT, 0]);
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    run += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  }
  return FLOOR_HEIGHT / run;
}
