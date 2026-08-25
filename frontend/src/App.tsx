import { lazy, memo, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { useSimulation } from "./hooks/useSimulation";
import { Scene, SceneLoadingFallback, type OrbitControlsHandle } from "./sim/Scene";
import { ActiveCarField, ParkedCarField, type ParkedCarInstance } from "./sim/Car";
import type { ParkedCarPos, PlayerSpeedRef } from "./sim/DrivableCar";
import { SimRenderContext, NodeSignsContext, type SimRenderValue } from "./sim/SimContext";
import { SlotHighlight } from "./sim/SlotHighlight";
import { buildRoadSegments } from "./sim/roadSegments";
import { AISLE_SPACING, bayLabel, CAR_Y_OFFSET, COLOR_HEX, toWorld } from "./sim/constants";
import type { CameraMode } from "./sim/CameraRig";
import type { RoutePanelCar } from "./ui/RoutePanel";
import type { LotData } from "./types";
import {
  ControlPanelTab,
  DEFAULT_OVERLAYS,
  type Overlays,
} from "./ui/ControlPanel";

// Code-split the heavy/conditional pieces so the initial bundle is smaller
// and the browser can start WebGL init without first downloading and parsing
// the drivable-car physics (2000+ lines, only used in POV/drive mode), the
// control drawer (only when opened), or the route panel (only when toggled).
const LazyDrivableCar = lazy(() =>
  import("./sim/DrivableCar").then((m) => ({ default: m.DrivableCar })),
);
const LazyControlPanel = lazy(() =>
  import("./ui/ControlPanel").then((m) => ({ default: m.ControlPanel })),
);
const LazyRoutePanel = lazy(() =>
  import("./ui/RoutePanel").then((m) => ({ default: m.RoutePanel })),
);

const EMPTY_SIGNS: import("./types").NodeSign[] = [];
/** Stable empty array for the DrivableCar routePath prop so the `?? []`
 *  fallback doesn't create a new array reference each render and break
 *  React.memo on the (already memoized) DrivableCar component. */
const EMPTY_PATH: string[] = [];

export function App() {
  const sim = useSimulation();
  const controlsRef = useRef<OrbitControlsHandle | null>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>("orbit");
  const [routeCarId, setRouteCarId] = useState<string | null>(null);
  const [followCarId, setFollowCarId] = useState<string | null>(null);
  const carGroupsRef = useRef<Map<string, THREE.Group>>(new Map());
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__parcoarCarGroups = carGroupsRef.current;
  }
  const [panelOpen, setPanelOpen] = useState(false);
  const [overlays, setOverlays] = useState<Overlays>(DEFAULT_OVERLAYS);
  const playerSpeedRef = useRef<PlayerSpeedRef>({ speed: 0, routeDistance: -1, overshot: false });
  const autoParkAvailableRef = useRef(false);
  // Stable callback so memo(DrivableCar) doesn't re-render on every SimContents
  // render. The callback only mutates a ref — no state, no deps.
  const onAutoParkAvailable = useCallback((available: boolean) => {
    autoParkAvailableRef.current = available;
  }, []);
  // Wrong-bay prompt: DrivableCar calls this when the player settles in a
  // non-assigned bay. The slot id is stored in a ref and polled by the HUD.
  const wrongBaySlotRef = useRef<string | null>(null);
  const onWrongBayPrompt = useCallback((slotId: string | null) => {
    wrongBaySlotRef.current = slotId;
  }, []);

  const patchOverlays = (patch: Partial<Overlays>) =>
    setOverlays((current) => ({ ...current, ...patch }));

  useEffect(() => {
    if (cameraMode !== "follow") return;
    // Only follow active (non-parked, non-leaving) AI cars. When the followed
    // car parks or leaves, it drops out of this list and we auto-switch to
    // the next available car.
    const ids = sim.activeCars
      .filter((car) => !car.player && !car.parked && !car.leaving)
      .map((car) => car.id);
    if (followCarId && !ids.includes(followCarId)) setFollowCarId(null);
    if (!followCarId && ids.length > 0) setFollowCarId(ids[0]);
  }, [cameraMode, followCarId, sim.activeCars]);

  useEffect(() => {
    const ids = sim.carRoutes.map((route) => route.carId);
    if (routeCarId && !ids.includes(routeCarId)) setRouteCarId(ids[0] ?? null);
    else if (!routeCarId && ids.length > 0) setRouteCarId(ids[0]);
  }, [sim.carRoutes, routeCarId]);

  // Entering a driving mode puts the player car in the garage as a real
  // participant; leaving removes it. The sim keeps the connection and all
  // other state across the switch.
  useEffect(() => {
    if (cameraMode === "pov" || cameraMode === "drive") sim.enterCar();
    else sim.exitCar();
  }, [cameraMode, sim.enterCar, sim.exitCar]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) return;
      const key = event.key.toLowerCase();
      // 'v' toggles POV even while the pointer is locked (the normal state
      // while driving), so the driver can exit the cockpit without first
      // pressing Escape to release the mouse.
      if (key === "v") {
        setCameraMode((current) => (current === "pov" ? "orbit" : "pov"));
        return;
      }
      if (document.pointerLockElement) return;
      if (key === "c") setPanelOpen((open) => !open);
      else if (key === "m") patchOverlays({ routeMap: !overlays.routeMap });
      else if (key === "p") {
        sim.updateSettings({ speed: sim.settings.speed === 0 ? 1 : 0 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlays.routeMap, sim.settings.speed, sim.updateSettings]);

  const lot = sim.lot;

  const parkedCarPositions = useMemo<ParkedCarPos[]>(() => {
    if (!lot) return [];
    const positions: ParkedCarPos[] = [];
    for (const car of [...sim.preParked, ...sim.parked]) {
      const node = lot.nodes[car.slotNode];
      if (!node) continue;
      const [x, y, z] = toWorld(node.x, node.y, node.floor);
      positions.push({ x, y, z });
    }
    return positions;
  }, [lot, sim.preParked, sim.parked]);

  const parkedCars = useMemo<ParkedCarInstance[]>(() => {
    if (!lot) return [];
    const cars: ParkedCarInstance[] = [];
    const add = (car: {
      slotNode: string;
      color: import("./types").CarColor;
      size: import("./types").CarSize;
    }) => {
      const node = lot.nodes[car.slotNode];
      if (!node) return;
      const [x, y, z] = toWorld(node.x, node.y, node.floor);
      const aisleY = Math.round(node.y / AISLE_SPACING) * AISLE_SPACING;
      const rotationY = node.y < aisleY ? Math.PI / 2 : -Math.PI / 2;
      cars.push({
        slotNode: car.slotNode,
        color: car.color,
        size: car.size,
        position: [x, y + CAR_Y_OFFSET, z],
        rotationY,
      });
    };
    for (const car of sim.preParked) add(car);
    for (const car of sim.parked) add(car);
    return cars;
  }, [lot, sim.preParked, sim.parked]);

  const routePanelCars = useMemo<RoutePanelCar[]>(
    () => sim.carRoutes.map((route) => ({ ...route, color: COLOR_HEX[route.color] })),
    [sim.carRoutes],
  );
  const roadSegments = useMemo(() => (lot ? buildRoadSegments(lot) : []), [lot]);

  // The drivable car's live guidance, derived from the same instructions the
  // boards use. No separate channel: the player is just another car.
  const playerCar = sim.activeCars.find((car) => car.player) ?? null;

  // Auto-exit drive/POV when the player parks. The player has no reason to
  // stay in the cockpit after parking — switch to orbit so they can see the
  // garage and watch traffic. The player can press V to re-enter if they want.
  useEffect(() => {
    if (playerCar?.status === "parked" && (cameraMode === "pov" || cameraMode === "drive")) {
      setCameraMode("orbit");
    }
  }, [playerCar?.status, cameraMode]);
  const playerRoute = sim.carRoutes.find((route) => route.carId === "P0") ?? null;

  // The car tree is fed to <Scene> through a context (see SimContents below)
  // instead of as children, so <Scene>'s memo holds across traffic events.
  // The provider value is memoized so consumers only re-render when one of
  // these fields actually changes.
  const simRenderValue = useMemo<SimRenderValue | null>(
    () =>
      lot
        ? {
            lot,
            cameraMode,
            carGroupsRef,
            playerSpeedRef,
            activeCars: sim.activeCars,
            parkedCars,
            parkedCarPositions,
            roadSegments,
            playerCar,
            playerRoute,
            onArrive: sim.onArrive,
            playerRunId: sim.playerRunId,
            reportPlayerNode: sim.reportPlayerNode,
            playerLeaveBay: sim.playerLeaveBay,
            autoParkAvailableRef,
            onAutoParkAvailable,
            onWrongBayPrompt,
          }
        : null,
    [
      lot,
      cameraMode,
      carGroupsRef,
      playerSpeedRef,
      sim.activeCars,
      parkedCars,
      parkedCarPositions,
      roadSegments,
      playerCar,
      playerRoute,
      sim.onArrive,
      sim.playerRunId,
      sim.reportPlayerNode,
      sim.playerLeaveBay,
      onAutoParkAvailable,
      onWrongBayPrompt,
    ],
  );

  // nodeSigns live in their own context so <ParkingLot> only re-renders when
  // the signs actually change (the sim hook deduplicates sign updates), not
  // on every active-car event.
  const nodeSignsValue = useMemo(
    () => (overlays.boardGuidance ? sim.nodeSigns : EMPTY_SIGNS),
    [overlays.boardGuidance, sim.nodeSigns],
  );

  // Followable cars, with a content-stable reference: the array identity only
  // changes when the set of followable car ids changes, so a memoized
  // <CameraControls> skips re-rendering on traffic events that don't touch
  // the followable set.
  const followableCars = useStableFollowable(sim.activeCars);

  const activeCount = sim.activeCars.length;
  const parkedCount = sim.preParked.length + sim.parked.length;

  return (
    <div className="relative h-full w-full bg-[#0a0b0e]">
      <NodeSignsContext.Provider value={nodeSignsValue}>
        <SimRenderContext.Provider value={simRenderValue}>
          {/* The Canvas mounts unconditionally so WebGL context creation,
              PMREM bake, lights and the camera rig can all start in parallel
              with the /lot.json fetch. <ParkingLot> waits for the lot
              internally; the car tree (SimContents) renders nothing until the
              lot is available. */}
          <Scene
            controlsRef={controlsRef}
            cameraMode={cameraMode}
            followCarId={followCarId}
            carGroupsRef={carGroupsRef}
            lot={lot}
          >
            {SIM_CONTENTS}
          </Scene>
        </SimRenderContext.Provider>
      </NodeSignsContext.Provider>

      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-4">
        {(cameraMode === "pov" || cameraMode === "drive") && (
          <PlayerGuidance
            status={playerCar?.status ?? "routing"}
            leaving={playerCar?.leaving ?? false}
            slot={playerRoute?.slot ?? null}
            destinationType={playerRoute?.destinationType ?? null}
            distance={playerRoute?.routeDistance ?? 0}
            nextDirection={playerRoute?.nextDirection ?? null}
            speedRef={playerSpeedRef}
          />
        )}
        <div className="flex items-start justify-between">
          <div className="rounded-lg border border-neutral-800 bg-[#0a0b0e] px-3 py-2">
            <div className="text-lg font-semibold tracking-tight text-white">ParCoar</div>
            <div className="text-xs text-neutral-400">Parking guidance simulator</div>
          </div>
          <div
            className={
              "flex flex-col items-end gap-1 rounded-lg border border-neutral-800 bg-[#0a0b0e] px-3 py-2 text-[11px] " +
              (overlays.status ? "" : "hidden")
            }
          >
            <StatusRow
              label="Backend"
              value={sim.connected ? "connected" : "disconnected"}
              tone={sim.connected ? "ok" : "bad"}
            />
            <StatusRow label="Active" value={`${activeCount}`} tone="neutral" />
            <StatusRow label="Parked" value={`${parkedCount}`} tone="neutral" />
          </div>
        </div>

        <div className="flex items-end justify-between">
          <div className="flex items-center gap-3">
            {cameraMode === "pov" || cameraMode === "drive" ? (
              <div className="flex items-center gap-4">
                <div className="text-[11px] font-semibold tracking-wide text-neutral-300">
                  <span className="text-white">W</span> Accelerate
                  <span className="mx-1.5 text-neutral-600">|</span>
                  <span className="text-white">S</span> Brake
                  <span className="mx-1.5 text-neutral-600">|</span>
                  <span className="text-white">A/D</span> Steer
                  <span className="mx-1.5 text-neutral-600">|</span>
                  <span className="text-white">V</span> Exit POV
                  <span className="mx-1.5 text-neutral-600">|</span>
                  <span className="text-white">P</span> Auto-park
                </div>
                <SpeedHud speedRef={playerSpeedRef} />
                <AutoParkPrompt availableRef={autoParkAvailableRef} />
                <WrongBayPrompt slotRef={wrongBaySlotRef} lot={lot} />
              </div>
            ) : (
              <div
                className={
                  "flex items-center gap-3 text-[11px] text-neutral-400 " +
                  (overlays.helpText ? "" : "hidden")
                }
              >
                <span><span className="text-neutral-200">Click</span> capture mouse</span>
                <span><span className="text-neutral-200">W A S D</span> move</span>
                <span><span className="text-neutral-200">Space / Shift</span> up, down</span>
                <span><span className="text-neutral-200">Ctrl</span> boost</span>
                <span><span className="text-neutral-200">Scroll</span> fly forward</span>
                <span><span className="text-neutral-200">V</span> driver POV</span>
              </div>
            )}
            <button
              type="button"
              onClick={() => controlsRef.current?.reset()}
              className="pointer-events-auto rounded border border-neutral-700 bg-black/70 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-neutral-200 hover:border-neutral-500 hover:text-white"
            >
              Reset View
            </button>
          </div>
          {sim.lotFull && (
            <div className="rounded-md border border-red-500/60 bg-black/80 px-3 py-1.5 text-[12px] font-semibold tracking-wide text-red-400">
              NO FREE BAY
            </div>
          )}
        </div>
      </div>

      {overlays.routeMap && lot && cameraMode !== "pov" && cameraMode !== "drive" && (
        <Suspense fallback={null}>
          <LazyRoutePanel
            lot={lot}
            cars={routePanelCars}
            selectedCarId={routeCarId}
            onSelectCar={setRouteCarId}
          />
        </Suspense>
      )}

      <ControlPanelTab open={panelOpen} onOpen={() => setPanelOpen(true)} />
      {panelOpen && (
        <Suspense fallback={null}>
          <LazyControlPanel
            open={panelOpen}
            onClose={() => setPanelOpen(false)}
            settings={sim.settings}
            onSettings={sim.updateSettings}
            overlays={overlays}
            onOverlays={patchOverlays}
            onSpawn={sim.spawnNow}
            onClearRoad={sim.clearRoad}
            onReset={sim.resetGarage}
            activeCount={activeCount}
            parkedCount={parkedCount}
          />
        </Suspense>
      )}

      <CameraControls
        mode={cameraMode}
        onModeChange={setCameraMode}
        followCarId={followCarId}
        onFollowCarChange={setFollowCarId}
        followableCars={followableCars}
      />

      {sim.error && <ErrorOverlay message={sim.error} />}
      {!lot && !sim.error && <LoadingScreen />}
    </div>
  );
}

/**
 * The in-Canvas car tree: parked cars, active AI car meshes, and the
 * drivable car. Reads everything from SimRenderContext so it takes no props
 * and the element instance passed to <Scene> is stable for the life of the
 * app — <Scene>'s memo therefore holds across traffic events, and only this
 * subtree (the context consumers) re-renders when the sim state changes.
 */
const SimContents = memo(function SimContents() {
  const ctx = useContext(SimRenderContext);
  if (!ctx) return null;
  const {
    lot,
    cameraMode,
    carGroupsRef,
    playerSpeedRef,
    activeCars,
    parkedCars,
    parkedCarPositions,
    roadSegments,
    playerCar,
    playerRoute,
    onArrive,
    playerRunId,
    reportPlayerNode,
    playerLeaveBay,
    onAutoParkAvailable,
    onWrongBayPrompt,
  } = ctx;
  return (
    <Suspense fallback={<SceneLoadingFallback />}>
      <ParkedCarField cars={parkedCars} />
      <SlotHighlight
        lot={lot}
        assignedSlot={playerCar?.slot ?? null}
        playerColor={playerCar?.color ?? "red"}
        visible={!!playerCar && playerCar.status !== "parked" && !playerCar.leaving}
      />
      <ActiveCarField
        cars={activeCars.filter((car) => !car.player)}
        lot={lot}
        onArrive={onArrive}
        carGroupsRef={carGroupsRef}
      />
      {(cameraMode === "pov" || cameraMode === "drive") && (
        <LazyDrivableCar
          lot={lot}
          carGroupsRef={carGroupsRef}
          speedRef={playerSpeedRef}
          parkedCars={parkedCarPositions}
          roadSegments={roadSegments}
          pov={cameraMode === "pov"}
          assignedSlot={playerCar?.slot ?? null}
          routePath={playerRoute?.path ?? EMPTY_PATH}
          playerStatus={playerCar?.status ?? "routing"}
          leaving={playerCar?.leaving ?? false}
          runId={playerRunId}
          onReportNode={reportPlayerNode}
          onLeaveBay={playerLeaveBay}
          onAutoParkAvailable={onAutoParkAvailable}
          onWrongBayPrompt={onWrongBayPrompt}
        />
      )}
    </Suspense>
  );
});

// A single stable element instance for <Scene>'s children. SimContents has no
// props and reads from context, so the same element description reconciles
// forever; context updates still drive SimContents re-renders.
const SIM_CONTENTS: ReactNode = <SimContents />;

interface FollowableCar {
  id: string;
  color: import("./types").CarColor;
  plate: string;
  player?: boolean;
}

/**
 * Returns the list of non-player active cars with a stable array identity:
 * the reference only changes when the set of followable car ids changes.
 * Lets a memoized <CameraControls> skip re-rendering on traffic events that
 * don't alter the followable set.
 */
function useStableFollowable(activeCars: { id: string; player?: boolean; parked?: boolean; leaving?: boolean }[]): FollowableCar[] {
  const ref = useRef<{ sig: string; list: FollowableCar[] }>({ sig: "", list: [] });
  return useMemo(() => {
    const list = activeCars.filter(
      (car) => !car.player && !car.parked && !car.leaving,
    ) as FollowableCar[];
    const sig = list.map((car) => car.id).join(",");
    if (sig === ref.current.sig) return ref.current.list;
    ref.current = { sig, list };
    return list;
  }, [activeCars]);
}

function LoadingScreen() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#0a0b0e] text-neutral-300">
      <span className="text-sm font-semibold tracking-[0.18em] text-neutral-400">LOADING</span>
    </div>
  );
}

