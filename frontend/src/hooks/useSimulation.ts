import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActiveCar,
  CarColor,
  InstructionSign,
  InstructionsMessage,
  LotData,
  LotEdge,
  ServerMessage,
  StateMessage,
} from "../types";
import {
  MAX_ACTIVE_CARS,
  MIN_ACTIVE_CARS,
  nextCarId,
  PREPARK_FILL_RATIO,
  randomColor,
  randomPlate,
  randomSize,
  SPAWN_INTERVAL_MS,
  STATE_TICK_MS,
  TARGET_ACTIVE_CARS,
} from "../sim/constants";

const WS_URL = "ws://localhost:8765";
const ENTRY_NODE = "E0";
const RECONNECT_DELAY_MS = 2000;

export interface SignboardData {
  key: string;
  nodeX: number;
  nodeY: number;
  floor: number;
  carId: string;
  color: CarColor;
  plate: string;
  direction: InstructionSign["direction"];
  slot: string;
  slotFloor: number;
}

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
  signboards: SignboardData[];
  lotFull: boolean;
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

/** Generate the static pre-parked cars (~50% of slots, size-matched). */
function generatePreParked(lot: LotData): ParkedCarData[] {
  const slots = Object.entries(lot.nodes).filter(
    ([, n]) => n.type === "slot" && n.size,
  );
  const out: ParkedCarData[] = [];
  for (const [id, node] of slots) {
    if (Math.random() < PREPARK_FILL_RATIO) {
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
  const [instructions, setInstructions] = useState<InstructionSign[]>([]);
  const [lotFull, setLotFull] = useState(false);

  // Refs for values needed inside stable callbacks / intervals.
  const activeCarsRef = useRef<ActiveCar[]>([]);
  const lotRef = useRef<LotData | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const latestInstructionsRef = useRef<Map<string, InstructionSign>>(new Map());
  const lastSpawnRef = useRef(0);

  activeCarsRef.current = activeCars;
  lotRef.current = lot;

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
    const msg: StateMessage = { type: "state", cars };
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
      for (const car of cars) {
        if (car.parked) continue;
        const sign = map.get(car.id);
        if (!sign) continue;
        // Only act when the car is waiting at the sign's node.
        if (sign.node !== car.fromNode || car.toNode !== car.fromNode) continue;

        if (sign.status === "no_slot") {
          car.status = "no_slot";
          changed = true;
          continue;
        }

        if (sign.status === "parked" || sign.direction === "arrived") {
          // Car has reached its assigned slot.
          car.status = "parked";
          car.parked = true;
          car.slot = sign.slot;
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
        // Migrate parked cars into the static parked list, then drop them
        // from the active set. Both setStates are top-level (no nesting).
        const newlyParked = cars
          .filter((c) => c.parked)
          .map((c) => ({
            key: `parked-${c.id}`,
            slotNode: c.slot ?? c.fromNode,
            color: c.color,
            plate: c.plate,
            size: c.size,
          }));
        if (newlyParked.length > 0) {
          setParked((p) => [...p, ...newlyParked]);
        }
        setActiveCars((prev) =>
          prev.some((c) => c.parked) ? prev.filter((c) => !c.parked) : prev,
        );
      }

      setInstructions(signs);
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
        setConnected(false);
        wsRef.current = null;
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

  // --- Spawning: maintain 8-12 active cars ---
  useEffect(() => {
    if (!lot) return;
    const id = setInterval(() => {
      const now = Date.now();
      const count = activeCarsRef.current.length;
      if (count < TARGET_ACTIVE_CARS && now - lastSpawnRef.current > SPAWN_INTERVAL_MS) {
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
    const initial = Array.from({ length: MIN_ACTIVE_CARS }, () => spawnCar());
    setActiveCars(initial);
  }, [lot, activeCars.length]);

  // --- Derive visible signboards ---
  const signboards = useMemo<SignboardData[]>(() => {
    if (!lot) return [];
    const map = latestInstructionsRef.current;
    const out: SignboardData[] = [];
    for (const car of activeCars) {
      if (car.parked || car.status === "no_slot") continue;
      const sign = map.get(car.id);
      if (!sign) continue;
      const node = lot.nodes[sign.node];
      if (!node) continue;
      out.push({
        key: `${car.id}-${sign.node}`,
        nodeX: node.x,
        nodeY: node.y,
        floor: node.floor,
        carId: car.id,
        color: sign.color,
        plate: sign.plate,
        direction: sign.direction,
        slot: sign.slot,
        slotFloor: sign.slot_floor,
      });
    }
    return out;
  }, [lot, activeCars, instructions]);

  return {
    lot,
    loading,
    connected,
    activeCars,
    preParked,
    parked,
    signboards,
    lotFull,
    onArrive,
  };
}
