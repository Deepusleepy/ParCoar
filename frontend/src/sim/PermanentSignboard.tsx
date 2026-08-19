import { memo } from "react";
import { Text } from "@react-three/drei";
import * as THREE from "three";
import type { CarRosterEntry, Direction, NodeSign } from "../types";
import { COLOR_HEX, FLOOR_HEIGHT, ROAD_WIDTH } from "./constants";

export interface PermanentSignboardProps {
  position: [number, number, number];
  rotY: number;
  label: string;
  arrowRotation: number;
  /** When true the board is on the top floor (no ceiling slab above), so the
   *  suspension rods are hidden — otherwise they'd hang from nothing. */
  isTopFloor?: boolean;
  /** Floor the board sits on, used to filter the roster to cars on that floor. */
  floor: number;
  /** When present, the board becomes a dynamic screen showing the car waiting
   *  at this node: its plate, direction, and assigned slot. */
  dynamic?: NodeSign;
  /** Roster of all active auto-running cars. When non-empty the board shows a
   *  live roster (plate + assigned slot) filtered to this board's floor. */
  roster?: CarRosterEntry[];
}

/** Convert a slot node id ("S2_5") + floor into a display label ("C5").
 *  The floor is encoded in the slot id itself (S{floor}_{num}). */
function slotLabel(slot: string, _slotFloor: number): string {
  if (!slot) return "";
  const m = slot.match(/^S(\d+)_(\d+)$/);
  if (!m) return slot;
  return `${String.fromCharCode(65 + Number(m[1]))}${m[2]}`;
}

/** Map a backend direction string to a Z-axis rotation for the chevron arrow.
 *  The arrow shape points up (+y) by default; these rotations steer it. */
function directionToRotation(dir: Direction): number {
  switch (dir) {
    case "left":
      return Math.PI / 2;
    case "right":
      return -Math.PI / 2;
    case "straight":
      return 0;
    case "up":
      return -Math.PI / 4;
    case "down":
      return (-Math.PI * 3) / 4;
    case "arrived":
      return 0;
    default:
      return 0;
  }
}

/* --- Dark LED highway-sign palette --- */
/** Matte black frame. */
const FRAME_COLOR = "#080a10";
/** True-black screen surface. */
const SCREEN_COLOR = "#000000";
/** Very dark blue emissive glow for the screen (subtle, not amber). */
const SCREEN_EMISSIVE = "#0a1622";
/** Bright sky-blue accent for arrows and labels. */
const ACCENT = "#38bdf8";
/** Off-white body text. */
const BODY_TEXT = "#f1f5f9";
/** Slate grey for dimmed roster rows. */
const DIM_TEXT = "#64748b";

/* --- Board dimensions, derived from the road so screen + frame cannot drift. */
const BOARD_W = ROAD_WIDTH + 1; // 8 over a 7-wide road (0.5 overhang/side)
const BOARD_H = 3.5;
/** Screen fills the board width; 0.25 frame margin top & bottom. */
const SCREEN_W = BOARD_W; // 8
const SCREEN_H = BOARD_H - 0.5; // 3.0
const BOARD_CENTER_Y = 5;
const BOARD_TOP_Y = BOARD_CENTER_Y + BOARD_H / 2; // 6.75
const ROD_LENGTH = FLOOR_HEIGHT - BOARD_TOP_Y; // 8.25
const ROD_CENTER_Y = (FLOOR_HEIGHT + BOARD_TOP_Y) / 2;

