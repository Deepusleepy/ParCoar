import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActiveCar,
  Direction,
  CarColor,
  BoardCar,
  CarRoute,
  InstructionSign,
  InstructionsMessage,
  LotData,
  LotEdge,
  NodeSign,
  ServerMessage,
  StateMessage,
} from "../types";
import { resolvePath } from "../sim/paths";
import {
  AISLE_SPACING,
  CAR_LENGTH,
  FLOOR_HEIGHT,
  MAX_ACTIVE_CARS,
  nextCarId,
  randomColor,
  randomPlate,
  randomSize,
  SPAWN_INTERVAL_MS,
  STATE_TICK_MS,
  TARGET_ACTIVE_CARS,
} from "../sim/constants";

const WS_URL = "ws://127.0.0.1:8765";
const ENTRY_NODE = "E0";
const RECONNECT_DELAY_MS = 2000;

/** How long a car that drove in stays parked before heading for the exit.
 *  Randomised per car so departures do not arrive in lockstep. A car leaving
 *  the ground floor can still spend about a minute and a half reaching the top
 *  exit. */
const MIN_STAY_MS = 30_000;
/** How many cars one signboard lists: one in the hero block plus two queued.
 *  Sampled over four minutes, a board had one car 80% of the time, two 19%,
 *  three 0.7% and four never, so a fourth row was only ever wasted height. */
const BOARD_ROWS = 3;

/* How full each storey starts, from its own entrance to its far end.
 *
 * This used to be a flat 50% across the whole garage, which quietly killed
 * the point of the product. The backend routes a car to its NEAREST free
 * bay, so with one bay in two free right at the entrance every car parked
 * within seconds of arriving. Measured: 18 of 26 cars had a route that never
 * passed a single guidance board, and six of the eleven boards were lit less
 * than 2% of the time. Cars drove past dark signs, which is exactly what
 * Deepu was seeing.
 *
 * A real garage is full near the door and empty at the back, and that is the
 * condition that makes guidance worth having at all. The gradient is
 * per-STOREY, not global: a car that comes up the ramp arrives at the far
 * end of the building but at the START of that floor's own run of bays, so a
 * single garage-wide gradient left every upper floor empty right where cars
 * entered it and no upstairs board ever lit.
 *
 * Ground floor is close to full so arrivals are pushed upstairs; each floor
 * above starts fuller than it ends, so a car still has to drive its length.
 * None of this touches the search, which stays a plain outward sweep to the
 * nearest free bay: that is the part Deepu has to explain. */
const FLOOR_FILL: Record<number, [start: number, end: number]> = {
  0: [0.995, 0.93],
  1: [0.98, 0.30],
  2: [0.75, 0.05],
};
/** Fallback for any storey not listed above. */
const DEFAULT_FILL: [number, number] = [0.8, 0.1];
/** How many cars may be driving to the exit at once. */
const MAX_LEAVING_CARS = 2;
const MAX_STAY_MS = 90_000;

export interface ParkedCarData {
  key: string;
  slotNode: string;
  color: CarColor;
  plate: string;
  size: "small" | "medium" | "large";
  /** When this car parked (ms). Cars that drove in leave again after a while
   *  so the garage reaches a steady state instead of filling up and jamming.
   *  Undefined for the pre-parked decoration, which never leaves. */
  parkedAt?: number;
  /** How long this car stays, in ms. Randomised so departures are staggered. */
  stayMs?: number;
}

export interface SimulationState {
  lot: LotData | null;
  loading: boolean;
  connected: boolean;
  activeCars: ActiveCar[];
  preParked: ParkedCarData[];
  parked: ParkedCarData[];
  lotFull: boolean;
  nodeSigns: NodeSign[];
  carRoutes: CarRoute[];
  onArrive: (carId: string, node: string) => void;
}

