/**
 * World layout constants for the ParCoar open world.
 *
 * The world is a 600×600 unit region split by a river running east-west
 * along Z=0. The Shibuya-style city sits south of the river (Z>20), the
 * quiet Japanese town sits north (Z<-20), and Mt. Fuji is a billboard far
 * to the north. An F1 race track sits on the town outskirts.
 *
 * All units are in Three.js world units. +X is east, +Z is south, +Y is up.
 */

/* ------------------------------------------------------------------ *
 *  World extents
 * ------------------------------------------------------------------ */

/** Half-extent of the world in X and Z. The world spans -300..300. */
export const WORLD_HALF = 300;
/** Full world size (600×600). */
export const WORLD_SIZE = WORLD_HALF * 2; // 600

/* ------------------------------------------------------------------ *
 *  River
 * ------------------------------------------------------------------ */

/** The river runs east-west along Z=0. */
export const RIVER_Z = 0;
/** Half-width of the river. The river spans Z=-20..20 (40 units wide). */
export const RIVER_HALF_WIDTH = 20;

/* ------------------------------------------------------------------ *
 *  City district (south of the river, Z > 20)
 * ------------------------------------------------------------------ */

/** Z coordinate where the city begins (south bank of the river). */
export const CITY_Z_START = RIVER_HALF_WIDTH; // 20
/** Z coordinate where the city ends (southern edge of the world). */
export const CITY_Z_END = WORLD_HALF; // 300
/** City ground center Z. */
export const CITY_GROUND_Z = (CITY_Z_START + CITY_Z_END) / 2; // 160
/** City ground depth (Z span). */
export const CITY_GROUND_DEPTH = CITY_Z_END - CITY_Z_START; // 280

/** North-south road X coordinates in the city (5 roads, 50-unit spacing). */
export const CITY_NS_ROADS = [-100, -50, 0, 50, 100];
/** East-west road Z coordinates in the city (4 roads). */
export const CITY_EW_ROADS = [20, 70, 120, 170];

/* ------------------------------------------------------------------ *
 *  Town (north of the river, Z < -20)
 * ------------------------------------------------------------------ */

/** Z coordinate where the town begins (north bank of the river). */
export const TOWN_Z_START = -RIVER_HALF_WIDTH; // -20
/** Z coordinate where the town ends (northern edge of the world). */
export const TOWN_Z_END = -360; // extended past -300 to cover race track
/** Town ground center Z. */
export const TOWN_GROUND_Z = (TOWN_Z_START + TOWN_Z_END) / 2; // -160
/** Town ground depth (Z span). */
export const TOWN_GROUND_DEPTH = TOWN_Z_START - TOWN_Z_END; // 280

/** North-south road X coordinates in the town (6 roads, 32-unit spacing). */
export const TOWN_NS_ROADS = [-80, -48, -16, 16, 48, 80];
/** East-west road Z coordinates in the town (4 roads, narrower spacing). */
export const TOWN_EW_ROADS = [-40, -80, -120, -160];

/* ------------------------------------------------------------------ *
 *  Bridges
 * ------------------------------------------------------------------ */

/** X coordinate of the modern urban bridge (city side, aligned with city NS road at X=50). */
export const BRIDGE_MODERN_X = 50;
/** X coordinate of the old steel truss bridge (town side, aligned with town NS road at X=-48). */
export const BRIDGE_TRUSS_X = -48;
/** Bridge width (perpendicular to the river). */
export const BRIDGE_WIDTH = 16;

/* ------------------------------------------------------------------ *
 *  Mt. Fuji billboard
 * ------------------------------------------------------------------ */

/** Z position of the Mt. Fuji billboard (far north, past the race track). */
export const FUJI_Z = -440;
/** Fuji billboard height in world units. */
export const FUJI_HEIGHT = 160;
/** Fuji billboard width in world units. */
export const FUJI_WIDTH = 280;
/** Fuji billboard center Y (base at ground level, peak at FUJI_HEIGHT). */
export const FUJI_Y = FUJI_HEIGHT / 2; // 80

