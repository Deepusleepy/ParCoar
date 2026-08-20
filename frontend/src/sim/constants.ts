import type { CarColor, CarSize, SlotSize } from "../types";

/* ------------------------------------------------------------------ *
 *  Layout constants (mirror top-level fields in lot.json)
 * ------------------------------------------------------------------ */

/** Vertical distance between floors in 3D world units (lot.json: floor_height). */
export const FLOOR_HEIGHT = 15;

/** Distance between consecutive junctions along an aisle (lot.json). */
export const JUNCTION_SPACING = 2.6;

/** Distance between adjacent aisles, centre-to-centre (lot.json). */
export const AISLE_SPACING = 17;

/** Distance from an aisle centreline to a slot centre (lot.json: slot_offset). */
export const SLOT_OFFSET = 6;

/* ------------------------------------------------------------------ *
 *  Geometry constants for the 3D structure
 * ------------------------------------------------------------------ */

/** Parking bay opening width (along the aisle). This MUST equal
 *  JUNCTION_SPACING so bays sit edge to edge and neighbouring bays share one
 *  painted separator. At 2.5 against a 2.6 pitch the two lines fell 0.1
 *  apart and, being 0.15 wide each, merged into a single 0.25 band with no
 *  asphalt showing between them: every separator in the garage was 67% over
 *  width. */
export const SLOT_WIDTH = JUNCTION_SPACING;

/** Parking bay depth (perpendicular to the aisle). */
export const SLOT_DEPTH = 5;

/** One driving lane width. Two lanes sit side by side per aisle. */
export const LANE_WIDTH = 3.5;

/** Full road width across both lanes of an aisle. */
export const ROAD_WIDTH = LANE_WIDTH * 2;

/** Road edge line width, and the offset of its CENTRE from the aisle
 *  centreline, so its outer edge lands exactly on the road edge.
 *
 *  Both numbers live here because two different renderers draw this same
 *  line: FloorPaint bakes it along the straight aisles and TurnRoad/RampRoad
 *  extrude it around the curves. They had drifted to 0.15 wide at 3.5 and
 *  0.22 wide at 3.42, so at every one of the 22 joints per storey the line
 *  changed width and jumped 0.19 into the carriageway. */
export const EDGE_LINE_WIDTH = 0.15;
export const EDGE_LINE_OFFSET = ROAD_WIDTH / 2 - EDGE_LINE_WIDTH / 2;

/** How far west of the building the inter-floor ramp runs, in lot units.
 *  Must exceed |slab minX| + ROAD_WIDTH/2 or the ramp's inner edge buries
 *  itself in the slab for its whole length: at 11 the ramp spanned x -14.5
 *  to -7.5 while the slab starts at -9.5, a 2-unit overlap along 51 units of
 *  run. 15 puts the ramp entirely outside, clear by 2 units. */
export const RAMP_OUTSET = 19;


/** Corner radius of the ramp's two 90-degree turns. Large enough that a car
 *  can drive through them without the road-edge clamp fighting the steering. */
export const RAMP_CORNER_RADIUS = 7;

/** Height of a structural pillar (one storey). */
export const PILLAR_HEIGHT = FLOOR_HEIGHT;

/** World-space scale: 1 lot unit = SCALE three.js units. */
export const SCALE = 1;

/** How high a car sits above the raw floor slab.
 *
 *  The GLTF models put their tyre contact patch at y=0, so this is purely the
 *  thickness of what they stand ON. The drivable surface is the road box,
 *  whose top is at ROAD_Y = 0.15, and the painted markings sit just above
 *  that. With this at 0 every MOVING car rode 0.15 below the tarmac, sunk
 *  into the road along its whole route, while parked cars sat below their own
 *  bay paint. Matching ROAD_Y puts every car level with the surface it is
 *  driving or parked on. */
export const CAR_Y_OFFSET = 0.15;