/* --- Shared geometry: one of each per board type, reused across all 11 boards. */
const ARROW_SHAPE = (() => {
  const s = new THREE.Shape();
  s.moveTo(0, 0.75); // tip
  s.lineTo(-0.5, 0); // bottom left
  s.lineTo(-0.2, 0); // notch left
  s.lineTo(-0.2, -0.75); // tail left
  s.lineTo(0.2, -0.75); // tail right
  s.lineTo(0.2, 0); // notch right
  s.lineTo(0.5, 0); // bottom right
  s.closePath();
  return s;
})();
const ARROW_GEOMETRY = new THREE.ShapeGeometry(ARROW_SHAPE);
const BOARD_BODY_GEO = new THREE.BoxGeometry(BOARD_W, BOARD_H, 0.2);
const BOARD_RIM_GEO = new THREE.BoxGeometry(BOARD_W + 0.14, BOARD_H + 0.14, 0.16);
const SCREEN_GEO = new THREE.PlaneGeometry(SCREEN_W, SCREEN_H);
// Rods were r=0.06 in near-black: sub-pixel and invisible, so even on covered
// floors the board looked unsupported. Thicker, and in the lighter frame tone.
const ROD_GEO = new THREE.CylinderGeometry(0.12, 0.12, ROD_LENGTH, 8);
/** Ground-standing posts for the open top deck, where there is no slab. */
const POST_H = BOARD_CENTER_Y - BOARD_H / 2;
const POST_CENTER_Y = POST_H / 2;
const POST_GEO = new THREE.CylinderGeometry(0.15, 0.18, POST_H, 10);
const BANNER_GEO = new THREE.PlaneGeometry(SCREEN_W - 0.6, 0.7);
/** Solid block of the car's colour, shown next to its plate. */
const SWATCH_GEO = new THREE.PlaneGeometry(0.5, 0.5);

/* --- Shared materials: 11 boards share these instead of one set each. */
// Frame is deliberately NOT the same near-black as the screen. A board seen
// from behind (which happens constantly once the camera can fly anywhere) was
// rendering as a pure black rectangle against a dark scene and reading as a
// hole in the world rather than as the back of a sign.
const FRAME_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#1b1f29",
  metalness: 0.35,
  roughness: 0.55,
});
/** Thin lit edge around the board so its silhouette is always legible. */
const EDGE_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#2b323f",
  emissive: "#38bdf8",
  emissiveIntensity: 0.07,
  metalness: 0.3,
  roughness: 0.5,
});
/** Rear skin of the board: brushed dark metal, clearly not a void. */
const BACK_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#333b49",
  metalness: 0.55,
  roughness: 0.45,
});
const ROD_MATERIAL = new THREE.MeshStandardMaterial({
  color: FRAME_COLOR,
  metalness: 0.6,
  roughness: 0.4,
});
const SCREEN_MATERIAL = new THREE.MeshStandardMaterial({
  color: SCREEN_COLOR,
  emissive: SCREEN_EMISSIVE,
  emissiveIntensity: 0.4,
  roughness: 0.5,
  metalness: 0.1,
});
/** Bright arrow shown only in driver mode (a live signal is active). */
const ARROW_BRIGHT_MATERIAL = new THREE.MeshStandardMaterial({
  color: ACCENT,
  emissive: ACCENT,
  emissiveIntensity: 0.8,
  roughness: 0.4,
});
/** Dim arrow for idle/static modes — low contrast so it reads as a permanent
 *  sign, not a live signal. Same accent hue, ~1/7 the emissive intensity. */
const ARROW_DIM_MATERIAL = new THREE.MeshStandardMaterial({
  color: ACCENT,
  emissive: ACCENT,
  emissiveIntensity: 0.12,
  roughness: 0.6,
});

/**
 * A large permanent ceiling-hung direction board at a turn or ramp.
 *
 * Dark LED highway-sign aesthetic: matte-black frame, true-black screen with
 * a subtle dark-blue glow, sky-blue accent arrows/labels, off-white body text.
 *
 * The board has three display modes — and none of them is ever blank:
 *  - Driver mode: a car is approaching or waiting at this node (`dynamic`
 *    present). Shows a highlighted plate banner, a big bright direction arrow
 *    (from the car's actual direction), the slot label, and a dimmed
 *    floor-filtered roster (excluding the active car).
 *  - Idle mode: no car at this node, but the floor has active cars. Shows the
 *    static `label` text and a dim chevron oriented by `arrowRotation`, plus a
 *    dimmed floor-filtered roster below. The arrow is dim/low-contrast so it
 *    reads as a permanent sign, not a live signal.
 *  - Static mode: no car and no roster. Shows the static `label` text and a
 *    dim chevron oriented by `arrowRotation`. Same dim treatment as idle.
 *
 * Memoised with a value comparator (see `propsEqual`) so the 11 boards do not
 * re-render on every car-movement tick unless the values they actually display
 * have changed.
 */