/** The direction label on the edge the route takes out of `route[hop]`.
 *  Mirrors the backend's direction_along: a board shows the turn a driver
 *  must make when they get there, not where the car happens to be now. */
function directionAt(lot: LotData, route: string[], hop: number): Direction {
  if (hop + 1 >= route.length) return "arrived";
  const edge = lot.edges[route[hop]]?.find((e) => e.to === route[hop + 1]);
  return edge ? edge.dir : "arrived";
}

/** Real driven length of one leg, in world units, memoised per node pair.
 *
 *  Straight-line distance badly understates a curved leg: a 180-degree turn
 *  loop measures 17.2 point to point but is about 32 units of road, and the
 *  ramp measures 53 against 83 driven. The queueing maths below is all in
 *  "how far apart are these two cars", so it has to use the distance the car
 *  actually drives or it holds cars back for seconds at every turn. */
const legLengthCache = new Map<string, number>();
function legLength(lot: LotData, fromId: string, toId: string): number {
  const key = `${fromId}>${toId}`;
  const cached = legLengthCache.get(key);
  if (cached !== undefined) return cached;
  const a = lot.nodes[fromId];
  const b = lot.nodes[toId];
  let len = 0;
  if (a && b) {
    const pts = resolvePath(a, b, lot);
    for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
  }
  if (!(len > 1e-6)) len = nodeGap(lot, fromId, toId);
  legLengthCache.set(key, len);
  return len;
}

/** Straight-line distance between two graph nodes, in world units. */
function nodeGap(lot: LotData, a: string, b: string): number {
  const A = lot.nodes[a];
  const B = lot.nodes[b];
  if (!A || !B) return Infinity;
  return Math.hypot(A.x - B.x, A.y - B.y, (A.floor - B.floor) * FLOOR_HEIGHT);
}

/** Which way this road leg runs relative to the original serpentine spine. */
function roadDirection(lot: LotData, fromId: string, toId: string): 1 | -1 | null {
  const from = lot.nodes[fromId];
  const to = lot.nodes[toId];
  if (!from || !to || fromId === toId || from.type === "slot" || to.type === "slot") return null;

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
    const originalX = aisle % 2 === 0 ? 1 : -1;
    return dx * originalX > 0 ? 1 : -1;
  }
  return to.floor > from.floor ? 1 : -1;
}

/** Direction of a moving car, or its next instructed leg while it waits. */
function carRoadDirection(
  lot: LotData,
  car: ActiveCar,
  instructions: Map<string, InstructionSign>,
): 1 | -1 | null {
  let target = car.toNode;
  if (target === car.fromNode) {
    const sign = instructions.get(car.id);
    target = sign?.node === car.fromNode ? sign.path?.[1] ?? target : target;
  }
  return roadDirection(lot, car.fromNode, target);
}

/** Is a road node held by same-direction traffic, or followed too closely?
 *
 * Cars in opposing lanes share graph nodes but are 3.5 units apart in the
 * scene, so they must not reserve against each other. Same-direction cars do
 * share a physical lane and still reserve the target plus one short node of
 * look-ahead. Bay nodes remain exclusive because there is only one bay. */
