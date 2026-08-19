import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActiveCar,
  CarColor,
  CarRosterEntry,
  InstructionSign,
  InstructionsMessage,
  LotData,
  LotEdge,
  NodeSign,
  ServerMessage,
  StateMessage,
} from "../types";
import {
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

export interface ParkedCarData {
  key: string;
  slotNode: string;
  color: CarColor;
  plate: string;
  size: "small" | "medium" | "large";
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
  onArrive: (carId: string, node: string) => void;
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
      if (c.slot) occupiedSlots.add(c.slot);
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
        const newlyParked = parkedThisCall.map((c) => ({
          key: `parked-${c.id}`,
          slotNode: c.slot || c.fromNode,
          color: c.color,
          plate: c.plate,
          size: c.size,
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
        setActiveCars((prev) =>
          prev.some((c) => c.parked) ? prev.filter((c) => !c.parked) : prev,
        );
      }

      // Prune instructions for cars no longer in activeCars.
      const activeIds = new Set(cars.map((c) => c.id));
      for (const key of latestInstructionsRef.current.keys()) {
        if (!activeIds.has(key)) latestInstructionsRef.current.delete(key);
      }

      // --- Compute dynamic node signs ---
      // A sign appears at a junction node only while a car is stopped there
      // waiting for (or just receiving) its next instruction. This reconnects
      // the signboards to the backend: they show the approaching car's colour,
      // plate, direction, and assigned slot in real time.
      const nodeSignList: NodeSign[] = [];
      for (const car of cars) {
        if (car.parked || car.status === "no_slot") continue;
        const sign = map.get(car.id);
        if (!sign) continue;
        const node = lotData.nodes[sign.node];
        if (!node) continue;
        // Show the sign as soon as the car starts heading toward this node
        // (toNode === sign.node) and keep it lit while the car is at the node
        // (fromNode === sign.node). The sign disappears once the car moves on
        // to the next node, so the driver sees the direction BEFORE the turn.
        if (car.toNode === sign.node || car.fromNode === sign.node) {
          nodeSignList.push({
            nodeId: sign.node,
            carColor: sign.color,
            carPlate: sign.plate,
            direction: sign.direction,
            slot: sign.slot,
            slotFloor: sign.slot_floor,
            floor: node.floor,
            nodeX: node.x,
            nodeY: node.y,
          });
        }
        // Look-ahead: if the backend provided a next_node, light up the
        // signboard at that node while the car is heading toward it. This
        // shows the direction at the next junction BEFORE the car arrives,
        // so the driver isn't already underneath the board when it lights.
        if (sign.next_node && sign.next_direction && car.toNode === sign.next_node) {
          const nextNodeObj = lotData.nodes[sign.next_node];
          if (nextNodeObj) {
            nodeSignList.push({
              nodeId: sign.next_node,
              carColor: sign.color,
              carPlate: sign.plate,
              direction: sign.next_direction,
              slot: sign.slot,
              slotFloor: sign.slot_floor,
              floor: nextNodeObj.floor,
              nodeX: nextNodeObj.x,
              nodeY: nextNodeObj.y,
            });
          }
        }
      }
      // Only update state when the set of active signs actually changes,
      // to avoid re-render storms on every 200ms WS tick.
      const sig = nodeSignList
        .map((s) => `${s.nodeId}:${s.carPlate}:${s.direction}:${s.slot}`)
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
      const count = activeCarsRef.current.length;
      // Don't spawn if a car is still sitting at the entry node (fromNode === toNode === E0).
      const entryBlocked = activeCarsRef.current.some(
        (c) => c.fromNode === ENTRY_NODE && c.toNode === ENTRY_NODE,
      );
      if (count < TARGET_ACTIVE_CARS && !entryBlocked && now - lastSpawnRef.current > SPAWN_INTERVAL_MS) {
        const car = spawnCar();
        setActiveCars((prev) =>
          prev.length >= MAX_ACTIVE_CARS ? prev : [...prev, car],
        );
        lastSpawnRef.current = now;
      }
    }, 400);
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
    onArrive,
  };
}
