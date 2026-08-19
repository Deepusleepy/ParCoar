import { memo, useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Text } from "@react-three/drei";
import type { CarRosterEntry, LotData, LotNode, NodeSign, NodeType, SlotSize } from "../types";
import {
  AISLE_SPACING,
  DIVIDER_COLOR,
  FLOOR_COLOR,
  FLOOR_HEIGHT,
  GUARDRAIL_COLOR,
  LANE_COLOR,
  LANE_WIDTH,
  MARKING_WHITE,
  PILLAR_COLOR,
  PILLAR_HEIGHT,
  ROAD_WIDTH,
  SLAB_PAD_X,
  SLAB_PAD_Z,
  SLOT_WIDTH,
  toWorld,
} from "./constants";
import { Envelope } from "./Envelope";
import { FloorPaint } from "./FloorPaint";
import { PermanentSignboard } from "./PermanentSignboard";
import { rampPoints, semicirclePoints } from "./geometry";

/* ================================================================== *
 *  Lot loading
 * ================================================================== */

/** Fetch and cache the lot graph from public/lot.json. */
function useLot(): LotData | null {
  const [lot, setLot] = useState<LotData | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/lot.json")
      .then((r) => r.json())
      .then((data: LotData) => {
        if (alive) setLot(data);
      })
      .catch(() => {
        /* keep null; Scene still renders controls/lighting */
      });
    return () => {
      alive = false;
    };
  }, []);
  return lot;
}

/* ================================================================== *
 *  Geometry helpers
 * ================================================================== */

/** Height of the road surface above the floor slab top. */
const ROAD_Y = 0.15;

/** Width of a raised concrete divider (across the road). */
const DIVIDER_WIDTH = 0.4;
/** Height of a raised concrete divider (above the road surface). */
const DIVIDER_HEIGHT = 0.22;

/** Spacing between perimeter pillars. Kept local to this file because the
 *  lot's JUNCTION_SPACING (2.6) is far too dense for structural columns and
 *  would render as a solid black wall of poles. */
const PILLAR_SPACING = 10;

/** Build a flat ribbon (road surface) following a polyline of points. */
function buildRibbon(points: THREE.Vector3[], width: number, yLift: number): THREE.BufferGeometry {
  const n = points.length;
  const half = width / 2;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();

  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (i === 0) tangent.subVectors(points[1], points[0]);
    else if (i === n - 1) tangent.subVectors(points[n - 1], points[n - 2]);
    else tangent.subVectors(points[i + 1], points[i - 1]);
    tangent.normalize();
    // Horizontal perpendicular (road width stays level across the lane).
    side.crossVectors(tangent, up).normalize();
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);

    const y = p.y + yLift;
    positions.push(p.x - side.x * half, y, p.z - side.z * half);
    positions.push(p.x + side.x * half, y, p.z + side.z * half);
    uvs.push(0, i / (n - 1));
    uvs.push(1, i / (n - 1));
  }

  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2);
    indices.push(a + 1, a + 3, a + 2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Build a continuous raised concrete divider following a polyline path. */
function buildSolidBarAlongPath(
  points: THREE.Vector3[],
  width: number,
  height: number,
  yBase: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const half = width / 2;
  const up = new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i === 0) tangent.subVectors(points[1], points[0]);
    else if (i === points.length - 1) tangent.subVectors(points[i], points[i - 1]);
    else tangent.subVectors(points[i + 1], points[i - 1]);
    tangent.setY(0).normalize();
    side.crossVectors(tangent, up).normalize();
    const y = p.y + yBase;
    positions.push(
      p.x - side.x * half, y, p.z - side.z * half,
      p.x + side.x * half, y, p.z + side.z * half,
      p.x - side.x * half, y + height, p.z - side.z * half,
      p.x + side.x * half, y + height, p.z + side.z * half,
    );
  }

  for (let i = 0; i < points.length - 1; i++) {
    const a = i * 4;
    const b = a + 4;
    indices.push(
      a, b, a + 1, a + 1, b, b + 1,
      a + 2, a + 3, b + 2, a + 3, b + 3, b + 2,
      a, a + 2, b, a + 2, b + 2, b,
      a + 1, b + 1, a + 3, b + 1, b + 3, a + 3,
    );
  }
  const last = (points.length - 1) * 4;
  indices.push(0, 1, 2, 1, 3, 2, last, last + 2, last + 1, last + 1, last + 2, last + 3);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** A BoxGeometry translated to (x, y, z). Used to build merged trim/bar sets. */
function makeBox(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.applyMatrix4(new THREE.Matrix4().setPosition(x, y, z));
  return g;
}

/** Offset every point of a polyline perpendicular to its tangent (in the X-Z plane). */
function offsetPoints(points: THREE.Vector3[], offset: number): THREE.Vector3[] {
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
    side.crossVectors(tangent, up).normalize();
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
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

/** Sample a point at a given arc-length distance along a polyline. */
function pointAtDistance(
  cum: number[],
  pts: THREE.Vector3[],
  dist: number,
): THREE.Vector3 {
  if (dist <= 0) return pts[0].clone();
  const total = cum[cum.length - 1];
  if (dist >= total) return pts[pts.length - 1].clone();
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < dist) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const segStart = cum[i - 1];
  const segLen = cum[i] - segStart;
  const t = segLen > 0 ? (dist - segStart) / segLen : 0;
  return pts[i - 1].clone().lerp(pts[i], t);
}

/** Cumulative arc-lengths for a polyline (precomputed for repeated sampling). */
function cumulativeLengths(points: THREE.Vector3[]): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + points[i].distanceTo(points[i - 1]));
  }
  return cum;
}

/* ================================================================== *
 *  Shared materials (module scope — live for the app lifetime)
 * ================================================================== */

const MAT_SLAB = new THREE.MeshStandardMaterial({
  color: FLOOR_COLOR,
  roughness: 0.96,
  metalness: 0,
  side: THREE.DoubleSide,
  envMapIntensity: 0.3,
});
const MAT_ASPHALT = new THREE.MeshStandardMaterial({
  color: LANE_COLOR,
  roughness: 0.95,
  side: THREE.DoubleSide,
  envMapIntensity: 0.3,
});
const MAT_EDGE = new THREE.MeshStandardMaterial({
  color: MARKING_WHITE,
  roughness: 0.5,
  emissive: MARKING_WHITE,
  emissiveIntensity: 0.1,
  side: THREE.DoubleSide,
  envMapIntensity: 0.3,
});
const MAT_DIVIDER = new THREE.MeshStandardMaterial({
  color: DIVIDER_COLOR,
  roughness: 0.9,
  envMapIntensity: 0.25,
});
const MAT_GUARDRAIL = new THREE.MeshStandardMaterial({
  color: GUARDRAIL_COLOR,
  roughness: 0.5,
  metalness: 0.6,
  envMapIntensity: 0.3,
});
const MAT_PILLAR = new THREE.MeshStandardMaterial({
  color: PILLAR_COLOR,
  roughness: 0.9,
  metalness: 0.1,
  envMapIntensity: 0.3,
});
const MAT_ARROW = new THREE.MeshStandardMaterial({
  color: MARKING_WHITE,
  roughness: 0.5,
  emissive: MARKING_WHITE,
  emissiveIntensity: 0.2,
  envMapIntensity: 0.3,
});
const MAT_GATE_FRAME = new THREE.MeshStandardMaterial({
  color: "#20242c",
  roughness: 0.8,
});
const MAT_GATE_GREEN = new THREE.MeshStandardMaterial({
  color: "#22c55e",
  emissive: "#22c55e",
  emissiveIntensity: 0.55,
  roughness: 0.4,
});
const MAT_GATE_RED = new THREE.MeshStandardMaterial({
  color: "#e5484d",
  emissive: "#e5484d",
  emissiveIntensity: 0.55,
  roughness: 0.4,
});
const MAT_AREA_DARK = new THREE.MeshStandardMaterial({
  color: "#080a10",
  metalness: 0.45,
  roughness: 0.55,
});
const MAT_AREA_SCREEN = new THREE.MeshStandardMaterial({
  color: "#000000",
  emissive: "#0a1622",
  emissiveIntensity: 0.4,
  roughness: 0.5,
  metalness: 0.1,
});