function ErrorOverlay({ message }: { message: string }) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#0a0b0e]/95 px-6 text-center">
      <div className="max-w-md rounded-lg border border-red-500/30 bg-black/60 p-5">
        <div className="text-sm font-semibold text-red-300">GARAGE COULD NOT START</div>
        <p className="mt-2 text-xs leading-relaxed text-neutral-400">
          {message}
        </p>
        <button
          type="button"
          className="mt-4 rounded border border-neutral-700 px-3 py-1.5 text-xs font-semibold text-neutral-200 hover:border-neutral-500"
          onClick={() => window.location.reload()}
        >
          Retry
        </button>
      </div>
    </div>
  );
}

/**
 * Live speed readout, isolated so the 10 Hz refresh re-renders only this
 * component. Polling from App level re-rendered the whole tree including the
 * Canvas subtree ten times a second while driving.
 */
function SpeedHud({ speedRef }: { speedRef: React.RefObject<PlayerSpeedRef> }) {
  const [speed, setSpeed] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setSpeed(speedRef.current?.speed ?? 0), 100);
    return () => clearInterval(interval);
  }, [speedRef]);
  return (
    <div className="rounded border border-neutral-700 bg-black/70 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-neutral-200">
      {speed >= 0 ? "" : "R "}
      {Math.abs(speed).toFixed(1)} u/s
    </div>
  );
}

