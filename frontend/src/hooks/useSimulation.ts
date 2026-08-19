import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActiveCar,
  Direction,
  CarColor,
  CarRosterEntry,
  CarRoute,
  InstructionSign,
  InstructionsMessage,
  LotData,
  LotEdge,
  NodeSign,
  ServerMessage,
  StateMessage,
} from "../types";
import {
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
 *  Randomised per car so departures do not arrive in lockstep. The garage is
 *  one-way, so a car leaving the ground floor drives the whole spiral to the
 *  top exit, which takes about a minute and a half. */
const MIN_STAY_MS = 30_000;
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
  carRoster: CarRosterEntry[];
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

/** Straight-line distance between two graph nodes, in world units. */
function nodeGap(lot: LotData, a: string, b: string): number {
  const A = lot.nodes[a];
  const B = lot.nodes[b];
  if (!A || !B) return Infinity;
  return Math.hypot(A.x - B.x, A.y - B.y, (A.floor - B.floor) * FLOOR_HEIGHT);
}

/** Is `node` held by another moving car, or too tightly followed by one?
 *
 *  A car is 4.5 long but junctions are only 2.6 apart, so one node of
 *  reservation is not enough separation down an aisle: a car occupies its own
 *  node and overhangs the previous one. So we also refuse to enter a node
 *  whose immediate successor is occupied.
 *
 *  That look-ahead must be conditional, which the first version got wrong in
 *  two ways that between them jammed the whole garage:
 *
 *   - The successor of a BAY is the junction the car is currently standing on,
 *     so any car merely approaching that junction stopped this one from
 *     parking. Bays are dead ends; nothing follows them. Skip the check.
 *   - Legs are not all the same length. The ramp is 53 units end to end, so a
 *     car at the foot of it was being blocked by a car a whole floor above, at
 *     a node it would not reach for eleven seconds. That is what left cars
 *     stuck at the joint between the ramp and the floor. Only look ahead when
 *     the next two nodes are genuinely within a car length of each other. */
function isNodeBusy(
  lot: LotData,
  cars: ActiveCar[],
  self: ActiveCar,
  node: string,
): boolean {
  for (const other of cars) {
    if (other === self || other.parked) continue;
    if (other.fromNode === node || other.toNode === node) return true;
  }
  if (lot.nodes[node]?.type === "slot") return false;
  const beyond = lot.edges[node]?.find((e) => e.dir === "straight" || e.dir === "up")?.to;
  if (!beyond || nodeGap(lot, node, beyond) > CAR_LENGTH) return false;
  for (const other of cars) {
    if (other === self || other.parked) continue;
    if (other.fromNode === beyond || other.toNode === beyond) return true;
  }
  return false;
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
  const slots = Object.entries(lot.nodes)
    .filter(([, n]) => n.type === "slot" && n.size)
    .sort(([, a], [, b]) => {
      if (a.floor !== b.floor) return a.floor - b.floor;
      if (a.y !== b.y) return a.y - b.y;
      return a.x - b.x;
    });
  const out: ParkedCarData[] = [];
  for (let i = 0; i < slots.length; i++) {
    if (i % 2 === 0) {
      const [id, node] = slots[i];
      out.push({
        key: `pre-${id}`,
        slotNode: id,
        color: randomColor(),
        plate: randomPlate(),
        size: node.size!,
      });
    }
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
  const [carRoster, setCarRoster] = useState<CarRosterEntry[]>([]);
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
  // Signature of the last carRoster array we committed to state, so we
  // only call setCarRoster when the set of active cars actually changes.
  const lastRosterSigRef = useRef("");
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

        // Routing: move toward the next node for this direction.
        const next = nextNodeForDirection(lotData, car.fromNode, sign.direction);

        // QUEUE. A node holds one car at a time. Without this, cars advanced
        // regardless of what was ahead and simply drove through each other:
        // a movement trace caught pairs closing to 2.8 units apart with 4.5
        // long bodies. Refusing to enter an occupied node makes them queue
        // nose to tail down the aisle, which is what a one-way lane does.
        //
        // This cannot deadlock: the aisles are one-way, so two cars can never
        // be each other's next node, and anything blocking eventually parks
        // (leaving activeCars) or drives on.
        // A car is 4.5 long but junctions are only 2.6 apart, so a car's body
        // spans nearly two nodes. Reserving one node still left them
        // overlapping at 2.78 centre to centre. Reserve the target node AND
        // the one beyond it, which is the node a car sitting at the target
        // would have its tail hanging back into.
        if (next && isNodeBusy(lotData, cars, car, next)) continue;

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

      // --- Compute dynamic node signs ---
      // A permanent board exists at every turn and every ramp. Previously a
      // board only lit up when the car was already stopped at its node, which
      // at this bay spacing meant it lit roughly a third of a second before
      // the car was on top of it: useless as guidance, and the thing Deepu
      // described as "so delayed, not showing things on time at all".
      //
      // The backend now sends each car's whole remaining route, so we light
      // every board ALONG that route and tell it how many hops away the car
      // is. A driver sees the turn board from the moment they enter the aisle.
      // When two cars route through the same board, the closer one wins.
      const bestByNode = new Map<string, NodeSign>();
      for (const car of cars) {
        if (car.parked || car.status === "no_slot") continue;
        const sign = map.get(car.id);
        if (!sign) continue;
        const route = sign.path ?? [sign.node];
        for (let hop = 0; hop < route.length; hop++) {
          const nodeId = route[hop];
          const node = lotData.nodes[nodeId];
          // Boards only exist at turns and at the foot of ramps.
          if (!node || (node.type !== "turn" && node.type !== "ramp_up")) continue;
          const existing = bestByNode.get(nodeId);
          if (existing && existing.hopsAway <= hop) continue;
          bestByNode.set(nodeId, {
            nodeId,
            carColor: sign.color,
            carPlate: sign.plate,
            // The direction to take AT that board, not the car's current one.
            direction: directionAt(lotData, route, hop),
            slot: sign.slot,
            slotFloor: sign.slot_floor,
            floor: node.floor,
            nodeX: node.x,
            nodeY: node.y,
            hopsAway: hop,
          });
        }
      }
      const nodeSignList = [...bestByNode.values()];

      // Only push to React state when what the boards actually display has
      // changed, so a 5 Hz tick does not re-render 11 signboards every time.
      const sig = nodeSignList
        .map((n) => `${n.nodeId}:${n.carPlate}:${n.direction}:${n.slot}:${n.hopsAway}`)
        .join("|");
      if (sig !== lastSignSigRef.current) {
        lastSignSigRef.current = sig;
        setNodeSigns(nodeSignList);
      }
      // --- Compute the roster of all active auto-running cars ---
      // Every permanent signboard shows this roster (colour swatch, plate,
      // assigned slot) so drivers can see the full set of cars currently
      // moving through the lot, not just the one at their node.
      const roster: CarRosterEntry[] = [];
      for (const car of cars) {
        if (car.parked) continue;
        const sign = map.get(car.id);
        if (!sign) continue;
        roster.push({
          carId: car.id,
          color: sign.color,
          plate: sign.plate,
          slot: sign.slot,
          slotFloor: sign.slot_floor,
          currentFloor: lotData.nodes[sign.node]?.floor ?? 0,
          status: car.status,
        });
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

      const rosterSig = roster
        .map((r) => `${r.carId}:${r.plate}:${r.slot}:${r.status}`)
        .join("|");
      if (rosterSig !== lastRosterSigRef.current) {
        lastRosterSigRef.current = rosterSig;
        setCarRoster(roster);
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
        })),
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
      // The garage is one-way, so leaving a ground-floor bay means driving the
      // whole spiral to the top exit: about 250 hops, a minute and a half of
      // road time. Without a cap on how many are doing that at once, they
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
    carRoster,
    carRoutes,
    onArrive,
  };
}
