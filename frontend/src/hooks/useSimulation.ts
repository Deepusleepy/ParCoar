import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActiveCar,
  BoardCar,
  CarRoute,
  InstructionSign,
  InstructionsMessage,
  LotData,
  NodeSign,
  ServerMessage,
  StateMessage,
} from "../types";
import {
  directionAt,
  isRoadBlocked,
  nodeGap,
} from "../sim/traffic";
import {
  generatePreParked,
  type GarageFill,
  type ParkedCarData,
} from "../sim/fill";
import { setSpeedScale } from "../sim/simSpeed";
import {
  CAR_LENGTH,
  LANE_WIDTH,
  nextCarId,
  PLAYER_ID,
  PLAYER_PLATE,
  randomColor,
  randomPlate,
  randomSize,
  SPAWN_INTERVAL_MS,
  STATE_TICK_MS,
  TARGET_ACTIVE_CARS,
  toWorld,
} from "../sim/constants";

/** Override with VITE_WS_URL when the backend runs somewhere else. */
const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://127.0.0.1:8765";
const ENTRY_NODE = "E0";
const RECONNECT_DELAY_MS = 2000;
const MIN_STAY_MS = 30_000;
const MAX_STAY_MS = 90_000;
const DEV_PUBLISH_MS = 50;
const BOARD_ROWS = 3;
/** Minimum interval between React state flushes of nodeSigns / carRoutes.
 *  applyInstructions runs on every WebSocket reply (~12.5/sec) and rebuilds
 *  the sign/route signatures; without throttling, a continuously-changing
 *  signature (a car approaching a turn, or AI route_distance updating every
 *  reply) fired setNodeSigns/setCarRoutes ~12x/sec, re-rendering App -> Scene
 *  -> DrivableCar and dropping frames. 250ms (4Hz) is well above the rate at
 *  which a human reads a turn board or a route list, so the boards/HUD stay
 *  responsive while the heavy tree stops re-rendering on every reply. */
const SIGN_FLUSH_MS = 250;
/** When no state has changed, still resend the last payload this often so
 *  the server can garbage-collect cars the client has removed. */
const HEARTBEAT_MS = 500;
/** After the drivable car reaches the exit, respawn it at the entry. */
const PLAYER_RESPAWN_DELAY_MS = 2500;

/**
 * Server-approved continuation routes, keyed by car object.
 *
 * Every fresh reply that aligns with a car's live leg publishes the FULL
 * remaining path here, and ActiveCarMesh consumes it while driving so a car
 * rolls through consecutive nodes without stopping for one server round
 * trip per hop. Plans are replaced wholesale on each publish and never
 * merged: Python owns routing, so the client must never stitch two routes
 * together. Keyed weakly by the ActiveCar object so plans for removed cars
 * are dropped with them.
 */
interface RoutePlan {
  version: number;
  /** Nodes still to traverse AFTER the car's current leg, in order. */
  upcoming: string[];
}

const routePlans = new WeakMap<ActiveCar, RoutePlan>();
let routePlanVersion = 0;

/** Publish the remaining hops of a server route for one car. */
export function publishRoutePlan(car: ActiveCar, upcoming: string[]): void {
  routePlanVersion += 1;
  routePlans.set(car, { version: routePlanVersion, upcoming });
}

/** Latest published plan for one car, or null when none exists yet. */
export function readRoutePlan(car: ActiveCar): RoutePlan | null {
  return routePlans.get(car) ?? null;
}

/**
 * Live view of the simulation world shared with the car meshes. Refreshed
 * on every render exactly like the hook's own refs above; ActiveCarMesh
 * reads it through isNodeEntryBlocked when deciding whether it may roll
 * into the next graph node between server replies.
 */
const sharedWorld: {
  lot: LotData | null;
  cars: ActiveCar[];
  instructions: Map<string, InstructionSign>;
  /** Live physical position of the player car (updated every frame from
   *  DrivableCar). AI cars check this to avoid driving through a player
   *  stopped between nodes, which the node-level gate alone can't catch. */
  playerPos: { x: number; z: number; floor: number } | null;
} = { lot: null, cars: [], instructions: new Map(), playerPos: null };

/**
 * Physical entry gate used at node crossings. Mirrors the standstill gate
 * in applyInstructions: a car may not roll into a graph node while another
 * car occupies or is committed to it. Returns true when the entry is
 * blocked. The caller must already have moved `self` onto the leg it wants
 * to enter (fromNode/toNode provisional), matching how the hook checks its
 * own assignments.
 *
 * The player-proximity check projects the player onto the AI car's travel
 * path so that a player on the oncoming lane (wrong side) or behind the AI
 * car (being overtaken) does NOT block — only a player ahead in the same
 * lane does.
 */
