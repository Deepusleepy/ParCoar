import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useSimulation } from "./hooks/useSimulation";
import { Scene, SceneLoadingFallback, type OrbitControlsHandle } from "./sim/Scene";
import { ActiveCarMesh, ParkedCarField, type ParkedCarInstance } from "./sim/Car";
import {
  DrivableCar,
  type ParkedCarPos,
  type PlayerSpeedRef,
} from "./sim/DrivableCar";
import { buildRoadSegments } from "./sim/roadSegments";
import { AISLE_SPACING, CAR_Y_OFFSET, COLOR_HEX, toWorld } from "./sim/constants";
import type { CameraMode } from "./sim/CameraRig";
import { RoutePanel, type RoutePanelCar } from "./ui/RoutePanel";
import {
  ControlPanel,
  ControlPanelTab,
  DEFAULT_OVERLAYS,
  type Overlays,
} from "./ui/ControlPanel";

const EMPTY_SIGNS: import("./types").NodeSign[] = [];

export function App() {
  const sim = useSimulation();
  const controlsRef = useRef<OrbitControlsHandle | null>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>("orbit");
  const [routeCarId, setRouteCarId] = useState<string | null>(null);
  const [followCarId, setFollowCarId] = useState<string | null>(null);
  const carGroupsRef = useRef<Map<string, THREE.Group>>(new Map());
  const [panelOpen, setPanelOpen] = useState(false);
  const [overlays, setOverlays] = useState<Overlays>(DEFAULT_OVERLAYS);
  const playerSpeedRef = useRef<PlayerSpeedRef>({ speed: 0 });
  const [playerSpeed, setPlayerSpeed] = useState(0);

  const patchOverlays = (patch: Partial<Overlays>) =>
    setOverlays((current) => ({ ...current, ...patch }));

  useEffect(() => {
    if (cameraMode !== "follow") return;
    const ids = sim.activeCars.map((car) => car.id);
    if (followCarId && !ids.includes(followCarId)) setFollowCarId(null);
    if (!followCarId && ids.length > 0) setFollowCarId(ids[0]);
  }, [cameraMode, followCarId, sim.activeCars]);

  useEffect(() => {
    const ids = sim.carRoutes.map((route) => route.carId);
    if (routeCarId && !ids.includes(routeCarId)) setRouteCarId(ids[0] ?? null);
    else if (!routeCarId && ids.length > 0) setRouteCarId(ids[0]);
  }, [sim.carRoutes, routeCarId]);

  useEffect(() => {
    if (cameraMode !== "pov" && cameraMode !== "drive") return;
    const interval = setInterval(() => setPlayerSpeed(playerSpeedRef.current.speed), 100);
    return () => clearInterval(interval);
  }, [cameraMode]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) return;
      if (document.pointerLockElement) return;
      const key = event.key.toLowerCase();
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

  if (sim.loading) return <LoadingScreen />;
  if (sim.error || !lot) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#0a0b0e] px-6 text-center">
        <div className="max-w-md rounded-lg border border-red-500/30 bg-black/60 p-5">
          <div className="text-sm font-semibold text-red-300">GARAGE COULD NOT START</div>
          <p className="mt-2 text-xs leading-relaxed text-neutral-400">
            {sim.error ?? "The garage layout is unavailable."}
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

  const activeCount = sim.activeCars.length;
  const parkedCount = sim.preParked.length + sim.parked.length;

  return (
    <div className="relative h-full w-full bg-[#0a0b0e]">
      <Scene
        controlsRef={controlsRef}
        cameraMode={cameraMode}
        followCarId={followCarId}
        carGroupsRef={carGroupsRef}
        lot={lot}
        nodeSigns={overlays.boardGuidance ? sim.nodeSigns : EMPTY_SIGNS}
      >
        <Suspense fallback={<SceneLoadingFallback />}>
          <ParkedCarField cars={parkedCars} />
          {sim.activeCars.map((car) => (
            <ActiveCarMesh
              key={car.id}
              car={car}
              lot={lot}
              onArrive={sim.onArrive}
              carGroupsRef={carGroupsRef}
            />
          ))}
          {(cameraMode === "pov" || cameraMode === "drive") && (
            <DrivableCar
              lot={lot}
              carGroupsRef={carGroupsRef}
              speedRef={playerSpeedRef}
              parkedCars={parkedCarPositions}
              roadSegments={roadSegments}
              pov={cameraMode === "pov"}
            />
          )}
        </Suspense>
      </Scene>

      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-4">
        <div className="flex items-start justify-between">
          <div className="rounded-lg border border-neutral-800 bg-black/60 px-3 py-2 backdrop-blur-sm">
            <div className="text-lg font-semibold tracking-tight text-white">ParCoar</div>
            <div className="text-xs text-neutral-400">Parking guidance simulator</div>
          </div>
          <div
            className={
              "flex flex-col items-end gap-1 rounded-lg border border-neutral-800 bg-black/60 px-3 py-2 text-[11px] backdrop-blur-sm " +
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
                </div>
                <div className="rounded border border-neutral-700 bg-black/70 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-neutral-200">
                  {playerSpeed >= 0 ? "" : "R "}
                  {Math.abs(playerSpeed).toFixed(1)} u/s
                </div>
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

      {overlays.routeMap && cameraMode !== "pov" && cameraMode !== "drive" && (
        <RoutePanel
          lot={lot}
          cars={routePanelCars}
          selectedCarId={routeCarId}
          onSelectCar={setRouteCarId}
        />
      )}

      <ControlPanelTab open={panelOpen} onOpen={() => setPanelOpen(true)} />
      <ControlPanel
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

      <CameraControls
        mode={cameraMode}
        onModeChange={setCameraMode}
        followCarId={followCarId}
        onFollowCarChange={setFollowCarId}
        activeCars={sim.activeCars}
      />
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-[#0a0b0e] text-neutral-300">
      <span className="text-sm font-semibold tracking-[0.18em] text-neutral-400">LOADING</span>
    </div>
  );
}

function CameraControls({
  mode,
  onModeChange,
  followCarId,
  onFollowCarChange,
  activeCars,
}: {
  mode: CameraMode;
  onModeChange: (mode: CameraMode) => void;
  followCarId: string | null;
  onFollowCarChange: (id: string | null) => void;
  activeCars: { id: string; color: import("./types").CarColor; plate: string }[];
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
      <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-1 rounded-lg border border-neutral-800 bg-black/80 p-1 backdrop-blur-sm">
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
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-neutral-800 bg-black/80 px-2 py-1 backdrop-blur-sm">
          <span className="text-[11px] font-semibold tracking-wide text-neutral-500">CAR</span>
          {activeCars.length === 0 ? (
            <span className="text-[11px] text-neutral-500">none active</span>
          ) : (
            <select
              value={followCarId ?? ""}
              onChange={(event: { target: { value: string } }) => onFollowCarChange(event.target.value || null)}
              className="bg-transparent text-[11px] font-medium text-neutral-100 outline-none [&>option]:bg-neutral-900"
            >
              {activeCars.map((car) => (
                <option key={car.id} value={car.id}>{car.plate} · {car.color}</option>
              ))}
            </select>
          )}
          {followCarId && (
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{
                backgroundColor: COLOR_HEX[
                  activeCars.find((car) => car.id === followCarId)?.color ?? "white"
                ],
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

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
