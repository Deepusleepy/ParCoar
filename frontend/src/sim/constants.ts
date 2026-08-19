import type { CarColor, CarSize, SlotSize } from "../types";

/* ------------------------------------------------------------------ *
 *  Layout constants (mirror top-level fields in lot.json)
 * ------------------------------------------------------------------ */

/** Vertical distance between floors in 3D world units (lot.json: floor_height). */
export const FLOOR_HEIGHT = 15;

/** Distance between consecutive junctions along an aisle (lot.json). */
export const JUNCTION_SPACING = 5;

/** Distance between adjacent aisles, centre-to-centre (lot.json). */
export const AISLE_SPACING = 24;

/** Distance from an aisle centreline to a slot centre (lot.json: slot_offset). */
export const SLOT_OFFSET = 9;

/* ------------------------------------------------------------------ *
 *  Geometry constants for the 3D structure
 * ------------------------------------------------------------------ */

/** Parking bay opening width (along the aisle). */
export const SLOT_WIDTH = 4.5;

/** Parking bay depth (perpendicular to the aisle). */
export const SLOT_DEPTH = 5;

/** One driving lane width. Two lanes sit side by side per aisle. */
export const LANE_WIDTH = 4.5;

/** Full road width across both lanes of an aisle. */
export const ROAD_WIDTH = LANE_WIDTH * 2;

/** Curve radius used for the 180° turns between aisles. */
export const RAMP_RADIUS = 12;

/** Length of the spiral ramp connecting one floor to the next. */
export const RAMP_LENGTH = 25;

/** Height of a structural pillar (one storey). */
export const PILLAR_HEIGHT = FLOOR_HEIGHT;

/** World-space scale: 1 lot unit = SCALE three.js units. */
export const SCALE = 1;

/** How high a car sits above the floor surface (top of road layer). */
export const CAR_Y_OFFSET = 0.2;

/* ------------------------------------------------------------------ *
 *  World-space lot framing (used by Scene + CameraRig)
 *  Lot spans z=-9..81 (world), x=0..45; computeBounds pads by
 *  AISLE_SPACING/2 giving minX=-13, maxX=58, minZ=-16, maxZ=88.
 * ------------------------------------------------------------------ */

/** World-space center of the lot footprint along X. */
export const LOT_CENTER_X = 22.5;
/** World-space center of the lot footprint along Z. */
export const LOT_CENTER_Z = 36; // (minZ + maxZ) / 2 ≈ (-16 + 88) / 2
/** Padded lot min Z (front edge, where floor labels sit). */
export const LOT_MIN_Z = -16;
/** Padded lot max Z (back edge). */
export const LOT_MAX_Z = 88;

/* ------------------------------------------------------------------ *
 *  Slot / car dimensions
 * ------------------------------------------------------------------ */

/** Slot bay dimensions in lot units, by size. */
export const SLOT_SIZE: Record<SlotSize, { w: number; l: number }> = {
  small: { w: SLOT_WIDTH * 0.9, l: SLOT_DEPTH * 0.85 },
  medium: { w: SLOT_WIDTH, l: SLOT_DEPTH },
  large: { w: SLOT_WIDTH * 1.1, l: SLOT_DEPTH * 1.15 },
};

/** Car body dimensions by car size (length along travel axis, width across). */
export const CAR_DIMS: Record<CarSize, { length: number; width: number; height: number }> = {
  small:  { length: 3.6, width: 1.65, height: 1.35 },
  medium: { length: 4.5, width: 1.80, height: 1.45 },
  large:  { length: 5.0, width: 1.95, height: 1.65 },
};

/** Visual scale multiplier applied to a car mesh by size. */
export const CAR_SIZE_MULTIPLIERS: Record<CarSize, number> = {
  small: 0.85,
  medium: 1.0,
  large: 1.15,
};

/* ------------------------------------------------------------------ *
 *  Colour palette (dark-mode garage aesthetic)
 * ------------------------------------------------------------------ */

