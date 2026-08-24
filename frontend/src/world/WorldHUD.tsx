import { useEffect, useRef, useState } from "react";
import {
  WORLD_HALF,
  RIVER_Z,
  RIVER_HALF_WIDTH,
  CITY_NS_ROADS,
  CITY_EW_ROADS,
  TOWN_NS_ROADS,
  TOWN_EW_ROADS,
  BRIDGE_MODERN_X,
  BRIDGE_TRUSS_X,
  TRACK_CENTER,
  TRACK_SIZE,
} from "./constants";
import { runtime, type CameraMode } from "./runtime";

/**
 * WorldHUD — minimal overlay for the open world.
 *
 * Drive mode: clock + district (top-left), minimap with heading arrow
 * (top-right), speed in km/h (bottom-right), fading controls hint
 * (bottom-left). Fly mode swaps speed for altitude and shows fly hints.
 *
 * Everything is polled from `runtime` at 10 Hz — no per-frame React work.
 */

const MINIMAP_SIZE = 180;
const MINIMAP_SCALE = MINIMAP_SIZE / (WORLD_HALF * 2);

export interface WorldHUDProps {
  mode: CameraMode;
}

interface HudSnapshot {
  x: number;
  y: number;
  z: number;
  heading: number;
  speedKmh: number;
  clock: string;
  location: string;
}

function snapshot(mode: CameraMode): HudSnapshot {
  const x = mode === "drive" ? runtime.carX : runtime.flyX;
  const y = mode === "drive" ? 0 : runtime.flyY;
  const z = mode === "drive" ? runtime.carZ : runtime.flyZ;
  return {
    x,
    y,
    z,
    heading: runtime.carHeading,
    speedKmh: runtime.carSpeedKmh,
    clock: formatClock(runtime.timeOfDay),
    location: getLocationName(x, z),
  };
}

function formatClock(t: number): string {
  const totalMinutes = Math.floor(t * 24 * 60) % (24 * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function getLocationName(x: number, z: number): string {
  if (Math.abs(z - RIVER_Z) < RIVER_HALF_WIDTH) {
    if (Math.abs(x - BRIDGE_MODERN_X) < 10) return "Modern Bridge";
    if (Math.abs(x - BRIDGE_TRUSS_X) < 10) return "Truss Bridge";
    return "The River";
  }
  if (z > RIVER_HALF_WIDTH) {
    if (z > 240) return "South City";
    if (x < -60) return "West City";
    if (x > 60) return "East City";
    return "City District";
  }
  const [tx, tz] = TRACK_CENTER;
  const [tw, td] = TRACK_SIZE;
  if (Math.abs(x - tx) < tw / 2 + 20 && Math.abs(z - tz) < td / 2 + 20) {
    return "Race Track";
  }
  if (z < -200) return "Rice Paddies";
  if (x < -60) return "Old Town";
  return "Town";
}

export function WorldHUD({ mode }: WorldHUDProps) {
  const [state, setState] = useState<HudSnapshot>(() => snapshot(mode));

  useEffect(() => {
    const interval = setInterval(() => setState(snapshot(mode)), 100);
    return () => clearInterval(interval);
  }, [mode]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        color: "#ffffff",
        userSelect: "none",
      }}
    >
      {/* Time of day + district (top-left) */}
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          padding: "8px 12px",
          background: "rgba(10,11,14,0.66)",
          borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.1)",
          fontSize: 13,
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: 1 }}>{state.clock}</div>
        <div style={{ fontSize: 10, opacity: 0.55, letterSpacing: 1 }}>{state.location}</div>
      </div>

      {/* Minimap (top-right) */}
      <div
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          padding: 4,
          background: "rgba(10,11,14,0.66)",
          borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        <Minimap x={state.x} z={state.z} heading={state.heading} mode={mode} />
      </div>

      <ControlsHint mode={mode} />

      {/* Speed (drive) / altitude (fly), bottom-right */}
      <div
        style={{
          position: "absolute",
          bottom: 16,
          right: 16,
          padding: "6px 12px",
          background: "rgba(10,11,14,0.66)",
          borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.1)",
          fontSize: mode === "drive" ? 20 : 11,
          fontWeight: mode === "drive" ? 700 : 400,
          opacity: 0.85,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {mode === "drive" ? `${Math.round(state.speedKmh)} km/h` : `ALT ${Math.round(state.y)}m`}
      </div>
    </div>
  );
}

