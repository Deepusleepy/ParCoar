import type { LotData, NodeType } from "../types";
import { AISLE_SPACING } from "./constants";
import { aisleOf, semicirclePoints } from "./geometry";

export interface RoadSegment {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  floor: number;
}

/** Centerlines used only to keep the manually driven car on the road. */
export function buildRoadSegments(lot: LotData): RoadSegment[] {
  const segments: RoadSegment[] = [];
  const aisles = new Map<string, { floor: number; y: number; xs: number[] }>();

  for (const [id, node] of Object.entries(lot.nodes)) {
    if (node.type !== "junction") continue;
    const aisle = aisleOf(id);
    if (aisle === null) continue;
    const key = `${node.floor}:${aisle}`;
    const value = aisles.get(key) ?? { floor: node.floor, y: node.y, xs: [] };
    value.xs.push(node.x);
    aisles.set(key, value);
  }

  const connections = new Set<NodeType>(["entry", "exit", "ramp_up", "ramp_in"]);
  for (const node of Object.values(lot.nodes)) {
    if (!connections.has(node.type)) continue;
    const aisle = Math.round(node.y / AISLE_SPACING);
    aisles.get(`${node.floor}:${aisle}`)?.xs.push(node.x);
  }

  for (const { floor, y, xs } of aisles.values()) {
    segments.push({
      x1: Math.min(...xs),
      z1: y,
      x2: Math.max(...xs),
      z2: y,
      floor,
    });
  }

  for (const [turnId, turn] of Object.entries(lot.nodes)) {
    if (turn.type !== "turn") continue;
    const neighbours = (lot.edges[turnId] ?? [])
      .map((edge) => edge.to)
      .filter((id, index, all) =>
        lot.nodes[id]?.type === "junction" && all.indexOf(id) === index,
      )
      .sort((first, second) => (aisleOf(first) ?? 0) - (aisleOf(second) ?? 0));
    if (neighbours.length !== 2) continue;

    const first = lot.nodes[neighbours[0]];
    const second = lot.nodes[neighbours[1]];
    const bulge = Math.sign(turn.x - first.x) || 1;
    const curve = semicirclePoints(turn.x, first.y, second.y, bulge, turn.floor);
    const points = [
      { x: first.x, z: first.y },
      { x: turn.x, z: first.y },
      ...curve.slice(1, -1).map((point) => ({ x: point.x, z: point.z })),
      { x: turn.x, z: second.y },
      { x: second.x, z: second.y },
    ];
    for (let index = 0; index < points.length - 1; index += 1) {
      segments.push({
        x1: points[index].x,
        z1: points[index].z,
        x2: points[index + 1].x,
        z2: points[index + 1].z,
        floor: turn.floor,
      });
    }
  }

  return segments;
}
