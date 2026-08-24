import { createContext } from "react";
import type * as THREE from "three";
import type { ActiveCar, CarRoute, LotData, NodeSign } from "../types";
import type { ParkedCarInstance } from "./Car";
import type { ParkedCarPos, PlayerSpeedRef } from "./DrivableCar";
import type { RoadSegment } from "./roadSegments";
import type { CameraMode } from "./CameraRig";

/**
 * Render-only view of the simulation, pushed to the in-Canvas car tree via a
 * context so that <Scene> does not take the car list as children.
 *
 * <Scene> is wrapped in memo and would re-render whenever its `children` prop
 * changed reference. The car list changes on every traffic event (spawn,
 * depart, park, arrive), so passing it as children dragged the whole Canvas
 * subtree through reconciliation on every event. Feeding it through a context
 * instead keeps <Scene>'s props stable: context updates bypass memo, so only
 * the consumers (the car tree) re-render, not the lights/environment/lot shell.
 */
export interface SimRenderValue {
  lot: LotData;
  cameraMode: CameraMode;
  carGroupsRef: React.MutableRefObject<Map<string, THREE.Group>>;
  playerSpeedRef: React.MutableRefObject<PlayerSpeedRef>;
  activeCars: ActiveCar[];
  parkedCars: ParkedCarInstance[];
  parkedCarPositions: ParkedCarPos[];
  roadSegments: RoadSegment[];
  playerCar: ActiveCar | null;
  playerRoute: CarRoute | null;
  onArrive: (carId: string, node: string) => void;
  playerRunId: number;
  reportPlayerNode: (nodeId: string) => void;
  playerLeaveBay: () => void;
  /** Ref that DrivableCar sets to true when auto-park is available.
   *  The HUD polls this to show a "Press P to park" prompt without
   *  triggering per-frame re-renders. */
  autoParkAvailableRef: React.MutableRefObject<boolean>;
}

export const SimRenderContext = createContext<SimRenderValue | null>(null);

/**
 * Dynamic sign-board data, split into its own context so <ParkingLot> only
 * re-renders when the signs actually change (deduplicated by the sim hook),
 * not on every active-car event.
 */
export const NodeSignsContext = createContext<NodeSign[] | null>(null);
