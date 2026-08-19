import { memo, useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Html, Text } from "@react-three/drei";
import type { CarRosterEntry, LotData, LotNode, NodeSign, NodeType, SlotSize } from "../types";
import {
  AISLE_SPACING,
  CENTER_LINE_COLOR,
  DIVIDER_COLOR,
  FLOOR_COLOR,
  FLOOR_HEIGHT,
  GUARDRAIL_COLOR,
  JUNCTION_SPACING,
  LANE_COLOR,
  LANE_WIDTH,
  MARKING_WHITE,
  PILLAR_COLOR,
  PILLAR_HEIGHT,
  RAMP_COLOR,
  RAMP_LENGTH,
  ROAD_WIDTH,
  SLOT_DEPTH,
  SLOT_OUTLINE_HEX,
  SLOT_SIZE,
  SLOT_WIDTH,
  toWorld,
} from "./constants";
import { PermanentSignboard } from "./PermanentSignboard";

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
const DIVIDER_HEIGHT = 0.3;

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

/** Build a raised solid bar (concrete divider) following a polyline path.
 *  Each segment becomes a box oriented along the segment direction; all
 *  segments are merged into a single geometry for efficient rendering. */
function buildSolidBarAlongPath(
  points: THREE.Vector3[],
  width: number,
  height: number,
  yBase: number,
): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  const up = new THREE.Vector3(0, 0, 1); // box local +z = length axis
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-6) continue;
    dir.normalize();
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const box = new THREE.BoxGeometry(width, height, len);
    const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(mid.x, mid.y + yBase + height / 2, mid.z),
      quat,
      new THREE.Vector3(1, 1, 1),
    );
    box.applyMatrix4(matrix);
    geos.push(box);
  }
  return mergeGeometries(geos, false) ?? new THREE.BufferGeometry();
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

