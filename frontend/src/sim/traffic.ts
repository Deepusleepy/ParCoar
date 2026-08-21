import type { ActiveCar, Direction, InstructionSign, LotData, LotEdge } from "../types";
import { resolvePath } from "./paths";
import {
  AISLE_SPACING,
  CAR_LENGTH,
  FLOOR_HEIGHT,
} from "./constants";

/*
 * Pure traffic rules for the simulated garage.
 *
 * Nothing here touches React or Three.js state that mutates per frame beyond
 * the leg-length cache below; every function answers one question about the
 * lot graph or the cars currently on it:
 *
 *   directionAt        - which way an edge between two route hops points
 *   legLength          - true driven length of one graph leg
 *   nodeGap            - straight-line gap between two nodes
 *   roadDirection      - which of the two lanes a leg belongs to
 *   carRoadDirection   - the lane a car is currently using (or about to use)
 *   isRoadBlocked      - may this car enter this segment yet?
 *   nextNodeForDirection - follow an edge label out of a node
 */

export function directionAt(lot: LotData, route: string[], hop: number): Direction {
  if (hop + 1 >= route.length) return "arrived";
  const edge = lot.edges[route[hop]]?.find((candidate) => candidate.to === route[hop + 1]);
  return edge?.dir ?? "arrived";
}

/** Real path length used only by the frontend's collision/queue safety gate. */
const legLengthCache = new Map<string, number>();
export function legLength(lot: LotData, fromId: string, toId: string): number {
  const key = `${fromId}>${toId}`;
  const cached = legLengthCache.get(key);
  if (cached !== undefined) return cached;
  const from = lot.nodes[fromId];
  const to = lot.nodes[toId];
  let length = 0;
  if (from && to) {
    const points = resolvePath(from, to, lot);
    for (let index = 1; index < points.length; index += 1) {
      length += points[index].distanceTo(points[index - 1]);
    }
  }
  if (!(length > 1e-6)) length = nodeGap(lot, fromId, toId);
  legLengthCache.set(key, length);
  return length;
}

export function nodeGap(lot: LotData, first: string, second: string): number {
  const a = lot.nodes[first];
  const b = lot.nodes[second];
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y, (a.floor - b.floor) * FLOOR_HEIGHT);
}

/**
 * Which of the two parallel lanes a leg belongs to: 1 for the leg's own
 * travel direction, -1 against it, null when the leg has no lane (slots).
 */
export function roadDirection(lot: LotData, fromId: string, toId: string): 1 | -1 | null {
  const from = lot.nodes[fromId];
  const to = lot.nodes[toId];
  if (!from || !to || fromId === toId || from.type === "slot" || to.type === "slot") {
    return null;
  }

  const turn = from.type === "turn" ? from : to.type === "turn" ? to : null;
  if (turn) {
    const other = from.type === "turn" ? to : from;
    const fromIsTurn = from.type === "turn";
    const otherIsNear = Math.abs(other.y - turn.y) < 0.01;
    return fromIsTurn === otherIsNear ? -1 : 1;
  }

  if (from.type === "ramp_up" && to.type === "ramp_in") return 1;
  if (from.type === "ramp_in" && to.type === "ramp_up") return -1;
  if (from.type === "ramp_up" || to.type === "ramp_up") return to.type === "ramp_up" ? 1 : -1;
  if (from.type === "ramp_in" || to.type === "ramp_in") return from.type === "ramp_in" ? 1 : -1;

  const dx = to.x - from.x;
  if (Math.abs(dx) > 0.01) {
    const aisle = Math.round(((from.y + to.y) / 2) / AISLE_SPACING);
    const originalDirection = aisle % 2 === 0 ? 1 : -1;
    return dx * originalDirection > 0 ? 1 : -1;
  }
  return to.floor > from.floor ? 1 : -1;
}

export function carRoadDirection(
  lot: LotData,
  car: ActiveCar,
  instructions: Map<string, InstructionSign>,
): 1 | -1 | null {
  let target = car.toNode;
  if (target === car.fromNode) {
    const instruction = instructions.get(car.id);
    target = instruction?.node === car.fromNode ? instruction.path[1] ?? target : target;
  }
  return roadDirection(lot, car.fromNode, target);
}

/**
 * Traffic safety only: stop a car entering a physically occupied lane segment.
 * This does not influence Python's bay selection or calculate alternate routes.
 */
export function isRoadBlocked(
  lot: LotData,
  cars: ActiveCar[],
  self: ActiveCar,
  node: string,
  beyond: string | undefined,
  instructions: Map<string, InstructionSign>,
): boolean {
  const direction = roadDirection(lot, self.fromNode, node);
  const blocks = (other: ActiveCar, target: string) => {
    if (other === self || other.parked) return false;
    if (other.fromNode !== target && other.toNode !== target) return false;
    if (lot.nodes[target]?.type === "slot") return true;

    if (other.fromNode === target && other.toNode !== target) {
      const length = legLength(lot, other.fromNode, other.toNode);
      if (other.progress * length > CAR_LENGTH * 1.5) return false;
    }

    if (other.toNode === target && other.fromNode !== target) {
      const length = legLength(lot, other.fromNode, other.toNode);
      if (other.fromNode === self.fromNode) {
        if (other.progress * length > CAR_LENGTH * 1.6) return false;
      } else if ((1 - other.progress) * length > CAR_LENGTH * 2) {
        return false;
      }
    }

    const otherDirection = carRoadDirection(lot, other, instructions);
    return direction === null || otherDirection === null || direction === otherDirection;
  };

  if (cars.some((other) => blocks(other, node))) return true;
  if (!beyond || lot.nodes[node]?.type === "slot" || nodeGap(lot, node, beyond) > CAR_LENGTH) {
    return false;
  }
  return cars.some((other) => blocks(other, beyond));
}

export function nextNodeForDirection(
  lot: LotData,
  fromNode: string,
  direction: LotEdge["dir"],
): string | null {
  return lot.edges[fromNode]?.find((edge) => edge.dir === direction)?.to ?? null;
}
