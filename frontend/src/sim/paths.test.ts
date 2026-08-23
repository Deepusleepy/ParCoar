import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { LotData } from "../types";
import { resolvePath } from "./paths";
import { LANE_WIDTH, toWorld } from "./constants";
import { rampPoints } from "./geometry";
import lotJson from "../../public/lot.json";

const lot = lotJson as unknown as LotData;
const FLOOR_HEIGHT = lot.floor_height;
const LANE_SHIFT = -LANE_WIDTH / 2;

function worldOf(id: string): THREE.Vector3 {
  const node = lot.nodes[id];
  const [x, y, z] = toWorld(node.x, node.y, node.floor);
  return new THREE.Vector3(x, y, z);
}

describe("resolvePath", () => {
  it("offsets straight legs into the driving lane", () => {
    const points = resolvePath(lot.nodes["J0_0_1"], lot.nodes["J0_0_2"], lot);
    expect(points.length).toBe(2);
    // +x traffic on an even aisle rides at z = centreline - LANE_WIDTH/2.
    const from = worldOf("J0_0_1");
    const to = worldOf("J0_0_2");
    expect(points[0].x).toBeCloseTo(from.x, 6);
    expect(points[0].z).toBeCloseTo(from.z + LANE_SHIFT, 6);
    expect(points[1].z).toBeCloseTo(to.z + LANE_SHIFT, 6);
    expect(points[0].y).toBeCloseTo(FLOOR_HEIGHT * 0, 6);
  });

  it("climbs ramps monotonically at road-sampling density", () => {
    const up = lot.nodes["R0_up"];
    const down = lot.nodes["R1_in"];
    const points = resolvePath(up, down, lot);
    expect(points.length).toBeGreaterThan(50);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].y).toBeGreaterThanOrEqual(points[i - 1].y - 1e-6);
      // Centreline resamples every ~0.5 units; the lane offset stretches
      // spacing a little on curves, so allow headroom but stay dense.
      expect(points[i].distanceTo(points[i - 1])).toBeLessThan(0.75);
    }
    expect(points[0].y).toBeCloseTo(worldOf("R0_up").y, 3);
    expect(points[points.length - 1].y).toBeCloseTo(worldOf("R1_in").y, 3);
  });

  it("runs the downhill direction on the opposite lane of the same curve", () => {
    const forward = resolvePath(lot.nodes["R0_up"], lot.nodes["R1_in"], lot);
    const backward = resolvePath(lot.nodes["R1_in"], lot.nodes["R0_up"], lot);
    expect(backward.length).toBe(forward.length);
    // Same centreline, one lane apart: each point of the reversed run sits
    // LANE_WIDTH/2 on the other side, so paired points are exactly one lane
    // width apart and neither drifts off the raw ramp curve.
    for (let i = 0; i < forward.length; i += 1) {
      expect(backward[i].distanceTo(forward[forward.length - 1 - i]))
        .toBeCloseTo(LANE_WIDTH, 3);
    }
    const raw = rampPoints(
      toWorld(lot.nodes["R0_up"].x, lot.nodes["R0_up"].y, lot.nodes["R0_up"].floor),
      toWorld(lot.nodes["R1_in"].x, lot.nodes["R1_in"].y, lot.nodes["R1_in"].floor),
    );
    expect(raw.length).toBe(forward.length);
    for (let i = 0; i < forward.length; i += 1) {
      expect(forward[i].distanceTo(raw[i])).toBeLessThan(LANE_WIDTH / 2 + 1e-4);
      expect(backward[i].distanceTo(raw[raw.length - 1 - i])).toBeLessThan(LANE_WIDTH / 2 + 1e-4);
      expect(forward[i].distanceTo(raw[i])).toBeGreaterThan(0.5);
    }
  });

  it("enters a slot with a lane-aligned bezier", () => {
    const junctionId = "J0_0_2";
    const slotId = "S0_2";
    const points = resolvePath(lot.nodes[junctionId], lot.nodes[slotId], lot);
    expect(points.length).toBeGreaterThan(10);
    // The curve leaves the junction already in the driving lane, not on the
    // centreline (the old sideways-lunge bug).
    const jw = worldOf(junctionId);
    const approach = worldOf("J0_0_3").sub(jw).setY(0).normalize();
    const sideZ = Math.sign(approach.clone().cross(new THREE.Vector3(0, 1, 0)).z);
    expect(points[0].z).toBeCloseTo(jw.z + sideZ * LANE_SHIFT, 5);
    // And it ends at the bay.
    const last = points[points.length - 1];
    expect(last.distanceTo(worldOf(slotId))).toBeLessThan(1e-6);
  });

  it("keeps turn loops flat and on their lane of the semicircle", () => {
    // Travelling far-junction -> turn resolves to the reversed semicircle.
    const points = resolvePath(lot.nodes["J0_1_20"], lot.nodes["T0_0"], lot);
    expect(points.length).toBeGreaterThan(20);
    for (const point of points) {
      expect(point.y).toBeCloseTo(FLOOR_HEIGHT * 0, 6);
    }
    // The lane offset is perpendicular to the tangent, i.e. radial on an
    // arc: this direction rides INSIDE the circle at r - LANE_WIDTH/2.
    const centre = new THREE.Vector2(
      lot.nodes["T0_0"].x,
      (lot.nodes["J0_0_20"].y + lot.nodes["J0_1_20"].y) / 2,
    );
    const radius = Math.abs(lot.nodes["J0_1_20"].y - lot.nodes["J0_0_20"].y) / 2;
    const laneRadius = radius - LANE_WIDTH / 2;
    for (let i = 1; i < points.length - 1; i += 1) {
      const d = Math.hypot(points[i].x - centre.x, points[i].z - centre.y);
      expect(d).toBeGreaterThan(laneRadius - 0.05);
      expect(d).toBeLessThan(laneRadius + 0.05);
    }
  });
});
