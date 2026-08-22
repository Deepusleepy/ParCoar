import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActiveCar,
  BoardCar,
  CarColor,
  CarRoute,
  Direction,
  InstructionSign,
  InstructionsMessage,
  LotData,
  LotEdge,
  NodeSign,
  ServerMessage,
  StateMessage,
} from "../types";
import { resolvePath } from "../sim/paths";
import { setSpeedScale } from "../sim/simSpeed";
import {
  AISLE_SPACING,
  CAR_LENGTH,
  FLOOR_HEIGHT,
  nextCarId,
  randomColor,
  randomPlate,
  randomSize,
  SPAWN_INTERVAL_MS,
  STATE_TICK_MS,
  TARGET_ACTIVE_CARS,
} from "../sim/constants";

/** Override with VITE_WS_URL when the backend runs somewhere else. */
const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://127.0.0.1:8765";
const ENTRY_NODE = "E0";
const RECONNECT_DELAY_MS = 2000;
const MIN_STAY_MS = 30_000;
const MAX_STAY_MS = 90_000;
const DEV_PUBLISH_MS = 50;
const BOARD_ROWS = 3;

export type GarageFill = "quiet" | "normal" | "busy";

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

export interface ParkedCarData {
  key: string;
  slotNode: string;
  color: CarColor;
  plate: string;
  /** Visual model only. It is not sent to Python or used for assignment. */
  size: ActiveCar["size"];
  parkedAt?: number;
  stayMs?: number;
}

export interface SimSettings {
  targetCars: number;
  spawnEverySec: number;
  maxLeaving: number;
  speed: number;
  fill: GarageFill;
}

export const DEFAULT_SETTINGS: SimSettings = {
  targetCars: TARGET_ACTIVE_CARS,
  spawnEverySec: SPAWN_INTERVAL_MS / 1000,
  maxLeaving: 2,
  speed: 1,
  fill: "normal",
};

export interface SimulationState {
  lot: LotData | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
  activeCars: ActiveCar[];
  preParked: ParkedCarData[];
  parked: ParkedCarData[];
  lotFull: boolean;
  nodeSigns: NodeSign[];
  carRoutes: CarRoute[];
  onArrive: (carId: string, node: string) => void;
  settings: SimSettings;
  updateSettings: (patch: Partial<SimSettings>) => void;
  spawnNow: () => void;
  clearRoad: () => void;
  resetGarage: () => void;
}

function directionAt(lot: LotData, route: string[], hop: number): Direction {
  if (hop + 1 >= route.length) return "arrived";
  const edge = lot.edges[route[hop]]?.find((candidate) => candidate.to === route[hop + 1]);
  return edge?.dir ?? "arrived";
}

/** Real path length used only by the frontend's collision/queue safety gate. */
const legLengthCache = new Map<string, number>();
function legLength(lot: LotData, fromId: string, toId: string): number {
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

function nodeGap(lot: LotData, first: string, second: string): number {
  const a = lot.nodes[first];
  const b = lot.nodes[second];
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y, (a.floor - b.floor) * FLOOR_HEIGHT);
}

