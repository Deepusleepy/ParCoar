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
  DAY_NIGHT_CYCLE_SECONDS,
} from "./constants";

/**
 * WorldHUD — minimal overlay for the spectator camera mode.
 *
 * Shows: time of day (top-left), minimap (top-right), controls hint
 * (bottom-left, fades after 8s), and camera speed (bottom-right).
 *
 * The HUD reads the spectator camera position from the R3F camera via a
 * shared ref (passed from WorldApp) and re-renders at a throttled 10fps
 * to avoid per-frame React overhead.
 */

const MINIMAP_SIZE = 180;
const MINIMAP_SCALE = MINIMAP_SIZE / (WORLD_HALF * 2);

export interface WorldHUDProps {
  /** Live camera position ref (updated by SpectatorCamera every frame). */
  cameraPosRef?: React.MutableRefObject<{ x: number; y: number; z: number } | null>;
}

export function WorldHUD({ cameraPosRef }: WorldHUDProps) {
  const [state, setState] = useState({
    x: 0,
    y: 50,
    z: 150,
    time: "08:24",
    location: "City District",
  });

  // Throttled update at 10fps
  useEffect(() => {
    const interval = setInterval(() => {
      const pos = cameraPosRef?.current;
      const x = pos?.x ?? 0;
      const z = pos?.z ?? 150;
      const y = pos?.y ?? 50;
      setState({
        x,
        y,
        z,
        time: getInGameTime(),
        location: getLocationName(x, z),
      });
    }, 100);
    return () => clearInterval(interval);
  }, [cameraPosRef]);

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
      {/* Time of day (top-left) */}
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          padding: "8px 12px",
          background: "rgba(10,11,14,0.7)",
          borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.1)",
          fontSize: 13,
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: 1 }}>{state.time}</div>
        <div style={{ fontSize: 10, opacity: 0.5, letterSpacing: 1 }}>{state.location}</div>
      </div>

      {/* Minimap (top-right) */}
      <div
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          padding: 4,
          background: "rgba(10,11,14,0.7)",
          borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        <Minimap x={state.x} z={state.z} />
      </div>

      {/* Controls hint (bottom-left, fades) */}
      <ControlsHint />

      {/* Altitude (bottom-right) */}
      <div
        style={{
          position: "absolute",
          bottom: 16,
          right: 16,
          padding: "6px 10px",
          background: "rgba(10,11,14,0.7)",
          borderRadius: 8,
          border: "1px solid rgba(255,255,255,0.1)",
          fontSize: 11,
          opacity: 0.7,
        }}
      >
        ALT {Math.round(state.y)}m
      </div>
    </div>
  );
}

/** Compute in-game time string from elapsed real time. */
function getInGameTime(): string {
  // The day/night cycle runs in DayNight.ts. We approximate the time
  // from the cycle length. This is a rough display — the authoritative
  // time lives in the DayNight state ref.
  const start = DAY_NIGHT_START_HOURS;
  const now = performance.now() / 1000;
  const cycleProgress = (now % DAY_NIGHT_CYCLE_SECONDS) / DAY_NIGHT_CYCLE_SECONDS;
  const totalHours = (start + cycleProgress * 24) % 24;
  const h = Math.floor(totalHours);
  const m = Math.floor((totalHours - h) * 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

const DAY_NIGHT_START_HOURS = 8.4; // 8:24am

function getLocationName(x: number, z: number): string {
  if (Math.abs(z - RIVER_Z) < RIVER_HALF_WIDTH) {
    if (Math.abs(x - BRIDGE_MODERN_X) < 10) return "Modern Bridge";
    if (Math.abs(x - BRIDGE_TRUSS_X) < 10) return "Old Bridge";
    return "The River";
  }
  if (z > RIVER_HALF_WIDTH) {
    if (x < -60) return "West City";
    if (x > 60) return "East City";
    if (z > 120) return "South City";
    return "City District";
  }
  // Town side
  const [tx, tz] = TRACK_CENTER;
  const [tw, td] = TRACK_SIZE;
  if (Math.abs(x - tx) < tw / 2 + 20 && Math.abs(z - tz) < td / 2 + 20) {
    return "Race Track";
  }
  if (z < -200) return "Rice Paddies";
  if (x < -60) return "Old Town";
  return "Town";
}

/** Canvas-based minimap. */
function Minimap({ x, z }: { x: number; z: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = MINIMAP_SIZE;
    const h = MINIMAP_SIZE;
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = "#0a0b0e";
    ctx.fillRect(0, 0, w, h);

    const toCanvas = (wx: number, wz: number): [number, number] => [
      (wx + WORLD_HALF) * MINIMAP_SCALE,
      (wz + WORLD_HALF) * MINIMAP_SCALE,
    ];

    // River
    const [, riverY] = toCanvas(0, RIVER_Z);
    const riverH = RIVER_HALF_WIDTH * 2 * MINIMAP_SCALE;
    ctx.fillStyle = "#1a2a3a";
    ctx.fillRect(0, riverY - riverH / 2, w, riverH);

    // City roads
    ctx.strokeStyle = "#3a3a3e";
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

    // Town roads
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

    // Camera position
    const [cx, cy] = toCanvas(x, z);
    ctx.fillStyle = "#00e5ff";
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#00e5ff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.stroke();
  }, [x, z]);

  return (
    <canvas
      ref={canvasRef}
      width={MINIMAP_SIZE}
      height={MINIMAP_SIZE}
      style={{ display: "block", borderRadius: 4 }}
    />
  );
}

/** Controls hint that fades out after 8 seconds. */
function ControlsHint() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 8000);
    return () => clearTimeout(timer);
  }, []);

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
      <div>WASD — fly</div>
      <div>Space / C — up / down</div>
      <div>Drag — look</div>
      <div>Scroll — speed</div>
      <div>Shift — boost</div>
    </div>
  );
}
