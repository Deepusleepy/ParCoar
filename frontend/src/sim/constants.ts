import type { CarColor, CarSize } from "../types";

/* ------------------------------------------------------------------ *
 *  Layout constants (mirror top-level fields in lot.json)
 * ------------------------------------------------------------------ */

export const FLOOR_HEIGHT = 15;
export const JUNCTION_SPACING = 2.6;
export const AISLE_SPACING = 17;
export const SLOT_OFFSET = 6;

/* ------------------------------------------------------------------ *
 *  Geometry constants for the 3D structure
 * ------------------------------------------------------------------ */

/** All bays are identical and sit edge to edge at the junction pitch. */
export const SLOT_WIDTH = JUNCTION_SPACING;
export const SLOT_DEPTH = 5;

export const LANE_WIDTH = 3.5;
export const ROAD_WIDTH = LANE_WIDTH * 2;
export const EDGE_LINE_WIDTH = 0.15;
export const EDGE_LINE_OFFSET = ROAD_WIDTH / 2 - EDGE_LINE_WIDTH / 2;

/** These mirror the values emitted in lot.json. */
export const RAMP_OUTSET = 19;
export const RAMP_CORNER_RADIUS = 7;

export const PILLAR_HEIGHT = FLOOR_HEIGHT;
export const SCALE = 1;
export const CAR_Y_OFFSET = 0.15;

/* ------------------------------------------------------------------ *
 *  World-space lot framing (used by Scene + CameraRig)
 * ------------------------------------------------------------------ */

export const LOT_CENTER_X = 27.3;
export const LOT_CENTER_Z = 25.5;
export const LOT_MIN_Z = -13;
export const LOT_MAX_Z = 64;

/* ------------------------------------------------------------------ *
 *  Visual car dimensions
 * ------------------------------------------------------------------ */

/** Visual model/body dimensions only. They do not affect bay assignment. */
export const CAR_DIMS: Record<CarSize, { length: number; width: number; height: number }> = {
  small: { length: 3.4, width: 1.55, height: 1.35 },
  medium: { length: 4.1, width: 1.68, height: 1.45 },
  large: { length: 4.5, width: 1.8, height: 1.65 },
};

/* ------------------------------------------------------------------ *
 *  Colour palette
 * ------------------------------------------------------------------ */

export const FLOOR_COLOR = "#3a3d44";
export const LANE_COLOR = "#1a1d24";
export const PILLAR_COLOR = "#15171c";
export const WALL_COLOR = "#1b1e25";
export const CEILING_COLOR = "#0a0b0e";
export const DIVIDER_COLOR = "#6b6f78";
export const GUARDRAIL_COLOR = "#2d3038";
export const MARKING_WHITE = "#f8fafc";

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
 *  Simulation tuning
 * ------------------------------------------------------------------ */

export const CAR_LENGTH = 4.5;
export const CAR_SPEED = 7;
export const STATE_TICK_MS = 200;
export const TARGET_ACTIVE_CARS = 3;
export const SPAWN_INTERVAL_MS = 6000;

/** The drivable car participates like any other car: same id on the wire,
 *  same boards, same bay assignment. The plate is what the overhead boards
 *  print for it. */
export const PLAYER_ID = "P0";
export const PLAYER_PLATE = "YOU";

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

/** Visual model variants only. */
export const CAR_SIZES: CarSize[] = ["small", "medium", "large"];

const PLATE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PLATE_DIGITS = "0123456789";

function pick<T>(arr: ArrayLike<T>): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function bayLabel(slot: string): string {
  const match = slot.match(/^S(\d+)_(\d+)$/);
  return match ? `${String.fromCharCode(65 + Number(match[1]))}${match[2]}` : slot;
}

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
export function nextCarId(): string {
  carCounter += 1;
  return `C${carCounter}`;
}

export function toWorld(x: number, y: number, floor: number): [number, number, number] {
  return [x * SCALE, floor * FLOOR_HEIGHT, y * SCALE];
}

export const SLAB_PAD_X = AISLE_SPACING / 2 + ROAD_WIDTH / 2 + 1.5;
export const SLAB_PAD_Z = SLOT_DEPTH + 2;
