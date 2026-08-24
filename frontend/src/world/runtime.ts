/**
 * Cross-boundary runtime state for the open world.
 *
 * The R3F scene graph (inside Canvas) and the DOM HUD (outside Canvas) need
 * to share small, high-frequency values — car position/speed, time of day,
 * camera mode — without per-frame React re-renders. This module holds one
 * mutable object that writers update in useFrame and readers poll on a
 * 10Hz interval. It is deliberately dumb: no events, no subscriptions.
 */

export type CameraMode = "drive" | "fly";

export interface RuntimeState {
  /** Active camera mode. "drive" is the default; V toggles. */
  mode: CameraMode;
  /** Player car state (drive mode). */
  carX: number;
  carZ: number;
  /** Car heading in radians. 0 = +Z (south, toward the city). */
  carHeading: number;
  /** Car speed in km/h (magnitude). */
  carSpeedKmh: number;
  /** Spectator camera position (fly mode). */
  flyX: number;
  flyY: number;
  flyZ: number;
  /** Normalized time of day, written by the day/night driver every frame. */
  timeOfDay: number;
}

export const runtime: RuntimeState = {
  mode: "drive",
  carX: 0,
  carZ: 120,
  carHeading: Math.PI,
  carSpeedKmh: 0,
  flyX: 0,
  flyY: 50,
  flyZ: 150,
  timeOfDay: 8.4 / 24,
};
