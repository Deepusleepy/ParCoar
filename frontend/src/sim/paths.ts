import * as THREE from "three";
import { LANE_WIDTH, toWorld } from "./constants";
import type { LotData, LotNode } from "../types";
import { rampPoints, semicirclePoints } from "./geometry";

/*
 * Path resolution for active cars.
 *
 * The lot graph stores node coordinates on the aisle *centreline* (the
 * divider between the two lanes). A car must drive in one lane, so every
 * resolved waypoint is offset perpendicular to its tangent by -LANE_WIDTH/2
 * (the left-hand driving lane relative to the travel direction). For straight
 * aisles this puts +x traffic at z = y - 1.75 and -x traffic at z = y + 1.75,
 * so the two directions never overlap. For curves the offset
 * produces a parallel curve, and for ramps only the horizontal (X-Z) lane
 * offset is applied — the vertical climb comes from the curve itself.
 *
 * Semicircle and ramp curve generators come from geometry.ts so the car path
 * follows the exact same geometry the road mesh is built from.
 */

/** Lane shift: shift to the driver's left (lot units). */
const LANE_SHIFT = -LANE_WIDTH / 2;

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

/** The two junctions connected to a turn, ordered by aisle position. */
function turnJunctions(lot: LotData, turnId: string): LotNode[] {
  const seen = new Set<string>();
  return (lot.edges[turnId] ?? [])
    .map((edge) => edge.to)
    .filter((id) => {
      if (seen.has(id) || lot.nodes[id]?.type !== "junction") return false;
      seen.add(id);
      return true;
    })
    .map((id) => lot.nodes[id])
    .sort((a, b) => a.y - b.y);
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
  // --- Ramp leg in either direction (same curve, reversed downhill) ---
  if (
    (fromNode.type === "ramp_up" && toNode.type === "ramp_in") ||
    (fromNode.type === "ramp_in" && toNode.type === "ramp_up")
  ) {
    const lower = fromNode.type === "ramp_up" ? fromNode : toNode;
    const upper = fromNode.type === "ramp_in" ? fromNode : toNode;
    const pts = rampPoints(
      toWorld(lower.x, lower.y, lower.floor),
      toWorld(upper.x, upper.y, upper.floor),
    );
    return offsetPerp(fromNode.type === "ramp_up" ? pts : [...pts].reverse(), LANE_SHIFT);
  }

  // --- Turn legs. The turn node sits at the end of the lower-numbered
  //     aisle. Travelling the other way reverses the same curve. ---
  if (fromNode.type === "turn" || toNode.type === "turn") {
    const turn = fromNode.type === "turn" ? fromNode : toNode;
    const turnId = nodeIdOf(lot, turn);
    const junctions = turnId ? turnJunctions(lot, turnId) : [];
    if (junctions.length === 2) {
      const near = junctions.find((node) => Math.abs(node.y - turn.y) < 0.01) ?? junctions[0];
      const far = junctions.find((node) => node !== near)!;
      const bulgeDir = Math.sign(turn.x - near.x) || 1;
      const semi = semicirclePoints(turn.x, near.y, far.y, bulgeDir, turn.floor);
      const curve = [worldOf(turn), ...semi.slice(1), worldOf(far)];
      let path: THREE.Vector3[];
      if (fromNode.type === "turn") {
        path = toNode === near ? [worldOf(turn), worldOf(near)] : curve;
      } else {
        path = fromNode === near ? [worldOf(near), worldOf(turn)] : [...curve].reverse();
      }
      return offsetPerp(path, LANE_SHIFT);
    }
    // Malformed turn: fall through to a straight line.
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
