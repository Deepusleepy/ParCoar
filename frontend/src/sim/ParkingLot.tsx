import { useMemo } from "react";
import * as THREE from "three";
import { Edges } from "@react-three/drei";
import type { LotData, LotNode, SlotSize } from "../types";
import {
  FLOOR_HEIGHT,
  ROAD_WIDTH,
  LANE_OFFSET,
  SLOT_SIZE,
  SLOT_OUTLINE_HEX,
  toWorld,
} from "./constants";

interface ParkingLotProps {
  lot: LotData;
}

type AisleSeg = {
  from: [number, number, number];
  to: [number, number, number];
  floor: number;
};

type SpurSeg = {
  from: [number, number, number];
  to: [number, number, number];
  floor: number;
};

type RampSeg = {
  from: [number, number, number];
  to: [number, number, number];
};

type SlotMark = {
  pos: [number, number, number];
  rotY: number;
  size: SlotSize;
};

/** Classify every edge in the lot into a renderable geometry descriptor. */
function buildGeometry(lot: LotData) {
  const aisles: AisleSeg[] = [];
  const spurs: SpurSeg[] = [];
  const ramps: RampSeg[] = [];
  const slots: SlotMark[] = [];

  const nodes = lot.nodes;
  for (const [fromId, edgeList] of Object.entries(lot.edges)) {
    const from = nodes[fromId];
    if (!from) continue;
    for (const edge of edgeList) {
      const to = nodes[edge.to];
      if (!to) continue;

      // Ramp: cross-floor connection (ramp_up -> ramp_in).
      if (from.type === "ramp_up" && to.type === "ramp_in") {
        ramps.push({
          from: toWorld(from.x, from.y, from.floor),
          to: toWorld(to.x, to.y, to.floor),
        });
        continue;
      }

      // Slot spur: junction/ramp_in/entry -> slot.
      if (to.type === "slot") {
        spurs.push({
          from: toWorld(from.x, from.y, from.floor),
          to: toWorld(to.x, to.y, to.floor),
          floor: from.floor,
        });
        continue;
      }

      // Aisle segment: same-floor non-slot connection.
      if (from.floor === to.floor) {
        aisles.push({
          from: toWorld(from.x, from.y, from.floor),
          to: toWorld(to.x, to.y, to.floor),
          floor: from.floor,
        });
      }
    }
  }

  // Slot markings (one per slot node).
  for (const node of Object.values(nodes)) {
    if (node.type !== "slot" || !node.size) continue;
    const pos = toWorld(node.x, node.y, node.floor);
    // Slots face the aisle: orient length axis toward y=0.
    const rotY = node.y < 0 ? 0 : Math.PI;
    slots.push({ pos, rotY, size: node.size });
  }

  return { aisles, spurs, ramps, slots };
}

/** A straight two-lane road strip between two world points on one floor. */
function AisleRoad({ seg }: { seg: AisleSeg }) {
  const [x1, y1, z1] = seg.from;
  const [x2, , z2] = seg.to;
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  const angle = Math.atan2(-dz, dx);
  const cx = (x1 + x2) / 2;
  const cz = (z1 + z2) / 2;
  const y = y1 + 0.12;

  const half = ROAD_WIDTH / 2;

  return (
    <group position={[cx, y, cz]} rotation={[0, angle, 0]}>
      {/* Road base */}
      <mesh>
        <boxGeometry args={[len, 0.1, ROAD_WIDTH]} />
        <meshStandardMaterial color="#15161a" roughness={0.9} metalness={0} />
      </mesh>
      {/* Outbound (going) lane: slightly lighter */}
      <mesh position={[0, 0.06, -LANE_OFFSET / 2]}>
        <boxGeometry args={[len, 0.02, LANE_OFFSET]} />
        <meshStandardMaterial color="#23252b" roughness={0.95} />
      </mesh>
      {/* Inbound (coming) lane: slightly darker */}
      <mesh position={[0, 0.06, LANE_OFFSET / 2]}>
        <boxGeometry args={[len, 0.02, LANE_OFFSET]} />
        <meshStandardMaterial color="#1b1d22" roughness={0.95} />
      </mesh>
      {/* Center divider line */}
      <mesh position={[0, 0.07, 0]}>
        <boxGeometry args={[len, 0.03, 0.06]} />
        <meshStandardMaterial
          color="#caa700"
          roughness={0.6}
          emissive="#3a2e00"
          emissiveIntensity={0.4}
        />
      </mesh>
      {/* Edge lines */}
      <mesh position={[0, 0.07, -half + 0.05]}>
        <boxGeometry args={[len, 0.02, 0.05]} />
        <meshStandardMaterial color="#6b7280" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.07, half - 0.05]}>
        <boxGeometry args={[len, 0.02, 0.05]} />
        <meshStandardMaterial color="#6b7280" roughness={0.8} />
      </mesh>
    </group>
  );
}

