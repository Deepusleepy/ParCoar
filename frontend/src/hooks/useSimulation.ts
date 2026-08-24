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
  StateCar,
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

/** Test-only setter for the shared world lot. Not used at runtime. */
export function __setSharedWorldLotForTests(l: LotData): void {
  sharedWorld.lot = l;
  sharedWorld.cars = [];
  sharedWorld.instructions = new Map();
}

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
    // Degenerate: car is effectively at the node. Use a radial check
    // but also require the player to be roughly in the same lane
    // (not clearly in the oncoming lane) to avoid blocking when the
    // player is passing through an intersection in the perpendicular
    // direction.
    const dpx = pp.x - tx;
    const dpz = pp.z - tz;
    if (Math.hypot(dpx, dpz) > CAR_LENGTH * 2) return false;
    return Math.hypot(dpx, dpz) < CAR_LENGTH;
  }
  const ux = dx / legDist;
  const uz = dz / legDist;

  // Compute the player's forward and lateral position relative to the
  // road CENTERLINE (not the AI car's lane-shifted position). The AI car
  // is lane-shifted by LANE_SHIFT = -LANE_WIDTH/2 (via cross(tangent, up)),
  // but the player is physics-based and can be anywhere on the road.
  // Comparing the player's actual position to the AI car's lane-shifted
  // position gives a lateral distance of LANE_WIDTH/2 when the player is
  // at the centerline — which is less than the old threshold and would
  // incorrectly block. Instead, measure lateral from the centerline and
  // use the SIGNED value to determine which side the player is on.
  //
  // For +X travel (ux=1, uz=0): lateral = -vz. The AI car is at -Z
  // (LANE_SHIFT = -LANE_WIDTH/2 via cross(tangent,up) = [0,0,1] * -W/2).
  // So lateral > 0 means the player is at -Z (same lane as AI), and
  // lateral < 0 means the player is at +Z (oncoming lane).
  const vx = pp.x - cx;
  const vz = pp.z - cz;
  const radial = Math.hypot(vx, vz);
  const forward = vx * ux + vz * uz;
  const lateral = vx * uz - vz * ux; // signed: + = same lane, - = oncoming

  // Radial guard: if the player is far from the AI car in ANY direction,
  // it cannot be a collision risk. This handles turn nodes where the
  // forward projection onto the NEW leg's direction is near zero even
  // though the player has reversed far away on the PREVIOUS leg. Without
  // this, a player who was beside the AI car at an intersection and then
  // reversed would keep the AI car frozen because forward ≈ 0 relative
  // to the new leg.
  if (radial > CAR_LENGTH * 2) return false;

  // Player clearly in the oncoming lane (signed lateral <= -threshold)
  // — let the AI car pass.
  if (lateral <= -LANE_WIDTH * 0.4) return false;
  // Player too far laterally on the same side to be on this road (e.g.
  // parked in a slot 6 units off the aisle, or on a perpendicular leg at
  // a turn). The radial guard above handles players far in any direction,
  // but a player within CAR_LENGTH*2 yet off the road (lateral >
  // LANE_WIDTH) still freezes the AI car because forward ≈ 0 relative
  // to the new leg at a turn or when the player is in a slot.
  if (lateral > LANE_WIDTH) return false;
  // Player clearly behind — not blocking entry to a node ahead.
  if (forward < -CAR_LENGTH * 0.5) return false;
  // Player ahead in the same lane near the car — block. The bound is a
  // fixed stopping distance (a few car lengths), NOT the full leg length:
  // the old `forward > legDist + CAR_LENGTH` upper bound held the AI car at
  // the entry whenever the player was anywhere ahead on the whole leg, so
  // on long aisles the AI car froze at the entry until the player passed the
  // target node. A player far ahead is not an obstacle; the per-frame gate
  // in Car.tsx handles a player that closes in mid-leg.
  const PLAYER_ENTRY_HOLD = CAR_LENGTH * 3;
  if (forward > PLAYER_ENTRY_HOLD) return false;
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

/** Read the player car's live physical position, or null when no player is
 *  in the garage. Used by the per-frame AI gate in Car.tsx to avoid driving
 *  through a player stopped mid-leg (the node-entry gate only checks at
 *  graph crossings). */
