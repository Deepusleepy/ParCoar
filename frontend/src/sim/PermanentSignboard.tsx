import { memo } from "react";
import { Text } from "@react-three/drei";
import * as THREE from "three";
import type { CarRosterEntry, Direction, NodeSign } from "../types";
import { FLOOR_HEIGHT, ROAD_WIDTH } from "./constants";

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
/** Red for no-slot status. */
const RED = "#e5484d";

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
const SCREEN_GEO = new THREE.PlaneGeometry(SCREEN_W, SCREEN_H);
const ROD_GEO = new THREE.CylinderGeometry(0.06, 0.06, ROD_LENGTH, 8);
const BANNER_GEO = new THREE.PlaneGeometry(SCREEN_W - 0.6, 0.7);

/* --- Shared materials: 11 boards share these instead of one set each. */
const FRAME_MATERIAL = new THREE.MeshStandardMaterial({
  color: FRAME_COLOR,
  metalness: 0.4,
  roughness: 0.6,
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
const BANNER_MATERIAL = new THREE.MeshStandardMaterial({
  color: "#0c2740",
  emissive: ACCENT,
  emissiveIntensity: 0.35,
  roughness: 0.5,
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
  floor,
  dynamic,
  roster,
}: PermanentSignboardProps) {
  // Filter the roster to cars on THIS floor only.
  const floorRoster = roster?.filter((r) => r.currentFloor === floor) ?? [];

  // The active car's id, used to exclude it from the roster rows.
  const activeCarId = dynamic?.carPlate
    ? roster?.find((r) => r.plate === dynamic.carPlate)?.carId
    : undefined;

  // Roster rows exclude the active car (shown in the banner instead).
  // Capped at 4 so rows stay within the screen's vertical bounds.
  const rosterRows = floorRoster.filter((r) => r.carId !== activeCarId).slice(0, 4);

  // Ramp boards have "RAMP" in their label; turn boards have "LEFT"/"RIGHT".
  const isRamp = label.includes("RAMP");

  const hasDynamic = !!dynamic;
  const hasRoster = rosterRows.length > 0;

  return (
    <group position={position} rotation={[0, rotY, 0]}>
      {/* Two suspension rods from ceiling down to board top corners.
          Hidden on the top floor where there's no ceiling slab to hang from. */}
      {!isTopFloor && (
        <>
          <mesh position={[-BOARD_W / 2 + 1, ROD_CENTER_Y, 0]} geometry={ROD_GEO} material={ROD_MATERIAL} />
          <mesh position={[BOARD_W / 2 - 1, ROD_CENTER_Y, 0]} geometry={ROD_GEO} material={ROD_MATERIAL} />
        </>
      )}

      {/* Tilted board group: rotated around X so the face points down at the road */}
      <group position={[0, BOARD_CENTER_Y, 0]} rotation={[0.3, 0, 0]}>
        {/* Board body — matte black metal frame */}
        <mesh castShadow geometry={BOARD_BODY_GEO} material={FRAME_MATERIAL} />

        {/* Emissive screen on the +Z face — true black with dark-blue glow */}
        <mesh position={[0, 0, 0.11]} geometry={SCREEN_GEO} material={SCREEN_MATERIAL} />

        {/* Screen content — sits just in front of the screen plane.
            All text/mesh Y positions are kept within ±SCREEN_HALF_H (1.5) so
            nothing leaks past the screen edges. */}
        <group position={[0, 0, 0.13]}>
          {hasDynamic ? (
            /* ---- Driver mode: highlighted banner + bright arrow + slot + roster ---- */
            <>
              {/* Top: highlighted plate banner (blue background panel + plate text) */}
              <mesh position={[0, 1.0, -0.01]} geometry={BANNER_GEO} material={BANNER_MATERIAL} />
              <Text
                position={[0, 1.0, 0]}
                fontSize={0.6}
                color={BODY_TEXT}
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.02}
                outlineColor="#000000"
              >
                {dynamic!.carPlate}
              </Text>

              {/* Middle: BIG bright direction arrow from the car's actual direction.
                  Scaled 0.8 and lowered to y=-0.1 so it never overlaps the plate
                  banner above (banner bottom at y=0.65). Spans -0.7..0.5. */}
              <mesh
                position={[0, -0.1, 0]}
                scale={[0.8, 0.8, 0.8]}
                rotation={[0, 0, directionToRotation(dynamic!.direction)]}
                geometry={ARROW_GEOMETRY}
                material={ARROW_BRIGHT_MATERIAL}
              />

              {/* Bottom: slot label "→ C12" */}
              <Text
                position={[0, -0.55, 0]}
                fontSize={0.55}
                color={BODY_TEXT}
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.02}
                outlineColor="#000000"
              >
                {`\u2192 ${slotLabel(dynamic!.slot, dynamic!.slotFloor)}`}
              </Text>

              {/* Ramp label — only ramp boards show "↑ RAMP" in driver mode. */}
              {isRamp && (
                <Text position={[0, -1.1, 0]} fontSize={0.3} color={ACCENT} anchorX="center" anchorY="middle">
                  {"\u2191 RAMP"}
                </Text>
              )}

              {/* Dimmed floor-filtered roster below (excluding the active car).
                  Max 2 rows (1 for ramp boards, which share space with the
                  "↑ RAMP" label). Spacing 0.2, fits within -1.5. */}
              {rosterRows.slice(0, isRamp ? 1 : 2).map((entry, i) => (
                <RosterRow key={entry.carId} entry={entry} x={-SCREEN_W / 2 + 0.4} y={-(isRamp ? 1.3 : 1.1) - i * 0.2} width={SCREEN_W - 0.8} />
              ))}
            </>
          ) : hasRoster ? (
            /* ---- Idle mode: dim static label + dim chevron + roster.
                The chevron is dim (ARROW_DIM_MATERIAL) so it reads as a
                permanent sign, not a live direction signal. ---- */
            <>
              {/* Static label text (e.g. "LEFT", "RIGHT", "RAMP UP -> B"). */}
              <Text
                position={[0, 0.85, 0]}
                fontSize={0.6}
                color={DIM_TEXT}
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.02}
                outlineColor="#000000"
              >
                {label}
              </Text>

              {/* Dim static chevron oriented by the board's arrowRotation.
                  Scale 0.6 at y=0.0 spans -0.45..0.45. */}
              <mesh
                position={[0, 0.0, 0]}
                scale={[0.6, 0.6, 0.6]}
                rotation={[0, 0, arrowRotation]}
                geometry={ARROW_GEOMETRY}
                material={ARROW_DIM_MATERIAL}
              />

              {/* Dimmed floor-filtered roster below.
                  Max 4 rows at 0.22 spacing starting at y=-0.75 → -0.75..-1.41,
                  within ±SCREEN_HALF_H (1.5). */}
              {rosterRows.map((entry, i) => (
                <RosterRow key={entry.carId} entry={entry} x={-SCREEN_W / 2 + 0.4} y={-0.75 - i * 0.22} width={SCREEN_W - 0.8} />
              ))}
            </>
          ) : (
            /* ---- Static mode: dim static label + dim chevron, centered.
                No roster to show, so the label + arrow take the full screen. ---- */
            <>
              <Text
                position={[0, 0.3, 0]}
                fontSize={0.8}
                color={DIM_TEXT}
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.02}
                outlineColor="#000000"
              >
                {label}
              </Text>

              {/* Dim static chevron oriented by arrowRotation.
                  Scale 0.8 at y=-0.5 spans -1.1..0.1. */}
              <mesh
                position={[0, -0.5, 0]}
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
  return d ? `${d.carPlate}|${d.direction}|${d.slot}|${d.slotFloor}` : "";
}

/** Signature of the roster rows this board will actually display: floor-filtered,
 *  active-car-excluded, capped at 4, keyed by the fields RosterRow renders
 *  (carId as React key, plate, slot, slotFloor, status). currentFloor drives the
 *  filter so a car changing floor invalidates the right boards. */
function rosterKey(
  roster: CarRosterEntry[] | undefined,
  floor: number,
  activePlate: string | undefined,
): string {
  if (!roster || roster.length === 0) return "";
  const rows: string[] = [];
  for (const r of roster) {
    if (r.currentFloor !== floor) continue;
    if (activePlate && r.plate === activePlate) continue;
    rows.push(`${r.carId}:${r.plate}:${r.slot}:${r.slotFloor}:${r.status}`);
    if (rows.length >= 4) break;
  }
  return rows.join("|");
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

  // Dynamic + roster: the only props that change tick-to-tick.
  if (dynamicKey(prev.dynamic) !== dynamicKey(next.dynamic)) return false;
  if (
    rosterKey(prev.roster, prev.floor, prev.dynamic?.carPlate) !==
    rosterKey(next.roster, next.floor, next.dynamic?.carPlate)
  ) {
    return false;
  }
  return true;
}

/** A single dimmed roster row: plate (left) + slot label (right).
 *  No colour swatches — plate text only. "NO SLOT" shown in red for no_slot. */
function RosterRow({
  entry,
  x,
  y,
  width,
}: {
  entry: CarRosterEntry;
  x: number;
  y: number;
  width: number;
}) {
  return (
    <group position={[0, y, 0]}>
      {/* Plate (left-aligned) */}
      <Text
        position={[x, 0, 0]}
        fontSize={0.25}
        color={DIM_TEXT}
        anchorX="left"
        anchorY="middle"
        outlineWidth={0.01}
        outlineColor="#000000"
      >
        {entry.plate}
      </Text>
      {/* Slot label (right-aligned) */}
      {entry.status === "no_slot" ? (
        <Text
          position={[x + width, 0, 0]}
          fontSize={0.25}
          color={RED}
          anchorX="right"
          anchorY="middle"
          outlineWidth={0.01}
          outlineColor="#000000"
        >
          NO SLOT
        </Text>
      ) : (
        <Text
          position={[x + width, 0, 0]}
          fontSize={0.25}
          color={DIM_TEXT}
          anchorX="right"
          anchorY="middle"
          outlineWidth={0.01}
          outlineColor="#000000"
        >
          {`\u2192 ${slotLabel(entry.slot, entry.slotFloor)}`}
        </Text>
      )}
    </group>
  );
}