/** Points for a 180° semicircle connecting two same-x junctions. */
function semicirclePoints(
  ax: number,
  ay: number,
  by: number,
  bulgeDir: number,
  floor: number,
  segments = 28,
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

/* ================================================================== *
 *  Derived geometry descriptors
 * ================================================================== */

interface AisleDesc {
  floor: number;
  y: number;
  x0: number;
  x1: number;
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
  /** Direction the arrow points along the aisle (+1 = +x, -1 = -x). */
  arrowDir: 1 | -1;
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
  const aisleMap = new Map<string, { floor: number; y: number; xs: number[]; index: number }>();
  for (const [id, node] of Object.entries(nodes)) {
    if (node.type !== "junction") continue;
    const aisle = aisleOf(id);
    if (aisle === null) continue;
    const key = `${node.floor}:${aisle}`;
    const entry = aisleMap.get(key) ?? { floor: node.floor, y: node.y, xs: [], index: aisle };
    entry.xs.push(node.x);
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
    if (entry) entry.xs.push(node.x);
  }
  for (const { floor, y, xs, index } of aisleMap.values()) {
    aisles.push({
      floor,
      y,
      x0: Math.min(...xs),
      x1: Math.max(...xs),
      index,
    });
  }

  // --- Turns: for each turn node, find incoming & outgoing junctions ---
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
    const isLeft = crossY < 0;
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
    const to = nodes[edgeList[0]?.to];
    if (to?.type !== "ramp_in") continue;
    ramps.push({
      floor: from.floor,
      points: rampPoints(toWorld(from.x, from.y, from.floor), toWorld(to.x, to.y, to.floor)),
    });

    // Permanent "RAMP UP" signboard at the base of the ramp, facing the
    // traffic approaching the ramp_up node from its incoming junction.
    let incomingJ: LotNode | null = null;
    for (const [srcId, edgeList] of Object.entries(lot.edges)) {
      if (edgeList.some((edge) => edge.to === fromId)) {
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
    const halfX = 7; // covers ramp path through slab, doesn't extend far into road
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
    const entryX = flowsPositive ? aisle.x0 : aisle.x1;
    const arrowDir: 1 | -1 = flowsPositive ? 1 : -1;
    const signX = entryX + arrowDir * 3;
    // Face oncoming traffic: toward the entry end (opposite of travel dir).
    const faceX = -arrowDir;
    const rotY = Math.atan2(faceX, 0);
    // Place signs just outside the road edge on each side (road half-width + 1).
    const sideOffset = ROAD_WIDTH / 2 + 1;

    for (const [nums, sideY] of [
      [leftNums, aisleY - sideOffset],
      [rightNums, aisleY + sideOffset],
    ] as [number[], number][]) {
      if (nums.length === 0) continue;
      const minNum = Math.min(...nums);
      const maxNum = Math.max(...nums);
      const label = `${floorLetter}${minNum} - ${floorLetter}${maxNum}`;
      // The -y board (sideY < aisleY) is viewed from the opposite side, so
      // its arrow direction must be flipped relative to the aisle travel dir.
      const sideArrowDir: 1 | -1 = sideY < aisleY ? (-arrowDir as 1 | -1) : arrowDir;
      areaSigns.push({
        position: toWorld(signX, sideY, aisle.floor),
        rotY,
        label,
        arrowDir: sideArrowDir,
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
    minX: Math.min(...xs) - AISLE_SPACING / 2 - 1,
    maxX: Math.max(...xs) + AISLE_SPACING / 2 + 1,
    minZ: Math.min(...ys) - SLOT_DEPTH - 2,
    maxZ: Math.max(...ys) + SLOT_DEPTH + 2,
  };
}

/* ================================================================== *
 *  Sub-components
 * ================================================================== */

/** A concrete floor slab (doubles as the ceiling for the floor below).
 *  When `rampHole` is given (a world [centerX, centerZ, halfX, halfZ] tuple),
 *  a rectangular hole of those half-extents is cut out of the slab there so a
 *  ramp can pass through. */
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

  // Slab material shared by every slab piece. Opaque so shadows work.
  const slabMat = (
    <meshStandardMaterial
      color={FLOOR_COLOR}
      roughness={0.96}
      metalness={0}
      envMapIntensity={0.3}
    />
  );

  // When no hole is needed, render one solid slab box.
  if (!rampHole) {
    return (
      <group position={[cx, y, cz]}>
        {/* Driving surface / ceiling slab */}
        <mesh receiveShadow castShadow position={[0, -0.25, 0]}>
          <boxGeometry args={[w, 0.5, d]} />
          {slabMat}
        </mesh>
        {/* Bright edge trim for depth perception */}
        <mesh position={[0, 0.02, d / 2]}>
          <boxGeometry args={[w, 0.06, 0.12]} />
          <meshStandardMaterial color="#2a2d34" roughness={0.7} envMapIntensity={0.3} />
        </mesh>
        <mesh position={[0, 0.02, -d / 2]}>
          <boxGeometry args={[w, 0.06, 0.12]} />
          <meshStandardMaterial color="#2a2d34" roughness={0.7} envMapIntensity={0.3} />
        </mesh>
        <mesh position={[w / 2, 0.02, 0]}>
          <boxGeometry args={[0.12, 0.06, d]} />
          <meshStandardMaterial color="#2a2d34" roughness={0.7} envMapIntensity={0.3} />
        </mesh>
        <mesh position={[-w / 2, 0.02, 0]}>
          <boxGeometry args={[0.12, 0.06, d]} />
          <meshStandardMaterial color="#2a2d34" roughness={0.7} envMapIntensity={0.3} />
        </mesh>
      </group>
    );
  }

  // Hole case: split the slab into 4 boxes surrounding a rectangular hole.
  // rampHole = [centerX, centerZ, halfX, halfZ] (world coords).
  const holeHalfX = rampHole[2];
  const holeHalfZ = rampHole[3];
  const holeSizeX = holeHalfX * 2;
  const holeSizeZ = holeHalfZ * 2;
  // Hole centre relative to the slab group origin.
  const ox = rampHole[0] - cx;
  const oz = rampHole[1] - cz;
  const holeLeft = ox - holeHalfX;
  const holeRight = ox + holeHalfX;
  const holeMinZ = oz - holeHalfZ;
  const holeMaxZ = oz + holeHalfZ;

  // Four surrounding boxes (each as [width, depth, centerX, centerZ]).
  // Left/right span the full slab depth; top/bottom span the hole width in X.
  const leftW = holeLeft - -w / 2;
  const rightW = w / 2 - holeRight;
  const topD = holeMinZ - -d / 2;
  const botD = d / 2 - holeMaxZ;
  const pieces: { size: [number, number]; pos: [number, number] }[] = [];
  if (leftW > 0.01)
    pieces.push({ size: [leftW, d], pos: [(-w / 2 + holeLeft) / 2, 0] });
  if (rightW > 0.01)
    pieces.push({ size: [rightW, d], pos: [(holeRight + w / 2) / 2, 0] });
  if (topD > 0.01)
    pieces.push({ size: [holeSizeX, topD], pos: [ox, (-d / 2 + holeMinZ) / 2] });
  if (botD > 0.01)
    pieces.push({ size: [holeSizeX, botD], pos: [ox, (holeMaxZ + d / 2) / 2] });

  return (
    <group position={[cx, y, cz]}>
      {pieces.map((p, i) => (
        <mesh key={`slab${i}`} receiveShadow castShadow position={[p.pos[0], -0.25, p.pos[1]]}>
          <boxGeometry args={[p.size[0], 0.5, p.size[1]]} />
          {slabMat}
        </mesh>
      ))}
      {/* Bright edge trim for depth perception (full perimeter) */}
      <mesh position={[0, 0.02, d / 2]}>
        <boxGeometry args={[w, 0.06, 0.12]} />
        <meshStandardMaterial color="#2a2d34" roughness={0.7} envMapIntensity={0.3} />
      </mesh>
      <mesh position={[0, 0.02, -d / 2]}>
        <boxGeometry args={[w, 0.06, 0.12]} />
        <meshStandardMaterial color="#2a2d34" roughness={0.7} envMapIntensity={0.3} />
      </mesh>
      <mesh position={[w / 2, 0.02, 0]}>
        <boxGeometry args={[0.12, 0.06, d]} />
        <meshStandardMaterial color="#2a2d34" roughness={0.7} envMapIntensity={0.3} />
      </mesh>
      <mesh position={[-w / 2, 0.02, 0]}>
        <boxGeometry args={[0.12, 0.06, d]} />
        <meshStandardMaterial color="#2a2d34" roughness={0.7} envMapIntensity={0.3} />
      </mesh>
      {/* Hole edge trim — four thin bars framing the ramp opening */}
      <mesh position={[ox, 0.02, holeMinZ]}>
        <boxGeometry args={[holeSizeX, 0.06, 0.12]} />
        <meshStandardMaterial color="#2a2d34" roughness={0.7} envMapIntensity={0.3} />
      </mesh>
      <mesh position={[ox, 0.02, holeMaxZ]}>
        <boxGeometry args={[holeSizeX, 0.06, 0.12]} />
        <meshStandardMaterial color="#2a2d34" roughness={0.7} envMapIntensity={0.3} />
      </mesh>
      <mesh position={[holeLeft, 0.02, oz]}>
        <boxGeometry args={[0.12, 0.06, holeSizeZ]} />
        <meshStandardMaterial color="#2a2d34" roughness={0.7} envMapIntensity={0.3} />
      </mesh>
      <mesh position={[holeRight, 0.02, oz]}>
        <boxGeometry args={[0.12, 0.06, holeSizeZ]} />
        <meshStandardMaterial color="#2a2d34" roughness={0.7} envMapIntensity={0.3} />
      </mesh>
    </group>
  );
});

/** A large painted directional arrow on the road surface (2.5 long, 0.6 wide). */
function DirectionArrow({
  position,
  rotY = 0,
}: {
  position: [number, number, number];
  rotY?: number;
}) {
  const mat = (
    <meshStandardMaterial
      color={MARKING_WHITE}
      roughness={0.5}
      emissive={MARKING_WHITE}
      emissiveIntensity={0.2}
      envMapIntensity={0.3}
    />
  );
  // Arrow points along +x by default; rotate around Y to steer it.
  return (
    <group position={position} rotation={[0, rotY, 0]}>
      {/* Shaft (1.4 long, spans x from -0.7 to +0.7) */}
      <mesh position={[0, 0.005, 0]}>
        <boxGeometry args={[1.4, 0.02, 0.45]} />
        {mat}
      </mesh>
      {/* Chevron head: two short bars forming a > at the +x end.
          Each bar is offset in Z so they start at the sides of the shaft
          and converge to a point past the shaft tip, creating a clean
          chevron instead of an X. */}
      <mesh position={[0.97, 0.005, 0.18]} rotation={[0, Math.PI / 4, 0]}>
        <boxGeometry args={[0.55, 0.02, 0.28]} />
        {mat}
      </mesh>
      <mesh position={[0.97, 0.005, -0.18]} rotation={[0, -Math.PI / 4, 0]}>
        <boxGeometry args={[0.55, 0.02, 0.28]} />
        {mat}
      </mesh>
    </group>
  );
}

/** A straight one-way aisle with two lanes separated by a physical concrete divider. */
const AisleRoad = memo(function AisleRoad({ aisle }: { aisle: AisleDesc }) {
  const { floor, y, x0, x1, index } = aisle;
  const len = x1 - x0;
  const cx = (x0 + x1) / 2;
  const baseY = floor * FLOOR_HEIGHT + ROAD_Y;
  const half = ROAD_WIDTH / 2;
  // Even aisles flow +x, odd aisles flow -x.
  const dir = index % 2 === 0 ? 1 : -1;
  const arrowRotY = dir > 0 ? 0 : Math.PI;

  // Two driving lanes: -z lane and +z lane, separated by the centre divider.
  const laneNegZ = y - LANE_WIDTH / 2;
  const lanePosZ = y + LANE_WIDTH / 2;

  // Generate arrow positions every 25 units along the aisle.
  const arrowXs: number[] = [];
  for (let d = 4; d < len; d += 25) {
    arrowXs.push(x0 + d);
  }

  return (
    <group>
      {/* Road surface (dark asphalt, full width). Box top sits at baseY = ROAD_Y. */}
      <mesh position={[cx, baseY - 0.1, y]} receiveShadow>
        <boxGeometry args={[len, 0.2, ROAD_WIDTH]} />
        <meshStandardMaterial color={LANE_COLOR} roughness={0.95} envMapIntensity={0.3} />
      </mesh>

      {/* White edge lines on outer edges (0.15 wide) */}
      <mesh position={[cx, baseY + 0.01, y - half + 0.075]}>
        <boxGeometry args={[len, 0.02, 0.15]} />
        <meshStandardMaterial
          color={MARKING_WHITE}
          roughness={0.5}
          emissive={MARKING_WHITE}
          emissiveIntensity={0.1}
          envMapIntensity={0.3}
        />
      </mesh>
      <mesh position={[cx, baseY + 0.01, y + half - 0.075]}>
        <boxGeometry args={[len, 0.02, 0.15]} />
        <meshStandardMaterial
          color={MARKING_WHITE}
          roughness={0.5}
          emissive={MARKING_WHITE}
          emissiveIntensity={0.1}
          envMapIntensity={0.3}
        />
      </mesh>

      {/* Center lane marking: double-yellow line (two thin yellow lines). */}
      <mesh position={[cx, baseY + 0.005, y - 0.1]}>
        <boxGeometry args={[len, 0.01, 0.08]} />
        <meshStandardMaterial
          color={CENTER_LINE_COLOR}
          roughness={0.5}
          emissive={CENTER_LINE_COLOR}
          emissiveIntensity={0.15}
          envMapIntensity={0.3}
        />
      </mesh>
      <mesh position={[cx, baseY + 0.005, y + 0.1]}>
        <boxGeometry args={[len, 0.01, 0.08]} />
        <meshStandardMaterial
          color={CENTER_LINE_COLOR}
          roughness={0.5}
          emissive={CENTER_LINE_COLOR}
          emissiveIntensity={0.15}
          envMapIntensity={0.3}
        />
      </mesh>

      {/* Direction arrows in BOTH driving lanes, both pointing in the travel
          direction (the lot is one-way serpentine, so both lanes flow the same way). */}
      {arrowXs.map((ax, i) => (
        <DirectionArrow
          key={`arrowN${i}`}
          position={[ax, baseY + 0.01, laneNegZ]}
          rotY={arrowRotY}
        />
      ))}
      {arrowXs.map((ax, i) => (
        <DirectionArrow
          key={`arrowP${i}`}
          position={[ax, baseY + 0.01, lanePosZ]}
          rotY={arrowRotY}
        />
      ))}
    </group>
  );
});

/** A curved 180° turn road with divider, edge lines, and one direction arrow. */
const TurnRoad = memo(function TurnRoad({ turn }: { turn: CurveDesc }) {
  const edgeOffset = ROAD_WIDTH / 2 - 0.08;
  const fy = turn.floor * FLOOR_HEIGHT;
  const ribbon = useMemo(
    () => buildRibbon(turn.points, ROAD_WIDTH, ROAD_Y + 0.005),
    [turn.points],
  );
  const leftEdge = useMemo(
    () => buildRibbon(offsetPoints(turn.points, edgeOffset), 0.22, ROAD_Y + 0.02),
    [turn.points, edgeOffset],
  );
  const rightEdge = useMemo(
    () => buildRibbon(offsetPoints(turn.points, -edgeOffset), 0.22, ROAD_Y + 0.02),
    [turn.points, edgeOffset],
  );
  // Raised concrete divider on turns (no parking here, cars cannot cross).
  const divider = useMemo(
    () => buildSolidBarAlongPath(turn.points, DIVIDER_WIDTH, DIVIDER_HEIGHT, ROAD_Y + 0.015),
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

  // Direction arrow at the apex of the curve, oriented tangent to it.
  const arrow = useMemo(() => {
    const pts = turn.points;
    const mid = Math.floor(pts.length / 2);
    const p = pts[mid];
    const a = pts[Math.max(0, mid - 1)];
    const b = pts[Math.min(pts.length - 1, mid + 1)];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const rotY = Math.atan2(-tz, tx);
    // Offset the arrow into the driving lane (offset -LANE_WIDTH/2 from centre).
    const up = new THREE.Vector3(0, 1, 0);
    const tangent = new THREE.Vector3(tx, 0, tz).normalize();
    const side = new THREE.Vector3().crossVectors(tangent, up).normalize();
    const dz = side.z * LANE_WIDTH / 2;
    const dx = side.x * LANE_WIDTH / 2;
    return {
      pos: [p.x - dx, fy + ROAD_Y + 0.02, p.z - dz] as [number, number, number],
      rotY,
    };
  }, [turn.points, fy]);

  return (
    <group>
      {/* Road surface */}
      <mesh geometry={ribbon} receiveShadow>
        <meshStandardMaterial color={LANE_COLOR} roughness={0.95} side={THREE.DoubleSide} envMapIntensity={0.3} />
      </mesh>
      {/* Edge lines */}
      <mesh geometry={leftEdge}>
        <meshStandardMaterial
          color={MARKING_WHITE}
          roughness={0.5}
          emissive={MARKING_WHITE}
          emissiveIntensity={0.1}
          envMapIntensity={0.3}
        />
      </mesh>
      <mesh geometry={rightEdge}>
        <meshStandardMaterial
          color={MARKING_WHITE}
          roughness={0.5}
          emissive={MARKING_WHITE}
          emissiveIntensity={0.1}
          envMapIntensity={0.3}
        />
      </mesh>
      {/* Raised concrete divider through the turn (no parking, cars cannot cross) */}
      <mesh geometry={divider} castShadow receiveShadow>
        <meshStandardMaterial
          color={DIVIDER_COLOR}
          roughness={0.9}
          envMapIntensity={0.3}
        />
      </mesh>
      {/* Guardrails on both outer edges of the turn */}
      <GuardRailAlongPath points={leftRailPts} yBase={ROAD_Y} />
      <GuardRailAlongPath points={rightRailPts} yBase={ROAD_Y} />
      {/* Direction arrow at apex */}
      <DirectionArrow position={arrow.pos} rotY={arrow.rotY} />
    </group>
  );
});

/** A spiral ramp between floors with guardrails and a direction arrow. */
const RampRoad = memo(function RampRoad({ ramp }: { ramp: CurveDesc }) {
  const edgeOffset = ROAD_WIDTH / 2 - 0.08;
  const ribbon = useMemo(
    () => buildRibbon(ramp.points, ROAD_WIDTH, ROAD_Y),
    [ramp.points],
  );
  // Soffit / support slab under the ramp (wider than the road).
  const soffit = useMemo(
    () => buildRibbon(ramp.points, ROAD_WIDTH + 1.2, ROAD_Y - 0.1),
    [ramp.points],
  );
  const leftEdge = useMemo(
    () => buildRibbon(offsetPoints(ramp.points, edgeOffset), 0.22, ROAD_Y + 0.02),
    [ramp.points, edgeOffset],
  );
  const rightEdge = useMemo(
    () => buildRibbon(offsetPoints(ramp.points, -edgeOffset), 0.22, ROAD_Y + 0.02),
    [ramp.points, edgeOffset],
  );
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

  // Direction arrow near the start of the ramp, oriented up the slope and
  // offset into the driving lane so the centreline divider doesn't hide it.
  const arrow = useMemo(() => {
    const pts = ramp.points;
    const i = Math.min(6, Math.floor(pts.length / 4));
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const rotY = Math.atan2(-tz, tx);
    const up = new THREE.Vector3(0, 1, 0);
    const tangent = new THREE.Vector3(tx, 0, tz).normalize();
    const side = new THREE.Vector3().crossVectors(tangent, up).normalize();
    const dx = side.x * LANE_WIDTH / 2;
    const dz = side.z * LANE_WIDTH / 2;
    return { pos: [p.x - dx, p.y + ROAD_Y + 0.02, p.z - dz] as [number, number, number], rotY };
  }, [ramp.points]);

  return (
    <group>
      {/* Support slab under ramp */}
      <mesh geometry={soffit} receiveShadow>
        <meshStandardMaterial color={FLOOR_COLOR} roughness={0.96} side={THREE.DoubleSide} envMapIntensity={0.3} />
      </mesh>
      {/* Threshold apron at ramp start — solid box bridging road-to-ramp
          transition. After Fix 1 the start tangent is purely -x, so a box
          spanning 2 units in -x from the start point sits flush. */}
      <mesh position={[ramp.points[0].x - 1, ramp.points[0].y + ROAD_Y - 0.325, ramp.points[0].z]}>
        <boxGeometry args={[2, 0.65, ROAD_WIDTH]} />
        <meshStandardMaterial color={RAMP_COLOR} roughness={0.95} envMapIntensity={0.3} />
      </mesh>
      {/* Threshold apron at ramp end — solid box bridging ramp-to-road
          transition at the ramp_in side. */}
      <mesh
        position={[
          ramp.points[ramp.points.length - 1].x - 1,
          ramp.points[ramp.points.length - 1].y + ROAD_Y - 0.325,
          ramp.points[ramp.points.length - 1].z,
        ]}
      >
        <boxGeometry args={[2, 0.65, ROAD_WIDTH]} />
        <meshStandardMaterial color={RAMP_COLOR} roughness={0.95} envMapIntensity={0.3} />
      </mesh>
      {/* Road surface */}
      <mesh geometry={ribbon} receiveShadow>
        <meshStandardMaterial color={RAMP_COLOR} roughness={0.95} side={THREE.DoubleSide} envMapIntensity={0.3} />
      </mesh>
      {/* Edge lines */}
      <mesh geometry={leftEdge}>
        <meshStandardMaterial color={MARKING_WHITE} roughness={0.6} side={THREE.DoubleSide} envMapIntensity={0.3} />
      </mesh>
      <mesh geometry={rightEdge}>
        <meshStandardMaterial color={MARKING_WHITE} roughness={0.6} side={THREE.DoubleSide} envMapIntensity={0.3} />
      </mesh>
      {/* Raised concrete divider through the ramp (no parking, cars cannot cross) */}
      <mesh geometry={divider} castShadow receiveShadow>
        <meshStandardMaterial
          color={DIVIDER_COLOR}
          roughness={0.9}
          side={THREE.DoubleSide}
          envMapIntensity={0.3}
        />
      </mesh>
      {/* Guardrails on both sides of the ramp */}
      <GuardRailAlongPath points={leftRailPts} yBase={ROAD_Y} />
      <GuardRailAlongPath points={rightRailPts} yBase={ROAD_Y} />
      {/* Direction arrow pointing up the ramp */}
      <DirectionArrow position={arrow.pos} rotY={arrow.rotY} />
    </group>
  );
});

/** A marked parking bay with L-shaped corner lines, a colour-coded border, and a slot number. */
const SlotMarking = memo(function SlotMarking({ slot }: { slot: SlotDesc }) {
  const sizeColor = SLOT_OUTLINE_HEX[slot.size];
  const [x, y, z] = slot.pos;
  const { w, l: d } = SLOT_SIZE[slot.size];
  const lineW = 0.15;
  const lineH = 0.03;
  const paintY = y + 0.02; // Slots are on bare floor slab, not road surface
  // Build a floor-prefixed label: S0_42 -> "A42", S1_7 -> "B7", S2_1 -> "C1".
  const floorLetter = String.fromCharCode(65 + Number(slot.id.match(/^S(\d+)_/)?.[1] ?? 0));
  const slotNum = slot.id.replace(/^S\d+_/, "");
  const numLabel = `${floorLetter}${slotNum}`;

  return (
    <group position={[x, paintY, z]} rotation={[0, slot.rotY, 0]}>
      {/* Left side line */}
      <mesh position={[-w / 2 + lineW / 2, lineH / 2, 0]}>
        <boxGeometry args={[lineW, lineH, d]} />
        <meshStandardMaterial
          color={MARKING_WHITE}
          roughness={0.5}
          emissive={MARKING_WHITE}
          emissiveIntensity={0.15}
          envMapIntensity={0.3}
        />
      </mesh>
      {/* Right side line */}
      <mesh position={[w / 2 - lineW / 2, lineH / 2, 0]}>
        <boxGeometry args={[lineW, lineH, d]} />
        <meshStandardMaterial
          color={MARKING_WHITE}
          roughness={0.5}
          emissive={MARKING_WHITE}
          emissiveIntensity={0.15}
          envMapIntensity={0.3}
        />
      </mesh>
      {/* Back line (closed end, away from the aisle) */}
      <mesh position={[0, lineH / 2, -d / 2 + lineW / 2]}>
        <boxGeometry args={[w, lineH, lineW]} />
        <meshStandardMaterial
          color={MARKING_WHITE}
          roughness={0.5}
          emissive={MARKING_WHITE}
          emissiveIntensity={0.15}
          envMapIntensity={0.3}
        />
      </mesh>
      {/* Colour-coded border on the aisle-facing edge (0.2 wide) */}
      <mesh position={[0, lineH / 2 + 0.005, d / 2 - 0.1]}>
        <boxGeometry args={[w, lineH, 0.2]} />
        <meshStandardMaterial
          color={sizeColor}
          emissive={sizeColor}
          emissiveIntensity={0.35}
          roughness={0.5}
          envMapIntensity={0.3}
        />
      </mesh>
      {/* Slot number painted in the centre */}
      <Text
        position={[0, lineH / 2 + 0.01, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={1.0}
        color={MARKING_WHITE}
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.04}
        outlineColor="#000000"
      >
        {numLabel}
      </Text>
    </group>
  );
});

/** Structural pillars around the perimeter of one storey. */
const Pillars = memo(function Pillars({ floor, bounds }: { floor: number; bounds: Bounds }) {
  const cols: React.ReactElement[] = [];
  const y0 = floor * FLOOR_HEIGHT;
  const y1 = y0 + PILLAR_HEIGHT;
  const cy = (y0 + y1) / 2;
  const zA = bounds.minZ + 1.5;
  const zB = bounds.maxZ - 1.5;
  const xStart = Math.ceil(bounds.minX / JUNCTION_SPACING) * JUNCTION_SPACING;
  const xEnd = bounds.maxX;
  let i = 0;
  for (let x = xStart; x <= xEnd; x += JUNCTION_SPACING) {
    for (const z of [zA, zB]) {
      cols.push(
        <mesh key={`p${i++}`} position={[x, cy, z]} castShadow>
          <cylinderGeometry args={[0.35, 0.4, PILLAR_HEIGHT, 12]} />
          <meshStandardMaterial color={PILLAR_COLOR} roughness={0.9} metalness={0.1} envMapIntensity={0.3} />
        </mesh>,
      );
    }
  }
  // Corner pillars on the short ends.
  for (const x of [bounds.minX + 1.5, bounds.maxX - 1.5]) {
    for (const z of [zA, zB]) {
      cols.push(
        <mesh key={`p${i++}`} position={[x, cy, z]} castShadow>
          <cylinderGeometry args={[0.4, 0.45, PILLAR_HEIGHT, 12]} />
          <meshStandardMaterial color={PILLAR_COLOR} roughness={0.9} metalness={0.1} envMapIntensity={0.3} />
        </mesh>,
      );
    }
  }
  return <group>{cols}</group>;
});

/**
 * Post-and-rail guardrail along a polyline.
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
  const { posts, railMeshes } = useMemo(() => {
    if (points.length < 2) {
      return { posts: [] as THREE.Vector3[], railMeshes: [] as { mid: THREE.Vector3; quat: THREE.Quaternion; len: number }[] };
    }
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
    // Pre-compute the rail segment transforms (midpoint, orientation, length)
    // once here so the render body doesn't allocate temp Vector3/Quaternion
    // objects on every React render.
    const meshes: { mid: THREE.Vector3; quat: THREE.Quaternion; len: number }[] = [];
    for (let i = 0; i < postPts.length - 1; i++) {
      const a = postPts[i];
      const b = postPts[i + 1];
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const dir3d = b.clone().sub(a).normalize();
      const quat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        dir3d,
      );
      meshes.push({ mid, quat, len: a.distanceTo(b) });
    }
    return { posts: postPts, railMeshes: meshes };
  }, [points]);

  return (
    <group>
      {posts.map((p, i) => (
        <mesh key={`post${i}`} position={[p.x, p.y + yBase + 0.4, p.z]} castShadow>
          <cylinderGeometry args={[0.04, 0.04, 0.8, 8]} />
          <meshStandardMaterial color={GUARDRAIL_COLOR} roughness={0.5} metalness={0.6} envMapIntensity={0.3} />
        </mesh>
      ))}
      {railMeshes.map((r, i) => (
        <mesh
          key={`rail${i}`}
          position={[r.mid.x, r.mid.y + yBase + 0.7, r.mid.z]}
          quaternion={r.quat}
          castShadow
        >
          <cylinderGeometry args={[0.03, 0.03, r.len, 8]} />
          <meshStandardMaterial color={GUARDRAIL_COLOR} roughness={0.5} metalness={0.6} envMapIntensity={0.3} />
        </mesh>
      ))}
    </group>
  );
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

/** An entry/exit portal arch with a coloured label. */
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
  return (
    <group position={[x, y, z]}>
      <mesh position={[0, 2, -ROAD_WIDTH / 2]} castShadow>
        <boxGeometry args={[0.3, 4, 0.3]} />
        <meshStandardMaterial color="#20242c" roughness={0.8} />
      </mesh>
      <mesh position={[0, 2, ROAD_WIDTH / 2]} castShadow>
        <boxGeometry args={[0.3, 4, 0.3]} />
        <meshStandardMaterial color="#20242c" roughness={0.8} />
      </mesh>
      <mesh position={[0, 4, 0]}>
        <boxGeometry args={[0.3, 0.3, ROAD_WIDTH + 0.4]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.6}
          roughness={0.4}
        />
      </mesh>
      <mesh position={[0, 3.2, 0]}>
        <boxGeometry args={[1.6, 0.9, 0.12]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.5}
          roughness={0.4}
        />
      </mesh>
      <Html position={[0, 3.2, 0.08]} center distanceFactor={80} occlude={false}>
        <div
          style={{
            color: "#fff",
            fontSize: "13px",
            fontWeight: 700,
            letterSpacing: "0.08em",
            textShadow: "0 1px 4px rgba(0,0,0,0.9)",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {label}
        </div>
      </Html>
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

  return (
    <group>
      {/* Road surface */}
      <mesh position={[cx, baseY - 0.1, cz]} receiveShadow>
        <boxGeometry args={[len, 0.2, ROAD_WIDTH]} />
        <meshStandardMaterial color={LANE_COLOR} roughness={0.95} envMapIntensity={0.3} />
      </mesh>
      {/* Edge lines */}
      <mesh position={[cx, baseY + 0.01, cz - half + 0.075]}>
        <boxGeometry args={[len, 0.02, 0.15]} />
        <meshStandardMaterial
          color={MARKING_WHITE}
          roughness={0.5}
          emissive={MARKING_WHITE}
          emissiveIntensity={0.1}
          envMapIntensity={0.3}
        />
      </mesh>
      <mesh position={[cx, baseY + 0.01, cz + half - 0.075]}>
        <boxGeometry args={[len, 0.02, 0.15]} />
        <meshStandardMaterial
          color={MARKING_WHITE}
          roughness={0.5}
          emissive={MARKING_WHITE}
          emissiveIntensity={0.1}
          envMapIntensity={0.3}
        />
      </mesh>
    </group>
  );
});


/** A post-mounted parking-area info sign at an aisle entry.
 *  Shows the slot number range for that aisle (e.g. "A1 - A16") with an
 *  arrow pointing in the direction of travel. Dark LED aesthetic matching
 *  the permanent signboards: matte-black frame, sky-blue accent. */
const AreaSignboard = memo(function AreaSignboard({ sign }: { sign: AreaSignDesc }) {
  const [x, y, z] = sign.position;
  const panelW = 5.0;
  const panelH = 2.2;
  const postH = 4;
  const ACCENT = "#38bdf8";

  return (
    <group position={[x, y, z]} rotation={[0, sign.rotY, 0]}>
      {/* Vertical post */}
      <mesh position={[0, postH / 2, 0]} castShadow>
        <cylinderGeometry args={[0.08, 0.08, postH, 8]} />
        <meshStandardMaterial color="#080a10" metalness={0.5} roughness={0.5} />
      </mesh>
      {/* Sign panel — matte black frame */}
      <group position={[0, postH + panelH / 2, 0]} rotation={[0.15, 0, 0]}>
        <mesh castShadow>
          <boxGeometry args={[panelW, panelH, 0.15]} />
          <meshStandardMaterial color="#080a10" metalness={0.4} roughness={0.6} />
        </mesh>
        {/* Emissive screen — true black with dark-blue glow */}
        <mesh position={[0, 0, 0.08]}>
          <planeGeometry args={[panelW - 0.4, panelH - 0.3]} />
          <meshStandardMaterial
            color="#000000"
            emissive="#0a1622"
            emissiveIntensity={0.4}
            roughness={0.5}
            metalness={0.1}
          />
        </mesh>
        {/* Slot range label */}
        <Text
          position={[0, 0.2, 0.1]}
          fontSize={0.65}
          color="#f1f5f9"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.02}
          outlineColor="#000000"
        >
          {sign.label}
        </Text>
        {/* Direction arrow (sky-blue, pointing along travel direction) */}
        <Text
          position={[0, -0.55, 0.1]}
          fontSize={0.8}
          color={ACCENT}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.02}
          outlineColor="#000000"
        >
          {sign.arrowDir > 0 ? "\u2192" : "\u2190"}
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
      {/* Floor slabs (each upper slab is the ceiling of the storey below). */}
      {floors.map((f) => (
        <FloorSlab key={`slab${f}`} floor={f} bounds={bounds} rampHole={geo.rampHoles.get(f)} />
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

      {/* Parking bay markings. */}
      {geo.slots.map((s, i) => (
        <SlotMarking key={`s${i}`} slot={s} />
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
          <Gate position={entry.pos} color="#22c55e" label="ENTRY" />
        </>
      )}
      {exit && (
        <>
          <ApproachRoad
            from={[exit.x, exit.y]}
            to={[exit.x - 15, exit.y]}
            floor={exit.floor}
          />
          <Gate position={exit.pos} color="#e5484d" label="EXIT" />
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
