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
});
