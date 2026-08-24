import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActiveCar, LotData } from "../types";
import {
  __setSharedWorldLotForTests,
  isNodeEntryBlocked,
  updatePlayerPos,
} from "../hooks/useSimulation";
import { LANE_WIDTH, toWorld } from "./constants";
import lotJson from "../../public/lot.json";

const lot = lotJson as unknown as LotData;

// isNodeEntryBlocked reads from the module-level sharedWorld singleton.
// We set sharedWorld.lot and sharedWorld.playerPos before each test.
// sharedWorld.cars is not exported, but isNodeEntryBlocked only uses it
// via isRoadBlocked, which we can bypass by ensuring no other cars are
// in the way (the cars array is set to [] by default).

const AI_ID = "C1";
const ENTRY = "E0";
const FIRST_NODE = "J0_0_1"; // first node after entry, along x-axis

function makeAICar(partial: Partial<ActiveCar>): ActiveCar {
  return {
    id: AI_ID,
    color: "blue",
    plate: "AI-001",
    size: "medium",
    fromNode: ENTRY,
    toNode: ENTRY,
    progress: 0,
    slot: null,
    status: "routing",
    parked: false,
    vacating: null,
    leaving: false,
    ...partial,
  };
}

beforeEach(() => {
  __setSharedWorldLotForTests(lot);
  updatePlayerPos(0, 0, -1);
});

afterEach(() => {
  updatePlayerPos(0, 0, -1);
});

describe("isNodeEntryBlocked — lateral awareness", () => {
  it("blocks when the player is ahead in the same lane", () => {
    // AI car at E0 (0,0), heading to J0_0_1 (2.6, 0).
    // Player at (1.5, 0) — same lane, ahead of the AI car.
    const ai = makeAICar({ fromNode: ENTRY, toNode: ENTRY });
    const [px, , pz] = toWorld(1.5, 0, 0);
    updatePlayerPos(px, pz, 0);
    expect(isNodeEntryBlocked(ai, FIRST_NODE, undefined)).toBe(true);
  });

  it("passes when the player is in the oncoming lane", () => {
    // AI car at E0 (0,0), heading to J0_0_1 (2.6, 0) along +X.
    // Player at (1.5, LANE_WIDTH) — oncoming lane (offset +Z by LANE_WIDTH).
    const ai = makeAICar({ fromNode: ENTRY, toNode: ENTRY });
    const [px, , pz] = toWorld(1.5, 0, 0);
    // Shift the player into the oncoming lane (+Z direction for +X travel).
    updatePlayerPos(px, pz + LANE_WIDTH, 0);
    expect(isNodeEntryBlocked(ai, FIRST_NODE, undefined)).toBe(false);
  });

  it("passes when the player is behind the AI car", () => {
    // AI car at J0_0_1 (2.6, 0), heading to J0_0_2.
    // Player at (0, 0) — behind the AI car (at E0).
    const ai = makeAICar({ fromNode: FIRST_NODE, toNode: FIRST_NODE });
    const [px, , pz] = toWorld(0, 0, 0);
    updatePlayerPos(px, pz, 0);
    // AI is at J0_0_1 heading to J0_0_2; player is behind at E0.
    expect(isNodeEntryBlocked(ai, "J0_0_2", undefined)).toBe(false);
  });

  it("passes when the player is far ahead (beyond stopping distance)", () => {
    // AI car at E0 (0,0), heading to J0_0_1 (2.6, 0).
    // Player at (50, 0) — same lane but very far ahead.
    const ai = makeAICar({ fromNode: ENTRY, toNode: ENTRY });
    const [px, , pz] = toWorld(50, 0, 0);
    updatePlayerPos(px, pz, 0);
    expect(isNodeEntryBlocked(ai, FIRST_NODE, undefined)).toBe(false);
  });

  it("passes when the player is on a different floor", () => {
    // AI car on floor 0, player on floor 1.
    const ai = makeAICar({ fromNode: ENTRY, toNode: ENTRY });
    const [px, , pz] = toWorld(1.5, 0, 1);
    updatePlayerPos(px, pz, 1);
    expect(isNodeEntryBlocked(ai, FIRST_NODE, undefined)).toBe(false);
  });

  it("passes when playerPos is null (no player active)", () => {
    const ai = makeAICar({ fromNode: ENTRY, toNode: ENTRY });
    updatePlayerPos(0, 0, -1);
    expect(isNodeEntryBlocked(ai, FIRST_NODE, undefined)).toBe(false);
  });

  it("passes at a turn node when the player has reversed far away on the previous leg", () => {
    // THE USER'S BUG: AI car is at a turn node (intersection). The player
    // was beside the AI car, then reversed far away on the previous leg.
    // The forward projection onto the NEW leg's direction is near zero
    // (the player moved perpendicular to the new leg), so the old code
    // kept the AI car frozen. The radial guard should clear this.
    //
    // AI car at J0_0_5 (an intersection), heading to J0_1_5 (turns +Z).
    // Player reversed to J0_0_1 — far away on the previous leg.
    const ai = makeAICar({ fromNode: "J0_0_5", toNode: "J0_0_5" });
    const [px, , pz] = toWorld(2.6, 0, 0); // J0_0_1 position
    updatePlayerPos(px, pz, 0);
    expect(isNodeEntryBlocked(ai, "J0_1_5", undefined)).toBe(false);
  });

  it("passes when the player is far from the AI car in any direction (radial guard)", () => {
    // AI car at E0 (0,0), heading to J0_0_1 (2.6, 0).
    // Player at (0, 20) — perpendicular to the leg, far away.
    // Forward ≈ 0, lateral is large, but radial distance is > CAR_LENGTH*2.
    const ai = makeAICar({ fromNode: ENTRY, toNode: ENTRY });
    const [px, , pz] = toWorld(0, 20, 0);
    updatePlayerPos(px, pz, 0);
    expect(isNodeEntryBlocked(ai, FIRST_NODE, undefined)).toBe(false);
  });

  it("blocks when the player is close beside the AI car at a turn node", () => {
    // AI car at J0_0_5 (intersection), heading to J0_1_5 (turns +Z).
    // Player at J0_0_5 — right at the intersection, same position.
    // This SHOULD block because the player is close enough to collide.
    const ai = makeAICar({ fromNode: "J0_0_5", toNode: "J0_0_5" });
    const [px, , pz] = toWorld(13, 0, 0); // J0_0_5 is at x=13
    updatePlayerPos(px, pz, 0);
    expect(isNodeEntryBlocked(ai, "J0_1_5", undefined)).toBe(true);
  });
});
