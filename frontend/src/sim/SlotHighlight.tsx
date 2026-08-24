import { memo, useMemo } from "react";
import * as THREE from "three";
import type { LotData } from "../types";
import {
  AISLE_SPACING,
  COLOR_HEX,
  FLOOR_HEIGHT,
  SLOT_DEPTH,
  SLOT_WIDTH,
  toWorld,
} from "./constants";

/** Road surface Y offset (matches DrivableCar's ROAD_Y). */
const ROAD_Y = 0.15;

interface SlotHighlightProps {
  lot: LotData;
  /** The bay the backend has reserved for the player, if any. */
  assignedSlot: string | null;
  /** The player car's color, used for the highlight tint. */
  playerColor: string;
  /** Hidden when the player is parked or leaving. */
  visible: boolean;
}

/**
 * A colored translucent rectangle on the ground at the player's assigned
 * parking bay, in the player's car color. Renders in all camera modes so
 * the player can spot their bay from orbit or overview, not just drive mode.
 */
export const SlotHighlight = memo(function SlotHighlight({
  lot,
  assignedSlot,
  playerColor,
  visible,
}: SlotHighlightProps) {
  const highlight = useMemo(() => {
    if (!assignedSlot || !visible) return null;
    const node = lot.nodes[assignedSlot];
    if (!node) return null;
    const [x, , z] = toWorld(node.x, node.y, node.floor);
    const aisleY = Math.round(node.y / AISLE_SPACING) * AISLE_SPACING;
    const rotY = node.y < aisleY ? 0 : Math.PI;
    const color =
      (COLOR_HEX as Record<string, string>)[playerColor] ?? "#22c55e";
    const y = node.floor * FLOOR_HEIGHT + ROAD_Y + 0.02;
    return { pos: [x, y, z] as [number, number, number], rotY, color };
  }, [lot, assignedSlot, playerColor, visible]);

  if (!highlight) return null;

  return (
    <group position={highlight.pos} rotation={[0, highlight.rotY, 0]}>
      {/* Translucent fill */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[SLOT_WIDTH, SLOT_DEPTH]} />
        <meshBasicMaterial
          color={highlight.color}
          transparent
          opacity={0.18}
          depthWrite={false}
        />
      </mesh>
      {/* Border outline (4 thin planes) */}
      {[
        { w: SLOT_WIDTH, d: 0.12, x: 0, z: -SLOT_DEPTH / 2 },
        { w: SLOT_WIDTH, d: 0.12, x: 0, z: SLOT_DEPTH / 2 },
        { w: 0.12, d: SLOT_DEPTH, x: -SLOT_WIDTH / 2, z: 0 },
        { w: 0.12, d: SLOT_DEPTH, x: SLOT_WIDTH / 2, z: 0 },
      ].map((b, i) => (
        <mesh key={i} position={[b.x, 0.01, b.z]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[b.w, b.d]} />
          <meshBasicMaterial
            color={highlight.color}
            transparent
            opacity={0.7}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
});
