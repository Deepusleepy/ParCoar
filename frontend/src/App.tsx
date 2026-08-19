import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useSimulation } from "./hooks/useSimulation";
import { Scene, SceneLoadingFallback, type OrbitControlsHandle } from "./sim/Scene";
import { ActiveCarMesh, ParkedCarField, type ParkedCarInstance } from "./sim/Car";
import { DrivableCar, buildRoadSegments, type ParkedCarPos, type PlayerSpeedRef } from "./sim/DrivableCar";
import { AISLE_SPACING, CAR_Y_OFFSET, COLOR_HEX, toWorld } from "./sim/constants";
import type { CameraMode } from "./sim/CameraRig";
import { RoutePanel, type RoutePanelCar } from "./ui/RoutePanel";

export function App() {
  const sim = useSimulation();
  // Ref to the OrbitControls instance, so the "Reset View" button can call
  // controls.reset() and restore the default isometric framing.
  const controlsRef = useRef<OrbitControlsHandle | null>(null);

  // Camera system state.
  const [cameraMode, setCameraMode] = useState<CameraMode>("orbit");
  // Which car's route the 2D panel is drawing. This is what turns the demo
  // from "cars drive around" into "here is the search the backend ran".
  const [routeCarId, setRouteCarId] = useState<string | null>(null);
  const [followCarId, setFollowCarId] = useState<string | null>(null);
  // Live car transforms (id -> THREE.Group), populated by ActiveCarMesh each
  // frame and read by CameraRig for follow/POV modes.
  const carGroupsRef = useRef<Map<string, THREE.Group>>(new Map());

  // Player car live speed (written by DrivableCar each frame, polled for HUD).
  const playerSpeedRef = useRef<PlayerSpeedRef>({ speed: 0 });
  const [playerSpeed, setPlayerSpeed] = useState(0);

  // Auto-pick a car when entering follow mode without a selection, and clear
  // the selection when the chosen car is no longer active. POV mode drives the
  // player car, so it doesn't need an AI car selection.
  useEffect(() => {
    if (cameraMode !== "follow") return;
    const ids = sim.activeCars.map((c) => c.id);
    if (followCarId && !ids.includes(followCarId)) {
      setFollowCarId(null);
    }
    if (!followCarId && ids.length > 0) {
      setFollowCarId(ids[0]);
    }
  }, [cameraMode, followCarId, sim.activeCars]);

  // Drop the route selection when that car parks or leaves, and adopt the
  // first available car so the panel is never empty for no reason.
  useEffect(() => {
    const ids = sim.carRoutes.map((r) => r.carId);
    if (routeCarId && !ids.includes(routeCarId)) setRouteCarId(ids[0] ?? null);
    else if (!routeCarId && ids.length > 0) setRouteCarId(ids[0]);
  }, [sim.carRoutes, routeCarId]);

  // Poll the player car's speed for the driving HUD (~10 Hz is enough for a
  // speedometer; faster updates just waste renders).
  useEffect(() => {
    if (cameraMode !== "pov" && cameraMode !== "drive") return;
    const id = setInterval(() => setPlayerSpeed(playerSpeedRef.current.speed), 100);
    return () => clearInterval(id);
  }, [cameraMode]);

  const lot = sim.lot;

  // World-space positions of all parked cars, for DrivableCar collision.
  // These useMemo hooks MUST run before the early return below to satisfy
  // the Rules of Hooks (hooks can't be called conditionally / after a return).
  const parkedCarPositions = useMemo<ParkedCarPos[]>(() => {
    if (!lot) return [];
    const out: ParkedCarPos[] = [];
    for (const c of sim.preParked) {
      const node = lot.nodes[c.slotNode];
      if (!node) continue;
      const [x, y, z] = toWorld(node.x, node.y, node.floor);
      out.push({ x, y, z });
    }
    for (const c of sim.parked) {
      const node = lot.nodes[c.slotNode];
      if (!node) continue;
      const [x, y, z] = toWorld(node.x, node.y, node.floor);
      out.push({ x, y, z });
    }
    return out;
  }, [sim.preParked, sim.parked, lot]);

  // Instanced parked-car placements (pre-parked + newly parked). Computes the
  // nose-in rotation (±π/2) per slot so ParkedCarField can bake it into each
  // instance matrix. Fed to a single <ParkedCarField> for ~18 draw calls total
  // instead of one cloned GLTF per car.
  const parkedCars = useMemo<ParkedCarInstance[]>(() => {
    if (!lot) return [];
    const out: ParkedCarInstance[] = [];
    const push = (c: { slotNode: string; color: import("./types").CarColor; size: import("./types").CarSize }) => {
      const node = lot.nodes[c.slotNode];
      if (!node) return;
      const [x, y, z] = toWorld(node.x, node.y, node.floor);
      // Nose-in: car faces the slot interior. Car front is +x at rotation 0,
      // so +π/2 → -Z (-y), -π/2 → +Z (+y).
      const aisleY = Math.round(node.y / AISLE_SPACING) * AISLE_SPACING;
      const rotationY = node.y < aisleY ? Math.PI / 2 : -Math.PI / 2;
      out.push({ slotNode: c.slotNode, color: c.color, size: c.size, position: [x, y + CAR_Y_OFFSET, z], rotationY });
    };
    for (const c of sim.preParked) push(c);
    for (const c of sim.parked) push(c);
    return out;
  }, [sim.preParked, sim.parked, lot]);

  // Route panel view-model: the sim speaks in colour names, the panel wants
  // hex it can drop straight into an SVG fill.
  const routePanelCars = useMemo<RoutePanelCar[]>(
    () => sim.carRoutes.map((r) => ({ ...r, color: COLOR_HEX[r.color] })),
    [sim.carRoutes],
  );

  // Road centerline segments for DrivableCar road-edge clamping.
  const roadSegments = useMemo(() => (lot ? buildRoadSegments(lot) : []), [lot]);

  if (sim.loading || !sim.lot) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#0a0b0e] text-neutral-300">
        <span className="text-sm font-semibold tracking-[0.18em] text-neutral-400">
          LOADING
        </span>
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
        nodeSigns={sim.nodeSigns}
        carRoster={sim.carRoster}
      >
        <Suspense fallback={<SceneLoadingFallback />}>
          {/* All parked cars (pre-parked decoration + newly parked) rendered
              as one instanced field — ~18 draw calls instead of ~400. */}
          <ParkedCarField cars={parkedCars} />
          {/* Active cars (moving through the lot) */}
          {sim.activeCars.map((c) => (
            <ActiveCarMesh
              key={c.id}
              car={c}
              lot={lot!}
              onArrive={sim.onArrive}
              carGroupsRef={carGroupsRef}
            />
          ))}
          {/* Player-drivable car (WASD) — in POV or Drive mode */}
          {(cameraMode === "pov" || cameraMode === "drive") && (
            <DrivableCar
              lot={lot!}
              carGroupsRef={carGroupsRef}
              speedRef={playerSpeedRef}
              parkedCars={parkedCarPositions}
              roadSegments={roadSegments}
              pov={cameraMode === "pov"}
            />
          )}
        </Suspense>
      </Scene>

      {/* HUD overlay */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-4">
        {/* Top bar — panel for readability over 3D scene */}
        <div className="flex items-start justify-between">
          <div className="rounded-lg border border-neutral-800 bg-black/60 px-3 py-2 backdrop-blur-sm">
            <div className="text-lg font-semibold tracking-tight text-white">ParCoar</div>
            <div className="text-xs text-neutral-400">
              Parking guidance simulator
            </div>
          </div>

          <div className="flex flex-col items-end gap-1 rounded-lg border border-neutral-800 bg-black/60 px-3 py-2 text-[11px] backdrop-blur-sm">
            <StatusRow
              label="Backend"
              value={sim.connected ? "connected" : "disconnected"}
              tone={sim.connected ? "ok" : "bad"}
            />
            <StatusRow label="Active" value={`${activeCount}`} tone="neutral" />
            <StatusRow label="Parked" value={`${parkedCount}`} tone="neutral" />
          </div>
        </div>

        {/* Bottom bar */}
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
              <div className="flex items-center gap-3 text-[11px] text-neutral-400">
                <span>
                  <span className="text-neutral-200">Click</span> to capture mouse
                </span>
                <span>
                  <span className="text-neutral-200">W A S D</span> move
                </span>
                <span>
                  <span className="text-neutral-200">Space / Shift</span> up, down
                </span>
                <span>
                  <span className="text-neutral-200">Ctrl</span> boost
                </span>
                <span>
                  <span className="text-neutral-200">Scroll</span> fly forward
                </span>
              </div>
            )}
            <button
              type="button"
              onClick={() => controlsRef.current?.reset()}
              className="pointer-events-auto rounded border border-neutral-700 bg-black/70 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-neutral-200 transition-colors hover:border-neutral-500 hover:text-white"
            >
              Reset View
            </button>
          </div>
          {sim.lotFull && (
            <div className="rounded-md border border-red-500/60 bg-black/80 px-3 py-1.5 text-[12px] font-semibold tracking-wide text-red-400">
              LOT FULL
            </div>
          )}
        </div>
      </div>

      {/* Live route panel: the graph the Python backend searched, with the
          selected car's path lit up. Hidden in the driving modes, where the
          bottom-left corner belongs to the driving HUD. */}
      {cameraMode !== "pov" && cameraMode !== "drive" && lot && (
        <RoutePanel
          lot={lot}
          cars={routePanelCars}
          selectedCarId={routeCarId}
          onSelectCar={setRouteCarId}
        />
      )}

      {/* Camera mode controls (bottom-center). */}
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

