import { describe, expect, it } from "vitest";
import {
  SPORT_CAR,
  forwardSpeed,
  speedKmh,
  stepCar,
  type CarBody,
  type CarInput,
  type WorldConstraints,
} from "./physics";

const NO_INPUT: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

const WORLD: WorldConstraints = {
  boxes: [[10, 20, 10, 20]],
  worldHalf: 300,
  isWater: (x, z) => Math.abs(z) < 20 && Math.abs(x - 50) > 8,
  bridgeCorridors: [{ x: 50, halfWidth: 8, zRange: 28 }],
};

function carAt(x: number, z: number, heading = 0): CarBody {
  return { x, z, heading, vx: 0, vz: 0 };
}

function drive(body: CarBody, input: Partial<CarInput>, seconds: number): void {
  const dt = 1 / 60;
  const full = { ...NO_INPUT, ...input };
  for (let i = 0; i < seconds * 60; i++) stepCar(body, full, SPORT_CAR, WORLD, dt);
}

describe("stepCar — longitudinal", () => {
  it("accelerates from rest along the heading", () => {
    const body = carAt(0, -100, 0); // heading 0 = +Z
    drive(body, { throttle: 1 }, 2);
    expect(forwardSpeed(body)).toBeGreaterThan(10);
    // Moving toward +Z.
    expect(body.z).toBeGreaterThan(-85);
    expect(Math.abs(body.x)).toBeLessThan(0.5);
  });

  it("never exceeds max speed", () => {
    const body = carAt(0, -200, 0);
    drive(body, { throttle: 1 }, 30);
    expect(forwardSpeed(body)).toBeLessThanOrEqual(SPORT_CAR.maxSpeed + 1e-6);
  });

  it("brakes to a stop, then reverses under continued brake", () => {
    const body = carAt(0, -150, 0);
    drive(body, { throttle: 1 }, 2);
    const fast = forwardSpeed(body);
    drive(body, { brake: 1 }, 1.2);
    expect(Math.abs(forwardSpeed(body))).toBeLessThan(2); // stopped
    const zAtStop = body.z;
    drive(body, { brake: 1 }, 1);
    expect(forwardSpeed(body)).toBeLessThan(0); // now reversing
    expect(body.z).toBeLessThan(zAtStop);
    expect(fast).toBeGreaterThan(10);
  });

  it("coasts to a stop with no input", () => {
    const body = carAt(0, -100, 0);
    drive(body, { throttle: 1 }, 2);
    drive(body, {}, 30);
    expect(Math.abs(forwardSpeed(body))).toBeLessThan(0.1);
  });
});

describe("stepCar — steering", () => {
  it("does not turn at a standstill", () => {
    const body = carAt(0, 0, 0);
    drive(body, { steer: 1 }, 2);
    expect(body.heading).toBe(0);
  });

  it("turns while moving, and reverse steering inverts", () => {
    const body = carAt(0, -50, 0);
    drive(body, { throttle: 1 }, 1.5);
    const h0 = body.heading;
    drive(body, { throttle: 1, steer: 1 }, 1);
    const turned = body.heading - h0;
    expect(turned).toBeGreaterThan(0.2);

    const body2 = carAt(0, -50, 0);
    drive(body2, { throttle: 1 }, 1.5);
    drive(body2, { brake: 1, steer: 1 }, 1); // reversing
    expect(body2.heading).toBeLessThan(Math.PI / 2); // turned the other way
  });
});

describe("stepCar — grip and drift", () => {
  it("lateral velocity decays faster with grip than with handbrake", () => {
    // Seed a pure sideways slide (heading +Z, velocity +X) and take one
    // step under each grip. The handbrake must retain more lateral speed.
    const slide = (handbrake: boolean) => {
      const body = carAt(0, 0, 0);
      body.vx = 5; // lateral relative to heading 0
      stepCar(body, { ...NO_INPUT, handbrake }, SPORT_CAR, WORLD, 1 / 60);
      const [rx, rz] = [Math.cos(body.heading), -Math.sin(body.heading)];
      return Math.abs(body.vx * rx + body.vz * rz);
    };
    expect(slide(true)).toBeGreaterThan(slide(false) * 1.02);
  });
});

describe("stepCar — collisions", () => {
  it("is pushed out of a building box and does not tunnel through", () => {
    const body = carAt(5, 15, Math.PI / 2); // heading +X, driving at the box's left wall
    drive(body, { throttle: 1 }, 4);
    // The box spans x 10..20; the car (r≈1.15) must stay left of x=10.
    expect(body.x).toBeLessThan(10);
    // It may slide along the wall but never end up inside.
    const r = SPORT_CAR.radius;
    const inside =
      body.x > 10 - r && body.x < 20 + r && body.z > 10 - r && body.z < 20 + r;
    expect(inside).toBe(false);
  });

  it("is blocked by river water off-bridge", () => {
    const body = carAt(0, -10, 0); // driving +Z toward the river at x=0 (no bridge)
    drive(body, { throttle: 1 }, 10);
    expect(Math.abs(body.z)).toBeLessThan(20); // never entered the water band
  });

  it("crosses the river on the bridge corridor", () => {
    const body = carAt(50, -60, 0); // aligned with the bridge at x=50
    drive(body, { throttle: 1 }, 6);
    expect(body.z).toBeGreaterThan(40); // made it across to the city side
  });

  it("is walled into the bridge corridor while on the bridge", () => {
    const body = carAt(46, -20, 0); // slightly off-center on the bridge approach
    drive(body, { throttle: 1, steer: -1 }, 3);
    expect(Math.abs(body.x - 50)).toBeLessThanOrEqual(8);
  });

  it("clamps to the world bounds", () => {
    const body = carAt(299, 0, Math.PI / 2);
    drive(body, { throttle: 1 }, 10);
    expect(body.x).toBeLessThanOrEqual(300);
  });
});

describe("helpers", () => {
  it("speedKmh converts u/s to km/h", () => {
    const body = carAt(0, 0);
    body.vx = 10; // u/s along +X
    expect(speedKmh(body)).toBeCloseTo(36, 5);
  });
});