/* ------------------------------------------------------------------ *
 *  Race track
 * ------------------------------------------------------------------ */

/** Race track center (X, Z) — far north, beyond the town, past the rice paddies. */
export const TRACK_CENTER: readonly [number, number] = [0, -310];
/** Race track footprint (width × depth). */
export const TRACK_SIZE: readonly [number, number] = [200, 80];

/* ------------------------------------------------------------------ *
 *  Color palettes
 * ------------------------------------------------------------------ */

/** City district palette — dense, cool grey concrete with neon accents. */
export const CITY_PALETTE = {
  concreteLow: "#9aa0a8",
  concreteHigh: "#b8bdc4",
  asphalt: "#2a2622",
  ground: "#3a3530",
  neonCyan: "#00e5ff",
  neonMagenta: "#ff2d95",
  neonWarmWhite: "#ffd28a",
  neonRed: "#ff3b3b",
  neonGreen: "#39ff14",
  windowGlow: "#ffcf8a",
  nightSky: "#0a1026",
} as const;

/** Town palette — warm, earthy, muted, residential. */
export const TOWN_PALETTE = {
  wallCream: "#d8c9a8",
  wallSage: "#c2b89e",
  wallTerracotta: "#b8a888",
  tileRoof: "#3a4252",
  ground: "#4a5a3a",
  streetlight: "#ffb066",
} as const;

/** Nature palette — grass, water, earth. */
export const NATURE_PALETTE = {
  grass: "#4a5a3a",
  grassDark: "#3a4a2a",
  water: "#1a2a3a",
  earth: "#5a4a3a",
  ricePaddy: "#8a9a6a",
} as const;

/** Race track palette — engineered, clean. */
export const TRACK_PALETTE = {
  surface: "#2a2a2e",
  kerbRed: "#d03030",
  kerbWhite: "#e8e8e8",
  barrier: "#1a1a1e",
  grandstand: "#2a2a30",
} as const;

/* ------------------------------------------------------------------ *
 *  Day / night cycle
 * ------------------------------------------------------------------ */

/** Real-time seconds for a full 24-hour cycle (20 minutes). */
export const DAY_NIGHT_CYCLE_SECONDS = 20 * 60; // 1200
/** Starting time of day as a normalized 0-1 value. 8:24am = 8.4/24 = 0.35. */
export const DAY_NIGHT_START = 8.4 / 24; // 0.35

/* ------------------------------------------------------------------ *
 *  City car physics
 * ------------------------------------------------------------------ */

/** Physics profile for the city car (arcade GTA-style feel). */
export const CITY_CAR_PHYSICS = {
  /** Maximum speed in units/second (~115 km/h at this scale). */
  MAX_SPEED: 32,
  /** Acceleration rate in units/second². */
  ACCEL_RATE: 18,
  /** Brake deceleration rate. */
  BRAKE_RATE: 28,
  /** Turn rate in radians/second at low speed. */
  TURN_RATE: 2.4,
  /** Lateral grip (1 = full grip, 0 = no grip). High = less drift. */
  GRIP: 0.86,
  /** Engine braking when no throttle is applied. */
  DRAG: 0.5,
} as const;

/* ------------------------------------------------------------------ *
 *  Rendering
 * ------------------------------------------------------------------ */

/** Pixel budget for the DPR cap. Matches the garage scene. */
export const PIXEL_BUDGET = 4_500_000;
/** Camera far plane — must reach Mt. Fuji at Z=-400 from the city. */
export const CAMERA_FAR = 2000;
/** Camera near plane. */
export const CAMERA_NEAR = 0.5;
/** Default camera field of view. */
export const CAMERA_FOV = 60;
/** Shadow map resolution. */
export const SHADOW_MAP_SIZE = 2048;
/** Shadow frustum half-extent (orthographic camera covers ±this in X and Z). */
export const SHADOW_FRUSTUM_HALF = 150;
