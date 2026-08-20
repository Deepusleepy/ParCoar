import { describe, expect, it } from "vitest";
import lotJson from "../../../shared/lot.json?raw";
import type { LotData } from "../types";
import { buildRoadSegments } from "./roadSegments";

const lot = JSON.parse(lotJson) as LotData;

function endpointMatches(
  segment: ReturnType<typeof buildRoadSegments>[number],
  x: number,
  z: number,
): boolean {
  return (
    Math.hypot(segment.x1 - x, segment.z1 - z) < 1e-6 ||
    Math.hypot(segment.x2 - x, segment.z2 - z) < 1e-6
  );
}

describe("buildRoadSegments", () => {
  it("connects both junctions of every turn", () => {
    const segments = buildRoadSegments(lot);
    for (const [turnId, turn] of Object.entries(lot.nodes)) {
      if (turn.type !== "turn") continue;
      const junctions = (lot.edges[turnId] ?? [])
        .map((edge) => edge.to)
        .filter((id, index, all) =>
          lot.nodes[id]?.type === "junction" && all.indexOf(id) === index,
        );
      expect(junctions).toHaveLength(2);
      for (const junctionId of junctions) {
        const junction = lot.nodes[junctionId];
        expect(
          segments.some(
            (segment) =>
              segment.floor === turn.floor && endpointMatches(segment, junction.x, junction.y),
          ),
        ).toBe(true);
      }
    }
  });
});
