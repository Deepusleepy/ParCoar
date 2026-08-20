import { describe, expect, it } from "vitest";
import {
  EDGE_LINE_OFFSET,
  EDGE_LINE_WIDTH,
  FLOOR_HEIGHT,
  JUNCTION_SPACING,
  ROAD_WIDTH,
  SLOT_WIDTH,
  bayLabel,
  toWorld,
} from "./constants";

describe("bayLabel", () => {
  it.each([
    ["S0_42", "A42"],
    ["S1_7", "B7"],
    ["S2_120", "C120"],
  ])("labels %s as %s", (id, label) => {
    expect(bayLabel(id)).toBe(label);
  });

  it.each(["J0_0_1", "T0_0", "S1_7_extra", "not-a-bay"])('leaves "%s" unchanged', (id) => {
    expect(bayLabel(id)).toBe(id);
  });
});

describe("toWorld", () => {
  it("maps floor height to Y and lot Y to world Z", () => {
    expect(toWorld(3.5, -4.25, 2)).toEqual([3.5, 2 * FLOOR_HEIGHT, -4.25]);
  });
});

describe("layout constants", () => {
  it("uses the junction pitch for bay width", () => {
    expect(SLOT_WIDTH).toBe(JUNCTION_SPACING);
  });

  it("puts the outer edge of the road line on the road edge", () => {
    expect(EDGE_LINE_OFFSET + EDGE_LINE_WIDTH / 2).toBeCloseTo(ROAD_WIDTH / 2, 10);
  });
});
