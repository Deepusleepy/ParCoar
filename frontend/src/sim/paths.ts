import * as THREE from "three";
import { FLOOR_HEIGHT, LANE_WIDTH, RAMP_LENGTH, toWorld } from "./constants";
import type { LotData, LotNode } from "../types";

/*
 * Path resolution for active cars.
 *
 * The lot graph stores node coordinates on the aisle *centreline* (the
 * divider between the two lanes). A car must drive in one lane, so every
 * resolved waypoint is offset perpendicular to its tangent by -LANE_WIDTH/2
 * (the right-hand driving lane relative to the travel direction). For
 * straight aisles this puts +x traffic at z = y - 2.25 and -x traffic at
 * z = y + 2.25, so the two directions never overlap. For curves the offset
 * produces a parallel curve, and for ramps only the horizontal (X-Z) lane
 * offset is applied — the vertical climb comes from the curve itself.
 *
 * The semicircle and ramp curve generators below are copied verbatim from
 * ParkingLot.tsx so the car path follows the exact same geometry the road
 * mesh is built from.
 */

/** Lane shift: shift to the right of the travel direction (lot units). */
const LANE_SHIFT = -LANE_WIDTH / 2;

/* ------------------------------------------------------------------ *
 *  Curve generators (mirror ParkingLot.tsx exactly)
 * ------------------------------------------------------------------ */

/** Points for a 180° semicircle connecting two same-x junctions. */
function semicirclePoints(
  ax: number,
  ay: number,
  by: number,
  bulgeDir: number,
  floor: number,
  segments = 48,
): THREE.Vector3[] {
  const cy = (ay + by) / 2;
  const r = Math.abs(by - ay) / 2;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const ang = -Math.PI / 2 + t * Math.PI;
    const x = ax + bulgeDir * r * Math.cos(ang);
    const y = cy + r * Math.sin(ang);
    pts.push(new THREE.Vector3(x, floor * FLOOR_HEIGHT, y));
  }
  return pts;
}

/** Control points for a sweeping spiral ramp between two floors. */
function rampPoints(
  from: [number, number, number],
  to: [number, number, number],
): THREE.Vector3[] {
  const [x0, y0, z0] = from;
  const [x1, y1, z1] = to;
  const midY = (y0 + y1) / 2;
  const midZ = (z0 + z1) / 2;
  // Bulge in -x so the ramp leaves the x=0 edge and climbs outside the slab
  const sweep = -RAMP_LENGTH;
  // ctrl[1] & ctrl[3] keep z and y equal to the endpoints so the ramp
  // starts/ends parallel to the road (zero z-tangent) and flat (zero
  // y-tangent). The Y profile [y0, y0, midY, y1, y1] makes CatmullRom
  // produce an S-curve (ease-in/ease-out); the Z shift happens only at
  // the middle control point. Max slope ~23% at midpoint.
  const ctrl = [
    new THREE.Vector3(x0, y0, z0),
    new THREE.Vector3(x0 + sweep * 0.7, y0, z0),
    new THREE.Vector3(x0 + sweep, midY, midZ),
    new THREE.Vector3(x0 + sweep * 0.7, y1, z1),
    new THREE.Vector3(x1, y1, z1),
  ];
  const curve = new THREE.CatmullRomCurve3(ctrl, false, "catmullrom", 0.5);
  return curve.getPoints(48);
}

/* ------------------------------------------------------------------ *
 *  Perpendicular lane offset
 * ------------------------------------------------------------------ */

/**
 * Offset every point of a polyline perpendicular to its tangent, in the
 * horizontal (X-Z) plane. Vertical (Y) is preserved. Replicates the
 * `offsetPoints` helper in ParkingLot.tsx.
 */
