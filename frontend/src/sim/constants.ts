import type { CarColor, CarSize, SlotSize } from "../types";

/** Vertical distance between floors in 3D world units. */
export const FLOOR_HEIGHT = 15;

/** World-space scale: 1 lot unit = SCALE three.js units. */
export const SCALE = 1;

/** How high a car sits above the floor surface (top of road layer). */
export const CAR_Y_OFFSET = 0.2;

/** Lane offset: the two parallel lanes are this far apart (in lot units). */
export const LANE_OFFSET = 1.6;

/** Road width (full, both lanes) in lot units. */
export const ROAD_WIDTH = 3.4;

/** Slot dimensions in lot units, by size. */
export const SLOT_SIZE: Record<SlotSize, { w: number; l: number }> = {
  small: { w: 2.2, l: 4.2 },
  medium: { w: 2.6, l: 4.6 },
  large: { w: 3.0, l: 5.0 },
};

/** Car body dimensions by car size (length along travel axis, width across). */
export const CAR_DIMS: Record<CarSize, { length: number; width: number; height: number }> = {
  small: { length: 3.2, width: 1.5, height: 1.2 },
  medium: { length: 3.8, width: 1.7, height: 1.35 },
  large: { length: 4.4, width: 1.85, height: 1.5 },
};

/** Map color names to hex values for three.js materials. */
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

/** Slot outline colors by size. */
export const SLOT_OUTLINE_HEX: Record<SlotSize, string> = {
  small: "#3b82f6",
  medium: "#eab308",
  large: "#22c55e",
};

/** Car travel speed in lot-units per second. */
export const CAR_SPEED = 7;

/** How often (ms) the frontend sends a state tick to the backend. */
export const STATE_TICK_MS = 200;

/** Target number of active (moving) cars to maintain. */
export const TARGET_ACTIVE_CARS = 10;

/** Min/max bounds for the active car count window. */
export const MIN_ACTIVE_CARS = 8;
export const MAX_ACTIVE_CARS = 12;

/** Spawn interval (ms) when below target. */
export const SPAWN_INTERVAL_MS = 1800;

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

/** Convert a lot (x, y, floor) into a three.js world position. */
export function toWorld(x: number, y: number, floor: number): [number, number, number] {
  return [x * SCALE, floor * FLOOR_HEIGHT, y * SCALE];
}
