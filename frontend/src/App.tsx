import { useSimulation } from "./hooks/useSimulation";
import { Scene } from "./sim/Scene";

export function App() {
  const sim = useSimulation();

  if (sim.loading || !sim.lot) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black text-white">
        <span className="text-sm tracking-wide text-neutral-500">Loading lot</span>
      </div>
    );
  }

  const activeCount = sim.activeCars.length;
  const parkedCount = sim.preParked.length + sim.parked.length;

  return (
    <div className="relative h-full w-full bg-black">
      <Scene
        lot={sim.lot}
        activeCars={sim.activeCars}
        preParked={sim.preParked}
        parked={sim.parked}
        signboards={sim.signboards}
        onArrive={sim.onArrive}
      />

      {/* HUD overlay */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-4">
        {/* Top bar */}
        <div className="flex items-start justify-between">
          <div className="text-white">
            <div className="text-base font-semibold tracking-tight">ParCoar</div>
            <div className="text-[11px] text-neutral-500">
              Parking guidance simulator
            </div>
          </div>

          <div className="flex flex-col items-end gap-1 text-[11px]">
            <StatusRow
              label="Backend"
              value={sim.connected ? "connected" : "disconnected"}
              tone={sim.connected ? "ok" : "bad"}
            />
            <StatusRow label="Active" value={`${activeCount}`} tone="neutral" />
            <StatusRow label="Parked" value={`${parkedCount}`} tone="neutral" />
            <StatusRow
              label="Signs"
              value={`${sim.signboards.length}`}
              tone="neutral"
            />
          </div>
        </div>

        {/* Bottom bar */}
        <div className="flex items-end justify-between">
          <div className="text-[11px] text-neutral-600">
            Drag to orbit. Scroll to zoom.
          </div>
          {sim.lotFull && (
            <div className="border border-red-500/60 bg-black/80 px-3 py-1.5 text-[12px] font-semibold tracking-wide text-red-400">
              LOT FULL
            </div>
          )}
        </div>
      </div>
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
