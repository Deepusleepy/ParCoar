import { describe, expect, it } from "vitest";
import type { ActiveCar, LotData } from "../types";
import {
  directionAt,
  isRoadBlocked,
  nextNodeForDirection,
  nodeGap,
  roadDirection,
} from "./traffic";
import lotJson from "../../public/lot.json";

const lot = lotJson as unknown as LotData;
const FLOOR_HEIGHT = lot.floor_height;

function makeCar(partial: Partial<ActiveCar>): ActiveCar {
  return {
    id: "car",
    color: "red",
    plate: "AAA-000",
    size: "medium",
    fromNode: "J0_0_1",
    toNode: "J0_0_1",
    progress: 0,
    slot: null,
    status: "routing",
    parked: false,
    vacating: null,
    leaving: false,
    ...partial,
  };
}

describe("roadDirection", () => {
  it("sends even aisles toward +x", () => {
    expect(roadDirection(lot, "J0_0_1", "J0_0_2")).toBe(1);
    expect(roadDirection(lot, "J0_0_2", "J0_0_1")).toBe(-1);
  });

  it("flows odd aisles toward -x", () => {
    expect(roadDirection(lot, "J0_1_1", "J0_1_2")).toBe(-1);
    expect(roadDirection(lot, "J0_1_2", "J0_1_1")).toBe(1);
  });

  it("classifies turn legs by near/far junction", () => {
    // T0_0 joins J0_0_20 (same y: near) and J0_1_20 (far).
    expect(roadDirection(lot, "T0_0", "J0_0_20")).toBe(-1);
    expect(roadDirection(lot, "J0_0_20", "T0_0")).toBe(1);
    expect(roadDirection(lot, "T0_0", "J0_1_20")).toBe(1);
    expect(roadDirection(lot, "J0_1_20", "T0_0")).toBe(-1);
  });

  it("labels ramps by climbing direction", () => {
    expect(roadDirection(lot, "R0_up", "R1_in")).toBe(1);
    expect(roadDirection(lot, "R1_in", "R0_up")).toBe(-1);
    // Single-ended ramp legs follow the same convention.
    expect(roadDirection(lot, "J0_3_1", "R0_up")).toBe(1);
    expect(roadDirection(lot, "R0_up", "J0_3_1")).toBe(-1);
    expect(roadDirection(lot, "J1_0_1", "R1_in")).toBe(-1);
    expect(roadDirection(lot, "R1_in", "J1_0_1")).toBe(1);
  });

  it("returns null without a lane", () => {
    expect(roadDirection(lot, "J0_0_2", "J0_0_2")).toBeNull();
    expect(roadDirection(lot, "J0_0_2", "S0_2")).toBeNull();
    expect(roadDirection(lot, "NOPE", "J0_0_1")).toBeNull();
  });
});

describe("nodeGap", () => {
  it("measures straight-line distance including floor height", () => {
    const a = lot.nodes["J0_0_1"];
    const b = lot.nodes["J1_0_1"];
    if (a.x === b.x && a.y === b.y) {
      expect(nodeGap(lot, "J0_0_1", "J1_0_1")).toBeCloseTo(FLOOR_HEIGHT, 6);
    } else {
      const expected = Math.hypot(a.x - b.x, a.y - b.y, (a.floor - b.floor) * FLOOR_HEIGHT);
      expect(nodeGap(lot, "J0_0_1", "J1_0_1")).toBeCloseTo(expected, 6);
    }
  });

  it("is Infinity for unknown nodes", () => {
    expect(nodeGap(lot, "MISSING", "J0_0_1")).toBe(Infinity);
  });
});

describe("directionAt", () => {
  it("reads the traversed edge's direction label", () => {
    expect(directionAt(lot, ["J0_0_1", "J0_0_2"], 0)).toBe("straight");
  });

  it("reports arrival past the end of the route", () => {
    expect(directionAt(lot, ["J0_0_1"], 0)).toBe("arrived");
    expect(directionAt(lot, ["J0_0_1", "J0_0_2"], 1)).toBe("arrived");
  });
});

describe("nextNodeForDirection", () => {
  it("follows an edge label out of a node", () => {
    expect(nextNodeForDirection(lot, "E0", "straight")).toBe("J0_0_1");
  });

  it("returns null when no edge carries the label", () => {
    expect(nextNodeForDirection(lot, "E0", "left")).toBeNull();
  });
});

describe("isRoadBlocked", () => {
  const emptyInstructions = new Map();

  it("blocks when another car sits at the target node", () => {
    const self = makeCar({ id: "self", fromNode: "J0_0_1", toNode: "J0_0_1" });
    const squatter = makeCar({ id: "other", fromNode: "J0_0_2", toNode: "J0_0_2" });
    expect(isRoadBlocked(lot, [squatter], self, "J0_0_2", undefined, emptyInstructions)).toBe(true);
  });

  it("ignores parked cars at the target node", () => {
    const self = makeCar({ id: "self", fromNode: "J0_0_1", toNode: "J0_0_1" });
    const parked = makeCar({ id: "other", fromNode: "J0_0_2", toNode: "J0_0_2", parked: true });
    expect(isRoadBlocked(lot, [parked], self, "J0_0_2", undefined, emptyInstructions)).toBe(false);
  });

  it("stops blocking once a car has pulled well away from its entry node", () => {
    // T0_0 -> J0_1_20 is a ~29 unit turn leg, so progress can exceed the
    // 1.5-car-length pull-away threshold here (it never could on a 2.6 aisle).
    const self = makeCar({ id: "self", fromNode: "T0_0", toNode: "T0_0" });
    const close = makeCar({
      id: "close",
      fromNode: "T0_0",
      toNode: "J0_1_20",
      progress: 0.05,
    });
    const away = makeCar({
      id: "away",
      fromNode: "T0_0",
      toNode: "J0_1_20",
      progress: 0.5,
    });
    expect(isRoadBlocked(lot, [close], self, "J0_1_20", undefined, emptyInstructions)).toBe(true);
    expect(isRoadBlocked(lot, [away], self, "J0_1_20", undefined, emptyInstructions)).toBe(false);
  });

  it("lets opposing-direction traffic through", () => {
    // Up-ramp lane vs down-ramp lane share the segment J0_3_1 <-> R0_up.
    const self = makeCar({ id: "self", fromNode: "J0_3_1", toNode: "J0_3_1" });
    const downhill = makeCar({ id: "down", fromNode: "R0_up", toNode: "J0_3_1", progress: 0 });
    expect(isRoadBlocked(lot, [downhill], self, "R0_up", undefined, emptyInstructions)).toBe(false);
  });

  it("always treats a slot as blocked while targeted", () => {
    const self = makeCar({ id: "self", fromNode: "J0_0_2", toNode: "J0_0_2" });
    const occupant = makeCar({ id: "occ", fromNode: "S0_2", toNode: "S0_2", progress: 0.99 });
    expect(isRoadBlocked(lot, [occupant], self, "S0_2", undefined, emptyInstructions)).toBe(true);
  });
});