function isNodeBusy(
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
    // A car that has already LEFT `target` only blocks it until its tail is
    // clear. Reserving the whole leg is right for a 2.6-unit aisle hop, where
    // the car is still overhanging the node it left, and wrong for the ramp,
    // which is a single leg tens of units long: a car at the ramp foot sat
    // motionless for thirteen seconds waiting for the car ahead to reach the
    // floor above. nodeGap is straight-line and so understates the ramp's
    // real path length, which only makes this more conservative.
    if (other.fromNode === target && other.toNode !== target) {
      const len = legLength(lot, other.fromNode, other.toNode);
      if (other.progress * len > CAR_LENGTH * 1.5) return false;
    }
    // The mirror of the same idea, and the one that produced the jam Deepu
    // could see: a car heading TOWARD `target` held it for the whole leg. On
    // a 2.6-unit aisle hop that is a third of a second and correct. On the
    // ramp, which is one leg 53 units end to end, a car entering it reserved
    // the node at the TOP for the whole twelve-second climb, so every car
    // behind stopped dead at the ramp foot — which is exactly where the RAMP
    // UP board hangs. Same on a turn loop, which is one 17-unit leg.
    //
    // A car now only holds the node it is heading for once it is genuinely
    // about to arrive. Two car lengths is far enough out that it still owns
    // the node before anyone else can reach it, and on every aisle hop the
    // leg is shorter than that, so short-range behaviour is unchanged.
    if (other.toNode === target && other.fromNode !== target) {
      const len = legLength(lot, other.fromNode, other.toNode);
      if (other.fromNode === self.fromNode) {
        // The other car is on the very leg we are about to start, ahead of
        // us. What matters then is the gap BETWEEN us, which is how far it
        // has already driven — not how far it still has to go.
        //
        // Measuring how far it had left to go is what made a car sit at the
        // mouth of every 180-degree turn for two to three seconds: the car
        // ahead had to get roughly half way round the loop before the one
        // behind was let on, even though the loop is 32 units of road and
        // comfortably holds two cars. Deepu watched a car stop dead under a
        // turn board with nothing in front of it but clear tarmac.
        if (other.progress * len > CAR_LENGTH * 1.6) return false;
      } else if ((1 - other.progress) * len > CAR_LENGTH * 2) {
        // Converging on the node from a different leg, and still far enough
        // off that it has no claim on it yet.
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

/** Find the destination node for a direction from a given node. */
function nextNodeForDirection(
  lot: LotData,
  fromNode: string,
  dir: LotEdge["dir"],
): string | null {
  const edges = lot.edges[fromNode];
  if (!edges) return null;
  const edge = edges.find((e) => e.dir === dir);
  return edge ? edge.to : null;
}

/** Generate the static pre-parked cars (~50% of slots, size-matched).
 *  Uses a deterministic slot pattern (every other slot) so the set of
 *  occupied positions is stable across reloads. Colors and plates are
 *  random for visual variety. When the backend assigns a slot to an active
 *  car, we remove any pre-parked car from that slot to avoid overlap. */
function generatePreParked(lot: LotData): ParkedCarData[] {
  // Order every bay the way a driver actually meets it: floor by floor, aisle
  // by aisle along the spine, and along each aisle in its travel direction.
  // Position in this list is how deep into the garage a bay is.
  const slots = Object.entries(lot.nodes)
    .filter(([, n]) => n.type === "slot" && n.size)
    .sort(([, a], [, b]) => {
      if (a.floor !== b.floor) return a.floor - b.floor;
      const aisleA = Math.round(a.y / AISLE_SPACING);
      const aisleB = Math.round(b.y / AISLE_SPACING);
      if (aisleA !== aisleB) return aisleA - aisleB;
      const travel = aisleA % 2 === 0 ? 1 : -1;
      if (a.x !== b.x) return (a.x - b.x) * travel;
      return a.y - b.y;
    });

  // Rank each bay within its own storey, so "depth" means how far into that
  // floor's run of bays it is, counted from where cars enter that floor.
  const rankInFloor = new Map<string, number>();
  const floorTotals = new Map<number, number>();
  for (const [id, node] of slots) {
    const n = floorTotals.get(node.floor) ?? 0;
    rankInFloor.set(id, n);
    floorTotals.set(node.floor, n + 1);
  }

  const out: ParkedCarData[] = [];
  for (let i = 0; i < slots.length; i++) {
    const [id, node] = slots[i];
    const total = floorTotals.get(node.floor) ?? 1;
    const depth = total > 1 ? (rankInFloor.get(id) ?? 0) / (total - 1) : 0;
    const [start, end] = FLOOR_FILL[node.floor] ?? DEFAULT_FILL;
    const fill = start + (end - start) * depth;
    // Deterministic hash on the bay's rank, so the same bays are taken on
    // every reload and the garage does not reshuffle itself mid-demo.
    const noise = ((i * 2654435761) >>> 0) / 4294967296;
    if (noise >= fill) continue;
    out.push({
      key: `pre-${id}`,
      slotNode: id,
      color: randomColor(),
      plate: randomPlate(),
      size: node.size!,
    });
  }
  return out;
}

/** Create a fresh active car at the entry node. */
function spawnCar(): ActiveCar {
  return {
    id: nextCarId(),
    color: randomColor(),
    plate: randomPlate(),
    size: randomSize(),
    fromNode: ENTRY_NODE,
    toNode: ENTRY_NODE,
    progress: 0,
    slot: null,
    status: "routing",
    parked: false,
    leaving: false,
    vacating: null,
  };
}

/** Put a parked car back on the road, heading for the exit.
 *  It gets a fresh id so the backend treats it as a new arrival with a new
 *  destination, rather than a parked car that mysteriously started moving. */
function departCar(p: ParkedCarData, size: ActiveCar["size"]): ActiveCar {
  return {
    id: nextCarId(),
    color: p.color,
    plate: p.plate,
    size,
    fromNode: p.slotNode,
    toNode: p.slotNode,
    progress: 0,
    slot: null,
    status: "routing",
    parked: false,
    leaving: true,
    vacating: p.slotNode,
  };
}

export function useSimulation(): SimulationState {

  const [lot, setLot] = useState<LotData | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [activeCars, setActiveCars] = useState<ActiveCar[]>([]);
  const [preParked, setPreParked] = useState<ParkedCarData[]>([]);
  const [parked, setParked] = useState<ParkedCarData[]>([]);
  const [lotFull, setLotFull] = useState(false);
  const [nodeSigns, setNodeSigns] = useState<NodeSign[]>([]);
  const [carRoutes, setCarRoutes] = useState<CarRoute[]>([]);

  // Refs for values needed inside stable callbacks / intervals.
  const activeCarsRef = useRef<ActiveCar[]>([]);
  const lotRef = useRef<LotData | null>(null);
  const preParkedRef = useRef<ParkedCarData[]>([]);
  const parkedRef = useRef<ParkedCarData[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const latestInstructionsRef = useRef<Map<string, InstructionSign>>(new Map());
  const lastSpawnRef = useRef(0);
  // Signature of the last nodeSigns array we committed to state, so we
  // only call setNodeSigns when the set of active signs actually changes.
  const lastSignSigRef = useRef("");
  /** Latest board queues, for the DEV-only inspection handle below. */
  const nodeSignsRef = useRef<NodeSign[]>([]);
  const lastRouteSigRef = useRef("");
  // Pending no_slot removal timers; cleared on unmount so a teardown
  // mid-grace-period doesn't fire setActiveCars after the hook is gone.
  const noSlotTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  activeCarsRef.current = activeCars;
  lotRef.current = lot;
  preParkedRef.current = preParked;
  parkedRef.current = parked;

  // --- Load lot.json ---
  useEffect(() => {
    let cancelled = false;
    fetch("/lot.json")
      .then((r) => r.json() as Promise<LotData>)
      .then((data) => {
        if (cancelled) return;
        setLot(data);
        setPreParked(generatePreParked(data));
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load lot.json", err);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Clear pending no_slot timers on unmount ---
  useEffect(() => {
    return () => {
      noSlotTimersRef.current.forEach(clearTimeout);
      noSlotTimersRef.current.clear();
    };
  }, []);

  // --- Send state to backend ---
  const sendState = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const cars = activeCarsRef.current
      .filter((c) => !c.parked)
      .map((c) => ({
        id: c.id,
        color: c.color,
        plate: c.plate,
        size: c.size,
        node: c.fromNode,
        leaving: c.leaving,
      }));
    // Tell the backend which slots already have a car so it never
    // assigns an occupied slot to an active car. This covers pre-parked
    // and parked cars, plus the slots active routing cars are heading
    // toward — closing the gap where a just-parked car's slot briefly
    // leaves routing_claimed before it appears in the frontend parked list.
    const occupiedSlots = new Set<string>();
    for (const p of preParkedRef.current) occupiedSlots.add(p.slotNode);
    for (const p of parkedRef.current) occupiedSlots.add(p.slotNode);
    // Also include slots that active routing cars are heading toward.
    for (const c of activeCarsRef.current) {
      if (c.slot && !c.leaving) occupiedSlots.add(c.slot);
      // A departing car still blocks its bay until it has physically pulled
      // out of it. Releasing it on the first tick let an arriving car be sent
      // straight into an occupied bay.
      if (c.vacating && c.fromNode === c.vacating) occupiedSlots.add(c.vacating);
    }
    const msg: StateMessage = {
      type: "state",
      cars,
      occupied_slots: [...occupiedSlots],
    };
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* ignore send errors */
    }
  }, []);

  // --- Apply instructions to stationary cars ---
  const applyInstructions = useCallback(
    (signs: InstructionSign[]) => {
      const lotData = lotRef.current;
      if (!lotData) return;

      // Store latest instruction per car.
      const map = latestInstructionsRef.current;
      for (const sign of signs) {
        map.set(sign.car_id, sign);
      }

      // Apply to cars that are stationary at the instructed node.
      let changed = false;
      const cars = activeCarsRef.current;
      const parkedThisCall: ActiveCar[] = [];
      const departedThisCall: string[] = [];
      for (const car of cars) {
        if (car.parked) continue;
        const sign = map.get(car.id);
        if (!sign) continue;
        // Only act when the car is waiting at the sign's node.
        if (sign.node !== car.fromNode || car.toNode !== car.fromNode) continue;

        if (sign.status === "no_slot") {
          if (car.status === "no_slot") continue; // already scheduled, don't re-schedule
          car.status = "no_slot";
          const t = setTimeout(() => {
            noSlotTimersRef.current.delete(t);
            setActiveCars((prev) => {
              const c = prev.find((x) => x.id === car.id);
              if (!c || c.status !== "no_slot") return prev; // recovered or gone
              latestInstructionsRef.current.delete(car.id);
              return prev.filter((x) => x.id !== car.id);
            });
          }, 3000);
          noSlotTimersRef.current.add(t);
          changed = true;
          continue;
        }

        if (sign.status === "left") {
          // Reached the exit. Drop it from the simulation entirely.
          car.status = "left";
          departedThisCall.push(car.id);
          changed = true;
          continue;
        }

        if (sign.status === "parked" || sign.direction === "arrived") {
          // Car has reached its assigned slot.
          car.status = "parked";
          car.parked = true;
          car.slot = sign.slot;
          parkedThisCall.push(car);
          changed = true;
          continue;
        }

        // The direction label is no longer unique on a two-way road: both
        // neighbours are "straight". Use the explicit BFS route, with the old
        // direction lookup only as a fallback for older backend messages.
        const routeIsCurrent = sign.path?.[0] === car.fromNode;
        const next = routeIsCurrent
          ? sign.path?.[1] ?? null
          : nextNodeForDirection(lotData, car.fromNode, sign.direction);
        const beyond = routeIsCurrent && sign.path?.[1] === next ? sign.path?.[2] : undefined;

        if (next && isNodeBusy(lotData, cars, car, next, beyond, map)) continue;

        if (next && next !== car.toNode) {
          car.toNode = next;
          car.status = "routing";
          car.slot = sign.slot;
          changed = true;
        }
      }

      if (changed) {
        // Collect slots that active cars are heading to (routing or parked).
        const claimedSlots = new Set(
          cars
            .filter((c) => c.slot)
            .map((c) => c.slot as string),
        );
        // Remove any pre-parked cars in those slots to avoid visual overlap.
        if (claimedSlots.size > 0) {
          setPreParked((prev) =>
            prev.filter((p) => !claimedSlots.has(p.slotNode)),
          );
        }

        // Migrate parked cars into the static parked list, then drop them
        // from the active set. Both setStates are top-level (no nesting).
        const now = Date.now();
        const newlyParked = parkedThisCall.map((c) => ({
          key: `parked-${c.id}`,
          slotNode: c.slot || c.fromNode,
          color: c.color,
          plate: c.plate,
          size: c.size,
          parkedAt: now,
          stayMs: MIN_STAY_MS + Math.random() * (MAX_STAY_MS - MIN_STAY_MS),
        }));
        if (newlyParked.length > 0) {
          // Replace any existing entries at the same slot (cleans up stale
          // duplicates from pre-fix double-assignments) and dedupe the
          // existing list, then append new arrivals that don't collide.
          setParked((p) => {
            const bySlot = new Map<string, (typeof p)[number]>();
            for (const x of p) bySlot.set(x.slotNode, x);
            for (const c of newlyParked) bySlot.set(c.slotNode, c);
            return [...bySlot.values()];
          });
        }
        const gone = new Set(departedThisCall);
        setActiveCars((prev) =>
          prev.some((c) => c.parked || gone.has(c.id))
            ? prev.filter((c) => !c.parked && !gone.has(c.id))
            : prev,
        );
      }

      // Prune instructions for cars no longer in activeCars.
      const activeIds = new Set(cars.map((c) => c.id));
      for (const key of latestInstructionsRef.current.keys()) {
        if (!activeIds.has(key)) latestInstructionsRef.current.delete(key);
      }

      // --- Compute what each permanent signboard shows ---
      //
      // A board exists at every turn and at the foot of every ramp. It shows
      // a QUEUE, not a single car: a driver three cars back needs to know
      // their own instruction, not watch the board talk to somebody else.
      // The nearest car is the one being instructed now; the rest are told
      // what is coming. As the leader passes the node it drops off its route
      // and the next car becomes the leader on its own.
      //
      // Each car appears on exactly ONE board: the FIRST one on its route.
      // That is the board it can actually see from the lane it is in, and it
      // lights the moment the car enters that lane rather than when it
      // arrives. Listing a car on every board along its whole route lit up
      // signs two floors ahead for a car a minute away.
      const queues = new Map<string, BoardCar[]>();
      for (const car of cars) {
        if (car.parked || car.status === "no_slot") continue;
        const sign = map.get(car.id);
        if (!sign) continue;
        const route = sign.path ?? [sign.node];
        // The backend's route BEGINS at the node the car is standing on, or
        // has just left. Counting that node as an upcoming board was the bug
        // behind "cars are passing but the board isn't working": a car that
        // had already driven under a turn board and was going round the loop
        // still had that board as hop 0 at distance 0, so the board kept it in
        // the big hero block, reading NOW, for the whole 4.5-second traversal
        // — while the car actually approaching was demoted to a small grey
        // row. Measured, every single "NOW" on a board was a car that had
        // already gone past it.
        //
        // So once a car is driving away from route[0], that node is behind it
        // and the first board it can still reach is route[1] onward.
        const movingOff = route.length > 1 && car.fromNode === route[0] && car.toNode === route[1];
        const startHop = movingOff ? 1 : 0;
        // How much of that first leg is left, so the distance shown counts
        // from where the car actually is rather than from the node behind it.
        let travelled = movingOff
          ? (1 - car.progress) * nodeGap(lotData, route[0], route[1])
          : 0;
        for (let hop = startHop; hop < route.length; hop++) {
          if (hop > startHop) travelled += nodeGap(lotData, route[hop - 1], route[hop]);
          const node = lotData.nodes[route[hop]];
          if (!node || (node.type !== "turn" && node.type !== "ramp_up")) continue;
          const queue = queues.get(route[hop]) ?? [];
          queue.push({
            carId: car.id,
            color: sign.color,
            plate: sign.plate,
            // The move to make AT that board, not the car's current one.
            direction: directionAt(lotData, route, hop),
            slot: sign.slot ?? "",
            leaving: !!car.leaving,
            distance: travelled,
          });
          queues.set(route[hop], queue);
          break;
        }
      }
      const nodeSignList: NodeSign[] = [...queues].map(([nodeId, queue]) => ({
        nodeId,
        floor: lotData.nodes[nodeId]?.floor ?? 0,
        cars: queue.sort((a, b) => a.distance - b.distance).slice(0, BOARD_ROWS),
      }));

      // Only push to React state when what the boards actually display has
      // changed, so a 5 Hz tick does not re-render 11 signboards every time.
      // Distance is quantised because it changes continuously and would
      // otherwise defeat the comparison entirely.
      const sig = nodeSignList
        .map(
          (n) =>
            n.nodeId +
            ":" +
            n.cars
              .map((c) => `${c.plate}|${c.direction}|${c.slot}|${Math.round(c.distance)}`)
              .join(","),
        )
        .join("|");
      nodeSignsRef.current = nodeSignList;
      if (sig !== lastSignSigRef.current) {
        lastSignSigRef.current = sig;
        setNodeSigns(nodeSignList);
      }
      // --- Routes for the 2D route panel ---
      // Same instruction data the boards use, surfaced so the panel can draw
      // the search result the backend produced. Gated on a signature so a
      // 5 Hz tick does not redraw the schematic when nothing has moved.
      const routes: CarRoute[] = [];
      for (const car of cars) {
        if (car.parked) continue;
        const sign = map.get(car.id);
        if (!sign) continue;
        // A one-node path is a car sitting on its destination; there is no
        // route to draw, and selecting it left the panel showing "0 hops".
        if (!sign.path || sign.path.length < 2) continue;
        routes.push({
          carId: car.id,
          plate: sign.plate,
          color: sign.color,
          slot: sign.slot ?? null,
          path: sign.path ?? [],
          floor: lotData.nodes[sign.node]?.floor ?? 0,
        });
      }
      const routeSig = routes.map((r) => `${r.carId}:${r.path[0]}:${r.path.length}`).join("|");
      if (routeSig !== lastRouteSigRef.current) {
        lastRouteSigRef.current = routeSig;
        setCarRoutes(routes);
      }

    },
    [],
  );

  // --- Dev-only: publish sim state so an automated pass can see what a car
  //     believes it is doing, rather than inferring it from pixels. ---
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const id = setInterval(() => {
      (window as unknown as Record<string, unknown>).__parcoarSim = {
        cars: activeCarsRef.current.map((c) => ({
          id: c.id,
          from: c.fromNode,
          to: c.toNode,
          slot: c.slot,
          status: c.status,
          leaving: c.leaving,
          parked: c.parked,
        })),
        signs: [...latestInstructionsRef.current.entries()].map(([k, v]) => ({
          id: k,
          node: v.node,
          dir: v.direction,
          slot: v.slot,
          status: v.status,
          hops: v.path?.length ?? 0,
          path: v.path ?? [],
        })),
        boards: nodeSignsRef.current,
        parked: parkedRef.current.length,
      };
    }, 500);
    return () => clearInterval(id);
  }, []);

  // --- WebSocket connection with auto-reconnect ---
  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(WS_URL);
      } catch {
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setLotFull(false);
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as ServerMessage;
          if (msg.type === "instructions") {
            const signs = (msg as InstructionsMessage).signs ?? [];
            const anyNoSlot = signs.some((s) => s.status === "no_slot");
            setLotFull(anyNoSlot);
            applyInstructions(signs);
          }
        } catch {
          /* ignore malformed messages */
        }
      };

      ws.onclose = () => {
        // Only clear state if this is still the active connection.
        // In React StrictMode, the first effect's WS may close after
        // the second effect has already created a new one.
        if (wsRef.current === ws) {
          setConnected(false);
          setLotFull(false);
          wsRef.current = null;
        }
        if (!disposed) {
          reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };

      ws.onerror = () => {
        // onclose will handle reconnect.
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    };
  }, [applyInstructions]);

  // --- State tick (~200ms) ---
  useEffect(() => {
    const id = setInterval(sendState, STATE_TICK_MS);
    return () => clearInterval(id);
  }, [sendState]);

  // --- Car arrival handler (called from Car useFrame) ---
  const onArrive = useCallback(
    (_carId: string, _node: string) => {
      // The Car component already updated car.fromNode. Send state promptly
      // so the backend responds with the next direction without waiting.
      sendState();
    },
    [sendState],
  );

  // --- Spawning: maintain 4-6 active cars ---
  useEffect(() => {
    if (!lot) return;
    const id = setInterval(() => {
      const now = Date.now();
      // Count arrivals only. A departing car occupies the road for a good 90
      // seconds on its way to the top exit, and if it counted toward the cap
      // a busy garage would stop admitting anyone.
      const count = activeCarsRef.current.filter((c) => !c.leaving).length;
      // Don't spawn if a car is still sitting at the entry node (fromNode === toNode === E0).
      const entryBlocked = activeCarsRef.current.some(
        (c) => c.fromNode === ENTRY_NODE && c.toNode === ENTRY_NODE,
      );
      if (count < TARGET_ACTIVE_CARS && !entryBlocked && now - lastSpawnRef.current > SPAWN_INTERVAL_MS) {
        const car = spawnCar();
        setActiveCars((prev) =>
          prev.filter((c) => !c.leaving).length >= MAX_ACTIVE_CARS
            ? prev
            : [...prev, car],
        );
        lastSpawnRef.current = now;
      }
    }, 400);
    return () => clearInterval(id);
  }, [lot]);

  // --- Departures: parked cars leave again after their stay ---
  // Only cars that actually drove in are eligible; the pre-parked decoration
  // has no parkedAt and stays put. Without this the garage fills to capacity
  // and then sits on LOT FULL forever, which is what it used to do.
  useEffect(() => {
    if (!lot) return;
    const id = setInterval(() => {
      // Leaving a ground-floor bay can still mean about 250 hops and a minute
      // and a half of road time. Without a cap on how many do that at once, they
      // accumulate: a soak run peaked at 34 cars on the road against an
      // arrivals cap of 6.
      const leaving = activeCarsRef.current.filter((c) => c.leaving).length;
      if (leaving >= MAX_LEAVING_CARS) return;

      const now = Date.now();
      const due = parkedRef.current.find(
        (p) => p.parkedAt !== undefined && now - p.parkedAt > p.stayMs!,
      );
      if (!due) return;
      const size = lotRef.current?.nodes[due.slotNode]?.size ?? "medium";
      setParked((prev) => prev.filter((p) => p.key !== due.key));
      setActiveCars((prev) => [...prev, departCar(due, size)]);
    }, 2000);
    return () => clearInterval(id);
  }, [lot]);

  // --- Seed initial cars once the lot is loaded ---
  useEffect(() => {
    if (!lot || activeCars.length > 0) return;
    const initial = [spawnCar()];
    setActiveCars(initial);
    // Set lastSpawnRef so the interval spawner doesn't fire a 2nd car immediately.
    lastSpawnRef.current = Date.now();
  }, [lot, activeCars.length]);

  return {
    lot,
    loading,
    connected,
    activeCars,
    preParked,
    parked,
    lotFull,
    nodeSigns,
    carRoutes,
    onArrive,
  };
}
