import { describe, expect, it } from "vitest";
import lotJson from "../../../shared/lot.json?raw";
import type { LotData } from "../types";
import { AISLE_SPACING, FLOOR_HEIGHT, SLAB_PAD_X, SLAB_PAD_Z } from "./constants";
import { aisleOf, rampPoints, semicirclePoints, slabBounds } from "./geometry";

const lot = JSON.parse(lotJson) as LotData;

function segmentGradients(points: ReturnType<typeof rampPoints>): number[] {
  return points.slice(1).map((point, index) => {
    const previous = points[index];
    const run = Math.hypot(point.x - previous.x, point.z - previous.z);
    return Math.abs(point.y - previous.y) / run;
  });
}

function headingChange(first: ReturnType<typeof rampPoints>[number], second: ReturnType<typeof rampPoints>[number]): number {
  return Math.atan2(second.z - first.z, second.x - first.x);
}

describe("aisleOf", () => {
  it("parses junction aisle numbers and rejects non-junction ids", () => {
    expect(aisleOf("J0_0_1")).toBe(0);
    expect(aisleOf("J12_42_987")).toBe(42);
    expect(aisleOf("J3_7_0")).toBe(7);

    for (const id of ["S0_1", "T0_0", "R0_up", "ENTRY_ROAD", "J0_1", "J0_1_2_extra"]) {
      expect(aisleOf(id)).toBeNull();
    }
  });
});

describe("slabBounds", () => {
  it("pads the structural graph footprint symmetrically", () => {
    const structural = Object.values(lot.nodes).filter(
      (node) => !["approach", "entry", "exit"].includes(node.type),
    );
    const xs = structural.map((node) => node.x);
    const ys = structural.map((node) => node.y);
    const expectedMinX = Math.min(...xs) - SLAB_PAD_X;
    const expectedMaxX = Math.max(...xs) + SLAB_PAD_X;
    const expectedMinZ = Math.min(...ys) - SLAB_PAD_Z;
    const expectedMaxZ = Math.max(...ys) + SLAB_PAD_Z;
    const bounds = slabBounds(lot);

    expect(bounds.minX).toBeCloseTo(expectedMinX, 10);
    expect(bounds.maxX).toBeCloseTo(expectedMaxX, 10);
    expect(bounds.minZ).toBeCloseTo(expectedMinZ, 10);
    expect(bounds.maxZ).toBeCloseTo(expectedMaxZ, 10);
    expect(Math.min(...xs) - bounds.minX).toBeCloseTo(bounds.maxX - Math.max(...xs), 10);
    expect(Math.min(...ys) - bounds.minZ).toBeCloseTo(bounds.maxZ - Math.max(...ys), 10);

    for (const node of structural) {
      expect(node.x).toBeGreaterThanOrEqual(bounds.minX);
      expect(node.x).toBeLessThanOrEqual(bounds.maxX);
      expect(node.y).toBeGreaterThanOrEqual(bounds.minZ);
      expect(node.y).toBeLessThanOrEqual(bounds.maxZ);
    }
  });
});

describe("semicirclePoints", () => {
  it("joins the two aisle centrelines with an even-radius semicircle", () => {
    const ax = 12;
    const ay = -5;
    const by = 21;
    const bulgeDir = -1;
    const floor = 2;
    const segments = 10;
    const points = semicirclePoints(ax, ay, by, bulgeDir, floor, segments);
    const centreZ = (ay + by) / 2;
    const radius = Math.abs(by - ay) / 2;

    expect(points).toHaveLength(segments + 1);
    expect(points[0]?.x).toBeCloseTo(ax, 10);
    expect(points[0]?.z).toBeCloseTo(ay, 10);
    expect(points.at(-1)?.x).toBeCloseTo(ax, 10);
    expect(points.at(-1)?.z).toBeCloseTo(by, 10);

    for (const point of points) {
      expect(point.y).toBeCloseTo(floor * FLOOR_HEIGHT, 10);
      expect(Math.hypot(point.x - ax, point.z - centreZ)).toBeCloseTo(radius, 10);
    }
  });
});

describe("rampPoints", () => {
  it("eases onto both decks, stays below the grade limit, and turns smoothly", () => {
    const from: [number, number, number] = [0, 0, 3 * AISLE_SPACING];
    const to: [number, number, number] = [0, FLOOR_HEIGHT, 0];
    const points = rampPoints(from, to);
    const gradients = segmentGradients(points);
    const maximumGradient = Math.max(...gradients);
    const headings = points.slice(1).map((point, index) => headingChange(points[index], point));
    const headingChanges = headings.slice(1).map((heading, index) => {
      const delta = heading - headings[index];
      return Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)));
    });

    expect(points[0]?.y).toBe(from[1]);
    expect(points.at(-1)?.y).toBe(to[1]);
    expect(points[0]?.toArray()).toEqual(from);
    expect(points.at(-1)?.toArray()).toEqual(to);
    expect(gradients[0]).toBeLessThan(maximumGradient * 0.5);
    expect(gradients.at(-1)).toBeLessThan(maximumGradient * 0.5);
    expect(maximumGradient).toBeLessThan(0.25);
    expect(Math.max(...headingChanges)).toBeLessThan((6 * Math.PI) / 180);
  });
});

describe("lot graph", () => {
  it("makes every slot a one-edge dead end into a junction", () => {
    for (const [id, node] of Object.entries(lot.nodes)) {
      if (node.type !== "slot") continue;
      const edges = lot.edges[id];
      expect(edges).toHaveLength(1);
      const destination = edges?.[0]?.to;
      expect(destination === undefined ? undefined : lot.nodes[destination]?.type).toBe("junction");
    }
  });

  it("uses parseable aisle ids for every junction", () => {
    for (const [id, node] of Object.entries(lot.nodes)) {
      if (node.type !== "junction") continue;
      expect(aisleOf(id)).not.toBeNull();
    }
  });

  it("keeps bay numbers contiguous on each floor", () => {
    const baysByFloor = new Map<number, number[]>();
    for (const [id, node] of Object.entries(lot.nodes)) {
      if (node.type !== "slot") continue;
      const match = id.match(/^S(\d+)_(\d+)$/);
      expect(match).not.toBeNull();
      if (!match) continue;
      expect(Number(match[1])).toBe(node.floor);
      const bays = baysByFloor.get(node.floor) ?? [];
      bays.push(Number(match[2]));
      baysByFloor.set(node.floor, bays);
    }

    for (const bays of baysByFloor.values()) {
      bays.sort((a, b) => a - b);
      for (let i = 1; i < bays.length; i++) {
        expect(bays[i]).toBe(bays[i - 1] + 1);
      }
    }
  });
});