function AutoParkPrompt({ availableRef }: { availableRef: React.MutableRefObject<boolean> }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const interval = setInterval(() => setAvailable(availableRef.current), 200);
    return () => clearInterval(interval);
  }, [availableRef]);
  if (!available) return null;
  return (
    <div className="pointer-events-none rounded-md border border-emerald-500/60 bg-black/80 px-3 py-1.5 text-[12px] font-semibold tracking-wide text-emerald-400 animate-pulse">
      Press <span className="text-white">P</span> to auto-park
    </div>
  );
}

function WrongBayPrompt({
  slotRef,
  lot,
}: {
  slotRef: React.MutableRefObject<string | null>;
  lot: LotData | null;
}) {
  const [slotId, setSlotId] = useState<string | null>(null);
  useEffect(() => {
    const interval = setInterval(() => setSlotId(slotRef.current), 200);
    return () => clearInterval(interval);
  }, [slotRef]);
  if (!slotId || !lot) return null;
  const label = lot.nodes[slotId] ? bayLabel(slotId) : slotId;
  return (
    <div className="pointer-events-none rounded-md border border-amber-500/60 bg-black/80 px-3 py-1.5 text-[12px] font-semibold tracking-wide text-amber-400">
      Wrong bay: <span className="text-white">{label}</span> — press{" "}
      <span className="text-white">L</span> to park here, or drive away
    </div>
  );
}

