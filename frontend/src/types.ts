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

export type Direction = "left" | "right" | "straight" | "up" | "down" | "arrived";

export type CarStatus = "routing" | "parked" | "no_slot" | "no_path" | "left";

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

/** Compatibility marker for the renderer. All bays use the same value. */
export type SlotSize = "standard";

/** Visual vehicle model only. It has no effect on bay assignment. */
export type CarSize = "small" | "medium" | "large";

export interface LotNode {
  type: NodeType;
  floor: number;
  x: number;
  y: number;
  /** Renderer compatibility only; never used by routing. */
  size?: SlotSize;
}

export interface LotEdge {
  dir: Direction;
  to: string;
  /** Physical distance driven along this directed edge. */
  cost: number;
}

export interface LotData {
  floors: number;
  floor_height: number;
  aisles_per_floor: number;
  junctions_per_aisle: number;
  junction_spacing: number;
  aisle_spacing: number;
  slot_offset: number;
  road_width?: number;
  slot_depth?: number;
  ramp_outset?: number;
  ramp_corner_radius?: number;
  nodes: Record<string, LotNode>;
  edges: Record<string, LotEdge[]>;
}

// --- WebSocket messages (must match shared/spec.md) -----------------

export interface StateCar {
  id: string;
  color: CarColor;
  plate: string;
  node: string;
  leaving: boolean;
  /** Existing reservation, sent so a reconnect can resume it. */
  assigned_slot: string | null;
  /** Bay still physically occupied while a departing car reverses out. */
  vacating_slot: string | null;
}

export interface StateMessage {
  type: "state";
  cars: StateCar[];
  /** Physical bay-sensor snapshot: pre-parked, parked, and currently vacating. */
  occupied_slots: string[];
}

export type DestinationType = "bay" | "exit" | null;

export interface InstructionSign {
  car_id: string;
  color: CarColor;
  plate: string;
  node: string;
  direction: Direction | null;
  destination: string | null;
  destination_type: DestinationType;
  destination_floor: number | null;
  /** Parking bay only. Null while leaving or when no bay exists. */
  slot: string | null;
  status: CarStatus;
  next_node: string | null;
  next_direction: Direction | null;
  path: string[];
  /** Remaining physical driving distance in lot units. */
  route_distance: number;
  estimated_seconds: number;
}

export interface InstructionsMessage {
  type: "instructions";
  signs: InstructionSign[];
}

export type ServerMessage = InstructionsMessage;

// --- Runtime car model (frontend-side) ------------------------------

export interface ActiveCar {
  id: string;
  color: CarColor;
  plate: string;
  /** Visual model/body dimensions only; Python never receives this. */
  size: CarSize;
  fromNode: string;
  toNode: string;
  progress: number;
  slot: string | null;
  status: CarStatus;
  parked: boolean;
  vacating: string | null;
  leaving: boolean;
}

export interface CarRoute {
  carId: string;
  plate: string;
  color: CarColor;
  slot: string | null;
  path: string[];
  floor: number;
  routeDistance: number;
  estimatedSeconds: number;
  destinationType: DestinationType;
}

export interface BoardCar {
  carId: string;
  color: CarColor;
  plate: string;
  direction: Direction;
  slot: string;
  leaving: boolean;
  distance: number;
}

export interface NodeSign {
  nodeId: string;
  floor: number;
  cars: BoardCar[];
}