export function readPlayerPos(): { x: number; z: number; floor: number } | null {
  return sharedWorld.playerPos;
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
        // Generate pre-parked cars SYNCHRONOUSLY, not via requestIdleCallback.
        // The previous async generation (requestIdleCallback with a 1s
        // timeout) could be delayed on a busy page, causing the first
        // WebSocket state message to report empty occupied_slots. The
        // backend would then assign AI cars to slots that are visually
        // occupied by pre-parked cars, causing overlap when the AI car
        // arrives before the pre-parked cars are reported. Synchronous
        // generation ensures occupied_slots is populated before the first
        // state message is sent.
        if (!cancelled) setPreParked(generatePreParked(data));
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
    //
    // Exception: while the player is driving, its live world position is
    // mutated every frame in sharedWorld.playerPos but never marks the
    // payload dirty (per-frame movement doesn't change activeCars). The
    // backend's adjust_distance_for_pos reads entry.pos, so a stale resend
    // would freeze route_distance at the last dirty-build position (e.g. the
    // spawn E0 position right after start). Force a rebuild every tick while
    // the player is in the garage with a live position so pos stays fresh.
    const playerLive =
      activeCarsRef.current.some((car) => car.player) &&
      sharedWorld.playerPos !== null;
    if (!dirtyRef.current && !playerLive) {
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
      .map((car) => {
        const entry: StateCar = {
          id: car.id,
          color: car.color,
          plate: car.plate,
          node: car.fromNode,
          leaving: car.leaving,
          assigned_slot: car.leaving ? null : car.slot,
          vacating_slot: car.vacating,
        };
        // The player is physical: its reported node is sparse and stale, so
        // also send its live world position. The backend uses this to adjust
        // route_distance from where the car actually is, not the stale node.
        if (car.player && sharedWorld.playerPos) {
          entry.pos = {
            x: sharedWorld.playerPos.x,
            z: sharedWorld.playerPos.z,
            floor: sharedWorld.playerPos.floor,
          };
        }
        return entry;
      });

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
          const slotChanged = instruction.slot !== car.slot;
          const statusChanged = instruction.status !== car.status;
          car.slot = instruction.slot ?? car.slot;
          car.status = instruction.status;
          if (slotChanged || statusChanged) changed = true;
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
      setActiveCars((current) => {
        const needsFilter = current.some(
          (car) => (car.parked && !car.player) || gone.has(car.id),
        );
        if (needsFilter) {
          return current.filter((car) => (!car.parked || car.player) && !gone.has(car.id));
        }
        // When `changed` is true but no cars need filtering (e.g. the player's
        // slot/status were mutated in place), still produce a new array so React
        // re-renders and DrivableCar receives the updated assignedSlot prop.
        return changed ? [...current] : current;
      });
    }

    const activeIds = new Set(cars.map((car) => car.id));
    for (const id of map.keys()) {
      if (!activeIds.has(id)) map.delete(id);
    }

    // Flush any pending board updates that were deferred by the throttle on a
    // previous reply. This runs on every reply (even when the rebuild below is
    // skipped) so a throttled change eventually reaches React state without
    // waiting for another structural change.
    if (signPendingRef.current) {
      const now = Date.now();
      if (now - lastSignFlushRef.current >= SIGN_FLUSH_MS) {
        lastSignFlushRef.current = now;
        signPendingRef.current = false;
        setNodeSigns(pendingSignsRef.current);
      }
    }

    // Routes are rebuilt on EVERY reply (not gated on instructionsChanged)
    // because the route list carries route_distance, which changes every
    // reply as cars move. The signature-based gate below would skip the
    // rebuild between node crossings, freezing the distance readout shown in
    // RoutePanel. The rebuild is cheap (one pass over active cars, no sorting
    // or directionAt calls); the 4Hz throttle on setCarRoutes still caps the
    // React re-render rate, so the heavy App tree only updates 4x/sec.
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
    pendingRoutesRef.current = routes;
    routePendingRef.current = true;
    {
      const now = Date.now();
      if (now - lastRouteFlushRef.current >= SIGN_FLUSH_MS) {
        lastRouteFlushRef.current = now;
        routePendingRef.current = false;
        setCarRoutes(pendingRoutesRef.current);
      }
    }

    // Skip the expensive queues/signList rebuild when neither the instructions
    // nor any car's lifecycle state changed structurally since the last reply,
    // AND no sign flush is due. The sign boards carry per-car distance which
    // changes every reply as cars move, so the rebuild must still run at the
    // 4Hz flush rate to keep board distances live. Without this, a car just
    // driving down an aisle (no structural change) would freeze the distance
    // on every overhead board until the next turn/slot transition.
    if (
      !changed &&
      !instructionsChanged &&
      Date.now() - lastSignFlushRef.current < SIGN_FLUSH_MS
    ) {
      return;
    }

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
      if (car.player && sharedWorld.playerPos && sharedWorld.playerPos.floor >= 0) {
        // The player is physics-based: progress is always 0 and fromNode/
        // toNode are stale (updated every ~150ms). Use the live world
        // position to find the nearest node in the route, then measure
        // from the actual position to the next node. This keeps the
        // signboard distance accurate instead of frozen at a stale value.
        const pp = sharedWorld.playerPos;
        // Find the LEG the player is currently driving, not the nearest
        // node. The nearest node can be the one AHEAD of the player
        // (once the player passes the midpoint of a segment), and
        // measuring from the player to the node after that skips the
        // partial segment the player is still on and uses a straight-
        // line distance instead of the path distance. Project the
        // player onto each route segment and pick the closest one; the
        // remaining distance is the path distance from the player to the
        // end of that leg.
        let legStart = 0;
        let bestLegDist = Infinity;
        let legProgress = 0;
        for (let i = 0; i + 1 < route.length; i += 1) {
          const a = lotData.nodes[route[i]];
          const b = lotData.nodes[route[i + 1]];
          if (!a || !b || a.floor !== pp.floor) continue;
          const [ax, , az] = toWorld(a.x, a.y, a.floor);
          const [bx, , bz] = toWorld(b.x, b.y, b.floor);
          const dx = bx - ax, dz = bz - az;
          const segLen2 = dx * dx + dz * dz;
          if (segLen2 === 0) continue;
          let t = ((pp.x - ax) * dx + (pp.z - az) * dz) / segLen2;
          if (t < 0) t = 0; else if (t > 1) t = 1;
          const px = ax + t * dx, pz = az + t * dz;
          const d = Math.hypot(pp.x - px, pp.z - pz);
          if (d < bestLegDist) {
            bestLegDist = d;
            legStart = i;
            legProgress = t;
          }
        }
        // Remaining driving distance from the player to the end of the
        // current leg, measured along the path (nodeGap), not straight-
        // line. The loop below adds nodeGap for each hop after
        // playerStartHop, so seed travelled with the partial leg
        // distance and start hopping from the leg's end node.
        const playerStartHop = legStart + 1;
        travelled = (1 - legProgress) * nodeGap(lotData, route[legStart], route[legStart + 1]);
        for (let hop = playerStartHop; hop < route.length; hop += 1) {
          if (hop > playerStartHop) travelled += nodeGap(lotData, route[hop - 1], route[hop]);
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
        continue;
      }
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
          .map((car) => `${car.plate}|${car.direction}|${car.slot}|${Math.round(car.distance)}`)
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

  const onArrive = useCallback(
    (carId: string, node: string) => {
      // Immediately remove leaving cars that arrive at the exit node,
      // without waiting for the backend round trip. The backend will
      // confirm "left" on the next state sync, but the visual should
      // disappear instantly so cars don't queue up at the exit.
      const lot = lotRef.current;
      if (lot && lot.nodes[node]?.type === "exit") {
        setActiveCars((current) => {
          const car = current.find((c) => c.id === carId);
          if (!car || !car.leaving) return current;
          instructionsRef.current.delete(carId);
          return current.filter((c) => c.id !== carId);
        });
      }
      sendState();
    },
    [sendState],
  );

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
    setActiveCars((current) => {
      if (current.some((car) => car.player)) return current;
      // Don't spawn the player on top of an AI car sitting at the entry
      // node. The player has no collision separation against active AI
      // cars (only parked cars), so overlapping at spawn would freeze
      // both cars in place. If the entry is occupied, skip this spawn
      // attempt — the user can press V again once the AI car departs.
      const entryOccupied = current.some(
        (car) => !car.player && car.fromNode === ENTRY_NODE && car.toNode === ENTRY_NODE,
      );
      if (entryOccupied) return current;
      return [...current, spawnPlayerCar()];
    });
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