/** A short single-lane spur from the aisle into a parking slot. */
function SlotSpur({ seg }: { seg: SpurSeg }) {
  const [x1, y1, z1] = seg.from;
  const [x2, , z2] = seg.to;
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  const angle = Math.atan2(-dz, dx);
  const cx = (x1 + x2) / 2;
  const cz = (z1 + z2) / 2;
  const y = y1 + 0.1;

  return (
    <mesh position={[cx, y, cz]} rotation={[0, angle, 0]}>
      <boxGeometry args={[len, 0.08, LANE_OFFSET]} />
      <meshStandardMaterial color="#1c1e23" roughness={0.95} />
    </mesh>
  );
}

/** An inclined ramp connecting two floors. */
function Ramp({ seg }: { seg: RampSeg }) {
  const [x1, y1, z1] = seg.from;
  const [x2, y2, z2] = seg.to;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dz = z2 - z1;
  const horizLen = Math.hypot(dx, dz);
  const angle = Math.atan2(-dz, dx);
  const pitch = Math.atan2(dy, horizLen);
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const cz = (z1 + z2) / 2;

  return (
    <group position={[cx, cy, cz]} rotation={[0, angle, 0]}>
      <group rotation={[0, 0, pitch]}>
        <mesh>
          <boxGeometry args={[horizLen, 0.12, ROAD_WIDTH]} />
          <meshStandardMaterial color="#181a1f" roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.07, -LANE_OFFSET / 2]}>
          <boxGeometry args={[horizLen, 0.02, LANE_OFFSET]} />
          <meshStandardMaterial color="#23252b" roughness={0.95} />
        </mesh>
        <mesh position={[0, 0.07, LANE_OFFSET / 2]}>
          <boxGeometry args={[horizLen, 0.02, LANE_OFFSET]} />
          <meshStandardMaterial color="#1b1d22" roughness={0.95} />
        </mesh>
        <mesh position={[0, 0.08, 0]}>
          <boxGeometry args={[horizLen, 0.03, 0.06]} />
          <meshStandardMaterial
            color="#caa700"
            roughness={0.6}
            emissive="#3a2e00"
            emissiveIntensity={0.4}
          />
        </mesh>
      </group>
    </group>
  );
}

/** A marked parking slot on the floor (outlined bay). */
function SlotMarking({ mark }: { mark: SlotMark }) {
  const { w, l } = SLOT_SIZE[mark.size];
  const outline = SLOT_OUTLINE_HEX[mark.size];
  const [x, y, z] = mark.pos;
  return (
    <group position={[x, y + 0.06, z]} rotation={[0, mark.rotY, 0]}>
      <mesh>
        <boxGeometry args={[l, 0.04, w]} />
        <meshStandardMaterial color="#0c0d10" roughness={0.95} />
      </mesh>
      <Edges threshold={15} color={outline} />
      {/* Size label tick at the aisle edge */}
      <mesh position={[0, 0.03, w / 2 - 0.15]}>
        <boxGeometry args={[0.5, 0.02, 0.08]} />
        <meshStandardMaterial
          color={outline}
          emissive={outline}
          emissiveIntensity={0.5}
        />
      </mesh>
    </group>
  );
}