function offsetPerp(points: THREE.Vector3[], offset: number): THREE.Vector3[] {
  const n = points.length;
  const out: THREE.Vector3[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    if (i === 0) tangent.subVectors(points[1], points[0]);
    else if (i === n - 1) tangent.subVectors(points[n - 1], points[n - 2]);
    else tangent.subVectors(points[i + 1], points[i - 1]);
    tangent.normalize();
    side.crossVectors(tangent, up);
    if (side.lengthSq() < 1e-6) {
      side.set(1, 0, 0);
    } else {
      side.normalize();
    }
    out.push(
      new THREE.Vector3(
        points[i].x + side.x * offset,
        points[i].y,
        points[i].z + side.z * offset,
      ),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  Graph helpers
 * ------------------------------------------------------------------ */

/** Find a node's id by object identity (fromNode is a reference into lot.nodes). */
function nodeIdOf(lot: LotData, node: LotNode): string | null {
  for (const [id, n] of Object.entries(lot.nodes)) {
    if (n === node) return id;
  }
  return null;
}

/** Find the incoming junction id for a turn node (the edge pointing TO it). */
function incomingJunctionId(lot: LotData, turnId: string): string | null {
  for (const [fromId, edgeList] of Object.entries(lot.edges)) {
    for (const edge of edgeList) {
      if (edge.to === turnId) return fromId;
    }
  }
  return null;
}

/** World-space position of a lot node. */
function worldOf(node: LotNode): THREE.Vector3 {
  const [x, y, z] = toWorld(node.x, node.y, node.floor);
  return new THREE.Vector3(x, y, z);
}

/* ------------------------------------------------------------------ *
 *  Public API
 * ------------------------------------------------------------------ */

/**
 * Resolve the world-space waypoints a car should follow to travel from
 * `fromNode` to `toNode`, with lane offset applied. Returns an empty array
 * when the two nodes are the same (car is stationary).
 */
export function resolvePath(
  fromNode: LotNode,
  toNode: LotNode,
  lot: LotData,
): THREE.Vector3[] {
  // --- Ramp leg: ramp_up -> ramp_in (spiral curve between floors) ---
  if (fromNode.type === "ramp_up" && toNode.type === "ramp_in") {
    const from = toWorld(fromNode.x, fromNode.y, fromNode.floor);
    const to = toWorld(toNode.x, toNode.y, toNode.floor);
    const pts = rampPoints(from, to);
    return offsetPerp(pts, LANE_SHIFT);
  }

  // --- Turn leg: turn -> outgoing junction (180° semicircle) ---
  if (fromNode.type === "turn") {
    const turnId = nodeIdOf(lot, fromNode);
    const inId = turnId ? incomingJunctionId(lot, turnId) : null;
    const a = inId ? lot.nodes[inId] : null;
    if (a) {
      const bulgeDir = fromNode.x >= a.x ? 1 : -1;
      const semi = semicirclePoints(fromNode.x, a.y, toNode.y, bulgeDir, fromNode.floor);
      // turnNode sits at the semicircle's first point; skip it to avoid a
      // zero-length opening segment, then exit to the outgoing junction.
      const path = [worldOf(fromNode), ...semi.slice(1), worldOf(toNode)];
      return offsetPerp(path, LANE_SHIFT);
    }
    // No incoming junction found: fall through to a straight line.
  }

  // --- Straight leg: aisle, junction->turn approach, entry->junction,
  //     ramp_in->junction (any same-plane A-to-B segment) ---
  // A leg into/out of a parking slot uses a cubic bezier curve so the car
  // rotates smoothly from the aisle travel direction into the slot
  // direction, instead of sliding sideways along a straight 2-point line.
  if (fromNode.type === "slot" || toNode.type === "slot") {
    const junctionNode = toNode.type === "slot" ? fromNode : toNode;

    // Find the junction's id by object identity, then its "straight" edge
    // to determine the aisle travel direction the car is coming from.
    const junctionId = nodeIdOf(lot, junctionNode);
    let approachDir: THREE.Vector3 | null = null;
    if (junctionId && lot.edges[junctionId]) {
      for (const e of lot.edges[junctionId]) {
        if (e.dir === "straight") {
          const next = lot.nodes[e.to];
          if (next && next.type !== "slot") {
            const jw = worldOf(junctionNode);
            const nw = worldOf(next);
            approachDir = new THREE.Vector3()
              .subVectors(nw, jw)
              .setY(0)
              .normalize();
            break;
          }
        }
      }
    }

    if (approachDir) {
      // Apply the lane offset to the junction endpoint of the bezier so the
      // curve starts/ends in the driving lane (matching the lane-offset
      // position the previous/next aisle leg uses). Without this the slot
      // leg begins on the centreline, causing a ~2.25-unit sideways jump
      // that makes the car lunge toward adjacent parked cars.
      const up = new THREE.Vector3(0, 1, 0);
      const side = new THREE.Vector3().crossVectors(approachDir, up).normalize();

      let p0: THREE.Vector3;
      let p3: THREE.Vector3;
      if (toNode.type === "slot") {
        // Arriving at slot: offset the junction (p0) into the driving lane.
        const jw = worldOf(fromNode);
        p0 = new THREE.Vector3(
          jw.x + side.x * LANE_SHIFT,
          jw.y,
          jw.z + side.z * LANE_SHIFT,
        );
        p3 = worldOf(toNode);
      } else {
        // Departing from slot: offset the junction (p3) into the driving lane.
        p0 = worldOf(fromNode);
        const jw = worldOf(toNode);
        p3 = new THREE.Vector3(
          jw.x + side.x * LANE_SHIFT,
          jw.y,
          jw.z + side.z * LANE_SHIFT,
        );
      }
      const dist = p0.distanceTo(p3);
      const d = Math.min(dist * 0.4, 4.5);
      const slotDir = new THREE.Vector3()
        .subVectors(p3, p0)
        .setY(0)
        .normalize();
      // p1 continues along the aisle travel direction; p2 approaches the
      // slot from the slot direction. The curve starts tangent to the aisle
      // and ends tangent to the slot leg, so the look-ahead rotation in
      // Car.tsx follows the curve instead of snapping sideways.
      const p1 = new THREE.Vector3().copy(p0).addScaledVector(approachDir, d);
      const p2 = new THREE.Vector3().copy(p3).addScaledVector(slotDir, -d);
      const curve = new THREE.CubicBezierCurve3(p0, p1, p2, p3);
      return curve.getPoints(24);
    }

    // Fallback: straight line when no approach direction can be derived.
    return [worldOf(fromNode), worldOf(toNode)];
  }
  return offsetPerp([worldOf(fromNode), worldOf(toNode)], LANE_SHIFT);
}