/** Concrete floor slab colour (lighter so asphalt reads clearly). */
export const FLOOR_COLOR = "#3a3d44";
/** Driving-lane asphalt colour (outbound lane, dark). */
export const LANE_COLOR = "#1a1d24";
/** Double-yellow centre line colour. */
export const CENTER_LINE_COLOR = "#eab308";
/** Lane centre / edge marking colour (white). */
export const LANE_MARKING_COLOR = "#f4f6fa";
/** Lane edge stripe colour. */
export const LANE_EDGE_COLOR = "#c9ccd4";
/** Ramp asphalt colour. */
export const RAMP_COLOR = "#16181d";
/** Structural pillar / column colour. */
export const PILLAR_COLOR = "#15171c";
/** Low perimeter wall / guardrail colour. */
export const WALL_COLOR = "#1b1e25";
/** Ceiling slab colour. */
export const CEILING_COLOR = "#0a0b0e";
/** Raised concrete divider/median colour (lighter than asphalt). */
export const DIVIDER_COLOR = "#6b6f78";
/** Dark metal colour for guardrail posts and rails. */
export const GUARDRAIL_COLOR = "#2d3038";
/** Bright white for slot corner lines and road arrows. */
export const MARKING_WHITE = "#f8fafc";

/** Slot outline colours by size. */
export const SLOT_OUTLINE_HEX: Record<SlotSize, string> = {
  small: "#3b82f6",
  medium: "#eab308",
  large: "#22c55e",
};

/** Map colour names to hex values for three.js materials. */
export const COLOR_HEX: Record<CarColor, string> = {
  red: "#e5484d",
  blue: "#3b82f6",
  green: "#22c55e",
  yellow: "#eab308",
  orange: "#f97316",
  purple: "#a855f7",
  cyan: "#22d3ee",
  white: "#f8fafc",
  silver: "#94a3b8",
};

/* ------------------------------------------------------------------ *
 *  Simulation tuning (used by useSimulation / Car / Signboard)
 * ------------------------------------------------------------------ */

/** Car travel speed in lot-units per second. */
export const CAR_SPEED = 7;

/** How often (ms) the frontend sends a state tick to the backend. */
export const STATE_TICK_MS = 200;

/** Target number of active (moving) cars to maintain. */
export const TARGET_ACTIVE_CARS = 5;

/** Min/max bounds for the active car count window. */
export const MIN_ACTIVE_CARS = 4;
export const MAX_ACTIVE_CARS = 6;

/** Spawn interval (ms) when below target. */
export const SPAWN_INTERVAL_MS = 3600;

/** Fraction of slots pre-filled at startup. */
export const PREPARK_FILL_RATIO = 0.5;

export const CAR_COLORS: CarColor[] = [
  "red",
  "blue",
  "green",
  "yellow",
  "orange",
  "purple",
  "cyan",
  "white",
  "silver",
];

export const CAR_SIZES: CarSize[] = ["small", "medium", "large"];

/** Letters/digits used for plate generation. */
const PLATE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PLATE_DIGITS = "0123456789";

function pick<T>(arr: ArrayLike<T>): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Generate a random license plate like "ABC-123". */
export function randomPlate(): string {
  const a = pick(PLATE_LETTERS);
  const b = pick(PLATE_LETTERS);
  const c = pick(PLATE_LETTERS);
  const d = pick(PLATE_DIGITS);
  const e = pick(PLATE_DIGITS);
  const f = pick(PLATE_DIGITS);
  return `${a}${b}${c}-${d}${e}${f}`;
}

export function randomColor(): CarColor {
  return pick(CAR_COLORS);
}

export function randomSize(): CarSize {
  return pick(CAR_SIZES);
}

let carCounter = 0;
/** Next unique car id ("C1", "C2", ...). */
export function nextCarId(): string {
  carCounter += 1;
  return `C${carCounter}`;
}

/** Convert a lot (x, y, floor) into a three.js world position (Y is up). */
export function toWorld(x: number, y: number, floor: number): [number, number, number] {
  return [x * SCALE, floor * FLOOR_HEIGHT, y * SCALE];
}