const DIRECTION_WORD: Record<string, string> = {
  left: "LEFT",
  right: "RIGHT",
  straight: "AHEAD",
  up: "UP",
  down: "DOWN",
};

/**
 * The guidance strip shown while driving: where you are going and what to do
 * next, from the same instruction the overhead boards carry.
 */
function PlayerGuidance({
  status,
  leaving,
  slot,
  destinationType,
  distance,
  nextDirection,
  speedRef,
}: {
  status: string;
  leaving: boolean;
  slot: string | null;
  destinationType: "bay" | "exit" | null;
  distance: number;
  nextDirection: string | null;
  speedRef: React.RefObject<PlayerSpeedRef>;
}) {
  // Poll the live route distance from the DrivableCar (updated every frame)
  // so the strip doesn't lag behind by a node gap. The overshot flag is set
  // when the car has driven past the slot — the HUD shows "behind" then.
  const [liveDistance, setLiveDistance] = useState(distance);
  const [overshot, setOvershot] = useState(false);
  useEffect(() => {
    const interval = setInterval(() => {
      const ref = speedRef.current;
      if (ref) {
        setLiveDistance(ref.routeDistance);
        setOvershot(ref.overshot);
      }
    }, 100);
    return () => clearInterval(interval);
  }, [speedRef]);
  useEffect(() => {
    // When the live distance goes stale (-1), fall back to the server value.
    if (speedRef.current?.routeDistance === undefined || speedRef.current.routeDistance < 0) {
      setLiveDistance(distance);
    }
  }, [distance, speedRef]);

  const shownDistance = liveDistance;
  let line: string;
  if (status === "parked") {
    line = `PARKED ${slot ? bayLabel(slot) : ""} — L TO LEAVE`;
  } else if (status === "no_slot") {
    line = "NO FREE BAY";
  } else if (destinationType === "exit" && leaving) {
    line = `${Math.round(shownDistance)} m · ${DIRECTION_WORD[nextDirection ?? ""] ?? ""} → EXIT`;
  } else if (overshot && slot) {
    line = `BAY ${bayLabel(slot)} · ${Math.round(shownDistance)} m BEHIND — TURN AROUND`;
  } else if (slot) {
    line = `BAY ${bayLabel(slot)} · ${Math.round(shownDistance)} m · ${
      DIRECTION_WORD[nextDirection ?? ""] ?? ""
    }`;
  } else {
    line = "WAITING FOR GUIDANCE";
  }
  return (
    <div className="absolute left-1/2 top-4 -translate-x-1/2">
      <div className="rounded-md border border-sky-500/40 bg-black/70 px-3 py-1 text-[12px] font-semibold tracking-wide text-sky-300">
        {line}
      </div>
    </div>
  );
}

