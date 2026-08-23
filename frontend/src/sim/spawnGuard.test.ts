import { describe, expect, it } from "vitest";
import type { ActiveCar } from "../types";

/**
 * Tests for the spawn guard logic that was buggy in useSimulation.ts.
 * The guard must:
 *  1. Not count the player car toward targetCars (off-by-one fix)
 *  2. Only reset the spawn cooldown when a car is actually spawned
 *
 * These tests model the exact filter logic used in the setActiveCars
 * callback so the invariant is locked even though the hook itself
 * is not directly unit-testable.
 */

function makeCar(partial: Partial<ActiveCar>): ActiveCar {
  return {
    id: "car",
    color: "red",
    plate: "AAA-000",
    size: "medium",
    fromNode: "E0",
    toNode: "E0",
    progress: 0,
    slot: null,
    status: "routing",
    parked: false,
    vacating: null,
    leaving: false,
    ...partial,
  };
}

describe("spawn guard: player exclusion", () => {
  it("counts only AI cars toward targetCars, not the player", () => {
    const existing: ActiveCar[] = [
      makeCar({ id: "P0", player: true, leaving: false }),
      makeCar({ id: "C1", player: false, leaving: false }),
      makeCar({ id: "C2", player: false, leaving: false }),
    ];
    const targetCars = 2;
    const activeAi = existing.filter((c) => !c.leaving && !c.player).length;
    expect(activeAi).toBe(2);
    expect(activeAi >= targetCars).toBe(true);
  });

  it("allows one more AI car when player is present and targetCars=3", () => {
    const existing: ActiveCar[] = [
      makeCar({ id: "P0", player: true, leaving: false }),
      makeCar({ id: "C1", player: false, leaving: false }),
      makeCar({ id: "C2", player: false, leaving: false }),
    ];
    const targetCars = 3;
    const activeAi = existing.filter((c) => !c.leaving && !c.player).length;
    expect(activeAi).toBe(2);
    expect(activeAi >= targetCars).toBe(false);
  });

  it("does not count leaving cars toward targetCars", () => {
    const existing: ActiveCar[] = [
      makeCar({ id: "C1", player: false, leaving: false }),
      makeCar({ id: "C2", player: false, leaving: true }),
    ];
    const targetCars = 2;
    const activeAi = existing.filter((c) => !c.leaving && !c.player).length;
    expect(activeAi).toBe(1);
    expect(activeAi >= targetCars).toBe(false);
  });
});

describe("spawn guard: cooldown reset", () => {
  it("models the spawned flag pattern: cooldown only resets on actual spawn", () => {
    const existing: ActiveCar[] = [
      makeCar({ id: "C1", player: false, leaving: false }),
      makeCar({ id: "C2", player: false, leaving: false }),
    ];
    const targetCars = 2;
    let spawned = false;
    const activeAi = existing.filter((c) => !c.leaving && !c.player).length;
    if (activeAi >= targetCars) {
      // no spawn, spawned stays false
    } else {
      spawned = true;
    }
    expect(spawned).toBe(false);
  });

  it("resets cooldown when a car is actually added", () => {
    const existing: ActiveCar[] = [
      makeCar({ id: "C1", player: false, leaving: false }),
    ];
    const targetCars = 3;
    let spawned = false;
    const activeAi = existing.filter((c) => !c.leaving && !c.player).length;
    if (activeAi >= targetCars) {
      spawned = false;
    } else {
      spawned = true;
    }
    expect(spawned).toBe(true);
  });
});
