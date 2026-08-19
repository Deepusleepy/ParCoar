import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { FLOOR_HEIGHT, LOT_CENTER_X, LOT_CENTER_Z } from "./constants";

/**
 * Camera modes available to the user.
 *
 * - `orbit`: FREE-FLY spectator camera (the default). There is no orbit
 *   target and no min/max distance — the camera can fly anywhere, including
 *   inside the building. Mouse drag looks, WASD flies, Space/Shift move in
 *   world up/down, Ctrl boosts, the mouse wheel sets fly speed.
 * - `overview` / `floor0` / `floor1` / `floor2`: INSTANT teleports. The free
 *   camera is snapped to a good vantage for that floor and control is handed
 *   straight back to free flight. Nothing stays locked.
 * - `follow`: chase cam locked behind & above a selected car.
 * - `pov`: first-person view from inside the player car.
 * - `drive`: third-person chase cam behind the player car.
 *
 * The names "orbit"/"overview"/"floor0"/"floor1"/"floor2"/"follow"/"pov"/
 * "drive" are kept stable because App.tsx imports `CameraMode` and switches on
 * these literals; "orbit" is the default App starts in, so it stays the name
 * for free flight.
 */
export type CameraMode =
  | "orbit"
  | "overview"
  | "floor0"
  | "floor1"
  | "floor2"
  | "follow"
  | "pov"
  | "drive";

/**
 * Imperative handle exposed via `controlsRef`. App.tsx only ever calls
 * `controlsRef.current?.reset()` (the "Reset View" button); Scene.tsx calls
 * `saveState()` once after mount as a no-op. `reset()` returns the free camera
 * to a sensible default vantage.
 */
export interface FlyControlsHandle {
  reset(): void;
  saveState(): void;
}

export interface CameraRigProps {
  mode: CameraMode;
  followCarId: string | null;
  /** Shared map of active-car id -> THREE.Group, populated by ActiveCarMesh. */
  carGroupsRef?: React.MutableRefObject<Map<string, THREE.Group>>;
  /** App-level controls ref (for the Reset View button). */
  controlsRef?: React.Ref<FlyControlsHandle>;
  /** Initial look target; used to orient the free camera on mount and on reset. */
  initialTarget: [number, number, number];
}

/* ------------------------------------------------------------------ *
 *  Tuning
 * ------------------------------------------------------------------ */

/** Base fly speed in world units / second. The building is ~55 x 63 x 45,
 *  so 25 u/s crosses a storey in well under a second; the boost and wheel
 *  range let you cross the whole lot or creep up to a surface. */
const DEFAULT_FLY_SPEED = 25;
const MIN_FLY_SPEED = 4;
const MAX_FLY_SPEED = 160;
/** Boost multiplier when Ctrl is held. */
const BOOST_MULT = 3.0;
/** Look sensitivity: radians per pixel of mouse drag. */
const LOOK_SENSITIVITY = 0.0025;
/** Pitch clamp: stop just shy of straight up/down so the view never flips. */
const PITCH_LIMIT = Math.PI / 2 - 0.05;

/** Default vantage for Reset View: a high 3/4 aerial over the lot. */
const DEFAULT_VANTAGE = {
  pos: new THREE.Vector3(LOT_CENTER_X + 35, 65, LOT_CENTER_Z + 65),
  look: new THREE.Vector3(LOT_CENTER_X, FLOOR_HEIGHT, LOT_CENTER_Z),
};

/** Predefined camera framings for the preset (teleport) modes.
 *  Each floor's vantage sits INSIDE its storey at floor*FLOOR_HEIGHT + 6,
 *  never within 0.5 of a slab (slabs are at multiples of FLOOR_HEIGHT).
 *  See the report for the arithmetic. */
const PRESETS: Record<
  "overview" | "floor0" | "floor1" | "floor2",
  { pos: THREE.Vector3; look: THREE.Vector3 }
> = {
  overview: {
    pos: new THREE.Vector3(LOT_CENTER_X + 30, 70, LOT_CENTER_Z + 70),
    look: new THREE.Vector3(LOT_CENTER_X, (3 * FLOOR_HEIGHT) / 2, LOT_CENTER_Z),
  },
  floor0: {
    pos: new THREE.Vector3(LOT_CENTER_X + 28, 0 * FLOOR_HEIGHT + 6, LOT_CENTER_Z - 28),
    look: new THREE.Vector3(LOT_CENTER_X, 0 * FLOOR_HEIGHT + 2, LOT_CENTER_Z),
  },
  floor1: {
    pos: new THREE.Vector3(LOT_CENTER_X + 28, 1 * FLOOR_HEIGHT + 6, LOT_CENTER_Z - 28),
    look: new THREE.Vector3(LOT_CENTER_X, 1 * FLOOR_HEIGHT + 2, LOT_CENTER_Z),
  },
  floor2: {
    pos: new THREE.Vector3(LOT_CENTER_X + 28, 2 * FLOOR_HEIGHT + 6, LOT_CENTER_Z - 28),
    look: new THREE.Vector3(LOT_CENTER_X, 2 * FLOOR_HEIGHT + 2, LOT_CENTER_Z),
  },
};