/** Canvas-based minimap with a heading arrow in drive mode. */
function Minimap({
  x,
  z,
  heading,
  mode,
}: {
  x: number;
  z: number;
  heading: number;
  mode: CameraMode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = MINIMAP_SIZE;
    const h = MINIMAP_SIZE;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = "#0a0b0e";
    ctx.fillRect(0, 0, w, h);

    const toCanvas = (wx: number, wz: number): [number, number] => [
      (wx + WORLD_HALF) * MINIMAP_SCALE,
      (wz + WORLD_HALF) * MINIMAP_SCALE,
    ];

    // River
    const [, riverY] = toCanvas(0, RIVER_Z);
    const riverH = RIVER_HALF_WIDTH * 2 * MINIMAP_SCALE;
    ctx.fillStyle = "#16283a";
    ctx.fillRect(0, riverY - riverH / 2, w, riverH);

    // City blocks (dark fill so roads read as a grid)
    ctx.fillStyle = "#141518";
    ctx.fillRect(0, riverY + riverH / 2, w, h - (riverY + riverH / 2));

    // Roads
    ctx.strokeStyle = "#3c3d42";
    ctx.lineWidth = 1;
    for (const rx of CITY_NS_ROADS) {
      const [cx] = toCanvas(rx, 0);
      ctx.beginPath();
      ctx.moveTo(cx, riverY + riverH / 2);
      ctx.lineTo(cx, h);
      ctx.stroke();
    }
    for (const rz of CITY_EW_ROADS) {
      const [, cy] = toCanvas(0, rz);
      ctx.beginPath();
      ctx.moveTo(0, cy);
      ctx.lineTo(w, cy);
      ctx.stroke();
    }
    for (const rx of TOWN_NS_ROADS) {
      const [cx] = toCanvas(rx, 0);
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, riverY - riverH / 2);
      ctx.stroke();
    }
    for (const rz of TOWN_EW_ROADS) {
      const [, cy] = toCanvas(0, rz);
      ctx.beginPath();
      ctx.moveTo(0, cy);
      ctx.lineTo(w, cy);
      ctx.stroke();
    }

    // Bridges
    ctx.strokeStyle = "#5a5a5e";
    ctx.lineWidth = 2;
    for (const bx of [BRIDGE_MODERN_X, BRIDGE_TRUSS_X]) {
      const [cx] = toCanvas(bx, 0);
      ctx.beginPath();
      ctx.moveTo(cx, riverY - riverH / 2);
      ctx.lineTo(cx, riverY + riverH / 2);
      ctx.stroke();
    }

    // Race track
    const [tx, tz] = TRACK_CENTER;
    const [tw, td] = TRACK_SIZE;
    const [tcx, tcy] = toCanvas(tx, tz);
    ctx.strokeStyle = "#4a4a4e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(tcx, tcy, (tw / 2) * MINIMAP_SCALE, (td / 2) * MINIMAP_SCALE, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Player: heading arrow (drive) or dot (fly)
    const [cx, cy] = toCanvas(x, z);
    if (mode === "drive") {
      ctx.save();
      ctx.translate(cx, cy);
      // Heading 0 = +Z = down on the minimap (+Z maps to +canvasY).
      ctx.rotate(Math.PI - heading);
      ctx.fillStyle = "#00e5ff";
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(5, 6);
      ctx.lineTo(0, 3);
      ctx.lineTo(-5, 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = "#00e5ff";
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#00e5ff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [x, z, heading, mode]);

  return (
    <canvas
      ref={canvasRef}
      width={MINIMAP_SIZE}
      height={MINIMAP_SIZE}
      style={{ display: "block", borderRadius: 4 }}
    />
  );
}

/** Controls hint that fades out after 9 seconds. */
function ControlsHint({ mode }: { mode: CameraMode }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 9000);
    return () => clearTimeout(timer);
  }, [mode]);

  return (
    <div
      style={{
        position: "absolute",
        bottom: 16,
        left: 16,
        fontSize: 12,
        lineHeight: 1.7,
        opacity: visible ? 0.7 : 0,
        transition: "opacity 1s",
        textShadow: "0 1px 3px rgba(0,0,0,0.8)",
      }}
    >
      {mode === "drive" ? (
        <>
          <div>WASD — drive</div>
          <div>Space — handbrake</div>
          <div>V — fly camera</div>
          <div>T — skip 6h</div>
        </>
      ) : (
        <>
          <div>WASD — fly</div>
          <div>Space / C — up / down</div>
          <div>Drag — look · Scroll — speed</div>
          <div>V — drive</div>
        </>
      )}
    </div>
  );
}
