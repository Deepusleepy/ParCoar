/**
 * Arcade car physics for the open world — a pure, testable module.
 *
 * Model: velocity is decomposed each step into forward and lateral
 * components relative to the car heading. Throttle/brake act on the
 * forward component, steering rotates the heading (scaled by speed so the
 * car can't spin in place), and grip exponentially decays the lateral
 * component. The handbrake swaps in a lower grip so the rear steps out —
 * that's the drift.
 *
 * Collisions are circle-vs-AABB against building footprints plus three
 * world constraints (bridge corridor walls, river water, world bounds).
 * Resolution is positional push-out along the minimum-penetration axis
 * with a small restitution and a speed scrub — arcade, not simulation.
 *
 * Units: world units and seconds (1 unit ≈ 1 m). Speeds in u/s; the HUD
 * converts to km/h (×3.6).
 */

export interface CarConfig {
  /** Top forward speed, u/s. */
  maxSpeed: number;
  /** Top reverse speed, u/s. */
  maxReverse: number;
  /** Throttle acceleration, u/s². */
  accel: number;
  /** Brake deceleration, u/s². */
  brake: number;
  /** Coasting deceleration (engine braking + rolling resistance), u/s². */
  coastDrag: number;
  /** Steering rate, rad/s, at the reference speed. */
  turnRate: number;
  /** Normal lateral grip — exponential decay rate of lateral velocity, 1/s. */
  grip: number;
  /** Lateral grip while the handbrake is held (lower = more drift). */
  driftGrip: number;
  /** Extra deceleration while the handbrake is held, u/s². */
  handbrakeDrag: number;
  /** Collision circle radius, u. */
  radius: number;
}

export const SPORT_CAR: CarConfig = {
  maxSpeed: 38,
  maxReverse: 8,
  accel: 16,
  brake: 30,
  coastDrag: 2.2,
  turnRate: 2.1,
  grip: 5.2,
  driftGrip: 1.6,
  handbrakeDrag: 7,
  radius: 1.15,
};

export const SEDAN_CAR: CarConfig = {
  maxSpeed: 32,
  maxReverse: 7,
  accel: 12,
  brake: 26,
  coastDrag: 2.0,
  turnRate: 1.9,
  grip: 5.6,
  driftGrip: 2.0,
  handbrakeDrag: 6,
  radius: 1.15,
};

export const SUV_CAR: CarConfig = {
  maxSpeed: 28,
  maxReverse: 6,
  accel: 10,
  brake: 24,
  coastDrag: 2.4,
  turnRate: 1.7,
  grip: 6.0,
  driftGrip: 2.4,
  handbrakeDrag: 6,
  radius: 1.25,
};

export interface CarBody {
  x: number;
  z: number;
  /** Heading in radians. 0 = +Z; increases clockwise seen from above (+X at π/2). */
  heading: number;
  vx: number;
  vz: number;
}

export interface CarInput {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1..1. Positive steers toward increasing heading. */
  steer: number;
  handbrake: boolean;
}

/** Axis-aligned box in the XZ plane: [minX, maxX, minZ, maxZ]. */
export type Box2 = readonly [number, number, number, number];

export interface WorldConstraints {
  /** Building/obstacle footprints the car collides with. */
  boxes: readonly Box2[];
  /** Half-extent of the drivable world (|x|,|z| clamped to this). */
  worldHalf: number;
  /** Returns true if the point is off-bridge river water (impassable). */
  isWater: (x: number, z: number) => boolean;
  /** Bridge corridor center Xs; while on a corridor the car is walled in. */
  bridgeCorridors: readonly { x: number; halfWidth: number; zRange: number }[];
}

export interface StepResult {
  /** True if a collision was resolved this step (for skid/crash SFX later). */
  collided: boolean;
}

const RESTITUTION = 0.25;
/** Fraction of forward speed scrubbed on a wall hit. */
const HIT_SCRUB = 0.45;

/** Forward unit vector components for a heading. */
function forwardOf(heading: number): [number, number] {
  return [Math.sin(heading), Math.cos(heading)];
}

/** Right unit vector components for a heading (forward rotated -90°). */
function rightOf(heading: number): [number, number] {
  return [Math.cos(heading), -Math.sin(heading)];
}

/**
 * Advance the car by dt seconds. Mutates `body`. Fixed-step: call with a
 * small constant dt (the component accumulates real time into fixed steps).
 */