function PermanentSignboardImpl({
  position,
  rotY,
  label,
  arrowRotation,
  isTopFloor = false,
  dynamic,
}: PermanentSignboardProps) {

  const hasDynamic = !!dynamic;

  return (
    <group position={position} rotation={[0, rotY, 0]}>
      {/* Two suspension rods from ceiling down to board top corners.
          Hidden on the top floor where there's no ceiling slab to hang from. */}
      {/* Support. On a covered storey the board hangs from the slab above on
          two rods. The TOP storey has no slab, and hiding the rods there left
          an 8 x 3.5 black rectangle floating in mid air with nothing holding
          it up: this is the "black slabs" Deepu reported. It now stands on
          two posts from the deck, like a real gantry sign. */}
      {isTopFloor ? (
        <>
          <mesh position={[-BOARD_W / 2 + 0.9, POST_CENTER_Y, 0]} geometry={POST_GEO} material={FRAME_MATERIAL} castShadow />
          <mesh position={[BOARD_W / 2 - 0.9, POST_CENTER_Y, 0]} geometry={POST_GEO} material={FRAME_MATERIAL} castShadow />
        </>
      ) : (
        <>
          <mesh position={[-BOARD_W / 2 + 1, ROD_CENTER_Y, 0]} geometry={ROD_GEO} material={ROD_MATERIAL} />
          <mesh position={[BOARD_W / 2 - 1, ROD_CENTER_Y, 0]} geometry={ROD_GEO} material={ROD_MATERIAL} />
        </>
      )}

      {/* Tilted board group: rotated around X so the face points down at the road */}
      <group position={[0, BOARD_CENTER_Y, 0]} rotation={[0.3, 0, 0]}>
        {/* Board body — matte black metal frame */}
        <mesh castShadow geometry={BOARD_BODY_GEO} material={FRAME_MATERIAL} />
        {/* Lit rim, slightly larger than the body, so the board reads as an
            object from every angle including directly behind it. */}
        <mesh geometry={BOARD_RIM_GEO} material={EDGE_MATERIAL} />
        {/* Rear skin. The screen is on the +Z face only, so from behind the
            board was flat FRAME_MATERIAL under 0.15 ambient, which renders as
            pure black and reads as a hole punched in the world. */}
        <mesh position={[0, 0, -0.11]} rotation={[0, Math.PI, 0]} geometry={SCREEN_GEO} material={BACK_MATERIAL} />

        {/* Emissive screen on the +Z face — true black with dark-blue glow */}
        <mesh position={[0, 0, 0.11]} geometry={SCREEN_GEO} material={SCREEN_MATERIAL} />

        {/* Screen content — sits just in front of the screen plane.
            All text/mesh Y positions are kept within ±SCREEN_HALF_H (1.5) so
            nothing leaks past the screen edges. */}
        <group position={[0, 0, 0.13]}>
          {hasDynamic ? (
            /* ---- A car is routed through here: plate, direction, destination.
                One instruction, large. A driver reads this from the far end of
                an aisle, so everything on it has to survive that distance. ---- */
            <>
              {/* The banner is painted in the car's OWN colour, and a solid
                  swatch sits beside the plate. With several cars nose to tail
                  in one aisle a plate alone does not tell a driver which of
                  them the board is talking to; matching the colour of the car
                  does it at a glance, from much further away than text. */}
              <mesh position={[0, 0.95, -0.01]} geometry={BANNER_GEO}>
                <meshStandardMaterial
                  color="#0c1220"
                  emissive={COLOR_HEX[dynamic!.carColor]}
                  emissiveIntensity={0.5}
                  roughness={0.5}
                />
              </mesh>
              <mesh position={[-SCREEN_W / 2 + 0.75, 0.95, 0.01]} geometry={SWATCH_GEO}>
                <meshStandardMaterial
                  color={COLOR_HEX[dynamic!.carColor]}
                  emissive={COLOR_HEX[dynamic!.carColor]}
                  emissiveIntensity={0.85}
                  roughness={0.4}
                />
              </mesh>
              {/* How far off the car still is, so a board that lights early
                  reads as "coming up" rather than "turn now". */}
              <Text
                position={[SCREEN_W / 2 - 0.85, 0.95, 0]}
                fontSize={0.34}
                color={dynamic!.hopsAway <= 1 ? ACCENT : DIM_TEXT}
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.02}
                outlineColor="#000000"
              >
                {dynamic!.hopsAway <= 1 ? "NOW" : `IN ${dynamic!.hopsAway}`}
              </Text>
              <Text
                position={[0.35, 0.95, 0]}
                fontSize={0.72}
                color={BODY_TEXT}
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.03}
                outlineColor="#000000"
              >
                {dynamic!.carPlate}
              </Text>

              <mesh
                position={[0.9, -0.35, 0]}
                scale={[0.95, 0.95, 0.95]}
                rotation={[0, 0, directionToRotation(dynamic!.direction)]}
                geometry={ARROW_GEOMETRY}
                material={ARROW_BRIGHT_MATERIAL}
              />
              <Text
                position={[-0.7, -0.35, 0]}
                fontSize={0.82}
                color={BODY_TEXT}
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.03}
                outlineColor="#000000"
              >
                {slotLabel(dynamic!.slot, dynamic!.slotFloor)}
              </Text>
            </>
          ) : (
            /* ---- Nobody routed here: behave as a permanent direction sign.
                Dim, so it never reads as a live signal, but never blank. ---- */
            <>
              <Text
                position={[0, 0.42, 0]}
                fontSize={0.92}
                color={DIM_TEXT}
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.03}
                outlineColor="#000000"
              >
                {label}
              </Text>
              <mesh
                position={[0, -0.62, 0]}
                scale={[0.8, 0.8, 0.8]}
                rotation={[0, 0, arrowRotation]}
                geometry={ARROW_GEOMETRY}
                material={ARROW_DIM_MATERIAL}
              />
            </>
          )}
        </group>
      </group>
    </group>
  );
}

