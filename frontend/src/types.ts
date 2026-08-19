// ParCoar shared types: lot layout, messages, and runtime car state.

export type NodeType =
  | "entry"
  | "junction"
  | "slot"
  | "turn"
  | "ramp_up"
  | "ramp_in"
  | "exit"
  | "approach";

export type SlotSize = "small" | "medium" | "large";

export type Direction = "left" | "right" | "straight" | "up" | "arrived";

export type CarStatus = "routing" | "parked" | "no_slot" | "left";

export type CarColor =
  | "red"
  | "blue"
  | "green"
  | "yellow"
  | "orange"
  | "purple"
  | "cyan"
  | "white"
  | "silver";

/** A node in the lot graph, as defined in lot.json. */
export interface LotNode {
  type: NodeType;
  floor: number;
  x: number;
  y: number;
  size?: SlotSize;
}

/** A directed edge from one node to another with a direction label. */
export interface LotEdge {
  dir: Direction;
  to: string;
}

export interface LotData {
  floors: number;
  floor_height: number;
  aisles_per_floor: number;
  junctions_per_aisle: number;
  junction_spacing: number;
  aisle_spacing: number;
  slot_offset: number;
  /** Full driving-road width across both lanes (mirrors constants.ROAD_WIDTH). */
  road_width?: number;
  /** Parking bay depth perpendicular to the aisle (mirrors constants.SLOT_DEPTH). */
  slot_depth?: number;
  nodes: Record<string, LotNode>;
  edges: Record<string, LotEdge[]>;
}

// --- WebSocket messages (must match shared/spec.md exactly) ---

export interface StateCar {
  id: string;
  color: CarColor;
  plate: string;
  size: SlotSize;
  node: string;
}

export interface StateMessage {
  type: "state";
  cars: StateCar[];
  /** Slot node IDs that already have a car (pre-parked + parked). */
  occupied_slots: string[];
}

export interface InstructionSign {
  car_id: string;
  color: CarColor;
  plate: string;
  node: string;
  direction: Direction;
  slot: string;
  slot_floor: number;
  status: CarStatus;
  /** Next node on the car's BFS path to its slot (look-ahead for signboards).
   *  The frontend lights up the signboard at this node BEFORE the car arrives,
   *  so the driver sees the direction in advance. null when the car is one
   *  step from its slot or already parked. */
  next_node?: string | null;
  /** Direction to take at `next_node`. null when `next_node` is null. */
  next_direction?: Direction | null;
  /** The car's whole remaining route, current node first, slot last.
   *  Signboards anywhere along this route light up as soon as the car is
   *  heading their way, rather than only once it has arrived underneath. */
  path?: string[];
}

export interface InstructionsMessage {
  type: "instructions";
  signs: InstructionSign[];
}

export type ServerMessage = InstructionsMessage;

// --- Runtime car model (frontend-side) ---

export type CarSize = SlotSize;

/** A car that exists in the simulation (active, moving). */
export interface ActiveCar {
  id: string;
  color: CarColor;
  plate: string;
  size: CarSize;
  /** Current graph node the car is at or just left. */
  fromNode: string;
  /** Node the car is travelling toward (equals fromNode when stationary). */
  toNode: string;
  /** Interpolation progress 0..1 between fromNode and toNode. */
  progress: number;
  /** Assigned slot node id, once known. */
  slot: string | null;
  /** Latest status from the backend. */
  status: CarStatus;
  /** True once the car has settled into its slot and should stop updating. */
  parked: boolean;
  /** True when this car has finished its stay and is driving to the exit.
   *  Leaving cars are routed to the exit node instead of to a bay, and are
   *  removed from the simulation once they get there. */
  leaving: boolean;
}

/** One entry in the roster of active auto-running cars, shown on every
 *  permanent signboard. Computed from the latest backend instructions on
 *  every WS message. */
export interface CarRosterEntry {
  carId: string;
  color: CarColor;
  plate: string;
  slot: string;
  slotFloor: number;
  /** Car's current floor, used to filter the roster per-board so each
   *  signboard only shows cars on its own floor. */
  currentFloor: number;
  status: CarStatus;
}

/** One active car's current route, for the 2D route panel. This is the same
 *  data the signboards use, surfaced so the panel can draw the search result
 *  the Python backend produced. */
export interface CarRoute {
  carId: string;
  plate: string;
  color: CarColor;
  /** Where it is heading: a bay, or the exit if it is on its way out. */
  slot: string | null;
  /** Whole remaining route, current node first. */
  path: string[];
  /** Floor the car is on right now. */
  floor: number;
}

/** A dynamic sign at a junction node, showing info about the car waiting
 *  there. Computed from the latest backend instructions on every WS message
 *  — only present while a car is actually stopped at the node. */
export interface NodeSign {
  nodeId: string;
  carColor: CarColor;
  carPlate: string;
  direction: InstructionSign["direction"];
  slot: string;
  slotFloor: number;
  floor: number;
  nodeX: number;
  nodeY: number;
  /** How many graph hops the car still is from this board. 0 means the car is
   *  here now. Boards use it to show a distance and to dim far-off cars, and
   *  to decide which car wins when two are routed through the same board. */
  hopsAway: number;
}
