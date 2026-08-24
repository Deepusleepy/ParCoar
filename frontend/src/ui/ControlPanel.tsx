import { memo, type ReactNode } from "react";
import type { GarageFill, SimSettings } from "../hooks/useSimulation";

/**
 * The controls drawer.
 *
 * The levers that make the simulator demonstrable: how much traffic there is,
 * how fast time runs, how full the garage starts, and what is drawn on top of
 * the 3D view. It slides in from the right and is closed by default, so the
 * garage is the only thing on screen until you ask for something else.
 */

export interface Overlays {
  routeMap: boolean;
  status: boolean;
  boardGuidance: boolean;
  helpText: boolean;
}

export const DEFAULT_OVERLAYS: Overlays = {
  routeMap: false,
  status: true,
  boardGuidance: true,
  helpText: true,
};

export const ControlPanel = memo(function ControlPanel({
  open,
  onClose,
  settings,
  onSettings,
  overlays,
  onOverlays,
  onSpawn,
  onClearRoad,
  onReset,
  activeCount,
  parkedCount,
}: {
  open: boolean;
  onClose: () => void;
  settings: SimSettings;
  onSettings: (patch: Partial<SimSettings>) => void;
  overlays: Overlays;
  onOverlays: (patch: Partial<Overlays>) => void;
  onSpawn: () => void;
  onClearRoad: () => void;
  onReset: () => void;
  activeCount: number;
  parkedCount: number;
}) {
  const paused = settings.speed === 0;

  // Keep the panel mounted (so the slide transition runs) but skip rendering
  // the inner contents when closed: nothing to reconcile while hidden.
  if (!open) {
    return (
      <div className="pointer-events-none absolute inset-y-0 right-0 z-20 w-[19rem] translate-x-full transition-transform duration-200" />
    );
  }

  return (
    <div
      className={
        "pointer-events-none absolute inset-y-0 right-0 z-20 w-[19rem] transition-transform duration-200 " +
        (open ? "translate-x-0" : "translate-x-full")
      }
    >
      <div className="pointer-events-auto flex h-full flex-col gap-5 overflow-y-auto border-l border-neutral-800 bg-[#0a0b0e] p-4">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-semibold tracking-[0.18em] text-neutral-500">
            CONTROLS
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[11px] font-semibold text-neutral-400 transition-colors hover:text-white"
          >
            Close
          </button>
        </div>

        <Section title="Traffic">
          <Slider
            label="Cars on the road"
            value={settings.targetCars}
            min={0}
            max={20}
            step={1}
            format={(v) => `${v}`}
            onChange={(targetCars) => onSettings({ targetCars })}
          />
          <Slider
            label="New car every"
            value={settings.spawnEverySec}
            min={0.5}
            max={20}
            step={0.5}
            format={(v) => `${v}s`}
            onChange={(spawnEverySec) => onSettings({ spawnEverySec })}
          />
          <Slider
            label="Leaving at once"
            value={settings.maxLeaving}
            min={0}
            max={8}
            step={1}
            format={(v) => `${v}`}
            onChange={(maxLeaving) => onSettings({ maxLeaving })}
          />
          <div className="flex gap-2 pt-1">
            <Action onClick={onSpawn}>Add a car</Action>
            <Action onClick={onClearRoad}>Clear the road</Action>
          </div>
          <Readout>
            {activeCount} moving · {parkedCount} parked
          </Readout>
        </Section>

        <Section title="Time">
          <div className="flex gap-1">
            {([0, 0.25, 0.5, 1, 2] as const).map((v) => (
              <Chip
                key={v}
                active={settings.speed === v}
                onClick={() => onSettings({ speed: v })}
              >
                {v === 0 ? "Pause" : `${v}x`}
              </Chip>
            ))}
          </div>
          {paused && <Readout>Paused. Nothing moves and no cars arrive.</Readout>}
        </Section>

        <Section title="Garage">
          <div className="flex gap-1">
            {(["quiet", "normal", "busy"] as GarageFill[]).map((f) => (
              <Chip key={f} active={settings.fill === f} onClick={() => onSettings({ fill: f })}>
                {f[0].toUpperCase() + f.slice(1)}
              </Chip>
            ))}
          </div>
          <Readout>
            How full the bays start. Fuller means arrivals drive further to find
            a space, so the guidance boards have more to say.
          </Readout>
          <Action onClick={onReset}>Apply and reset</Action>
        </Section>

        <Section title="Show">
          <Toggle
            label="Route map"
            hint="The graph the backend searched, with one car's path lit"
            on={overlays.routeMap}
            onChange={(routeMap) => onOverlays({ routeMap })}
          />
          <Toggle
            label="Live board guidance"
            hint="Turn off to see the garage without a guidance system"
            on={overlays.boardGuidance}
            onChange={(boardGuidance) => onOverlays({ boardGuidance })}
          />
          <Toggle
            label="Status readout"
            on={overlays.status}
            onChange={(status) => onOverlays({ status })}
          />
          <Toggle
            label="Keyboard hints"
            on={overlays.helpText}
            onChange={(helpText) => onOverlays({ helpText })}
          />
        </Section>

        <div className="mt-auto pt-2 text-[10px] leading-relaxed text-neutral-600">
          <span className="text-neutral-400">C</span> controls ·{" "}
          <span className="text-neutral-400">M</span> route map ·{" "}
          <span className="text-neutral-400">P</span> pause
        </div>
      </div>
    </div>
  );
});

/** The tab that opens the drawer, parked against the right edge. */
export function ControlPanelTab({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  if (open) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="pointer-events-auto absolute right-0 top-1/2 z-20 -translate-y-1/2 rounded-l-md border border-r-0 border-neutral-700 bg-[#0a0b0e] px-2 py-3 text-[10px] font-semibold tracking-[0.18em] text-neutral-400 transition-colors hover:text-white"
      style={{ writingMode: "vertical-rl" }}
    >
      CONTROLS
    </button>
  );
}

/* --- Small building blocks ------------------------------------------ */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[10px] font-semibold tracking-[0.18em] text-neutral-500">
        {title.toUpperCase()}
      </h2>
      {children}
    </section>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between text-[11px] text-neutral-400">
        {label}
        <span className="tabular-nums text-neutral-200">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-neutral-800 accent-white"
      />
    </label>
  );
}

function Toggle({
  label,
  hint,
  on,
  onChange,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className="flex items-start justify-between gap-3 rounded px-1 py-1 text-left transition-colors hover:bg-white/5"
    >
      <span className="flex flex-col">
        <span className="text-[11px] text-neutral-200">{label}</span>
        {hint && <span className="text-[10px] leading-snug text-neutral-600">{hint}</span>}
      </span>
      <span
        className={
          "mt-0.5 h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors " +
          (on ? "bg-white/80" : "bg-neutral-700")
        }
      >
        <span
          className={
            "block h-3 w-3 rounded-full bg-black transition-transform " +
            (on ? "translate-x-3" : "translate-x-0")
          }
        />
      </span>
    </button>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex-1 rounded px-2 py-1 text-[11px] font-semibold transition-colors " +
        (active ? "bg-white/20 text-white ring-1 ring-white/40" : "text-neutral-400 hover:text-neutral-100")
      }
    >
      {children}
    </button>
  );
}

function Action({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 rounded border border-neutral-700 px-2 py-1 text-[11px] font-semibold text-neutral-200 transition-colors hover:border-neutral-500 hover:text-white"
    >
      {children}
    </button>
  );
}

function Readout({ children }: { children: ReactNode }) {
  return <p className="text-[10px] leading-snug text-neutral-600">{children}</p>;
}