export const PermanentSignboard = memo(PermanentSignboardImpl, propsEqual);

/* --- Memo comparator: skip re-renders whose displayed values are unchanged.
 *     The parent passes fresh `dynamic`/`roster` objects every car-movement
 *     tick; without this every board re-layouts its troika <Text> several times
 *     a second. We compare only the fields that reach the screen. --- */

/** Signature of the dynamic sign fields the component actually renders. */
function dynamicKey(d: NodeSign | undefined): string {
  return d ? `${d.carPlate}|${d.carColor}|${d.direction}|${d.slot}|${d.slotFloor}|${d.hopsAway}` : "";
}


function propsEqual(prev: PermanentSignboardProps, next: PermanentSignboardProps): boolean {
  // Static-per-board props (come from geo.signboards, stable, but compare by
  // value in case the caller ever rebuilds them).
  if (prev.label !== next.label) return false;
  if (prev.arrowRotation !== next.arrowRotation) return false;
  if (prev.rotY !== next.rotY) return false;
  if (prev.floor !== next.floor) return false;
  if (prev.isTopFloor !== next.isTopFloor) return false;
  const pp = prev.position;
  const np = next.position;
  if (pp[0] !== np[0] || pp[1] !== np[1] || pp[2] !== np[2]) return false;

  // `dynamic` is the only prop that changes tick to tick. The roster prop is
  // still accepted for the caller's sake but no longer displayed: four rows of
  // 0.25-unit text on a board read from the far end of an aisle were a
  // sub-pixel smear, and a direction gantry should carry one instruction.
  if (dynamicKey(prev.dynamic) !== dynamicKey(next.dynamic)) return false;
  return true;
}