/* ------------------------------------------------------------------ *
 *  World-space lot framing (used by Scene + CameraRig)
 *  Structural nodes span x=0..54.6, z=-6..57. slabBounds() in geometry.ts
 *  pads x by SLAB_PAD_X and z by SLAB_PAD_Z,
 *  giving minX=-13.5, maxX=68.1, minZ=-13, maxZ=64.
 * ------------------------------------------------------------------ */

/** World-space center of the lot footprint along X. */
export const LOT_CENTER_X = 27.3; // (-13.5 + 68.1) / 2
/** World-space center of the lot footprint along Z. */
export const LOT_CENTER_Z = 25.5; // (-13 + 64) / 2
/** Padded lot min Z (front edge, where floor labels sit). */
export const LOT_MIN_Z = -13;
/** Padded lot max Z (back edge). */
export const LOT_MAX_Z = 64;

/* ------------------------------------------------------------------ *
 *  Slot / car dimensions
 * ------------------------------------------------------------------ */

/** Car body dimensions by size. Scale is uniform, so `length` also sets the
 *  rendered width; these are trimmed slightly from real-world figures because
 *  a 1.95-wide car in a 2.5-wide bay left only 0.27 either side and the wing
 *  mirrors of neighbouring cars visibly touched. */
export const CAR_DIMS: Record<CarSize, { length: number; width: number; height: number }> = {
  small:  { length: 3.4, width: 1.55, height: 1.35 },
  medium: { length: 4.1, width: 1.68, height: 1.45 },
  large:  { length: 4.5, width: 1.80, height: 1.65 },
};

/* ------------------------------------------------------------------ *
 *  Colour palette (dark-mode garage aesthetic)
 * ------------------------------------------------------------------ */

/** Concrete floor slab colour (lighter so asphalt reads clearly). */
export const FLOOR_COLOR = "#3a3d44";
/** Asphalt colour. One value for every driveable surface: straight aisles,
 *  turn loops and the inter-floor ramp all share it. Give them separate
 *  colours or separate materials and the road visibly changes shade at every
 *  junction. */
export const LANE_COLOR = "#1a1d24";
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

/** Longest car body, used as the minimum gap cars keep from one another. */
export const CAR_LENGTH = 4.5;

/** Car travel speed in lot-units per second. */
export const CAR_SPEED = 7;

/** How often (ms) the frontend sends a state tick to the backend. */
export const STATE_TICK_MS = 200;

/** Target number of arriving (moving) cars to maintain. Deliberately small:
 *  the aisles are one-way and narrow, and with more than a few cars they queue
 *  nose to tail and read as a traffic jam rather than a guidance demo. */
export const TARGET_ACTIVE_CARS = 3;


/** Spawn interval (ms) when below target. */
export const SPAWN_INTERVAL_MS = 6000;


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

/** Display name for a bay node id: "S2_5" becomes "C5". The floor is encoded
 *  in the id itself as S{floor}_{number}. */
export function bayLabel(slot: string): string {
  const m = slot.match(/^S(\d+)_(\d+)$/);
  return m ? `${String.fromCharCode(65 + Number(m[1]))}${m[2]}` : slot;
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

/** How far the floor slab extends past the outermost graph node.
 *
 *  A 180-degree turn bulges AISLE_SPACING/2 beyond the turn node, and the road
 *  is ROAD_WIDTH wide, so the tarmac reaches AISLE_SPACING/2 + ROAD_WIDTH/2
 *  past it. The old padding of AISLE_SPACING/2 + 1 covered the centreline but
 *  not the road, so every turn loop overhung the deck by 2.5 units and read as
 *  a ribbon of road floating off the side of the building.
 *
 *  RAMP_OUTSET must stay clear of this: the ramp runs at -RAMP_OUTSET with its
 *  own ROAD_WIDTH, so it needs RAMP_OUTSET > SLAB_PAD_X + ROAD_WIDTH/2. */
export const SLAB_PAD_X = AISLE_SPACING / 2 + ROAD_WIDTH / 2 + 1.5;
/** Slab padding across the aisles: bays plus a margin. */
export const SLAB_PAD_Z = SLOT_DEPTH + 2;
