import { describe, expect, it } from "vitest";
import type { LotData } from "../types";
import { generatePreParked, type GarageFill } from "./fill";
import lotJson from "../../public/lot.json";

const lot = lotJson as unknown as LotData;

const PRESETS: GarageFill[] = ["quiet", "normal", "busy"];

describe("generatePreParked", () => {
  it("is deterministic for a given preset", () => {
    const first = generatePreParked(lot, "normal").map((car) => car.slotNode);
    const second = generatePreParked(lot, "normal").map((car) => car.slotNode);
    expect(first).toEqual(second);
  });

  it("fills more bays as the preset gets busier on every floor", () => {
    const counts = PRESETS.map((preset) => {
      const perFloor = new Map<number, number>();
      for (const car of generatePreParked(lot, preset)) {
        const floor = Number(car.slotNode.match(/^S(\d+)_/)?.[1]);
        perFloor.set(floor, (perFloor.get(floor) ?? 0) + 1);
      }
      return perFloor;
    });
    for (let floor = 0; floor <= 2; floor += 1) {
      const quietFloor = counts[0].get(floor) ?? 0;
      const normalFloor = counts[1].get(floor) ?? 0;
      const busyFloor = counts[2].get(floor) ?? 0;
      expect(quietFloor).toBeLessThanOrEqual(normalFloor);
      expect(normalFloor).toBeLessThanOrEqual(busyFloor);
      // The presets differ by construction, so equality everywhere would mean
      // the fill fractions are not actually being applied.
      expect(quietFloor).toBeLessThan(busyFloor);
    }
  });

  it("only returns real slots, once each, with stable keys", () => {
    const cars = generatePreParked(lot, "busy");
    const seen = new Set<string>();
    for (const car of cars) {
      expect(seen.has(car.slotNode)).toBe(false);
      seen.add(car.slotNode);
      expect(lot.nodes[car.slotNode]?.type).toBe("slot");
      expect(car.key).toBe(`pre-${car.slotNode}`);
      expect(car.plate.length).toBeGreaterThan(0);
    }
    // The busiest preset must still leave some bays empty.
    expect(cars.length).toBeLessThan(Object.values(lot.nodes).filter((n) => n.type === "slot").length);
  });

  it("falls back to the default fill band for unknown floors", () => {
    const synthetic = {
      nodes: {
        S9_1: { type: "slot", floor: 9, x: 0, y: 0 },
      },
      edges: {},
    } as unknown as LotData;
    const cars = generatePreParked(synthetic, "quiet");
    // depth=0 -> fill=start=0.7 of the default band... the quiet preset has no
    // floor 9 entry, so DEFAULT_FILL [0.8, 0.1] applies and index 0's noise is
    // 0, which lands under 0.8.
    expect(cars).toHaveLength(1);
    expect(cars[0].slotNode).toBe("S9_1");
  });
});