export function stepCar(
  body: CarBody,
  input: CarInput,
  cfg: CarConfig,
  world: WorldConstraints,
  dt: number,
): StepResult {
  let collided = false;

  const [fx, fz] = forwardOf(body.heading);
  const [rx, rz] = rightOf(body.heading);

  // Decompose velocity into forward / lateral components.
  let vf = body.vx * fx + body.vz * fz;
  let vl = body.vx * rx + body.vz * rz;

  // --- longitudinal ---
  if (input.throttle > 0) {
    vf = Math.min(vf + cfg.accel * input.throttle * dt, cfg.maxSpeed);
  }
  if (input.brake > 0) {
    if (vf > 0.4) {
      vf = Math.max(vf - cfg.brake * input.brake * dt, 0);
    } else {
      // Reverse.
      vf = Math.max(vf - cfg.accel * 0.55 * input.brake * dt, -cfg.maxReverse);
    }
  }
  // Coast drag toward zero.
  const drag = cfg.coastDrag + (input.handbrake ? cfg.handbrakeDrag : 0);
  if (input.throttle === 0) {
    const dv = drag * dt;
    if (Math.abs(vf) <= dv) vf = 0;
    else vf -= Math.sign(vf) * dv;
  } else if (input.handbrake) {
    const dv = cfg.handbrakeDrag * dt;
    if (Math.abs(vf) <= dv) vf = 0;
    else vf -= Math.sign(vf) * dv;
  }

  // --- steering ---
  // Turn authority ramps in with speed (no spinning in place) and eases
  // off at very high speed so the car stays composed on a straight.
  const speed = Math.abs(vf);
  const speedFactor = Math.min(speed / 7, 1) * (1 / (1 + speed / (cfg.maxSpeed * 1.4)));
  if (input.steer !== 0 && speedFactor > 0) {
    body.heading += input.steer * cfg.turnRate * speedFactor * Math.sign(vf) * dt;
  }

  // --- lateral grip ---
  const gripRate = input.handbrake ? cfg.driftGrip : cfg.grip;
  vl *= Math.exp(-gripRate * dt);

  // Recompose world velocity from the (possibly rotated) basis.
  const [nfx, nfz] = forwardOf(body.heading);
  const [nrx, nrz] = rightOf(body.heading);
  let vx = nfx * vf + nrx * vl;
  let vz = nfz * vf + nrz * vl;

  // --- integrate ---
  const nx = body.x + vx * dt;
  const nz = body.z + vz * dt;

  // --- world constraints ---
  let px = nx;
  let pz = nz;

  // River water: block entry, scrub most of the speed.
  if (world.isWater(px, pz)) {
    px = body.x;
    pz = body.z;
    vx *= 0.2;
    vz *= 0.2;
    collided = true;
  }

  // Bridge corridor walls: while between the ramp band edges, clamp to the
  // corridor so the car can't drive off the deck.
  for (const bc of world.bridgeCorridors) {
    const inZBand = Math.abs(pz) < bc.zRange;
    const nearX = Math.abs(px - bc.x) < bc.halfWidth + 6;
    if (inZBand && nearX) {
      const minX = bc.x - bc.halfWidth + cfg.radius;
      const maxX = bc.x + bc.halfWidth - cfg.radius;
      if (px < minX) {
        px = minX;
        vx = Math.abs(vx) * RESTITUTION;
        collided = true;
      } else if (px > maxX) {
        px = maxX;
        vx = -Math.abs(vx) * RESTITUTION;
        collided = true;
      }
    }
  }

  // Building AABBs (circle vs box, minimum-penetration push-out).
  const r = cfg.radius;
  for (const [bx0, bx1, bz0, bz1] of world.boxes) {
    // Broad phase.
    if (px < bx0 - r || px > bx1 + r || pz < bz0 - r || pz > bz1 + r) continue;
    // Penetration depths along each axis from the box exterior.
    const penLeft = px - (bx0 - r); // push left amount
    const penRight = bx1 + r - px;
    const penUp = pz - (bz0 - r);
    const penDown = bz1 + r - pz;
    const minPen = Math.min(penLeft, penRight, penUp, penDown);
    if (minPen <= 0) continue;
    if (minPen === penLeft) {
      px = bx0 - r;
      vx = -Math.abs(vx) * RESTITUTION;
    } else if (minPen === penRight) {
      px = bx1 + r;
      vx = Math.abs(vx) * RESTITUTION;
    } else if (minPen === penUp) {
      pz = bz0 - r;
      vz = -Math.abs(vz) * RESTITUTION;
    } else {
      pz = bz1 + r;
      vz = Math.abs(vz) * RESTITUTION;
    }
    // Scrub forward speed so scraping a wall bleeds momentum.
    const scrub = 1 - HIT_SCRUB * (minPen > r * 0.5 ? 1 : 0.4);
    vx *= scrub;
    vz *= scrub;
    collided = true;
  }

  // World bounds.
  const wh = world.worldHalf - r;
  if (px < -wh) {
    px = -wh;
    vx = 0;
    collided = true;
  } else if (px > wh) {
    px = wh;
    vx = 0;
    collided = true;
  }
  if (pz < -wh) {
    pz = -wh;
    vz = 0;
    collided = true;
  } else if (pz > wh) {
    pz = wh;
    vz = 0;
    collided = true;
  }

  body.x = px;
  body.z = pz;
  body.vx = vx;
  body.vz = vz;

  return { collided };
}

/** Signed forward speed of the body along its heading, u/s. */
export function forwardSpeed(body: CarBody): number {
  const [fx, fz] = forwardOf(body.heading);
  return body.vx * fx + body.vz * fz;
}

/** Speed magnitude in km/h (for the HUD). */
export function speedKmh(body: CarBody): number {
  return Math.hypot(body.vx, body.vz) * 3.6;
}