export function isNodeEntryBlocked(
  self: ActiveCar,
  node: string,
  beyond: string | undefined,
): boolean {
  const lot = sharedWorld.lot;
  if (!lot) return false;
  if (isRoadBlocked(lot, sharedWorld.cars, self, node, beyond, sharedWorld.instructions)) {
    return true;
  }
  // Physical check: if the player car is stopped on the road ahead, block
  // entry so AI cars don't drive through it. The node-level gate above only
  // catches cars whose fromNode/toNode matches, but the player reports nodes
  // sparsely and can sit between them. Unlike the old radial check, this
  // projects the player onto the AI car's travel path so that a player on the
  // oncoming lane (wrong side) or behind the AI car (being overtaken) does
  // NOT block — only a player ahead in the same lane does.
  const pp = sharedWorld.playerPos;
  const target = lot.nodes[node];
  const from = lot.nodes[self.fromNode];
  if (!pp || pp.floor < 0 || !target || !from) return false;
  if (pp.floor !== target.floor) return false;

  const [fx, , fz] = toWorld(from.x, from.y, from.floor);
  const [tx, , tz] = toWorld(target.x, target.y, target.floor);

  // Car position along the leg (node-centreline). At both call sites the car
  // is at fromNode (progress 0 / standstill), but use progress when the
  // provisional toNode matches the target for robustness.
  const t = self.toNode === node ? self.progress : 0;
  const cx = fx + (tx - fx) * t;
  const cz = fz + (tz - fz) * t;

  // Forward direction from the car toward the target node (XZ only).
  const dx = tx - cx;
  const dz = tz - cz;
  const legDist = Math.hypot(dx, dz);
  if (legDist < 1e-4) {
    // Degenerate: car is effectively at the node; fall back to a simple
    // radial check so we never silently clear a blocked entry.
    return Math.hypot(pp.x - tx, pp.z - tz) < CAR_LENGTH;
  }
  const ux = dx / legDist;
  const uz = dz / legDist;

  // Shift the car position into its driving lane (left-hand offset, matching
  // resolvePath's LANE_SHIFT = -LANE_WIDTH/2 applied via cross(tangent, up)).
  const carX = cx + uz * (LANE_WIDTH / 2);
  const carZ = cz - ux * (LANE_WIDTH / 2);

  // Project the player onto the path: forward (along travel) and lateral
  // (perpendicular) distances relative to the AI car's lane position.
  const vx = pp.x - carX;
  const vz = pp.z - carZ;
  const forward = vx * ux + vz * uz;
  const lateral = Math.abs(vx * uz - vz * ux);

  // Player in the oncoming lane — let the AI car pass.
  if (lateral >= LANE_WIDTH * 0.65) return false;
  // Player behind the AI car — not blocking entry to a node ahead.
  if (forward < -CAR_LENGTH * 0.5) return false;
  // Player well past the target node — already cleared the entry.
  if (forward > legDist + CAR_LENGTH) return false;
  // Player ahead in the same lane near the target node — block.
  return true;
}

/** Update the player car's live physical position. Called every frame from
 *  DrivableCar so AI cars can avoid the player even when stopped between
 *  graph nodes. Mutates the existing playerPos object in place to avoid a
 *  per-frame heap allocation (this runs at the frame rate). */
export function updatePlayerPos(x: number, z: number, floor: number): void {
  const pp = sharedWorld.playerPos;
  if (pp) {
    pp.x = x;
    pp.z = z;
    pp.floor = floor;
  } else {
    sharedWorld.playerPos = { x, z, floor };
  }
}

export type { GarageFill, ParkedCarData } from "../sim/fill";

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
  /** True while the drivable car is in the garage as a participant. */
  playerDriving: boolean;
  /**
   * Bumped every time the drivable car should teleport back to its spawn
   * (entering the garage, respawn after exiting, garage reset). The car
   * component watches this to reset its physics.
   */
  playerRunId: number;
  onArrive: (carId: string, node: string) => void;
  settings: SimSettings;
  updateSettings: (patch: Partial<SimSettings>) => void;
  spawnNow: () => void;
  clearRoad: () => void;
  resetGarage: () => void;
  enterCar: () => void;
  exitCar: () => void;
  /** Report the graph node the drivable car is physically at. */
  reportPlayerNode: (nodeId: string) => void;
  /** Leave the assigned bay and follow guidance to the exit. */
  playerLeaveBay: () => void;
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