/** Frame-rate-independent lerp factor: approaches 1 at `strength` per second. */
function lerpK(strength: number, dt: number): number {
  const s = Math.max(0, Math.min(1, strength));
  return 1 - Math.pow(1 - s, dt);
}

const isPreset = (m: CameraMode): m is "overview" | "floor0" | "floor1" | "floor2" =>
  m === "overview" || m === "floor0" || m === "floor1" || m === "floor2";

/**
 * CameraRig drives the camera each frame based on the current `mode`.
 *
 * In the free-flight modes (`orbit` and the presets after their one-shot
 * teleport) the user has full WASD/mouse control with no orbit target. In
 * `follow` / `pov` / `drive` the rig drives the camera directly from the
 * selected car's transform (read from `carGroupsRef`) and free-flight input
 * is ignored.
 */
export function CameraRig({
  mode,
  followCarId,
  carGroupsRef,
  controlsRef,
  initialTarget,
}: CameraRigProps) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  // Free-flight orientation state. Position lives on the camera itself; yaw
  // and pitch live here so mouse-look can update them outside useFrame.
  const yawRef = useRef(0);
  /** Scratch vector for wheel dolly; avoids allocating per wheel event. */
  const dolly = useRef(new THREE.Vector3());
  const pitchRef = useRef(0);
  const flySpeedRef = useRef(DEFAULT_FLY_SPEED);
  // Tracks which preset mode we have already teleported into, so a preset
  // teleports once on entry and then hands back to free flight.
  const presetDoneRef = useRef<CameraMode | null>(null);
  // Previous frame's mode, used to re-derive yaw/pitch when handing back from
  // a car mode into free flight.
  const prevModeRef = useRef<CameraMode>(mode);

  // Reusable temp vectors (avoid per-frame allocation).
  const tmpDir = useRef(new THREE.Vector3());
  const fwd = useRef(new THREE.Vector3());
  const right = useRef(new THREE.Vector3());
  const move = useRef(new THREE.Vector3());
  const tmpPos = useRef(new THREE.Vector3());
  const tmpLook = useRef(new THREE.Vector3());
  const tmpFwd = useRef(new THREE.Vector3());
  const tmpFwd2 = useRef(new THREE.Vector3());
  const tmpUp = useRef(new THREE.Vector3());
  const tmpEuler = useRef(new THREE.Euler());
  const tmpQuat = useRef(new THREE.Quaternion());

  /** Orient the free camera to look at `target`, deriving yaw/pitch from the
   *  direction vector. Uses the lookDir convention:
   *    lookDir = (-cos(pitch) sin(yaw), sin(pitch), -cos(pitch) cos(yaw))
   *  => pitch = asin(dir.y), yaw = atan2(-dir.x, -dir.z). */
  const lookAtTarget = (target: THREE.Vector3) => {
    tmpDir.current.subVectors(target, camera.position);
    const len = tmpDir.current.length();
    if (len < 1e-6) return;
    tmpDir.current.divideScalar(len);
    pitchRef.current = THREE.MathUtils.clamp(
      Math.asin(THREE.MathUtils.clamp(tmpDir.current.y, -1, 1)),
      -PITCH_LIMIT,
      PITCH_LIMIT,
    );
    yawRef.current = Math.atan2(-tmpDir.current.x, -tmpDir.current.z);
  };

  // --- Dev-only: let an automated visual check park the camera anywhere. ---
  // The free-fly rig rewrites camera.rotation every frame from yaw/pitch, so
  // an external lookAt() would be overwritten; this sets the rig's own state
  // instead. Stripped from production builds by the import.meta.env.DEV guard.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as {
      __parcoarFly?: (pos: [number, number, number], look: [number, number, number]) => void;
    };
    w.__parcoarFly = (pos, look) => {
      camera.position.set(pos[0], pos[1], pos[2]);
      lookAtTarget(new THREE.Vector3(look[0], look[1], look[2]));
    };
    return () => {
      delete w.__parcoarFly;
    };
  });

  // --- Mount: set Euler order + initial orientation from the camera's
  //     starting position toward initialTarget. ---
  useEffect(() => {
    camera.rotation.order = "YXZ";
    const target = new THREE.Vector3(initialTarget[0], initialTarget[1], initialTarget[2]);
    lookAtTarget(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount only

  // --- Keyboard state for free flight. ---
  const keysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const isFlyKey = (code: string) =>
      code === "KeyW" ||
      code === "KeyA" ||
      code === "KeyS" ||
      code === "KeyD" ||
      code === "Space" ||
      code === "ShiftLeft" ||
      code === "ShiftRight" ||
      code === "ControlLeft" ||
      code === "ControlRight";
    const onDown = (e: KeyboardEvent) => {
      if (!isFlyKey(e.code)) return;
      // Stop the page from scrolling / the browser from intercepting
      // Ctrl+keys while flying.
      e.preventDefault();
      keysRef.current.add(e.code);
    };
    const onUp = (e: KeyboardEvent) => {
      if (!isFlyKey(e.code)) return;
      keysRef.current.delete(e.code);
    };
    const onBlur = () => keysRef.current.clear();
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // --- Mouse-drag look + wheel fly-speed. Attached to the canvas element. ---
  useEffect(() => {
    const el = gl.domElement;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (e: PointerEvent) => {
      // Left button only — look around. Don't capture right/middle so R3F
      // object picking and any context menu keep working.
      if (e.button !== 0) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      // Yaw about world up; pitch about local X. Inverted Y so pushing the
      // mouse up looks up.
      yawRef.current -= dx * LOOK_SENSITIVITY;
      pitchRef.current = THREE.MathUtils.clamp(
        pitchRef.current + dy * LOOK_SENSITIVITY,
        -PITCH_LIMIT,
        PITCH_LIMIT,
      );
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer id may already be released */
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Shift+wheel trims how fast W/A/S/D fly. Plain wheel moves the camera
      // along the direction you are looking, which is what "zoom" means to
      // anyone who has used a 3D viewer. The first version only adjusted fly
      // speed, silently, so scrolling appeared to do nothing at all.
      if (e.shiftKey) {
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        flySpeedRef.current = THREE.MathUtils.clamp(
          flySpeedRef.current * factor,
          MIN_FLY_SPEED,
          MAX_FLY_SPEED,
        );
        return;
      }
      // Dolly along the true look direction (including pitch) so scrolling
      // while looking down takes you down toward the floor, not past it.
      // Step scales with fly speed so it stays usable at every zoom level.
      const step = -Math.sign(e.deltaY) * flySpeedRef.current * 0.28;
      const cp = Math.cos(pitchRef.current);
      dolly.current.set(
        -Math.sin(yawRef.current) * cp,
        Math.sin(pitchRef.current),
        -Math.cos(yawRef.current) * cp,
      );
      camera.position.addScaledVector(dolly.current, step);
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("wheel", onWheel);
    };
  }, [gl, camera]);

  // --- Imperative handle for App's "Reset View" button + Scene's saveState. ---
  const handle = useMemo<FlyControlsHandle>(
    () => ({
      reset: () => {
        camera.position.copy(DEFAULT_VANTAGE.pos);
        lookAtTarget(DEFAULT_VANTAGE.look);
        flySpeedRef.current = DEFAULT_FLY_SPEED;
        presetDoneRef.current = null;
      },
      saveState: () => {
        /* no-op: the free camera has no saved spherical state to restore. */
      },
    }),
    // camera is a stable instance; refs are stable. lookAtTarget closes over
    // refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [camera],
  );

  useEffect(() => {
    if (controlsRef && typeof controlsRef === "object") {
      (controlsRef as React.MutableRefObject<FlyControlsHandle | null>).current = handle;
    }
  }, [handle, controlsRef]);

  // --- Per-frame camera driving. ---
  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 30);

    // --- Follow / POV / Drive: lock onto a car. Free-flight input ignored. ---
    if (mode === "follow" || mode === "pov" || mode === "drive") {
      const carGroup =
        mode === "follow"
          ? followCarId
            ? carGroupsRef?.current.get(followCarId) ?? null
            : null
          : (carGroupsRef?.current.get("player") ?? null);
      if (!carGroup) {
        // Car gone (parked / despawned): release to free flight so the user
        // isn't frozen on a stale frame.
        return;
      }

      const yaw = carGroup.rotation.y;
      const pitch = carGroup.rotation.z;
      // Car model faces +X at yaw 0; rotation about Y maps +X -> (cos, 0, -sin).
      fwd.current
        .set(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.sin(yaw) * Math.cos(pitch))
        .normalize();
      const carPos = carGroup.position;

      if (mode === "follow") {
        tmpPos.current
          .copy(carPos)
          .sub(tmpFwd.current.copy(fwd.current).multiplyScalar(14))
          .add(tmpUp.current.set(0, 9, 0));
        tmpLook.current
          .copy(carPos)
          .add(tmpFwd2.current.copy(fwd.current).multiplyScalar(5))
          .add(tmpUp.current.set(0, 1.5, 0));
        const k = lerpK(0.9, dt);
        camera.position.lerp(tmpPos.current, k);
        camera.lookAt(tmpLook.current);
      } else if (mode === "drive") {
        tmpPos.current
          .copy(carPos)
          .sub(tmpFwd.current.copy(fwd.current).multiplyScalar(9))
          .add(tmpUp.current.set(0, 4.5, 0));
        tmpLook.current
          .copy(carPos)
          .add(tmpFwd2.current.copy(fwd.current).multiplyScalar(6))
          .add(tmpUp.current.set(0, 1.2, 0));
        const k = lerpK(0.98, dt);
        camera.position.lerp(tmpPos.current, k);
        camera.lookAt(tmpLook.current);
      } else {
        // POV: driver's-eye position inside the cabin (right-hand drive).
        const EYE_FWD = 0.3;
        const EYE_RIGHT = 0.42;
        const EYE_UP = 1.22;
        tmpPos.current.set(EYE_FWD, EYE_UP, -EYE_RIGHT);
        tmpLook.current.set(EYE_FWD + 14, EYE_UP - 0.25, -EYE_RIGHT);
        tmpEuler.current.set(0, yaw, pitch, "XYZ");
        tmpQuat.current.setFromEuler(tmpEuler.current);
        const lex = tmpPos.current.x, ley = tmpPos.current.y, lez = tmpPos.current.z;
        const llx = tmpLook.current.x, lly = tmpLook.current.y, llz = tmpLook.current.z;
        tmpPos.current.applyQuaternion(tmpQuat.current).add(carPos);
        tmpLook.current.set(llx, lly, llz).applyQuaternion(tmpQuat.current).add(carPos);
        camera.position.copy(tmpPos.current);
        camera.lookAt(tmpLook.current);
        tmpPos.current.set(lex, ley, lez);
      }
      return;
    }

    // --- Free flight (orbit + presets after teleport). ---

    // Handing back from a car mode: re-derive yaw/pitch from the camera's
    // current forward so free flight continues from where the car cam left
    // off instead of snapping to a stale orientation.
    const prev = prevModeRef.current;
    prevModeRef.current = mode;
    if ((prev === "follow" || prev === "pov" || prev === "drive") && !isPreset(mode)) {
      camera.getWorldDirection(tmpDir.current);
      // getWorldDirection returns the forward unit vector; reuse the same
      // yaw/pitch inversion as lookAtTarget.
      pitchRef.current = THREE.MathUtils.clamp(
        Math.asin(THREE.MathUtils.clamp(tmpDir.current.y, -1, 1)),
        -PITCH_LIMIT,
        PITCH_LIMIT,
      );
      yawRef.current = Math.atan2(-tmpDir.current.x, -tmpDir.current.z);
    }

    // Preset: one-shot teleport to the vantage, then continue as free flight.
    if (isPreset(mode) && presetDoneRef.current !== mode) {
      const p = PRESETS[mode];
      camera.position.copy(p.pos);
      lookAtTarget(p.look);
      flySpeedRef.current = DEFAULT_FLY_SPEED;
      presetDoneRef.current = mode;
    }

    // Apply keyboard movement (frame-rate independent).
    const keys = keysRef.current;
    const boost =
      keys.has("ControlLeft") || keys.has("ControlRight");
    const speed = flySpeedRef.current * (boost ? BOOST_MULT : 1);

    // Horizontal forward from yaw (drop pitch so looking down doesn't send
    // you sideways); right is perpendicular in the XZ plane.
    fwd.current.set(-Math.sin(yawRef.current), 0, -Math.cos(yawRef.current)).normalize();
    right.current.set(Math.cos(yawRef.current), 0, -Math.sin(yawRef.current));

    move.current.set(0, 0, 0);
    if (keys.has("KeyW")) move.current.add(fwd.current);
    if (keys.has("KeyS")) move.current.sub(fwd.current);
    if (keys.has("KeyD")) move.current.add(right.current);
    if (keys.has("KeyA")) move.current.sub(right.current);
    // World up/down so looking down doesn't drift you sideways.
    if (keys.has("Space")) move.current.y += 1;
    if (keys.has("ShiftLeft") || keys.has("ShiftRight")) move.current.y -= 1;

    if (move.current.lengthSq() > 0) {
      move.current.normalize().multiplyScalar(speed * dt);
      camera.position.add(move.current);
    }

    // Commit orientation. Order YXZ keeps yaw about world up and pitch about
    // the camera's local X, so there is never any roll.
    camera.rotation.set(pitchRef.current, yawRef.current, 0, "YXZ");
  });

  // The rig is fully imperative; it renders no scene objects.
  return null;
}
