import { useMemo } from "react";
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

/** Build a large chevron arrow shape (~1.5 units tall) for the sign screen. */
function useArrowShape() {
  return useMemo(() => {
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
  }, []);
}

/**
 * A large permanent ceiling-hung direction board at a turn or ramp.
 *
 * Dark LED highway-sign aesthetic: matte-black frame, true-black screen with
 * a subtle dark-blue glow, sky-blue accent arrows/labels, off-white body text.
 *
 * The board has three display modes:
 *  - Driver mode: a car is approaching or waiting at this node (`dynamic`
 *    present). Shows a highlighted plate banner, a big direction arrow, the
 *    slot label, and a dimmed floor-filtered roster (excluding the active car).
 *  - Idle mode: no car at this node, but the floor has active cars. Shows a
 *    dim ramp label (ramp boards only) and a dimmed floor-filtered roster.
 *    No direction arrow — the bright static arrow was confusing drivers.
 *  - Static mode: no car and no roster. Shows a dim ramp label only (no arrow).
 */
export function PermanentSignboard({
  position,
  rotY,
  label,
  isTopFloor = false,
  floor,
  dynamic,
  roster,
}: PermanentSignboardProps) {
  const arrowShape = useArrowShape();

  // Bigger board: 10 wide × 3.5 tall (was 10 × 2.5).
  const boardW = ROAD_WIDTH + 1; // 10
  const boardH = 3.5;
  const screenW = 10;
  const screenH = 3.0;
  // Board center raised to 5 (was 4) for better visibility.
  const boardCenterY = 5;
  const boardTopY = boardCenterY + boardH / 2; // 6.75
  const rodLength = FLOOR_HEIGHT - boardTopY; // 8.25
  const rodCenterY = (FLOOR_HEIGHT + boardTopY) / 2;

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
          <mesh position={[-boardW / 2 + 1, rodCenterY, 0]}>
            <cylinderGeometry args={[0.06, 0.06, rodLength, 8]} />
            <meshStandardMaterial color={FRAME_COLOR} metalness={0.6} roughness={0.4} />
          </mesh>
          <mesh position={[boardW / 2 - 1, rodCenterY, 0]}>
            <cylinderGeometry args={[0.06, 0.06, rodLength, 8]} />
            <meshStandardMaterial color={FRAME_COLOR} metalness={0.6} roughness={0.4} />
          </mesh>
        </>
      )}

      {/* Tilted board group: rotated around X so the face points down at the road */}
      <group position={[0, boardCenterY, 0]} rotation={[0.3, 0, 0]}>
        {/* Board body — matte black metal frame */}
        <mesh castShadow>
          <boxGeometry args={[boardW, boardH, 0.2]} />
          <meshStandardMaterial color={FRAME_COLOR} metalness={0.4} roughness={0.6} />
        </mesh>

        {/* Emissive screen on the +Z face — true black with dark-blue glow */}
        <mesh position={[0, 0, 0.11]}>
          <planeGeometry args={[screenW, screenH]} />
          <meshStandardMaterial
            color={SCREEN_COLOR}
            emissive={SCREEN_EMISSIVE}
            emissiveIntensity={0.4}
            roughness={0.5}
            metalness={0.1}
          />
        </mesh>

        {/* Screen content — sits just in front of the screen plane.
            All text/mesh Y positions are kept within ±1.4 (screen half-height
            is 1.5) so nothing leaks past the screen edges. */}
        <group position={[0, 0, 0.13]}>
          {hasDynamic ? (
            /* ---- Driver mode: highlighted banner + big arrow + slot + roster ---- */
            <>
              {/* Top: highlighted plate banner (blue background panel + plate text) */}
              <mesh position={[0, 1.0, -0.01]}>
                <planeGeometry args={[screenW - 0.6, 0.7]} />
                <meshStandardMaterial
                  color="#0c2740"
                  emissive={ACCENT}
                  emissiveIntensity={0.35}
                  roughness={0.5}
                />
              </mesh>
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

              {/* Middle: BIG direction arrow from the car's actual direction.
                  Scaled down (0.8) and lowered to y=-0.1 so it never overlaps
                  the plate banner above (banner bottom at y=0.65). */}
              <mesh position={[0, -0.1, 0]} scale={[0.8, 0.8, 0.8]} rotation={[0, 0, directionToRotation(dynamic!.direction)]}>
                <shapeGeometry args={[arrowShape]} />
                <meshStandardMaterial
                  color={ACCENT}
                  emissive={ACCENT}
                  emissiveIntensity={0.8}
                  roughness={0.4}
                />
              </mesh>

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
                <RosterRow key={entry.carId} entry={entry} x={-screenW / 2 + 0.4} y={-(isRamp ? 1.3 : 1.1) - i * 0.2} width={screenW - 0.8} />
              ))}
            </>
          ) : hasRoster ? (
            /* ---- Idle mode: dim ramp label + roster (no arrow — the
                bright static arrow was confusing drivers into thinking a
                direction signal was active when no car was approaching). ---- */
            <>
              {/* Ramp label — only ramp boards show text. */}
              {isRamp && (
                <Text
                  position={[0, 0.7, 0]}
                  fontSize={0.8}
                  color={ACCENT}
                  anchorX="center"
                  anchorY="middle"
                  outlineWidth={0.03}
                  outlineColor="#000000"
                >
                  {"\u2191 RAMP"}
                </Text>
              )}

              {/* Dimmed floor-filtered roster below.
                  Max 4 rows at 0.22 spacing starting at y=-0.7 → fits within -1.4. */}
              {rosterRows.map((entry, i) => (
                <RosterRow key={entry.carId} entry={entry} x={-screenW / 2 + 0.4} y={-0.7 - i * 0.22} width={screenW - 0.8} />
              ))}
            </>
          ) : (
            /* ---- Static mode: dim ramp label only (no arrow). ---- */
            <>
              {isRamp && (
                <Text
                  position={[0, 0.4, 0]}
                  fontSize={0.9}
                  color={ACCENT}
                  anchorX="center"
                  anchorY="middle"
                  outlineWidth={0.03}
                  outlineColor="#000000"
                >
                  {"\u2191 RAMP"}
                </Text>
              )}
            </>
          )}
        </group>
      </group>
    </group>
  );
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
