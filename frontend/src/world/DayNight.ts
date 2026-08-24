import { createContext, useContext, useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  DAY_NIGHT_CYCLE_SECONDS,
  DAY_NIGHT_START,
} from "./constants";

/**
 * The day/night cycle is the living spine of the world. Everything — sun
 * direction, sky gradient, fog, window glow, neon, streetlights, exposure —
 * keys off a single normalized `timeOfDay` parameter (0=midnight, 0.5=noon,
 * 1=midnight again).
 *
 * The cycle runs in real-time: 20 minutes of real time = 24 in-game hours.
 * The state is held in a mutable ref and updated every frame via useFrame,
 * so consumers (lights, sky shader, materials) read it inside their own
 * useFrame without triggering React re-renders.
 */

export interface DayNightState {
  /** Normalized time of day: 0=midnight, 0.5=noon, 1=midnight again. */
  timeOfDay: number;
  /** Sun position in world space (normalized direction × distance). */
  sunPosition: THREE.Vector3;
  /** Sun (directional light) color. */
  sunColor: THREE.Color;
  /** Sun (directional light) intensity. 0 at night. */
  sunIntensity: number;
  /** Sky gradient top color (zenith). */
  skyTop: THREE.Color;
  /** Sky gradient horizon color. */
  skyHorizon: THREE.Color;
  /** Ambient light color. */
  ambientColor: THREE.Color;
  /** Ambient light intensity. */
  ambientIntensity: number;
  /** Hemisphere light sky color. */
  hemiSky: THREE.Color;
  /** Hemisphere light ground color. */
  hemiGround: THREE.Color;
  /** Hemisphere light intensity. */
  hemiIntensity: number;
  /** Window emissive glow factor (0=dark, 1=full glow). */
  windowGlow: number;
  /** Neon sign emissive intensity (0=washed out in daylight, 1=dominant). */
  neonIntensity: number;
  /** Streetlight intensity (0=off, 1=full). */
  streetlightIntensity: number;
  /** Fog color (matches horizon for seamless blend). */
  fogColor: THREE.Color;
  /** Fog near plane distance. */
  fogNear: number;
  /** Fog far plane distance. */
  fogFar: number;
  /** Tone mapping exposure (rises slightly at night so neon doesn't clip). */
  exposure: number;
  /** Clock string for HUD, "HH:MM". */
  clockString: string;
}

/* ------------------------------------------------------------------ *
 *  Sky keyframes — 13 samples across 24 hours
 * ------------------------------------------------------------------ *
 *  Each entry defines the sky gradient (top + horizon) at a given
 *  normalized time. Everything else (sun, fog, glow) is derived from the
 *  sun elevation so the transitions stay smooth between keyframes.
 */

interface SkyKeyframe {
  t: number;
  top: string;
  horizon: string;
}

const SKY_KEYFRAMES: SkyKeyframe[] = [
  { t: 0.0, top: "#050818", horizon: "#0a1026" }, // midnight
  { t: 0.2, top: "#1a1a3a", horizon: "#3a2a4a" }, // pre-dawn 4:48am
  { t: 0.25, top: "#4a5a8a", horizon: "#ff9a4a" }, // sunrise 6:00am
  { t: 0.3, top: "#6a8aba", horizon: "#ffd28a" }, // morning 7:12am
  { t: 0.4, top: "#7ab0e0", horizon: "#c8d8f0" }, // mid-morning 9:36am
  { t: 0.5, top: "#4a90e0", horizon: "#b8d0f0" }, // noon
  { t: 0.6, top: "#5a9ad0", horizon: "#c0d0e8" }, // afternoon 2:24pm
  { t: 0.7, top: "#6a8aca", horizon: "#ffc890" }, // late afternoon 4:48pm
  { t: 0.75, top: "#5a4a8a", horizon: "#ff6a8a" }, // sunset 6:00pm
  { t: 0.8, top: "#3a2a5a", horizon: "#7a3a6a" }, // dusk 7:12pm
  { t: 0.85, top: "#1a1a3a", horizon: "#2a2a4a" }, // blue hour 8:24pm
  { t: 0.9, top: "#0a1026", horizon: "#1a1a3a" }, // night 9:36pm
  { t: 1.0, top: "#050818", horizon: "#0a1026" }, // midnight
];

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

/** Smoothstep: 0 at edge0, 1 at edge1, smooth in between. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Linear interpolation. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolate the sky keyframe array to get top/horizon colors at time t. */
function sampleSky(t: number, top: THREE.Color, horizon: THREE.Color): void {
  const n = SKY_KEYFRAMES.length;
  for (let i = 0; i < n - 1; i++) {
    const a = SKY_KEYFRAMES[i];
    const b = SKY_KEYFRAMES[i + 1];
    if (t >= a.t && t <= b.t) {
      const f = (t - a.t) / (b.t - a.t);
      top.set(a.top).lerp(new THREE.Color(b.top), f);
      horizon.set(a.horizon).lerp(new THREE.Color(b.horizon), f);
      return;
    }
  }
  // Fallback: first keyframe
  top.set(SKY_KEYFRAMES[0].top);
  horizon.set(SKY_KEYFRAMES[0].horizon);
}

/**
 * Sun elevation: -1 (below horizon, midnight) to +1 (overhead, noon).
 * At timeOfDay 0.25 (6am) elevation=0 (sunrise), 0.5 (noon) elevation=1,
 * 0.75 (6pm) elevation=0 (sunset).
 */