/* --- Shared static geometries (built once, reused, never disposed) --- */

/** Merged painted direction arrow: shaft + two chevron bars in one geometry. */
const ARROW_GEO = (() => {
  const parts: THREE.BufferGeometry[] = [];
  const shaft = new THREE.BoxGeometry(1.4, 0.02, 0.45);
  shaft.applyMatrix4(new THREE.Matrix4().setPosition(0, 0.005, 0));
  parts.push(shaft);
  for (const [dz, ry] of [[0.18, Math.PI / 4], [-0.18, -Math.PI / 4]] as const) {
    const bar = new THREE.BoxGeometry(0.55, 0.02, 0.28);
    const m = new THREE.Matrix4().makeRotationY(ry);
    m.setPosition(0.97, 0.005, dz);
    bar.applyMatrix4(m);
    parts.push(bar);
  }
  return mergeGeometries(parts, false) ?? new THREE.BufferGeometry();
})();

/** Gate kit: a kerbed island, attendant booth, boom housing, two side posts,
 *  and a top bar — all merged into one geometry sharing MAT_GATE_FRAME. The
 *  booth sits on the +z side of the road; the island raises it above the
 *  approach road so the gate reads as a real portal from a distance. */
const GATE_FRAME_GEO = (() => {
  const half = ROAD_WIDTH / 2; // 3.5
  return (
    mergeGeometries(
      [
        makeBox(0.3, 4, 0.3, 0, 2, -half), // south leg
        makeBox(0.3, 4, 0.3, 0, 2, half), // north leg
        makeBox(0.3, 0.3, ROAD_WIDTH + 0.4, 0, 4, 0), // top bar
        makeBox(0.7, 1.4, 0.7, 0, 3.0, half), // boom housing on north leg
        makeBox(2.2, 2.6, 2.2, 0, 1.6, 6), // attendant booth on the island
        makeBox(7, 0.45, 4.5, 0, 0.075, 5.75), // kerbed island (north of road)
      ],
      false,
    ) ?? new THREE.BufferGeometry()
  );
})();

/** Coloured gate parts: the raised boom arm and the label panel, merged into
 *  one draw call. Shared geometry; the material (green/red) is per gate.
 *
 *  Three things were wrong here and all three are visible in Deepu's
 *  screenshots:
 *   - The boom lay HORIZONTALLY across the road at y=3.0, and cars are 1.35
 *     to 1.65 tall, so every car drove straight through a closed barrier. It
 *     now stands vertically in the raised position, hinged at its housing,
 *     which is what an open barrier looks like and leaves the road clear.
 *   - The label panel was 1.8 wide in X and 0.12 thin in Z. The road runs
 *     along X, so a driver saw a 0.12-wide sliver edge-on, and from three
 *     quarters it sliced the word in half ("EXIT" read as "IT"). It is now
 *     thin in X and wide in Z, facing the traffic.
 *   - The boom tip box sat at z = -ROAD_WIDTH/2, exactly inside the south
 *     leg, permanently interpenetrating it. */
const GATE_ARM_LEN = ROAD_WIDTH - 0.9;
const GATE_BOOM_GEO = (() =>
  mergeGeometries(
    [
      // Raised arm, standing up from the housing on the north leg.
      makeBox(0.15, GATE_ARM_LEN, 0.12, 0, 3.5 + GATE_ARM_LEN / 2, ROAD_WIDTH / 2),
      // Tip, on the free (upper) end of the raised arm.
      makeBox(0.22, 0.3, 0.22, 0, 3.5 + GATE_ARM_LEN, ROAD_WIDTH / 2),
      // Label panel: thin across the road, wide along it, above the top bar.
      makeBox(0.14, 1.05, 3.0, 0, 4.85, 0),
    ],
    false,
  ) ?? new THREE.BufferGeometry())();

/** Emissive booth window on the booth's road-facing (south) face. */
const GATE_SCREEN_GEO = makeBox(1.4, 1.0, 0.06, 0, 1.6, 4.85);

/** How far back along the approach road the gate portal stands, away from the
 *  building. Both approach roads run in from -x, so the gate moves to -x.
 *
 *  It used to sit exactly on the entry/exit node at x = 0, which is also
 *  where the first aisle's two bay-range signboards stand (2.5 before the
 *  first bay, at z = +/-4.1). The gate's own legs are at z = +/-3.5 on the
 *  same x, so from a driver's seat each leg stood squarely in front of one
 *  board — the "A21 - A40" sign on the ground floor was permanently hidden
 *  behind a black post. Standing the portal off the building also reads
 *  better: a barrier belongs on the approach, before you are inside. */
const GATE_SETBACK = 6;

/** Area-sign dimensions shared by the merged sign body and the screen plane. */
// Sized against a 7-wide road and a 4.5-long car. The old 5.0 x 2.2 panel on
// a 4-unit post read as a motorway billboard standing indoors.
const AREA_POST_H = 2.9;
const AREA_PANEL_W = 3.2;
const AREA_PANEL_H = 1.25;

/** Merged area-sign body: vertical post + tilted panel frame in one geometry. */
const AREA_SIGN_GEO = (() => {
  const post = new THREE.CylinderGeometry(0.08, 0.08, AREA_POST_H, 8);
  post.applyMatrix4(new THREE.Matrix4().setPosition(0, AREA_POST_H / 2, 0));
  const panel = new THREE.BoxGeometry(AREA_PANEL_W, AREA_PANEL_H, 0.15);
  const m = new THREE.Matrix4().makeRotationX(0.15);
  m.setPosition(0, AREA_POST_H + AREA_PANEL_H / 2, 0);
  panel.applyMatrix4(m);
  return mergeGeometries([post, panel], false) ?? new THREE.BufferGeometry();
})();

/** Emissive screen plane for area signs. */
const AREA_SCREEN_GEO = new THREE.PlaneGeometry(AREA_PANEL_W - 0.4, AREA_PANEL_H - 0.3);

/* ================================================================== *
 *  Derived geometry descriptors
 * ================================================================== */

interface AisleDesc {
  floor: number;
  y: number;
  x0: number;
  x1: number;
  /** x extent of the junctions only (where the bays are), excluding the entry
   *  and ramp nodes that sit outside the parking at x = 0. */
  bayX0: number;
  bayX1: number;
  /** Aisle index (0-based) — even aisles flow +x, odd flow -x. */
  index: number;
}

interface CurveDesc {
  floor: number;
  points: THREE.Vector3[];
}

interface SlotDesc {
  id: string;
  pos: [number, number, number];
  size: SlotSize;
  rotY: number;
}

interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** X-range of edge parking slots on one long side of the slab. */
interface SlotEdge {
  minX: number;
  maxX: number;
}