function roadDirection(lot: LotData, fromId: string, toId: string): 1 | -1 | null {
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

function carRoadDirection(
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
function isRoadBlocked(
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

function nextNodeForDirection(
  lot: LotData,
  fromNode: string,
  direction: LotEdge["dir"],
): string | null {
  return lot.edges[fromNode]?.find((edge) => edge.dir === direction)?.to ?? null;
}

function generatePreParked(lot: LotData, fillLevel: GarageFill = "normal"): ParkedCarData[] {
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

function departCar(car: ParkedCarData): ActiveCar {
  return {
    id: nextCarId(),
    color: car.color,
    plate: car.plate,
    size: car.size,
    fromNode: car.slotNode,
    toNode: car.slotNode,
    progress: 0,
    slot: null,
    status: "routing",
    parked: false,
    leaving: true,
    vacating: car.slotNode,
  };
}

export function useSimulation(): SimulationState {
  const [lot, setLot] = useState<LotData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [activeCars, setActiveCars] = useState<ActiveCar[]>([]);
  const [preParked, setPreParked] = useState<ParkedCarData[]>([]);
  const [parked, setParked] = useState<ParkedCarData[]>([]);
  const [lotFull, setLotFull] = useState(false);
  const [settings, setSettings] = useState<SimSettings>(DEFAULT_SETTINGS);
  const [nodeSigns, setNodeSigns] = useState<NodeSign[]>([]);
  const [carRoutes, setCarRoutes] = useState<CarRoute[]>([]);

  const settingsRef = useRef(settings);
  const activeCarsRef = useRef<ActiveCar[]>([]);
  const lotRef = useRef<LotData | null>(null);
  const preParkedRef = useRef<ParkedCarData[]>([]);
  const parkedRef = useRef<ParkedCarData[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const instructionsRef = useRef<Map<string, InstructionSign>>(new Map());
  const lastSpawnRef = useRef(0);
  const lastSignSignatureRef = useRef("");
  const lastRouteSignatureRef = useRef("");
  const nodeSignsRef = useRef<NodeSign[]>([]);
  const removalTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  settingsRef.current = settings;
  activeCarsRef.current = activeCars;
  lotRef.current = lot;
  preParkedRef.current = preParked;
  parkedRef.current = parked;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/lot.json")
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load garage layout (${response.status})`);
        return response.json() as Promise<LotData>;
      })
      .then((data) => {
        if (cancelled) return;
        setLot(data);
        setPreParked(generatePreParked(data));
        setError(null);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        const message = reason instanceof Error ? reason.message : "Failed to load garage layout";
        console.error(message);
        setError(message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      removalTimersRef.current.forEach(clearTimeout);
      removalTimersRef.current.clear();
    };
  }, []);

  const sendState = useCallback(() => {
    const websocket = wsRef.current;
    if (!websocket || websocket.readyState !== WebSocket.OPEN) return;

    const cars = activeCarsRef.current
      .filter((car) => !car.parked)
      .map((car) => ({
        id: car.id,
        color: car.color,
        plate: car.plate,
        node: car.fromNode,
        leaving: car.leaving,
        assigned_slot: car.leaving ? null : car.slot,
        vacating_slot: car.vacating,
      }));

    // This is a simulated physical sensor snapshot. Active reservations are
    // deliberately excluded because Python owns them.
    const occupiedSlots = new Set<string>();
    for (const car of preParkedRef.current) occupiedSlots.add(car.slotNode);
    for (const car of parkedRef.current) occupiedSlots.add(car.slotNode);
    for (const car of activeCarsRef.current) {
      if (car.vacating && car.fromNode === car.vacating) occupiedSlots.add(car.vacating);
    }

    const message: StateMessage = {
      type: "state",
      cars,
      occupied_slots: [...occupiedSlots],
    };

    try {
      websocket.send(JSON.stringify(message));
    } catch {
      // onclose handles reconnecting.
    }
  }, []);

  const applyInstructions = useCallback((instructions: InstructionSign[]) => {
    const lotData = lotRef.current;
    if (!lotData) return;

    const map = instructionsRef.current;
    for (const instruction of instructions) map.set(instruction.car_id, instruction);

    const cars = activeCarsRef.current;
    let changed = false;
    const newlyParked: ActiveCar[] = [];
    const departed: string[] = [];

    for (const car of cars) {
      if (car.parked) continue;
      const instruction = map.get(car.id);
      if (!instruction) continue;
      if (instruction.node !== car.fromNode || car.toNode !== car.fromNode) continue;

      if (instruction.status === "no_slot" || instruction.status === "no_path") {
        if (car.status === instruction.status) continue;
        car.status = instruction.status;
        const timer = setTimeout(() => {
          removalTimersRef.current.delete(timer);
          setActiveCars((current) => {
            const existing = current.find((candidate) => candidate.id === car.id);
            if (!existing || existing.status !== instruction.status) return current;
            instructionsRef.current.delete(car.id);
            return current.filter((candidate) => candidate.id !== car.id);
          });
        }, 3000);
        removalTimersRef.current.add(timer);
        changed = true;
        continue;
      }

      if (instruction.status === "left") {
        car.status = "left";
        departed.push(car.id);
        changed = true;
        continue;
      }

      if (instruction.status === "parked") {
        car.status = "parked";
        car.parked = true;
        car.slot = instruction.slot ?? car.fromNode;
        newlyParked.push(car);
        changed = true;
        continue;
      }

      const routeIsCurrent = instruction.path[0] === car.fromNode;
      const next = routeIsCurrent
        ? instruction.path[1] ?? null
        : instruction.direction
          ? nextNodeForDirection(lotData, car.fromNode, instruction.direction)
          : null;
      const beyond = routeIsCurrent && instruction.path[1] === next
        ? instruction.path[2]
        : undefined;

      if (next && isRoadBlocked(lotData, cars, car, next, beyond, map)) continue;
      if (next && next !== car.toNode) {
        car.toNode = next;
        car.status = "routing";
        car.slot = instruction.slot;
        changed = true;
      }
    }

    if (changed) {
      const claimed = new Set(
        cars.flatMap((car) => (!car.leaving && car.slot ? [car.slot] : [])),
      );
      if (claimed.size > 0) {
        setPreParked((current) => current.filter((car) => !claimed.has(car.slotNode)));
      }

      const now = Date.now();
      if (newlyParked.length > 0) {
        const additions: ParkedCarData[] = newlyParked.map((car) => ({
          key: `parked-${car.id}`,
          slotNode: car.slot ?? car.fromNode,
          color: car.color,
          plate: car.plate,
          size: car.size,
          parkedAt: now,
          stayMs: MIN_STAY_MS + Math.random() * (MAX_STAY_MS - MIN_STAY_MS),
        }));
        setParked((current) => {
          const bySlot = new Map(current.map((car) => [car.slotNode, car]));
          for (const car of additions) bySlot.set(car.slotNode, car);
          return [...bySlot.values()];
        });
      }

      const gone = new Set(departed);
      setActiveCars((current) =>
        current.some((car) => car.parked || gone.has(car.id))
          ? current.filter((car) => !car.parked && !gone.has(car.id))
          : current,
      );
    }

    const activeIds = new Set(cars.map((car) => car.id));
    for (const id of map.keys()) {
      if (!activeIds.has(id)) map.delete(id);
    }

    const queues = new Map<string, BoardCar[]>();
    for (const car of cars) {
      if (car.parked || car.status === "no_slot" || car.status === "no_path") continue;
      const instruction = map.get(car.id);
      if (!instruction) continue;
      const route = instruction.path.length > 0 ? instruction.path : [instruction.node];
      const movingOff = route.length > 1 && car.fromNode === route[0] && car.toNode === route[1];
      const startHop = movingOff ? 1 : 0;
      let travelled = movingOff
        ? (1 - car.progress) * nodeGap(lotData, route[0], route[1])
        : 0;

      for (let hop = startHop; hop < route.length; hop += 1) {
        if (hop > startHop) travelled += nodeGap(lotData, route[hop - 1], route[hop]);
        const node = lotData.nodes[route[hop]];
        if (!node || (node.type !== "turn" && node.type !== "ramp_up")) continue;
        const queue = queues.get(route[hop]) ?? [];
        queue.push({
          carId: car.id,
          color: instruction.color,
          plate: instruction.plate,
          direction: directionAt(lotData, route, hop),
          slot: instruction.slot ?? "",
          leaving: car.leaving,
          distance: travelled,
        });
        queues.set(route[hop], queue);
        break;
      }
    }

    const signList: NodeSign[] = [...queues].map(([nodeId, queue]) => ({
      nodeId,
      floor: lotData.nodes[nodeId]?.floor ?? 0,
      cars: queue.sort((a, b) => a.distance - b.distance).slice(0, BOARD_ROWS),
    }));
    const signSignature = signList
      .map((sign) =>
        `${sign.nodeId}:${sign.cars
          .map((car) => `${car.plate}|${car.direction}|${car.slot}|${Math.round(car.distance)}`)
          .join(",")}`,
      )
      .join("|");
    nodeSignsRef.current = signList;
    if (signSignature !== lastSignSignatureRef.current) {
      lastSignSignatureRef.current = signSignature;
      setNodeSigns(signList);
    }

    const routes: CarRoute[] = [];
    for (const car of cars) {
      if (car.parked) continue;
      const instruction = map.get(car.id);
      if (!instruction || instruction.path.length < 2) continue;
      routes.push({
        carId: car.id,
        plate: instruction.plate,
        color: instruction.color,
        slot: instruction.slot,
        path: instruction.path,
        floor: lotData.nodes[instruction.node]?.floor ?? 0,
        routeDistance: instruction.route_distance,
        estimatedSeconds: instruction.estimated_seconds,
        destinationType: instruction.destination_type,
      });
    }
    const routeSignature = routes
      .map((route) =>
        `${route.carId}:${route.slot ?? "-"}:${route.routeDistance}:${route.path.join(">")}`,
      )
      .join("|");
    if (routeSignature !== lastRouteSignatureRef.current) {
      lastRouteSignatureRef.current = routeSignature;
      setCarRoutes(routes);
    }
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const interval = setInterval(() => {
      (window as unknown as Record<string, unknown>).__parcoarSim = {
        cars: activeCarsRef.current.map((car) => ({
          id: car.id,
          size: car.size,
          from: car.fromNode,
          to: car.toNode,
          slot: car.slot,
          status: car.status,
          leaving: car.leaving,
          parked: car.parked,
          progress: car.progress,
        })),
        signs: [...instructionsRef.current.entries()].map(([id, instruction]) => ({
          id,
          node: instruction.node,
          dir: instruction.direction,
          slot: instruction.slot,
          status: instruction.status,
          path: instruction.path,
          routeDistance: instruction.route_distance,
        })),
        boards: nodeSignsRef.current,
        parked: parkedRef.current.length,
      };
    }, DEV_PUBLISH_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      let websocket: WebSocket;
      try {
        websocket = new WebSocket(WS_URL);
      } catch {
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        return;
      }
      wsRef.current = websocket;

      websocket.onopen = () => {
        setConnected(true);
        setLotFull(false);
        sendState();
      };
      websocket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string) as ServerMessage;
          if (message.type !== "instructions") return;
          const instructions = (message as InstructionsMessage).signs ?? [];
          setLotFull(instructions.some((instruction) => instruction.status === "no_slot"));
          applyInstructions(instructions);
        } catch {
          // Ignore malformed server frames.
        }
      };
      websocket.onclose = () => {
        if (wsRef.current === websocket) {
          wsRef.current = null;
          setConnected(false);
          setLotFull(false);
        }
        if (!disposed) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };
      websocket.onerror = () => {
        try {
          websocket.close();
        } catch {
          // onclose performs recovery.
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        wsRef.current?.close();
      } catch {
        // Already closed.
      }
      wsRef.current = null;
    };
  }, [applyInstructions, sendState]);

  useEffect(() => {
    const interval = setInterval(sendState, STATE_TICK_MS);
    return () => clearInterval(interval);
  }, [sendState]);

  const onArrive = useCallback(() => sendState(), [sendState]);

  useEffect(() => {
    setSpeedScale(settings.speed);
  }, [settings.speed]);

  useEffect(() => {
    if (!lot) return;
    const interval = setInterval(() => {
      const now = Date.now();
      const incomingCount = activeCarsRef.current.filter((car) => !car.leaving).length;
      const entryBlocked = activeCarsRef.current.some(
        (car) => car.fromNode === ENTRY_NODE && car.toNode === ENTRY_NODE,
      );
      const current = settingsRef.current;
      if (current.speed === 0) return;
      if (
        incomingCount < current.targetCars &&
        !entryBlocked &&
        now - lastSpawnRef.current > current.spawnEverySec * 1000
      ) {
        const car = spawnCar();
        setActiveCars((existing) =>
          existing.filter((candidate) => !candidate.leaving).length >= current.targetCars
            ? existing
            : [...existing, car],
        );
        lastSpawnRef.current = now;
      }
    }, 400);
    return () => clearInterval(interval);
  }, [lot]);

  useEffect(() => {
    if (!lot) return;
    const interval = setInterval(() => {
      const current = settingsRef.current;
      if (current.speed === 0) return;
      const leavingCount = activeCarsRef.current.filter((car) => car.leaving).length;
      if (leavingCount >= current.maxLeaving) return;

      const now = Date.now();
      const due = parkedRef.current.find(
        (car) => car.parkedAt !== undefined && now - car.parkedAt > (car.stayMs ?? 0),
      );
      if (!due) return;
      setParked((existing) => existing.filter((car) => car.key !== due.key));
      setActiveCars((existing) => [...existing, departCar(due)]);
    }, 2000);
    return () => clearInterval(interval);
  }, [lot]);

  useEffect(() => {
    if (!lot || activeCars.length > 0) return;
    setActiveCars([spawnCar()]);
    lastSpawnRef.current = Date.now();
  }, [lot, activeCars.length]);

  const updateSettings = useCallback((patch: Partial<SimSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  const spawnNow = useCallback(() => {
    if (
      activeCarsRef.current.some(
        (car) => car.fromNode === ENTRY_NODE && car.toNode === ENTRY_NODE,
      )
    ) {
      return;
    }
    setActiveCars((current) => [...current, spawnCar()]);
    lastSpawnRef.current = Date.now();
  }, []);

  const clearRoad = useCallback(() => {
    setActiveCars([]);
    instructionsRef.current.clear();
  }, []);

  const resetGarage = useCallback(() => {
    const current = lotRef.current;
    if (!current) return;
    setActiveCars([]);
    setParked([]);
    setPreParked(generatePreParked(current, settingsRef.current.fill));
    instructionsRef.current.clear();
    lastSpawnRef.current = Date.now();
  }, []);

  return {
    lot,
    loading,
    error,
    connected,
    activeCars,
    preParked,
    parked,
    lotFull,
    nodeSigns,
    carRoutes,
    onArrive,
    settings,
    updateSettings,
    spawnNow,
    clearRoad,
    resetGarage,
  };
}
