import {
  BRIDGE_DECK_Y,
  BRIDGE_MODERN_X,
  BRIDGE_RAMP_END,
  BRIDGE_RAMP_START,
  BRIDGE_TRUSS_X,
  BRIDGE_WIDTH,
  RIVER_HALF_WIDTH,
  RIVER_Z,
} from "./constants";

/**
 * Ground-height + water contract for the drivable world.
 *
 * The world is flat at y=0 except on the two bridge corridors, where the
 * road ramps up to the deck height over the banks and stays flat across
 * the water. River.tsx must build its bridge decks to match this profile
 * (flat deck at BRIDGE_DECK_Y between |z| = BRIDGE_RAMP_END, linear ramps
 * out to 0 at |z| = BRIDGE_RAMP_START).
 *
 * Everything that needs "how high is the ground here" (the car, placed
 * props) calls groundHeight; anything that must not be driven into (the
 * river surface off-bridge) is flagged by isWater.
 */

/** Half-width of each bridge corridor (drivable width incl. ramps). */
const CORRIDOR_HALF = BRIDGE_WIDTH / 2;

const BRIDGE_CORRIDORS: readonly number[] = [BRIDGE_MODERN_X, BRIDGE_TRUSS_X];

/** Height of drivable ground at (x, z). Bridges ramp; everything else is 0. */
export function groundHeight(x: number, z: number): number {
  for (const bx of BRIDGE_CORRIDORS) {
    if (Math.abs(x - bx) > CORRIDOR_HALF) continue;
    const az = Math.abs(z - RIVER_Z);
    if (az >= BRIDGE_RAMP_START) return 0;
    if (az <= BRIDGE_RAMP_END) return BRIDGE_DECK_Y;
    // Linear ramp between the ramp band edges.
    const t = (BRIDGE_RAMP_START - az) / (BRIDGE_RAMP_START - BRIDGE_RAMP_END);
    return BRIDGE_DECK_Y * t;
  }
  return 0;
}

/** True if (x, z) is river water that a car cannot occupy (off-bridge). */
export function isWater(x: number, z: number): boolean {
  if (Math.abs(z - RIVER_Z) >= RIVER_HALF_WIDTH) return false;
  for (const bx of BRIDGE_CORRIDORS) {
    if (Math.abs(x - bx) <= CORRIDOR_HALF) return false;
  }
  return true;
}