function sunElevation(t: number): number {
  return Math.sin((t - 0.25) * Math.PI * 2);
}

/**
 * Sun azimuth: +1 at sunrise (east, +X), -1 at sunset (west, -X).
 */
function sunAzimuth(t: number): number {
  return Math.cos((t - 0.25) * Math.PI * 2);
}

/** Convert timeOfDay to a clock string "HH:MM". */
function clockString(t: number): string {
  const totalMinutes = Math.floor(t * 24 * 60) % (24 * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ *
 *  State creation and per-frame update
 * ------------------------------------------------------------------ */

function createInitialState(): DayNightState {
  const s = {
    timeOfDay: DAY_NIGHT_START,
    sunPosition: new THREE.Vector3(),
    sunColor: new THREE.Color(),
    skyTop: new THREE.Color(),
    skyHorizon: new THREE.Color(),
    ambientColor: new THREE.Color(),
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    fogColor: new THREE.Color(),
  } as DayNightState;
  updateState(s);
  return s;
}

/** Recompute all derived fields from s.timeOfDay. Called every frame. */
function updateState(s: DayNightState): void {
  const t = s.timeOfDay;
  const elev = sunElevation(t);
  const azim = sunAzimuth(t);

  // Sun position: direction from origin to sun, scaled out to shadow range.
  // A slight Z tilt (0.25) prevents axis-aligned shadow acne.
  s.sunPosition.set(azim, elev, 0.25).normalize().multiplyScalar(400);

  // Sun color: warm orange at sunrise/sunset, white at noon, off at night.
  const dayFactor = THREE.MathUtils.clamp(elev * 2, 0, 1); // 0 below horizon, 1 at noon+
  const horizonGlow = smoothstep(0.15, -0.05, elev); // warm near horizon
  const sunWarm = new THREE.Color("#ff9a4a");
  const sunWhite = new THREE.Color("#fff5e0");
  s.sunColor.copy(sunWhite).lerp(sunWarm, horizonGlow);

  // Sun intensity: peaks at noon, zero when below horizon.
  s.sunIntensity = dayFactor * 3.0;

  // Sky gradient from keyframes.
  sampleSky(t, s.skyTop, s.skyHorizon);

  // Ambient: cool blue at night, warm soft white at day. Never fully dark
  // so geometry stays visible at night (min ~0.08 dark-blue ambient).
  const nightColor = new THREE.Color("#0a1026");
  const dayColor = new THREE.Color("#b0c4e0");
  s.ambientColor.copy(nightColor).lerp(dayColor, dayFactor);
  s.ambientIntensity = lerp(0.08, 0.5, dayFactor);

  // Hemisphere: sky color from skyTop, ground dark. Min intensity at night
  // keeps buildings/ground from becoming pure black silhouettes.
  s.hemiSky.copy(s.skyTop);
  s.hemiGround.set(0.1, 0.08, 0.06);
  s.hemiIntensity = lerp(0.12, 0.7, dayFactor);

  // Window glow: ramps on as sun drops below ~0.15 elevation.
  s.windowGlow = smoothstep(0.15, -0.05, elev);

  // Neon: crossfades slightly earlier than windows (city changes identity).
  s.neonIntensity = smoothstep(0.2, -0.1, elev);

  // Streetlights: stagger on near sunset (last to come on, first to go off).
  s.streetlightIntensity = smoothstep(0.05, -0.05, elev);

  // Fog: matches horizon color, tighter at night but not so tight that
  // distant buildings vanish. fogFar stays >= 300 at night.
  s.fogColor.copy(s.skyHorizon);
  s.fogNear = lerp(80, 40, 1 - dayFactor);
  s.fogFar = lerp(700, 350, 1 - dayFactor);

  // Exposure: rises at night so neon, window glow, and moonlight read
  // instead of clipping to black.
  s.exposure = lerp(1.0, 1.8, 1 - dayFactor);

  // Clock string.
  s.clockString = clockString(t);
}

/* ------------------------------------------------------------------ *
 *  Context — shared across all world components inside the Canvas
 * ------------------------------------------------------------------ */

export type DayNightRef = RefObject<DayNightState>;

export const DayNightContext = createContext<DayNightRef | null>(null);

/**
 * Consume the day/night state ref. Must be used inside a component that is
 * a descendant of WorldScene (which provides the context).
 */
export function useDayNightState(): DayNightRef {
  const ctx = useContext(DayNightContext);
  if (!ctx) {
    throw new Error("useDayNightState must be used within DayNightContext.Provider");
  }
  return ctx;
}

/**
 * The day/night cycle driver hook. Call this once inside the Canvas (in
 * WorldScene). It advances time every frame and returns a ref to the live
 * state. Pass the ref to consumers via DayNightContext.Provider.
 */
export function useDayNight(): DayNightRef {
  const stateRef = useRef<DayNightState>(createInitialState());

  // Debug override — allows external scripts (Playwright) to set the time
  // of day by dispatching a "devin-set-time" event on window.
  useEffect(() => {
    const onSetTime = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail === "number") {
        stateRef.current.timeOfDay = detail % 1;
        updateState(stateRef.current);
      }
    };
    window.addEventListener("devin-set-time", onSetTime);
    return () => window.removeEventListener("devin-set-time", onSetTime);
  }, []);

  useFrame((_, delta) => {
    const s = stateRef.current;
    s.timeOfDay = (s.timeOfDay + delta / DAY_NIGHT_CYCLE_SECONDS) % 1;
    updateState(s);
  });

  return stateRef;
}