/** The drivable car enters the garage like any other car: same wire format,
 *  same assignment, its plate ("YOU") on the overhead boards. */
function spawnPlayerCar(): ActiveCar {
  return {
    id: PLAYER_ID,
    player: true,
    color: "red",
    plate: PLAYER_PLATE,
    size: "large",
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
  const [playerDriving, setPlayerDriving] = useState(false);
  const [playerRunId, setPlayerRunId] = useState(0);

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
  /** Throttle: setNodeSigns/setCarRoutes fire at most 4Hz so the ~12.5/sec
   *  WebSocket reply rate doesn't re-render the App tree on every reply.
   *  A pending flag ensures the last signature change eventually flushes even
   *  if no further change arrives within the throttle window. */
  const lastSignFlushRef = useRef(0);
  const lastRouteFlushRef = useRef(0);
  const signPendingRef = useRef(false);
  const routePendingRef = useRef(false);
  const pendingSignsRef = useRef<NodeSign[]>([]);
  const pendingRoutesRef = useRef<CarRoute[]>([]);
  const nodeSignsRef = useRef<NodeSign[]>([]);
  const removalTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const playerRespawnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Dirty flag: set true by any state mutation (car move/spawn/depart/park,
   *  slot change). sendState only rebuilds + serializes when dirty; otherwise
   *  it resends the last payload at most once per HEARTBEAT_MS. */
  const dirtyRef = useRef(true);
  const lastHeartbeatRef = useRef(0);
  const lastPayloadRef = useRef<string | null>(null);

  settingsRef.current = settings;
  activeCarsRef.current = activeCars;
  lotRef.current = lot;
  preParkedRef.current = preParked;
  parkedRef.current = parked;
  sharedWorld.lot = lot;
  sharedWorld.cars = activeCars;
  sharedWorld.instructions = instructionsRef.current;

  // Any change to the car/slot state marks the next sendState dirty so the
  // server gets the new snapshot. In-place mutations inside applyInstructions
  // that matter (move, slot, park, depart) always go through setActiveCars/
  // setParked/setPreParked, so watching these three covers them.
  useEffect(() => {
    dirtyRef.current = true;
  }, [activeCars, preParked, parked]);

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
        // Paint the lot first so the loading screen can dismiss before the
        // (potentially hundreds of) pre-parked cars are generated on the
        // main thread. Filling the garage runs off the critical path.
        setLot(data);
        setError(null);
        setLoading(false);
        const runFill = () => {
          if (cancelled) return;
          setPreParked(generatePreParked(data));
        };
        const ric = (
          window as unknown as {
            requestIdleCallback?: (
              cb: (deadline: IdleDeadline) => void,
              opts?: { timeout: number },
            ) => number;
          }
        ).requestIdleCallback;
        if (ric) {
          ric(() => runFill(), { timeout: 1000 });
        } else {
          setTimeout(runFill, 0);
        }
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

    // Heartbeat path: nothing the server cares about changed since the last
    // send. Avoid the per-tick JSON.stringify + array rebuild entirely; just
    // resend the last payload occasionally so the server can GC cars that
    // disappeared from the client.
    if (!dirtyRef.current) {
      if (lastPayloadRef.current === null) return;
      const now = Date.now();
      if (now - lastHeartbeatRef.current < HEARTBEAT_MS) return;
      lastHeartbeatRef.current = now;
      try {
        websocket.send(lastPayloadRef.current);
      } catch {
        // onclose handles reconnecting.
      }
      return;
    }

    const cars = activeCarsRef.current
      .filter((car) => !car.parked || car.player)
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
      // The player's bay never enters the parked list, so report it occupied
      // directly for as long as the player holds it.
      if (car.player && car.parked && car.slot) occupiedSlots.add(car.slot);
    }

    const message: StateMessage = {
      type: "state",
      cars,
      occupied_slots: [...occupiedSlots],
    };

    const payload = JSON.stringify(message);
    lastPayloadRef.current = payload;
    dirtyRef.current = false;
    lastHeartbeatRef.current = Date.now();

    try {
      websocket.send(payload);
    } catch {
      // onclose handles reconnecting.
    }
  }, []);

  /** Reset the drivable car to the entry approach and bump the run id so the
   *  3D car teleports and zeroes its physics. */
  const respawnPlayer = useCallback(() => {
    setActiveCars((current) =>
      current.map((car) =>
        car.player
          ? {
              ...car,
              fromNode: ENTRY_NODE,
              toNode: ENTRY_NODE,
              progress: 0,
              slot: null,
              status: "routing",
              parked: false,
              leaving: false,
              vacating: null,
            }
          : car,
      ),
    );
    setPlayerRunId((runId) => runId + 1);
  }, []);

  const schedulePlayerRespawn = useCallback(() => {
    if (playerRespawnTimerRef.current) clearTimeout(playerRespawnTimerRef.current);
    playerRespawnTimerRef.current = setTimeout(() => {
      playerRespawnTimerRef.current = null;
      respawnPlayer();
    }, PLAYER_RESPAWN_DELAY_MS);
  }, [respawnPlayer]);

  const applyInstructions = useCallback((instructions: InstructionSign[]) => {
    const lotData = lotRef.current;
    if (!lotData) return;

    const map = instructionsRef.current;
    // Detect structural changes (path/slot/status/node) against the previous
    // instruction for each car. The board/route rebuild below is gated on this
    // plus `changed` so it only runs when something structural actually moved,
    // not on every 80ms reply. Per-message distance values are excluded from
    // the signatures further down, so setNodeSigns/setCarRoutes fire only on
    // real structural changes (node crossings, slot assignments, status
    // transitions) rather than every reply.
    let instructionsChanged = false;
    for (const instruction of instructions) {
      const prev = map.get(instruction.car_id);
      if (
        !prev ||
        prev.status !== instruction.status ||
        prev.slot !== instruction.slot ||
        prev.node !== instruction.node ||
        prev.path.length !== instruction.path.length
      ) {
        instructionsChanged = true;
      } else {
        for (let i = 0; i < instruction.path.length; i += 1) {
          if (prev.path[i] !== instruction.path[i]) {
            instructionsChanged = true;
            break;
          }
        }
      }
      map.set(instruction.car_id, instruction);
    }

    const cars = activeCarsRef.current;
    let changed = false;
    const newlyParked: ActiveCar[] = [];
    const departed: string[] = [];

    for (const car of cars) {
      if (car.parked) continue;
      const instruction = map.get(car.id);
      if (!instruction) continue;

      // A car caught BETWEEN nodes by this reply consumes only route
      // refinement: when the fresh path still runs through the leg being
      // driven, the full remaining route is adopted wholesale; anything
      // older than the live leg is skipped and the next periodic state
      // send realigns within one STATE_TICK_MS. Lifecycle transitions -
      // parking, leaving, eviction - keep their standstill anchor below,
      // exactly as before.
      if (car.toNode !== car.fromNode) {
        if (instruction.status !== "routing") continue;
        if (instruction.path[0] !== car.fromNode) continue;
        if (instruction.path[1] !== car.toNode) continue;
        const slotChanged = instruction.slot !== car.slot;
        car.slot = instruction.slot;
        if (slotChanged) changed = true;
        publishRoutePlan(car, instruction.path.slice(2));
        continue;
      }

      // The drivable car is a participant but not a puppet: guidance is
      // recorded for the HUD and boards, while its position stays physical.
      // It is never moved by instructions, never evicted on failure, and
      // never converted into a static parked car.
      if (car.player) {
        if (instruction.status === "parked") {
          car.status = "parked";
          car.parked = true;
          car.slot = instruction.slot ?? car.fromNode;
          changed = true;
        } else if (instruction.status === "left") {
          car.vacating = null;
          schedulePlayerRespawn();
        } else {
          car.slot = instruction.slot ?? car.slot;
          car.status = instruction.status;
        }
        continue;
      }

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

      // Standing start. A fresh reply for a stationary car always names
      // the node it sits on; guard anyway against malformed frames. The
      // physical entry gate still decides when the journey may begin,
      // keeping stopped traffic from overlapping.
      if (instruction.path[0] !== car.fromNode) continue;
      const next = instruction.path[1] ?? null;
      const beyond = instruction.path[2];
      if (!next || next === car.toNode) continue;
      if (next && isRoadBlocked(lotData, cars, car, next, beyond, map)) {
        // Road is blocked: cache the full path (including the first hop)
        // so Car.tsx can retry the departure every frame via its heldNode
        // mechanism instead of waiting for the next server reply (~400ms).
        car.slot = instruction.slot;
        publishRoutePlan(car, instruction.path.slice(1));
        continue;
      }
      car.toNode = next;
      car.status = "routing";
      car.slot = instruction.slot;
      changed = true;
      // Hand over everything beyond the first hop so the car rolls
      // through later nodes without another round trip per hop.
      publishRoutePlan(car, instruction.path.slice(2));
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
        current.some((car) => (car.parked && !car.player) || gone.has(car.id))
          ? current.filter((car) => (!car.parked || car.player) && !gone.has(car.id))
          : current,
      );
    }

    const activeIds = new Set(cars.map((car) => car.id));
    for (const id of map.keys()) {
      if (!activeIds.has(id)) map.delete(id);
    }

    // Flush any pending board/route updates that were deferred by the
    // throttle on a previous reply. This runs on every reply (even when the
    // rebuild below is skipped) so a throttled change eventually reaches React
    // state without waiting for another structural change.
    if (signPendingRef.current) {
      const now = Date.now();
      if (now - lastSignFlushRef.current >= SIGN_FLUSH_MS) {
        lastSignFlushRef.current = now;
        signPendingRef.current = false;
        setNodeSigns(pendingSignsRef.current);
      }
    }
    if (routePendingRef.current) {
      const now = Date.now();
      if (now - lastRouteFlushRef.current >= SIGN_FLUSH_MS) {
        lastRouteFlushRef.current = now;
        routePendingRef.current = false;
        setCarRoutes(pendingRoutesRef.current);
      }
    }

    // Skip the expensive queues/signList/routes rebuild when neither the
    // instructions nor any car's lifecycle state changed structurally since
    // the last reply. This drops the per-reply cost from ~15-25 object
    // allocations + 2 long signature strings to near zero in steady state.
    if (!changed && !instructionsChanged) return;

    const queues = new Map<string, BoardCar[]>();
    for (const car of cars) {
      if (car.parked || car.status === "no_slot" || car.status === "no_path") continue;
      const instruction = map.get(car.id);
      if (!instruction) continue;
      const route = instruction.path.length > 0 ? instruction.path : [instruction.node];

      // Boards must describe where the car IS, not where it reported itself
      // one round trip ago: the instruction path starts at the node of the
      // PREVIOUS state send, so anchoring the scan to the head of the path
      // attached cars to turns they had already passed whenever a reply
      // arrived late. Anchor instead to the car's LIVE leg - the route
      // index it is physically driving right now - and accumulate board
      // distances from the far end of that leg using its motion progress.
      // Fall back to the start of the route when the reply predates the
      // live graph entirely.
      let legIndex = -1;
      for (let index = 0; index + 1 < route.length; index += 1) {
        if (route[index] === car.fromNode && route[index + 1] === car.toNode) {
          legIndex = index;
          break;
        }
      }
      const startHop = legIndex >= 0 ? legIndex + 1 : 1;
      let travelled = 0;
      if (legIndex >= 0) {
        const legProgress = Math.min(1, Math.max(0, car.progress));
        travelled = (1 - legProgress) * nodeGap(lotData, route[legIndex], route[legIndex + 1]);
      } else if (route.length > 1) {
        travelled = nodeGap(lotData, route[0], route[1]);
      }

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
          .map((car) => `${car.plate}|${car.direction}|${car.slot}`)
          .join(",")}`,
      )
      .join("|");
    nodeSignsRef.current = signList;
    if (signSignature !== lastSignSignatureRef.current) {
      lastSignSignatureRef.current = signSignature;
      pendingSignsRef.current = signList;
      signPendingRef.current = true;
    }
    // Try an immediate flush if the throttle window is already open; otherwise
    // the pre-gate flush check on the next reply will pick it up.
    if (signPendingRef.current) {
      const now = Date.now();
      if (now - lastSignFlushRef.current >= SIGN_FLUSH_MS) {
        lastSignFlushRef.current = now;
        signPendingRef.current = false;
        setNodeSigns(pendingSignsRef.current);
      }
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
        nextDirection: instruction.next_direction,
      });
    }
    // Exclude routeDistance from the signature entirely so setCarRoutes fires
    // only on structural changes (path/slot reassignment), not on every 80ms
    // reply where AI cars move ~0.56u and the unrounded distance churns. Live
    // distances are already pushed to the HUD via playerSpeedRef and Car's
    // own useFrame; the route list does not need per-reply distance updates.
    const routeSignature = routes
      .map((route) => `${route.carId}:${route.slot ?? "-"}:${route.path.join(">")}`)
      .join("|");
    if (routeSignature !== lastRouteSignatureRef.current) {
      lastRouteSignatureRef.current = routeSignature;
      pendingRoutesRef.current = routes;
      routePendingRef.current = true;
    }
    if (routePendingRef.current) {
      const now = Date.now();
      if (now - lastRouteFlushRef.current >= SIGN_FLUSH_MS) {
        lastRouteFlushRef.current = now;
        routePendingRef.current = false;
        setCarRoutes(pendingRoutesRef.current);
      }
    }
  }, [schedulePlayerRespawn]);

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
      const incomingCount = activeCarsRef.current.filter(
        (car) => !car.leaving && !car.player,
      ).length;
      const entryBlocked = activeCarsRef.current.some(
        (car) =>
          !car.player &&
          car.fromNode === ENTRY_NODE &&
          car.toNode === ENTRY_NODE,
      );
      const current = settingsRef.current;
      if (current.speed === 0) return;
      if (
        incomingCount < current.targetCars &&
        !entryBlocked &&
        now - lastSpawnRef.current > current.spawnEverySec * 1000
      ) {
        const car = spawnCar();
        setActiveCars((existing) => {
          const activeAi = existing.filter((c) => !c.leaving && !c.player).length;
          if (activeAi >= current.targetCars) return existing;
          return [...existing, car];
        });
        // Reset cooldown based on the ref check we already did (not the
        // setState callback, which runs async during render). The ref may
        // be stale by one frame, but the entryBlocked + incomingCount guard
        // above already proved the slot is free.
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
      const leavingCount = activeCarsRef.current.filter((car) => car.leaving && !car.player).length;
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
        (car) =>
          !car.player &&
          car.fromNode === ENTRY_NODE &&
          car.toNode === ENTRY_NODE,
      )
    ) {
      return;
    }
    setActiveCars((current) => [...current, spawnCar()]);
    lastSpawnRef.current = Date.now();
  }, []);

  const enterCar = useCallback(() => {
    setActiveCars((current) =>
      current.some((car) => car.player) ? current : [...current, spawnPlayerCar()],
    );
    setPlayerDriving(true);
    setPlayerRunId((runId) => runId + 1);
  }, []);

  const exitCar = useCallback(() => {
    if (playerRespawnTimerRef.current) {
      clearTimeout(playerRespawnTimerRef.current);
      playerRespawnTimerRef.current = null;
    }
    instructionsRef.current.delete(PLAYER_ID);
    setActiveCars((current) => current.filter((car) => !car.player));
    setPlayerDriving(false);
  }, []);

  const reportPlayerNode = useCallback((nodeId: string) => {
    setActiveCars((current) =>
      current.map((car) => {
        if (!car.player || car.fromNode === nodeId) return car;
        return { ...car, fromNode: nodeId, toNode: nodeId };
      }),
    );
  }, []);

  const playerLeaveBay = useCallback(() => {
    let requested = false;
    setActiveCars((current) =>
      current.map((car) => {
        if (!car.player || car.leaving) return car;
        requested = true;
        return {
          ...car,
          leaving: true,
          parked: false,
          vacating: car.slot ?? car.fromNode,
          slot: null,
          status: "routing",
        };
      }),
    );
    if (requested) sendState();
  }, [sendState]);

  const clearRoad = useCallback(() => {
    // The drivable car survives a road clear; only the traffic goes.
    setActiveCars((current) => current.filter((car) => car.player));
    for (const id of [...instructionsRef.current.keys()]) {
      if (id !== PLAYER_ID) instructionsRef.current.delete(id);
    }
  }, []);

  const resetGarage = useCallback(() => {
    const current = lotRef.current;
    if (!current) return;
    setActiveCars((cars) => cars.filter((car) => car.player));
    setParked([]);
    setPreParked(generatePreParked(current, settingsRef.current.fill));
    for (const id of [...instructionsRef.current.keys()]) {
      if (id !== PLAYER_ID) instructionsRef.current.delete(id);
    }
    lastSpawnRef.current = Date.now();
    respawnPlayer();
  }, [respawnPlayer]);

  useEffect(() => {
    return () => {
      if (playerRespawnTimerRef.current) clearTimeout(playerRespawnTimerRef.current);
    };
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
    playerDriving,
    playerRunId,
    onArrive,
    settings,
    updateSettings,
    spawnNow,
    clearRoad,
    resetGarage,
    enterCar,
    exitCar,
    reportPlayerNode,
    playerLeaveBay,
  };
}
