// ParCoar shared types: lot layout, messages, and runtime car state.

export type NodeType =
  | "entry"
  | "junction"
  | "slot"
  | "ramp_up"
  | "ramp_in"
  | "exit";

export type SlotSize = "small" | "medium" | "large";

export type Direction = "left" | "right" | "straight" | "up" | "arrived";

export type CarStatus = "routing" | "parked" | "no_slot";

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
}

/** A static, pre-parked car rendered for atmosphere only. */
export interface PreParkedCar {
  slotNode: string;
  color: CarColor;
  plate: string;
  size: CarSize;
}