const CameraControls = memo(function CameraControls({
  mode,
  onModeChange,
  followCarId,
  onFollowCarChange,
  followableCars,
}: {
  mode: CameraMode;
  onModeChange: (mode: CameraMode) => void;
  followCarId: string | null;
  onFollowCarChange: (id: string | null) => void;
  followableCars: FollowableCar[];
}) {
  const buttons: { id: CameraMode; label: string }[] = [
    { id: "orbit", label: "Orbit" },
    { id: "overview", label: "Overview" },
    { id: "floor0", label: "Floor A" },
    { id: "floor1", label: "Floor B" },
    { id: "floor2", label: "Floor C" },
    { id: "follow", label: "Follow" },
    { id: "pov", label: "POV" },
    { id: "drive", label: "Drive" },
  ];

  return (
    <div className="pointer-events-none absolute bottom-16 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
      <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-1 rounded-lg border border-neutral-800 bg-[#0a0b0e] p-1">
        {buttons.map((button, index) => (
          <div key={button.id} className="flex items-center">
            {(index === 2 || index === 5) && <div className="mx-0.5 h-6 w-px bg-neutral-600" />}
            <button
              type="button"
              onClick={() => onModeChange(button.id)}
              className={
                "rounded-md px-2.5 py-1 text-[11px] font-semibold tracking-wide transition-colors " +
                (mode === button.id
                  ? "bg-white/20 text-white ring-2 ring-white/40"
                  : "text-neutral-400 hover:text-neutral-100")
              }
            >
              {button.label}
            </button>
          </div>
        ))}
      </div>

      {mode === "follow" && (
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-neutral-800 bg-[#0a0b0e] px-2 py-1">
          <span className="text-[11px] font-semibold tracking-wide text-neutral-500">CAR</span>
          {followableCars.length === 0 ? (
            <span className="text-[11px] text-neutral-500">none active</span>
          ) : (
            <select
              value={followCarId ?? ""}
              onChange={(event: { target: { value: string } }) => onFollowCarChange(event.target.value || null)}
              className="bg-transparent text-[11px] font-medium text-neutral-100 outline-none [&>option]:bg-neutral-900"
            >
              {followableCars.map((car) => (
                <option key={car.id} value={car.id}>{car.plate} · {car.color}</option>
              ))}
            </select>
          )}
          {followCarId && (
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{
                backgroundColor: COLOR_HEX[
                  followableCars.find((car) => car.id === followCarId)?.color ?? "white"
                ],
              }}
            />
          )}
        </div>
      )}
    </div>
  );
});

function StatusRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ok" | "bad" | "neutral";
}) {
  const color = tone === "ok" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : "text-neutral-300";
  const dot = tone === "ok" ? "bg-emerald-400" : tone === "bad" ? "bg-red-400" : "bg-neutral-600";
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className="text-neutral-500">{label}</span>
      <span className={`${color} tabular-nums`}>{value}</span>
    </div>
  );
}