/** Camera mode buttons + car selector for follow/POV. */
function CameraControls({
  mode,
  onModeChange,
  followCarId,
  onFollowCarChange,
  activeCars,
}: {
  mode: CameraMode;
  onModeChange: (m: CameraMode) => void;
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
  const showCarPicker = mode === "follow";

  return (
    <div className="pointer-events-none absolute bottom-16 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
      <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-1 rounded-lg border border-neutral-800 bg-black/80 p-1 backdrop-blur-sm">
        {buttons.map((b, i) => {
          const active = mode === b.id;
          // Add dividers between groups: after Overview (index 1), after Floor C (index 4)
          const showDivider = i === 2 || i === 5;
          return (
            <div key={b.id} className="flex items-center">
              {showDivider && <div className="mx-0.5 h-6 w-px bg-neutral-600" />}
              <button
                key={b.id}
                type="button"
                onClick={() => onModeChange(b.id)}
                className={
                  "rounded-md px-2.5 py-1 text-[11px] font-semibold tracking-wide transition-colors " +
                  (active
                    ? "bg-white/20 text-white ring-2 ring-white/40"
                    : "text-neutral-400 hover:text-neutral-100")
                }
              >
                {b.label}
              </button>
            </div>
          );
        })}
      </div>

      {showCarPicker && (
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-neutral-800 bg-black/80 px-2 py-1 backdrop-blur-sm">
          <span className="text-[11px] font-semibold tracking-wide text-neutral-500">
            CAR
          </span>
          {activeCars.length === 0 ? (
            <span className="text-[11px] text-neutral-500">none active</span>
          ) : (
            <select
              value={followCarId ?? ""}
              onChange={(e) => onFollowCarChange(e.target.value || null)}
              className="bg-transparent text-[11px] font-medium text-neutral-100 outline-none [&>option]:bg-neutral-900"
            >
              {activeCars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.plate} · {c.color}
                </option>
              ))}
            </select>
          )}
          {followCarId && (
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{
                backgroundColor: COLOR_HEX[activeCars.find((c) => c.id === followCarId)?.color ?? "white"],
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
  const color =
    tone === "ok"
      ? "text-emerald-400"
      : tone === "bad"
        ? "text-red-400"
        : "text-neutral-300";
  const dot =
    tone === "ok"
      ? "bg-emerald-400"
      : tone === "bad"
        ? "bg-red-400"
        : "bg-neutral-600";
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className="text-neutral-500">{label}</span>
      <span className={`${color} tabular-nums`}>{value}</span>
    </div>
  );
}