/** Descriptor for a permanent ceiling-hung direction signboard. */
interface SignboardDesc {
  nodeId: string;
  position: [number, number, number];
  rotY: number;
  label: string;
  arrowRotation: number;
  isTopFloor: boolean;
  /** Floor the board sits on, used to filter the roster to cars on that floor. */
  floor: number;
}

/** Descriptor for a post-mounted parking-area info sign at an aisle entry.
 *  Shows the slot number range for that aisle (e.g. "A1 - A16 →"). */
interface AreaSignDesc {
  position: [number, number, number];
  rotY: number;
  label: string;
  /** True when this board's bays lie on the approaching driver's LEFT. The
   *  board faces oncoming traffic, so the arrow points that way on screen. */
  pointsLeft: boolean;
}

/** Parse the aisle index from a junction id "J{floor}_{aisle}_{n}". */
function aisleOf(id: string): number | null {
  const m = id.match(/^J\d+_(\d+)_\d+$/);
  return m ? Number(m[1]) : null;
}

/** Classify the lot graph into renderable descriptors. */
function buildGeometry(lot: LotData) {
  const aisles: AisleDesc[] = [];
  const turns: CurveDesc[] = [];
  const ramps: CurveDesc[] = [];
  const slots: SlotDesc[] = [];
  const signboards: SignboardDesc[] = [];
  const areaSigns: AreaSignDesc[] = [];
  const nodes = lot.nodes;
  // Top floor has no ceiling slab above it, so signboards there omit the rods.
  const maxFloor = Math.max(...Object.values(nodes).map((n) => n.floor));

  // --- Aisles: group junctions by (floor, aisle) ---
  const aisleMap = new Map<string, { floor: number; y: number; xs: number[]; index: number; bayX0?: number; bayX1?: number; hasConnection?: boolean }>();
  for (const [id, node] of Object.entries(nodes)) {
    if (node.type !== "junction") continue;
    const aisle = aisleOf(id);
    if (aisle === null) continue;
    const key = `${node.floor}:${aisle}`;
    const entry = aisleMap.get(key) ?? { floor: node.floor, y: node.y, xs: [], index: aisle };
    entry.xs.push(node.x);
    entry.bayX0 = Math.min(entry.bayX0 ?? node.x, node.x);
    entry.bayX1 = Math.max(entry.bayX1 ?? node.x, node.x);
    aisleMap.set(key, entry);
  }
  // Include entry/exit/ramp nodes that sit on an aisle centreline (same floor &
  // y) so the road surface covers the 10-unit gap between the first junction
  // (x=10) and the portal/ramp node at x=0.
  const connectionTypes = new Set<NodeType>(["entry", "exit", "ramp_up", "ramp_in"]);
  for (const node of Object.values(nodes)) {
    if (!connectionTypes.has(node.type)) continue;
    const aisle = Math.round(node.y / AISLE_SPACING);
    const entry = aisleMap.get(`${node.floor}:${aisle}`);
    if (entry) {
      entry.xs.push(node.x);
      // Remember the junction-only extent separately. The entry and ramp
      // nodes sit at x = 0, outside the parking, and letting them define the
      // aisle's start pushed the aisle-entrance signposts to x = -2.5: over
      // the edge of the building, straddling the ramp opening, standing on
      // nothing above a 15-unit drop. The road still needs the wider extent.
      entry.hasConnection = true;
    }
  }
  for (const { floor, y, xs, index, bayX0, bayX1 } of aisleMap.values()) {
    aisles.push({
      floor,
      y,
      x0: Math.min(...xs),
      x1: Math.max(...xs),
      // Extent of the JUNCTIONS only, i.e. where bays actually are. Signposts
      // use this so they never end up beyond the building edge.
      bayX0: bayX0 ?? Math.min(...xs),
      bayX1: bayX1 ?? Math.max(...xs),
      index,
    });
  }

  // --- Turns. The two junction neighbours are ordered by aisle index, which
  //     preserves the original serpentine traversal for geometry and boards. ---
  for (const [id, node] of Object.entries(nodes)) {
    if (node.type !== "turn") continue;
    const neighbours = (lot.edges[id] ?? [])
      .map((edge) => edge.to)
      .filter((target, index, all) => nodes[target]?.type === "junction" && all.indexOf(target) === index)
      .sort((a, b) => (aisleOf(a) ?? 0) - (aisleOf(b) ?? 0));
    const a = nodes[neighbours[0]];
    const b = nodes[neighbours[1]];
    if (!a || !b) continue;
    const bulgeDir = Math.sign(node.x - a.x) || 1;
    const fy = node.floor * FLOOR_HEIGHT;
    const semi = semicirclePoints(node.x, a.y, b.y, bulgeDir, node.floor);
    const points: THREE.Vector3[] = [
      new THREE.Vector3(a.x, fy, a.y),
      new THREE.Vector3(node.x, fy, a.y),
      ...semi.slice(1, -1),
      new THREE.Vector3(node.x, fy, b.y),
      new THREE.Vector3(b.x, fy, b.y),
    ];
    turns.push({ floor: node.floor, points });

    // Permanent signboard at this turn: classify LEFT/RIGHT from the cross
    // product of the approach and exit directions (in the world X-Z plane).
    const apx = node.x - a.x;
    const apz = node.y - a.y;
    const exx = b.x - node.x;
    const exz = b.y - node.y;
    const crossY = apz * exx - apx * exz;
    // With +Y up and the approach/exit vectors in the XZ plane, the driver's
    // left is (up x approach), so dot(exit, left) = apz*exx - apx*exz = crossY,
    // and crossY > 0 is a LEFT turn. This was inverted, so all nine boards in
    // the garage named the opposite of the turn the road actually makes.
    const isLeft = crossY > 0;
    // Face oncoming traffic: board +Z points back toward the incoming node.
    const faceX = a.x - node.x;
    const faceZ = a.y - node.y;
    const rotY = Math.atan2(faceX, faceZ);
    // Offset the board a few units back toward the incoming direction so it
    // sits just before the turn rather than on top of it.
    const apLen = Math.hypot(apx, apz) || 1;
    const off = 3;
    const sx = node.x - (apx / apLen) * off;
    const sy = node.y - (apz / apLen) * off;
    signboards.push({
      nodeId: id,
      position: toWorld(sx, sy, node.floor),
      rotY,
      label: isLeft ? "LEFT" : "RIGHT",
      arrowRotation: isLeft ? Math.PI / 2 : -Math.PI / 2,
      isTopFloor: node.floor === maxFloor,
      floor: node.floor,
    });
  }

  // --- Ramps: ramp_up -> ramp_in edges ---
  for (const [fromId, edgeList] of Object.entries(lot.edges)) {
    const from = nodes[fromId];
    if (from?.type !== "ramp_up") continue;
    const rampEdge = edgeList.find((edge) => nodes[edge.to]?.type === "ramp_in");
    const to = rampEdge ? nodes[rampEdge.to] : undefined;
    if (!to) continue;
    ramps.push({
      floor: from.floor,
      points: rampPoints(toWorld(from.x, from.y, from.floor), toWorld(to.x, to.y, to.floor)),
    });

    // Permanent "RAMP UP" signboard at the base of the ramp, facing the
    // traffic approaching the ramp_up node from its incoming junction.
    let incomingJ: LotNode | null = null;
    for (const [srcId, incomingEdges] of Object.entries(lot.edges)) {
      if (nodes[srcId]?.type === "junction" && incomingEdges.some((edge) => edge.to === fromId)) {
        incomingJ = nodes[srcId];
        break;
      }
    }
    if (incomingJ) {
      const apx = from.x - incomingJ.x;
      const apz = from.y - incomingJ.y;
      const apLen = Math.hypot(apx, apz) || 1;
      const off = 3;
      const sx = from.x - (apx / apLen) * off;
      const sy = from.y - (apz / apLen) * off;
      const destFloorLetter = String.fromCharCode(65 + from.floor + 1);
      signboards.push({
        nodeId: fromId,
        position: toWorld(sx, sy, from.floor),
        rotY: Math.atan2(incomingJ.x - from.x, incomingJ.y - from.y),
        label: `RAMP UP → ${destFloorLetter}`,
        arrowRotation: -Math.PI / 4, // angled upward
        isTopFloor: from.floor === maxFloor,
        floor: from.floor,
      });
    }
  }

  // --- Ramp-in hole positions: the upper floor slab must have a hole cut at
  // each ramp_in location so it doesn't overlap the top of the ramp. ---
  // Rectangular hole: halfX is short (covers ramp path through slab, doesn't
  // extend far into the road), halfZ covers the ramp width. Centre is shifted
  // toward the ramp entry (-x) so the road surface stays intact.
  const rampHoles = new Map<number, [number, number, number, number]>();
  for (const node of Object.values(nodes)) {
    if (node.type !== "ramp_in") continue;
    const pos = toWorld(node.x, node.y, node.floor);
    const halfZ = ROAD_WIDTH / 2 + 1; // 5.5 — covers ramp width
    const halfX = 9; // covers the ramp's approach under the widened slab
    const centerX = pos[0] - halfX; // hole right edge = pos[0] = road start (x=0)
    rampHoles.set(node.floor, [centerX, pos[2], halfX, halfZ]);
  }

  // --- Slots ---
  for (const [id, node] of Object.entries(nodes)) {
    if (node.type !== "slot" || !node.size) continue;
    const pos = toWorld(node.x, node.y, node.floor);
    // Rotate the slot so its opening faces the nearest aisle centreline.
    const aisleY = Math.round(node.y / AISLE_SPACING) * AISLE_SPACING;
    const rotY = node.y < aisleY ? 0 : Math.PI;
    slots.push({ id, pos, size: node.size, rotY });
  }

  // --- Parking area info signs (one per side of each aisle entry) ---
  // For each aisle, slots on the -y side and +y side get separate signs
  // showing the number range available on THAT side of the road.
  for (const aisle of aisles) {
    const floorLetter = String.fromCharCode(65 + aisle.floor);
    const aisleY = aisle.y;
    const leftNums: number[] = []; // -y side
    const rightNums: number[] = []; // +y side
    for (const [id, node] of Object.entries(nodes)) {
      if (node.type !== "slot" || node.floor !== aisle.floor) continue;
      const nearestAisleY = Math.round(node.y / AISLE_SPACING) * AISLE_SPACING;
      if (nearestAisleY !== aisleY) continue;
      const num = Number(id.replace(/^S\d+_/, ""));
      if (Number.isNaN(num)) continue;
      if (node.y < aisleY) leftNums.push(num);
      else rightNums.push(num);
    }

    // Even aisles flow +x (entry at low x); odd aisles flow -x (entry at high x).
    const flowsPositive = aisle.index % 2 === 0;
    const entryX = flowsPositive ? aisle.bayX0 : aisle.bayX1;
    const arrowDir: 1 | -1 = flowsPositive ? 1 : -1;
    // Sit the post BEFORE the first bay of the aisle. It used to be placed
    // 3 units *into* the aisle at a z of ROAD_WIDTH/2 + 1 = 4.5, but bays now
    // start only 3.5 from the aisle centreline, so the post was landing inside
    // a bay and running straight through whatever car was parked there.
    const signX = entryX - arrowDir * 2.5;
    // Face oncoming traffic: toward the entry end (opposite of travel dir).
    const faceX = -arrowDir;
    const rotY = Math.atan2(faceX, 0);
    // Place signs just outside the road edge on each side (road half-width + 1).
    const sideOffset = ROAD_WIDTH / 2 + 0.6;

    for (const [nums, sideSign] of [
      [leftNums, -1],
      [rightNums, 1],
    ] as [number[], -1 | 1][]) {
      if (nums.length === 0) continue;
      const minNum = Math.min(...nums);
      const maxNum = Math.max(...nums);
      const label = `${floorLetter}${minNum} - ${floorLetter}${maxNum}`;
      // Which hand is this row of bays on, for the driver coming down the
      // aisle? Facing +x, the driver's left is -z; facing -x it is +z. So the
      // row is on their left exactly when its side and the flow direction
      // disagree in sign.
      //
      // Both boards used to show the aisle's TRAVEL direction instead, so
      // every board in the garage displayed the same sideways arrow -- one of
      // them always pointing at the wrong row of bays, and neither of them
      // telling the driver anything the road markings didn't.
      const pointsLeft = sideSign * arrowDir < 0;
      areaSigns.push({
        position: toWorld(signX, aisleY + sideSign * sideOffset, aisle.floor),
        rotY,
        label,
        pointsLeft,
      });
    }
  }

  return { aisles, turns, ramps, slots, rampHoles, signboards, areaSigns };
}

