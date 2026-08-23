import { describe, expect, it } from "vitest";
import type { ActiveCar } from "../types";
import { publishRoutePlan, readRoutePlan } from "../hooks/useSimulation";

/**
 * Tests for the standstill departure path caching fix.
 *
 * When a standstill car gets a routing instruction but the road is blocked,
 * the full path (including the first hop) is published via publishRoutePlan
 * so Car.tsx can retry the departure every frame via its heldNode mechanism,
 * instead of waiting for the next server reply (~400ms).
 *
 * The key invariant: the published path includes the first hop (path.slice(1))
 * when blocked, vs path.slice(2) when the car departs immediately.
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

describe("standstill departure: path caching when blocked", () => {
  it("publishes the full path including the first hop when road is blocked", () => {
    const car = makeCar({ id: "C1", fromNode: "E0", toNode: "E0" });
    const fullPath = ["E0", "J0_0_1", "J0_0_2", "S0_5"];
    // When blocked: publishRoutePlan(car, instruction.path.slice(1))
    // This includes the first hop so Car.tsx can retry it every frame.
    publishRoutePlan(car, fullPath.slice(1));
    const plan = readRoutePlan(car);
    expect(plan).not.toBeNull();
    expect(plan!.upcoming).toEqual(["J0_0_1", "J0_0_2", "S0_5"]);
  });

  it("publishes the path without the first hop when car departs immediately", () => {
    const car = makeCar({ id: "C2", fromNode: "E0", toNode: "J0_0_1" });
    const fullPath = ["E0", "J0_0_1", "J0_0_2", "S0_5"];
    // When departing: publishRoutePlan(car, instruction.path.slice(2))
    // The first hop is already the car's toNode, so only remaining hops are published.
    publishRoutePlan(car, fullPath.slice(2));
    const plan = readRoutePlan(car);
    expect(plan).not.toBeNull();
    expect(plan!.upcoming).toEqual(["J0_0_2", "S0_5"]);
  });

  it("each publish creates a new version so Car.tsx picks up the update", () => {
    const car = makeCar({ id: "C3" });
    publishRoutePlan(car, ["J0_0_1", "S0_5"]);
    const v1 = readRoutePlan(car);
    publishRoutePlan(car, ["J0_0_1", "J0_0_2", "S0_3"]);
    const v2 = readRoutePlan(car);
    expect(v1).not.toBeNull();
    expect(v2).not.toBeNull();
    expect(v2!.version).toBeGreaterThan(v1!.version);
    expect(v2!.upcoming).toEqual(["J0_0_1", "J0_0_2", "S0_3"]);
  });

  it("returns null for a car with no published plan", () => {
    const car = makeCar({ id: "C4" });
    expect(readRoutePlan(car)).toBeNull();
  });
});
