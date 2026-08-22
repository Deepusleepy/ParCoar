import type { CarColor, CarSize, LotData } from "../types";
import { AISLE_SPACING, randomColor, randomPlate, randomSize } from "./constants";

/*
 * Deterministic pre-parked fill for the garage.
 *
 * Which bays are filled is a pure function of the fill preset and the lot
 * graph (a Knuth-multiplicative hash over the sorted bay order), so every
 * reload with the same preset produces the same garage. Colours, plates and
 * sizes stay random per call.
 */

export type GarageFill = "quiet" | "normal" | "busy";

export interface ParkedCarData {
  key: string;
  slotNode: string;
  color: CarColor;
  plate: string;
  /** Visual model only. It is not sent to Python or used for assignment. */
  size: CarSize;
  parkedAt?: number;
  stayMs?: number;
}

const FILL_PRESETS: Record<GarageFill, Record<number, [number, number]>> = {
  quiet: {
    0: [0.7, 0.3],
    1: [0.5, 0.08],
    2: [0.3, 0.02],
  },
  normal: {
    0: [0.995, 0.93],
    1: [0.98, 0.3],
    2: [0.75, 0.05],
  },
  busy: {
    0: [0.999, 0.985],
    1: [0.995, 0.82],
    2: [0.95, 0.4],
  },
};
const DEFAULT_FILL: [number, number] = [0.8, 0.1];

export function generatePreParked(lot: LotData, fillLevel: GarageFill = "normal"): ParkedCarData[] {
  const slots = Object.entries(lot.nodes)
    .filter(([, node]) => node.type === "slot")
    .sort(([, a], [, b]) => {
      if (a.floor !== b.floor) return a.floor - b.floor;
      const aisleA = Math.round(a.y / AISLE_SPACING);
      const aisleB = Math.round(b.y / AISLE_SPACING);
      if (aisleA !== aisleB) return aisleA - aisleB;
      const travel = aisleA % 2 === 0 ? 1 : -1;
      if (a.x !== b.x) return (a.x - b.x) * travel;
      return a.y - b.y;
    });

  const rankInFloor = new Map<string, number>();
  const totals = new Map<number, number>();
  for (const [id, node] of slots) {
    const rank = totals.get(node.floor) ?? 0;
    rankInFloor.set(id, rank);
    totals.set(node.floor, rank + 1);
  }

  const cars: ParkedCarData[] = [];
  for (let index = 0; index < slots.length; index += 1) {
    const [id, node] = slots[index];
    const total = totals.get(node.floor) ?? 1;
    const depth = total > 1 ? (rankInFloor.get(id) ?? 0) / (total - 1) : 0;
    const [start, end] = FILL_PRESETS[fillLevel][node.floor] ?? DEFAULT_FILL;
    const fill = start + (end - start) * depth;
    const noise = ((index * 2654435761) >>> 0) / 4294967296;
    if (noise >= fill) continue;
    cars.push({
      key: `pre-${id}`,
      slotNode: id,
      color: randomColor(),
      plate: randomPlate(),
      size: randomSize(),
    });
  }
  return cars;
}