/** A single floor slab. */
function FloorSlab({ floor, bounds }: { floor: number; bounds: { minX: number; maxX: number; minZ: number; maxZ: number } }) {
  const w = bounds.maxX - bounds.minX;
  const d = bounds.maxZ - bounds.minZ;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const y = floor * FLOOR_HEIGHT;
  return (
    <group position={[cx, y, cz]}>
      {/* Thin transparent driving surface */}
      <mesh receiveShadow>
        <boxGeometry args={[w, 0.1, d]} />
        <meshStandardMaterial
          color="#0a0b0e"
          transparent
          opacity={0.3}
          roughness={1}
          metalness={0}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Floor edge trim for depth perception */}
      <mesh position={[0, 0.06, d / 2]}>
        <boxGeometry args={[w, 0.04, 0.08]} />
        <meshStandardMaterial color="#2a2d34" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.06, -d / 2]}>
        <boxGeometry args={[w, 0.04, 0.08]} />
        <meshStandardMaterial color="#2a2d34" roughness={0.8} />
      </mesh>
      {/* Floor label */}
      <FloorLabel x={-bounds.minX + 2.5} z={0} />
    </group>
  );
}

function FloorLabel({ x, z }: { x: number; z: number }) {
  // Render a subtle floor number marker using small boxes (no DOM).
  return (
    <group position={[x, 0.2, z]}>
      <mesh>
        <boxGeometry args={[1.4, 0.02, 1.4]} />
        <meshStandardMaterial color="#1a1c22" />
      </mesh>
    </group>
  );
}

/** Structural columns connecting floors for visual depth. */
function Columns({ bounds }: { bounds: { minX: number; maxX: number; minZ: number; maxZ: number } }) {
  const cols: React.ReactElement[] = [];
  const xs = [bounds.minX + 1, bounds.maxX - 1, (bounds.minX + bounds.maxX) / 2];
  const zs = [bounds.minZ + 1, bounds.maxZ - 1];
  let i = 0;
  for (const x of xs) {
    for (const z of zs) {
      cols.push(
        <mesh key={i++} position={[x, FLOOR_HEIGHT, z]}>
          <boxGeometry args={[0.5, FLOOR_HEIGHT * 3, 0.5]} />
          <meshStandardMaterial color="#16181d" roughness={0.9} />
        </mesh>,
      );
    }
  }
  return <group>{cols}</group>;
}

export function ParkingLot({ lot }: ParkingLotProps) {
  const { aisles, spurs, ramps, slots } = useMemo(() => buildGeometry(lot), [lot]);

  const bounds = useMemo(() => {
    const xs = Object.values(lot.nodes).map((n) => n.x);
    const ys = Object.values(lot.nodes).map((n) => n.y);
    const minX = Math.min(...xs) - 4;
    const maxX = Math.max(...xs) + 4;
    const minZ = Math.min(...ys) - 6;
    const maxZ = Math.max(...ys) + 6;
    return { minX, maxX, minZ, maxZ };
  }, [lot]);

  const floors = useMemo(() => {
    const set = new Set<number>();
    for (const n of Object.values(lot.nodes)) set.add(n.floor);
    return [...set].sort((a, b) => a - b);
  }, [lot]);

  return (
    <group>
      {floors.map((f) => (
        <FloorSlab key={f} floor={f} bounds={bounds} />
      ))}
      <Columns bounds={bounds} />
      {aisles.map((seg, i) => (
        <AisleRoad key={`a${i}`} seg={seg} />
      ))}
      {spurs.map((seg, i) => (
        <SlotSpur key={`s${i}`} seg={seg} />
      ))}
      {ramps.map((seg, i) => (
        <Ramp key={`r${i}`} seg={seg} />
      ))}
      {slots.map((mark, i) => (
        <SlotMarking key={`m${i}`} mark={mark} />
      ))}
    </group>
  );
}

/** Helper exported for Scene: world bounds of the lot. */
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