/** World bounds of the lot footprint (with padding for slots/curves). */
function computeBounds(lot: LotData): Bounds {
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

/* ================================================================== *
 *  Sub-components
 * ================================================================== */

/** A concrete floor slab (doubles as the ceiling for the floor below).
 *  When `rampHole` is given (a world [centerX, centerZ, halfX, halfZ] tuple),
 *  a rectangular hole of those half-extents is cut out of the slab there so a
 *  ramp can pass through. All slab pieces share one material; the perimeter
 *  edge-trim bars are merged into one geometry, and the hole-trim bars into
 *  another, so each slab renders at most 3 draw calls. */
const FloorSlab = memo(function FloorSlab({
  floor,
  bounds,
  rampHole,
}: {
  floor: number;
  bounds: Bounds;
  rampHole?: [number, number, number, number];
}) {
  const w = bounds.maxX - bounds.minX;
  const d = bounds.maxZ - bounds.minZ;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const y = floor * FLOOR_HEIGHT;

  // No edge trim of any kind.
  //
  // The slab used to carry two sets of thin bars: four around its perimeter
  // and four framing the ramp opening, each 0.06 tall and 0.12 wide. Both
  // were meant to read as a kerb. At that size neither ever did. What they
  // actually produced was a hard hairline of a different tone drawn exactly
  // along the lip of the deck, running the full 81.6 by 77 of every storey,
  // which from any outside camera reads as a wire strung across the building.
  // That is the "weird rod" Deepu has photographed repeatedly. It is present
  // on all three floors because every slab draws its own.
  //
  // Proven by raycasting three separate pixel columns through the rod in his
  // screenshot: all three hit a mesh of size 81.72 x 0.06 x 77.12 in colour
  // #2a2d34 (MAT_TRIM), 2 to 4 pixels tall, sandwiched between the ramp road
  // above and below it.
  //
  // The hole trim was worse than cosmetic: its bar at the hole's right edge
  // sat at x = 0, spanning the full 11-unit width of the ramp opening — a bar
  // laid across the ramp mouth, exactly where a car drives off the ramp onto
  // the deck.
  //
  // Neither is needed. The Envelope already puts a 1-unit spandrel and a
  // lighter coping band along every slab edge, which is the kerb; the ramp
  // opening is framed by the ramp's own edge lines and guardrails.
  const slabGeo = useMemo(() => {
    if (!rampHole) return makeBox(w, 0.5, d, 0, -0.25, 0);

    // Hole case: split the slab into 4 boxes surrounding a rectangular hole.
    // rampHole = [centerX, centerZ, halfX, halfZ] (world coords).
    const holeHalfX = rampHole[2];
    const holeHalfZ = rampHole[3];
    // Hole centre relative to the slab group origin.
    const ox = rampHole[0] - cx;
    const oz = rampHole[1] - cz;
    // CLAMP the hole to the slab. The ramp opening is centred on the ramp,
    // which starts outside the building, so the raw hole extended 4.5 units
    // past the west edge. The left piece was then skipped (negative width)
    // while the top and bottom pieces were still drawn at the hole's FULL
    // width, so floors B and C grew a 4.5 x 77 tongue of slab sticking out
    // past floor A with no parapet and no guardrail over a 15 and 30 unit
    // drop. Clamping first keeps every piece inside the footprint.
    const holeLeft = Math.max(ox - holeHalfX, -w / 2);
    const holeRight = Math.min(ox + holeHalfX, w / 2);
    const holeMinZ = Math.max(oz - holeHalfZ, -d / 2);
    const holeMaxZ = Math.min(oz + holeHalfZ, d / 2);
    const clampedSizeX = Math.max(0, holeRight - holeLeft);
    const clampedCx = (holeLeft + holeRight) / 2;

    const leftW = holeLeft - -w / 2;
    const rightW = w / 2 - holeRight;
    const topD = holeMinZ - -d / 2;
    const botD = d / 2 - holeMaxZ;
    const slabParts: THREE.BufferGeometry[] = [];
    if (leftW > 0.01)
      slabParts.push(makeBox(leftW, 0.5, d, (-w / 2 + holeLeft) / 2, -0.25, 0));
    if (rightW > 0.01)
      slabParts.push(makeBox(rightW, 0.5, d, (holeRight + w / 2) / 2, -0.25, 0));
    if (topD > 0.01)
      slabParts.push(makeBox(clampedSizeX, 0.5, topD, clampedCx, -0.25, (-d / 2 + holeMinZ) / 2));
    if (botD > 0.01)
      slabParts.push(makeBox(clampedSizeX, 0.5, botD, clampedCx, -0.25, (holeMaxZ + d / 2) / 2));
    return mergeGeometries(slabParts, false) ?? new THREE.BufferGeometry();
  }, [w, d, cx, cz, rampHole]);

  useEffect(() => () => slabGeo.dispose(), [slabGeo]);

  return (
    <group position={[cx, y, cz]}>
      <mesh geometry={slabGeo} material={MAT_SLAB} receiveShadow castShadow />
    </group>
  );
});

/** A large painted directional arrow on the road surface (2.5 long, 0.6 wide).
 *  The shaft + chevron head are pre-merged into ARROW_GEO so each arrow is a
 *  single draw call sharing MAT_ARROW. */
function DirectionArrow({
  position,
  rotY = 0,
}: {
  position: [number, number, number];
  rotY?: number;
}) {
  // Arrow points along +x by default; rotate around Y to steer it.
  return <mesh position={position} rotation={[0, rotY, 0]} geometry={ARROW_GEO} material={MAT_ARROW} />;
}

/** A straight two-way aisle. The flat paint (edges, centre line, arrows, bay
 *  outlines) is now baked by <FloorPaint>; this component renders only the
 *  raised asphalt box that gives the road its 3D thickness and shadow. */
const AisleRoad = memo(function AisleRoad({ aisle }: { aisle: AisleDesc }) {
  const { floor, y, x0, x1 } = aisle;
  const len = x1 - x0;
  const cx = (x0 + x1) / 2;
  const baseY = floor * FLOOR_HEIGHT + ROAD_Y;

  return (
    <mesh position={[cx, baseY - 0.1, y]} material={MAT_ASPHALT} receiveShadow>
      <boxGeometry args={[len, 0.2, ROAD_WIDTH]} />
    </mesh>
  );
});

/** A curved two-way turn with a median, edge lines, guardrails, and arrows. */
const TurnRoad = memo(function TurnRoad({ turn }: { turn: CurveDesc }) {
  const edgeOffset = ROAD_WIDTH / 2 - 0.08;
  const ribbon = useMemo(
    () => buildRibbon(turn.points, ROAD_WIDTH, ROAD_Y + 0.005),
    [turn.points],
  );
  // Both edge ribbons share MAT_EDGE, so merge them into one geometry.
  const edges = useMemo(
    () => {
      const l = buildRibbon(offsetPoints(turn.points, edgeOffset), 0.22, ROAD_Y + 0.02);
      const r = buildRibbon(offsetPoints(turn.points, -edgeOffset), 0.22, ROAD_Y + 0.02);
      return mergeGeometries([l, r], false) ?? new THREE.BufferGeometry();
    },
    [turn.points, edgeOffset],
  );
  // Raised concrete divider on turns (no parking here, cars cannot cross).
  const divider = useMemo(
    () => buildSolidBarAlongPath(turn.points, DIVIDER_WIDTH, DIVIDER_HEIGHT, ROAD_Y + 0.005),
    [turn.points],
  );
  // Guardrails only cover the curved (semicircle) portion of the turn.
  // The straight approach/exit segments are part of the aisle road and have
  // adjacent parking slots — railing them would drop posts in front of slots.
  // turn.points = [entryJunction, semiStart, ...semiMid, semiEnd, exitJunction],
  // so slice(1, -1) keeps only the semicircle points (semiStart..semiEnd).
  const curvePts = useMemo(
    () => turn.points.slice(1, turn.points.length - 1),
    [turn.points],
  );
  const leftRailPts = useMemo(
    () => offsetPoints(curvePts, edgeOffset),
    [curvePts, edgeOffset],
  );
  const rightRailPts = useMemo(
    () => offsetPoints(curvePts, -edgeOffset),
    [curvePts, edgeOffset],
  );

  // Opposing arrows at the apex, one in each left-driving lane.
  const arrows = useMemo(() => {
    const pts = turn.points;
    const mid = Math.floor(pts.length / 2);
    const p = pts[mid];
    const a = pts[Math.max(0, mid - 1)];
    const b = pts[Math.min(pts.length - 1, mid + 1)];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const rotY = Math.atan2(-tz, tx);
    const tangent = new THREE.Vector3(tx, 0, tz).normalize();
    const side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize();
    const dx = side.x * LANE_WIDTH / 2;
    const dz = side.z * LANE_WIDTH / 2;
    return [
      { pos: [p.x - dx, p.y + ROAD_Y + 0.02, p.z - dz] as [number, number, number], rotY },
      { pos: [p.x + dx, p.y + ROAD_Y + 0.02, p.z + dz] as [number, number, number], rotY: rotY + Math.PI },
    ];
  }, [turn.points]);

  useEffect(() => {
    return () => {
      ribbon.dispose();
      edges.dispose();
      divider.dispose();
    };
  }, [ribbon, edges, divider]);

  return (
    <group>
      {/* Road surface */}
      <mesh geometry={ribbon} material={MAT_ASPHALT} receiveShadow />
      {/* Edge lines (left + right merged) */}
      <mesh geometry={edges} material={MAT_EDGE} />
      <mesh geometry={divider} material={MAT_DIVIDER} receiveShadow />
      {/* Guardrails on both outer edges of the turn */}
      <GuardRailAlongPath points={leftRailPts} yBase={ROAD_Y} />
      <GuardRailAlongPath points={rightRailPts} yBase={ROAD_Y} />
      {arrows.map((arrow, i) => (
        <DirectionArrow key={i} position={arrow.pos} rotY={arrow.rotY} />
      ))}
    </group>
  );
});

/** A two-way ramp between floors with a median, guardrails, and arrows. */
const RampRoad = memo(function RampRoad({ ramp }: { ramp: CurveDesc }) {
  const edgeOffset = ROAD_WIDTH / 2 - 0.08;
  // Soffit / support slab under the ramp (wider than the road).
  const soffit = useMemo(
    () => buildRibbon(ramp.points, ROAD_WIDTH + 1.2, ROAD_Y - 0.1),
    [ramp.points],
  );
  // Road surface. There used to be a "threshold apron" box at each end,
  // meant to bridge ramp to floor. It did the opposite: a FLAT 2-unit box
  // held at the ramp's FINAL height while the deck beneath it was still
  // climbing at 18%. Measured, that left a hard 0.362-unit step straight
  // across the full 7-unit carriageway, plus a coplanar z-fighting sliver
  // where the two surfaces met. That step is the dark band across the road
  // at the ramp joint that Deepu photographed repeatedly.
  //
  // No apron is needed. rampPoints() starts and ends exactly on the floor
  // heights, so the ribbon already meets each deck flush at ROAD_Y.
  const road = useMemo(
    () => buildRibbon(ramp.points, ROAD_WIDTH, ROAD_Y),
    [ramp.points],
  );
  // Both edge ribbons share MAT_EDGE, so merge them into one geometry.
  const edges = useMemo(() => {
    const l = buildRibbon(offsetPoints(ramp.points, edgeOffset), 0.22, ROAD_Y + 0.02);
    const r = buildRibbon(offsetPoints(ramp.points, -edgeOffset), 0.22, ROAD_Y + 0.02);
    return mergeGeometries([l, r], false) ?? new THREE.BufferGeometry();
  }, [ramp.points, edgeOffset]);
  // Raised concrete divider on ramps (no parking here, cars cannot cross).
  const divider = useMemo(
    () => buildSolidBarAlongPath(ramp.points, DIVIDER_WIDTH, DIVIDER_HEIGHT, ROAD_Y),
    [ramp.points],
  );
  // Guardrail paths (offset to both edges of the ramp).
  const leftRailPts = useMemo(
    () => offsetPoints(ramp.points, edgeOffset),
    [ramp.points, edgeOffset],
  );
  const rightRailPts = useMemo(
    () => offsetPoints(ramp.points, -edgeOffset),
    [ramp.points, edgeOffset],
  );

  // Opposing arrows near the ramp foot, one in each left-driving lane.
  const arrows = useMemo(() => {
    const pts = ramp.points;
    const i = Math.min(6, Math.floor(pts.length / 4));
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const rotY = Math.atan2(-tz, tx);
    const tangent = new THREE.Vector3(tx, 0, tz).normalize();
    const side = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize();
    const dx = side.x * LANE_WIDTH / 2;
    const dz = side.z * LANE_WIDTH / 2;
    return [
      { pos: [p.x - dx, p.y + ROAD_Y + 0.02, p.z - dz] as [number, number, number], rotY },
      { pos: [p.x + dx, p.y + ROAD_Y + 0.02, p.z + dz] as [number, number, number], rotY: rotY + Math.PI },
    ];
  }, [ramp.points]);

  useEffect(() => {
    return () => {
      soffit.dispose();
      road.dispose();
      edges.dispose();
      divider.dispose();
    };
  }, [soffit, road, edges, divider]);

  return (
    <group>
      {/* Support slab under ramp */}
      <mesh geometry={soffit} material={MAT_SLAB} receiveShadow />
      {/* Road surface */}
      <mesh geometry={road} material={MAT_ASPHALT} receiveShadow />
      {/* Edge lines (left + right merged) */}
      <mesh geometry={edges} material={MAT_EDGE} />
      <mesh geometry={divider} material={MAT_DIVIDER} receiveShadow />
      {/* Guardrails on both sides of the ramp */}
      <GuardRailAlongPath points={leftRailPts} yBase={ROAD_Y} />
      <GuardRailAlongPath points={rightRailPts} yBase={ROAD_Y} />
      {arrows.map((arrow, i) => (
        <DirectionArrow key={i} position={arrow.pos} rotY={arrow.rotY} />
      ))}
    </group>
  );
});

/** Structural pillars around the perimeter of one storey, rendered as a single
 *  InstancedMesh. Uses PILLAR_SPACING (10) instead of the lot's
 *  JUNCTION_SPACING (2.6) so columns read as columns, not a solid wall. */
const Pillars = memo(function Pillars({ floor, bounds }: { floor: number; bounds: Bounds }) {
  const mesh = useMemo(() => {
    const y0 = floor * FLOOR_HEIGHT;
    const cy = y0 + PILLAR_HEIGHT / 2;
    const zA = bounds.minZ + 1.5;
    const zB = bounds.maxZ - 1.5;
    const positions: [number, number, number][] = [];
    const xStart = Math.ceil(bounds.minX / PILLAR_SPACING) * PILLAR_SPACING;
    for (let x = xStart; x <= bounds.maxX; x += PILLAR_SPACING) {
      positions.push([x, cy, zA], [x, cy, zB]);
    }
    // Corner pillars on the short ends.
    for (const x of [bounds.minX + 1.5, bounds.maxX - 1.5]) {
      positions.push([x, cy, zA], [x, cy, zB]);
    }
    if (positions.length === 0) return null;
    const geo = new THREE.CylinderGeometry(0.35, 0.4, PILLAR_HEIGHT, 12);
    const inst = new THREE.InstancedMesh(geo, MAT_PILLAR, positions.length);
    inst.castShadow = true;
    const m = new THREE.Matrix4();
    for (let i = 0; i < positions.length; i++) {
      m.setPosition(positions[i][0], positions[i][1], positions[i][2]);
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    return inst;
  }, [floor, bounds]);

  useEffect(() => {
    return () => {
      // Dispose the per-storey geometry; the shared material is not disposed.
      mesh?.geometry.dispose();
    };
  }, [mesh]);

  if (!mesh) return null;
  return <primitive object={mesh} />;
});

/**
 * Post-and-rail guardrail along a polyline, built as ONE merged geometry
 * (every post + every rail segment) so the whole rail renders as a single
 * draw call sharing MAT_GUARDRAIL.
 * Posts: 0.8 high, 0.08 diameter cylinders every 4 units.
 * Rail: 0.06 diameter horizontal cylinder at 0.7 height.
 */
function GuardRailAlongPath({
  points,
  yBase,
}: {
  points: THREE.Vector3[];
  yBase: number;
}) {
  const geo = useMemo(() => {
    if (points.length < 2) return new THREE.BufferGeometry();
    const cum = cumulativeLengths(points);
    const total = cum[cum.length - 1];
    const postPts: THREE.Vector3[] = [];
    for (let d = 0; d <= total; d += 4) {
      postPts.push(pointAtDistance(cum, points, d));
    }
    // Ensure a post at the very end.
    const last = points[points.length - 1];
    if (postPts[postPts.length - 1].distanceTo(last) > 0.5) {
      postPts.push(last.clone());
    }

    const parts: THREE.BufferGeometry[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (const p of postPts) {
      const post = new THREE.CylinderGeometry(0.04, 0.04, 0.8, 8);
      post.applyMatrix4(new THREE.Matrix4().setPosition(p.x, p.y + yBase + 0.4, p.z));
      parts.push(post);
    }
    for (let i = 0; i < postPts.length - 1; i++) {
      const a = postPts[i];
      const b = postPts[i + 1];
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const dir = b.clone().sub(a).normalize();
      const len = a.distanceTo(b);
      const rail = new THREE.CylinderGeometry(0.03, 0.03, len, 8);
      const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
      const matrix = new THREE.Matrix4().compose(
        new THREE.Vector3(mid.x, mid.y + yBase + 0.7, mid.z),
        quat,
        new THREE.Vector3(1, 1, 1),
      );
      rail.applyMatrix4(matrix);
      parts.push(rail);
    }
    return mergeGeometries(parts, false) ?? new THREE.BufferGeometry();
  }, [points, yBase]);

  useEffect(() => () => geo.dispose(), [geo]);

  if (points.length < 2) return null;
  return <mesh geometry={geo} material={MAT_GUARDRAIL} castShadow />;
}

/**
 * Post-and-rail guardrails along the exposed outer edges of a floor.
 * The rails are split into segments that avoid the X-range of edge parking
 * slots so they don't visually obstruct the slot markings.
 */
const GuardRails = memo(function GuardRails({
  floor,
  bounds,
  southSlots,
  northSlots,
}: {
  floor: number;
  bounds: Bounds;
  southSlots: SlotEdge | null;
  northSlots: SlotEdge | null;
}) {
  const slabY = floor * FLOOR_HEIGHT;

  /** Build guardrail polylines along one long edge, leaving a gap over the
   *  slot area so the rails only cover the driving/turn portions. */
  const segments = useMemo(() => {
    const margin = SLOT_WIDTH / 2 + 1;
    const buildSegs = (z: number, edge: SlotEdge | null): THREE.Vector3[][] => {
      if (!edge) {
        return [[
          new THREE.Vector3(bounds.minX, slabY, z),
          new THREE.Vector3(bounds.maxX, slabY, z),
        ]];
      }
      const slotStart = edge.minX - margin;
      const slotEnd = edge.maxX + margin;
      const segs: THREE.Vector3[][] = [];
      if (bounds.minX < slotStart) {
        segs.push([
          new THREE.Vector3(bounds.minX, slabY, z),
          new THREE.Vector3(slotStart, slabY, z),
        ]);
      }
      if (bounds.maxX > slotEnd) {
        segs.push([
          new THREE.Vector3(slotEnd, slabY, z),
          new THREE.Vector3(bounds.maxX, slabY, z),
        ]);
      }
      return segs;
    };
    return {
      south: buildSegs(bounds.minZ + 0.6, southSlots),
      north: buildSegs(bounds.maxZ - 0.6, northSlots),
    };
  }, [bounds, slabY, southSlots, northSlots]);

  return (
    <group>
      {segments.south.map((pts, i) => (
        <GuardRailAlongPath key={`s${i}`} points={pts} yBase={0} />
      ))}
      {segments.north.map((pts, i) => (
        <GuardRailAlongPath key={`n${i}`} points={pts} yBase={0} />
      ))}
    </group>
  );
});

/** An entry/exit portal: kerbed island, attendant booth with a lit window,
 *  boom barrier on a proper housing, two side posts, a top bar, and a coloured
 *  overhead label. Entry and exit use the same kit — green boom vs red boom.
 *  Three draw calls per gate (frame, coloured boom, booth screen). */
const Gate = memo(function Gate({
  position,
  color,
  label,
}: {
  position: [number, number, number];
  color: string;
  label: string;
}) {
  const [x, y, z] = position;
  const barMat = color === "#22c55e" ? MAT_GATE_GREEN : MAT_GATE_RED;
  return (
    <group position={[x, y, z]}>
      {/* Frame: legs + top bar + boom housing + booth + kerbed island (merged) */}
      <mesh geometry={GATE_FRAME_GEO} material={MAT_GATE_FRAME} castShadow receiveShadow />
      {/* Coloured boom arm + tip + label backplate (merged) */}
      <mesh geometry={GATE_BOOM_GEO} material={barMat} />
      {/* Lit booth window */}
      <mesh geometry={GATE_SCREEN_GEO} material={MAT_AREA_SCREEN} />
      {/* Billboarded in-world text, not a DOM overlay. As <Html> with
          occlude={false} the label painted on top of everything, including
          pillars in front of it and even when the camera was underneath the
          building, and distanceFactor blew it up absurdly at close range.
          The floor labels were moved off <Html> for exactly this reason; the
          gates were missed. */}
      {/* One label on each face of the panel, fixed rather than billboarded.
          A Billboard rotates freely and sliced itself through the panel from
          three-quarter angles; two fixed faces read correctly from either
          approach and can never intersect the geometry they sit on. */}
      {([1, -1] as const).map((face) => (
        <Text
          key={face}
          position={[face * 0.09, 4.85, 0]}
          rotation={[0, face * (Math.PI / 2), 0]}
          fontSize={0.66}
          color="#ffffff"
          anchorX="center"
          anchorY="middle"
          letterSpacing={0.12}
          outlineWidth={0.035}
          outlineColor="#000000"
        >
          {label}
        </Text>
      ))}
    </group>
  );
});

/** A simple approach road segment outside the lot boundary with edge lines. */
const ApproachRoad = memo(function ApproachRoad({
  from,
  to,
  floor,
}: {
  from: [number, number];
  to: [number, number];
  floor: number;
}) {
  const [x0, z0] = from;
  const [x1, z1] = to;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const len = Math.abs(x1 - x0);
  const baseY = floor * FLOOR_HEIGHT + ROAD_Y;
  const half = ROAD_WIDTH / 2;

  // Both edge lines share MAT_EDGE, so merge them into one geometry.
  const edges = useMemo(() => {
    const a = makeBox(len, 0.02, 0.15, cx, baseY + 0.01, cz - half + 0.075);
    const b = makeBox(len, 0.02, 0.15, cx, baseY + 0.01, cz + half - 0.075);
    return mergeGeometries([a, b], false) ?? new THREE.BufferGeometry();
  }, [len, cx, cz, baseY, half]);

  useEffect(() => () => edges.dispose(), [edges]);

  return (
    <group>
      {/* Road surface */}
      <mesh position={[cx, baseY - 0.1, cz]} material={MAT_ASPHALT} receiveShadow>
        <boxGeometry args={[len, 0.2, ROAD_WIDTH]} />
      </mesh>
      {/* Edge lines (left + right merged) */}
      <mesh geometry={edges} material={MAT_EDGE} />
    </group>
  );
});


/** A post-mounted parking-area info sign at an aisle entry.
 *  Shows the slot number range for that aisle (e.g. "A1 - A16") with an
 *  arrow pointing in the direction of travel. Dark LED aesthetic matching
 *  the permanent signboards: matte-black frame, sky-blue accent. The post +
 *  tilted panel frame are pre-merged into AREA_SIGN_GEO so each sign is two
 *  meshes (body + screen) plus its two troika labels. */
const AreaSignboard = memo(function AreaSignboard({ sign }: { sign: AreaSignDesc }) {
  const [x, y, z] = sign.position;
  const ACCENT = "#38bdf8";

  return (
    <group position={[x, y, z]} rotation={[0, sign.rotY, 0]}>
      {/* Merged post + tilted panel frame */}
      <mesh geometry={AREA_SIGN_GEO} material={MAT_AREA_DARK} castShadow />
      {/* Tilted screen group (matches the tilt baked into the panel frame) */}
      <group position={[0, AREA_POST_H + AREA_PANEL_H / 2, 0]} rotation={[0.15, 0, 0]}>
        {/* Emissive screen — true black with dark-blue glow */}
        <mesh geometry={AREA_SCREEN_GEO} material={MAT_AREA_SCREEN} position={[0, 0, 0.08]} />
        {/* Slot range label */}
        <Text
          position={[0, 0.18, 0.1]}
          fontSize={0.42}
          color="#f1f5f9"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.02}
          outlineColor="#000000"
        >
          {sign.label}
        </Text>
        {/* Arrow pointing at the row of bays this board is announcing. It sat
            at y = -0.55, which is outside the 0.95-tall screen (+/-0.475) and
            half off the panel frame \u2014 the arrow appeared to float below the
            board rather than on it. */}
        <Text
          position={[0, -0.28, 0.1]}
          fontSize={0.4}
          color={ACCENT}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.02}
          outlineColor="#000000"
        >
          {sign.pointsLeft ? "\u2190" : "\u2192"}
        </Text>
      </group>
    </group>
  );
});


/* ================================================================== *
 *  Main component
 * ================================================================== */

export const ParkingLot = memo(function ParkingLot({
  nodeSigns,
  carRoster,
}: {
  nodeSigns?: NodeSign[];
  carRoster?: CarRosterEntry[];
}) {
  const lot = useLot();

  const geo = useMemo(() => (lot ? buildGeometry(lot) : null), [lot]);
  const bounds = useMemo(() => (lot ? computeBounds(lot) : null), [lot]);
  // Lookup of dynamic sign data by node id, so each permanent signboard can
  // show real-time car info when a car is waiting at its node.
  const signByNodeId = useMemo(
    () => new Map(nodeSigns?.map((s) => [s.nodeId, s])),
    [nodeSigns],
  );
  const floors = useMemo(() => {
    if (!lot) return [];
    const set = new Set<number>();
    for (const n of Object.values(lot.nodes)) set.add(n.floor);
    return [...set].sort((a, b) => a - b);
  }, [lot]);

  const entry = useMemo(() => {
    if (!lot) return null;
    const e = Object.values(lot.nodes).find((n) => n.type === "entry");
    return e ? { pos: toWorld(e.x, e.y, e.floor) as [number, number, number], x: e.x, y: e.y, floor: e.floor } : null;
  }, [lot]);

  const exit = useMemo(() => {
    if (!lot) return null;
    const x = Object.values(lot.nodes).find((n) => n.type === "exit");
    return x ? { pos: toWorld(x.x, x.y, x.floor) as [number, number, number], x: x.x, y: x.y, floor: x.floor } : null;
  }, [lot]);

  // X-range of the edge parking slots (closest to the south/north slab edges)
  // so the perimeter guardrails can be split to avoid obstructing them.
  const slotEdges = useMemo(() => {
    if (!geo || geo.slots.length === 0) return { south: null, north: null };
    const zs = geo.slots.map((s) => s.pos[2]);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const south = geo.slots.filter((s) => s.pos[2] === minZ);
    const north = geo.slots.filter((s) => s.pos[2] === maxZ);
    return {
      south: south.length ? { minX: Math.min(...south.map((s) => s.pos[0])), maxX: Math.max(...south.map((s) => s.pos[0])) } : null,
      north: north.length ? { minX: Math.min(...north.map((s) => s.pos[0])), maxX: Math.max(...north.map((s) => s.pos[0])) } : null,
    };
  }, [geo]);

  if (!lot || !geo || !bounds) return null;
  const maxFloor = floors[floors.length - 1];

  return (
    <group>
      {/* Building envelope: site apron, perimeter spandrels, stair/lift core,
          roof parapet. Sits under/around the slabs so the structure reads as
          finished instead of floating in the void. */}
      <Envelope bounds={bounds} floors={floors} />

      {/* Floor slabs (each upper slab is the ceiling of the storey below). */}
      {floors.map((f) => (
        <FloorSlab key={`slab${f}`} floor={f} bounds={bounds} rampHole={geo.rampHoles.get(f)} />
      ))}

      {/* Baked flat paint per floor: road surface, edge/centre lines, bay
          outlines, bay numbers, and direction arrows — one textured plane. */}
      {floors.map((f) => (
        <FloorPaint key={`paint${f}`} lot={lot} floor={f} bounds={bounds} />
      ))}

      {/* Pillars hold up the ceiling of each non-top storey. */}
      {floors
        .filter((f) => f < maxFloor)
        .map((f) => (
          <Pillars key={`pil${f}`} floor={f} bounds={bounds} />
        ))}

      {/* Post-and-rail guardrails along the exposed long edges of every storey. */}
      {floors.map((f) => (
        <GuardRails
          key={`rail${f}`}
          floor={f}
          bounds={bounds}
          southSlots={slotEdges.south}
          northSlots={slotEdges.north}
        />
      ))}

      {/* Driving lanes, curved turns, and spiral ramps. */}
      {geo.aisles.map((a, i) => (
        <AisleRoad key={`a${i}`} aisle={a} />
      ))}
      {geo.turns.map((t, i) => (
        <TurnRoad key={`t${i}`} turn={t} />
      ))}
      {geo.ramps.map((r, i) => (
        <RampRoad key={`r${i}`} ramp={r} />
      ))}

      {/* Permanent direction signboards at all turns and ramps. When a car is
          waiting at a board's node, the board becomes a dynamic screen showing
          that car's colour, plate, direction, and assigned slot. */}
      {geo.signboards.map((s, i) => (
        <PermanentSignboard
          key={`ps${i}`}
          position={s.position}
          rotY={s.rotY}
          label={s.label}
          arrowRotation={s.arrowRotation}
          isTopFloor={s.isTopFloor}
          floor={s.floor}
          dynamic={signByNodeId.get(s.nodeId)}
          roster={carRoster}
        />
      ))}

      {/* Parking area info signs at aisle entries (slot range per aisle). */}
      {geo.areaSigns.map((s, i) => (
        <AreaSignboard key={`as${i}`} sign={s} />
      ))}

      {/* Floor labels are now rendered in Scene.tsx (bright, billboarded). */}

      {/* Entry / exit approach roads and portal gates. */}
      {entry && (
        <>
          <ApproachRoad
            from={[entry.x - 15, entry.y]}
            to={[entry.x, entry.y]}
            floor={entry.floor}
          />
          <Gate
            position={[entry.pos[0] - GATE_SETBACK, entry.pos[1], entry.pos[2]]}
            color="#22c55e"
            label="ENTRY"
          />
        </>
      )}
      {exit && (
        <>
          <ApproachRoad
            from={[exit.x, exit.y]}
            to={[exit.x - 15, exit.y]}
            floor={exit.floor}
          />
          <Gate
            position={[exit.pos[0] - GATE_SETBACK, exit.pos[1], exit.pos[2]]}
            color="#e5484d"
            label="EXIT"
          />
        </>
      )}
    </group>
  );
});

/** World bounds of the lot (re-exported for camera framing in Scene). */
export function lotBounds(lot: LotData) {
  const xs = Object.values(lot.nodes).map((n) => n.x);
  const ys = Object.values(lot.nodes).map((n) => n.y);
  const floors = Object.values(lot.nodes).map((n) => n.floor);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minZ: Math.min(...ys),
    maxZ: Math.max(...ys),
    minFloor: Math.min(...floors),
    maxFloor: Math.max(...floors),
  };
}

// Re-export for type usage in other files.
export type { LotNode };
