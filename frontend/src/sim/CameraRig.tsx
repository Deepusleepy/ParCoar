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
/** Pointer-lock look. Deliberately lower than drag-look: captured mouse
 *  deltas are raw and unsmoothed, and at drag sensitivity the view jitters
 *  with every small hand movement. */
const MOUSE_LOOK_SENSITIVITY = 0.0011;
/** POV head-look sensitivity. Higher than the spectator pointer-lock value:
 *  in the cockpit the yaw clamp is only 0.6π, and at the spectator rate it
 *  takes ~1700px of mouse travel to reach the limit, which reads as "I
 *  can't turn my head". 0.0019 reaches the yaw limit in ~990px — still
 *  controlled, no jitter, but the driver can actually look over their
 *  shoulder to reverse. */
const POV_LOOK_SENSITIVITY = 0.0019;
/** Pitch clamp: stop just shy of straight up/down so the view never flips. */
const PITCH_LIMIT = Math.PI / 2 - 0.05;

/** Vertical field of view per rig family. Scene.tsx creates the canvas at a
 *  fixed 45°; the cockpit modes override it here, per mode, and every other
 *  mode restores the baseline on switch.
 *
 *  68° is narrow enough that the car interior fills the view and feels
 *  substantial (80° miniaturized everything), but wide enough to see
 *  adjacent bays and pillars in tight parking garage spaces. Racing games
 *  typically use 60-75° for cockpit view. */
const SPECTATOR_FOV = 45;
const COCKPIT_FOV = 68;
/** FOV easing time constant (seconds): a 45↔65 change settles in ~3τ ≈
 *  0.25 s, so switching modes breathes instead of snapping. Exponential in
 *  dt directly — lerpK() clamps its strength to ≤1 and cannot express a
 *  rate faster than 1/s. */
const FOV_TIME_CONSTANT = 0.08;

/** POV look-around range: how far the driver can turn their head. */
const POV_YAW_LIMIT = Math.PI * 0.6;
const POV_PITCH_LIMIT = Math.PI * 0.25;
/** How much of the remaining view offset closes per second of movement.
 *  0.8 closes gently — the view recenters smoothly without the snappy
 *  head-flick that 1.2 produced. The driver's glance lingers naturally
 *  and returns forward without fighting the user. */
const POV_RECENTER_SPEED = 0.8;
/** Player speed above which the POV view starts re-centring (u/s). 4 u/s is
 *  actually driving, not the creep that happens the instant you touch the
 *  throttle — so a glance survives a momentary nudge. */
const POV_RECENTER_MIN_SPEED = 4;
/** Hold Alt to hold your look direction while driving — re-centering pauses
 *  while the key is down, so a blind-spot glance stays put as long as you
 *  need it. */
const POV_LOOK_LOCK_KEY = "AltLeft";
/** Fraction of the car's ramp pitch that carries into the driver's gaze.
 *  The eye POSITION still tilts 1:1 with the cabin (the head rides in the
 *  seat), but the look direction levels itself partially — the way a real
 *  driver's inner ear keeps the horizon from swinging fully with the nose.
 *  1 = view tilts 1:1 with the car (nauseating on ramps); 0 = view stays
 *  world-level regardless of slope (feels disconnected from the car). 0.3
 *  keeps a subtle sense of the slope without the wild swing that 0.65
 *  produced — the #1 source of "weird movements" in POV. */
const POV_PITCH_FOLLOW = 0.3;

/** Default vantage for Reset View: a high 3/4 aerial over the lot. */
/** Where "Reset View" puts you: the same opening shot the app starts on. Keep
 *  this in step with `cameraPos` in Scene.tsx, or resetting moves you
 *  somewhere you have never been. */
const DEFAULT_VANTAGE = {
  pos: new THREE.Vector3(LOT_CENTER_X - 96, 72, LOT_CENTER_Z - 104),
  look: new THREE.Vector3(LOT_CENTER_X, (3 * FLOOR_HEIGHT) / 2, LOT_CENTER_Z),
};

/** Predefined camera framings for the preset (teleport) modes.
 *  Each floor's vantage sits INSIDE its storey at floor*FLOOR_HEIGHT + 6,
 *  never within 0.5 of a slab (slabs are at multiples of FLOOR_HEIGHT). */
const PRESETS: Record<
  "overview" | "floor0" | "floor1" | "floor2",
  { pos: THREE.Vector3; look: THREE.Vector3 }
> = {
  overview: {
    pos: new THREE.Vector3(LOT_CENTER_X + 30, 70, LOT_CENTER_Z + 70),
    look: new THREE.Vector3(LOT_CENTER_X, (3 * FLOOR_HEIGHT) / 2, LOT_CENTER_Z),
  },
  // Floor vantages look ALONG the aisles from the south-west corner. Turn
  // boards hang near x = 3 and x = 51.6, so the vantage stays clear of them
  // instead of filling the frame with a signboard.
  floor0: {
    pos: new THREE.Vector3(LOT_CENTER_X - 34, 0 * FLOOR_HEIGHT + 7, LOT_CENTER_Z - 34),
    look: new THREE.Vector3(LOT_CENTER_X + 6, 0 * FLOOR_HEIGHT + 1.5, LOT_CENTER_Z),
  },
  floor1: {
    pos: new THREE.Vector3(LOT_CENTER_X - 34, 1 * FLOOR_HEIGHT + 7, LOT_CENTER_Z - 34),
    look: new THREE.Vector3(LOT_CENTER_X + 6, 1 * FLOOR_HEIGHT + 1.5, LOT_CENTER_Z),
  },
  floor2: {
    pos: new THREE.Vector3(LOT_CENTER_X - 34, 2 * FLOOR_HEIGHT + 7, LOT_CENTER_Z - 34),
    look: new THREE.Vector3(LOT_CENTER_X + 6, 2 * FLOOR_HEIGHT + 1.5, LOT_CENTER_Z),
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

  // POV look-around offsets (radians) applied in car space. While the pointer
  // is locked the mouse steers them; they re-centre themselves once the car
  // moves off, so looking back while reversing costs no keypresses.
  const povYawOffsetRef = useRef(0);
  const povPitchOffsetRef = useRef(0);
  // Live mode mirror so event handlers read the current mode without
  // rebinding every render.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Previous-frame player position, for measuring speed in the rig.
  const prevPlayerPosRef = useRef(new THREE.Vector3());
  const hasPrevPlayerPosRef = useRef(false);
  // True while the driver holds the look-lock key; suppresses POV
  // re-centering so a blind-spot glance stays put.
  const povLookLockRef = useRef(false);

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
  const tmpQuatLook = useRef(new THREE.Quaternion());
  /** Smoothed look target for the drive chase cam. */
  const driveLookRef = useRef(new THREE.Vector3());
  /** Smoothed look target for the follow chase cam (same jitter fix as
   *  driveLookRef: AI heading steps arrive smoothed, not 1:1). */
  const followLookRef = useRef(new THREE.Vector3());
  /** Current camera FOV, eased toward the mode's target each frame. */
  const fovRef = useRef(SPECTATOR_FOV);

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
      __parcoarPovLook?: (yaw: number, pitch: number) => void;
    };
    w.__parcoarFly = (pos, look) => {
      camera.position.set(pos[0], pos[1], pos[2]);
      lookAtTarget(new THREE.Vector3(look[0], look[1], look[2]));
    };
    // Head-look offsets for POV (radians), same state the pointer drives —
    // headless browsers reject pointer lock, so tests go through here.
    w.__parcoarPovLook = (yaw, pitch) => {
      povYawOffsetRef.current = yaw;
      povPitchOffsetRef.current = pitch;
    };
    return () => {
      delete w.__parcoarFly;
      delete w.__parcoarPovLook;
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

  // --- POV look-lock: hold Alt to freeze re-centering so a blind-spot
  //     glance stays put while driving. Independent of the free-flight key
  //     set above so it never conflicts with WASD. ---
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code === POV_LOOK_LOCK_KEY) povLookLockRef.current = true;
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === POV_LOOK_LOCK_KEY) povLookLockRef.current = false;
    };
    const onBlur = () => {
      povLookLockRef.current = false;
    };
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
      if (document.pointerLockElement === el) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    // Look with the mouse without holding anything, the way a game does.
    // Click the scene once to capture the pointer; Escape releases it.
    // Drag-to-look still works when the pointer is not captured, so nothing
    // is lost for anyone who prefers that.
    const locked = () => document.pointerLockElement === el;
    const onClick = () => {
      if (!locked()) el.requestPointerLock?.();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (locked()) {
        if (modeRef.current === "pov") {
          // Look around the cabin instead of flying: raw deltas steer the
          // POV view offsets, clamped to a natural neck range. Uses the
          // higher POV_LOOK_SENSITIVITY so the driver can actually reach
          // the yaw limit without a huge mouse sweep.
          povYawOffsetRef.current = THREE.MathUtils.clamp(
            povYawOffsetRef.current - e.movementX * POV_LOOK_SENSITIVITY,
            -POV_YAW_LIMIT,
            POV_YAW_LIMIT,
          );
          povPitchOffsetRef.current = THREE.MathUtils.clamp(
            povPitchOffsetRef.current - e.movementY * POV_LOOK_SENSITIVITY,
            -POV_PITCH_LIMIT,
            POV_PITCH_LIMIT,
          );
          return;
        }
        // movementX/Y are raw deltas; there is no cursor position to track.
        yawRef.current -= e.movementX * MOUSE_LOOK_SENSITIVITY;
        // MINUS: movementY is positive when the mouse is pushed DOWN, and
        // pushing the mouse down must look down, which is negative pitch.
        pitchRef.current = THREE.MathUtils.clamp(
          pitchRef.current - e.movementY * MOUSE_LOOK_SENSITIVITY,
          -PITCH_LIMIT,
          PITCH_LIMIT,
        );
        return;
      }
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      // Yaw about world up; pitch about local X. Inverted Y so pushing the
      // mouse up looks up.
      yawRef.current -= dx * LOOK_SENSITIVITY;
      pitchRef.current = THREE.MathUtils.clamp(
        pitchRef.current - dy * LOOK_SENSITIVITY,
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
      // anyone who has used a 3D viewer.
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

    el.addEventListener("click", onClick);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("click", onClick);
      el.removeEventListener("pointerdown", onPointerDown);
      if (document.pointerLockElement === el) document.exitPointerLock?.();
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

  // --- Mode transitions: fresh look-around state whenever the driver gets
  //     in, and no stale speed sample when handing between rigs. ---
  useEffect(() => {
    povYawOffsetRef.current = 0;
    povPitchOffsetRef.current = 0;
    hasPrevPlayerPosRef.current = false;
    povLookLockRef.current = false;
  }, [mode]);

  // --- Per-frame camera driving. ---
  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 30);

    // --- Per-mode field of view. Cockpit rigs widen to COCKPIT_FOV; every
    // spectator/free-flight mode eases back to SPECTATOR_FOV. Runs before
    // any early return so the restore also happens while a car mode has no
    // car to track.
    const targetFov = mode === "pov" || mode === "drive" ? COCKPIT_FOV : SPECTATOR_FOV;
    fovRef.current +=
      (targetFov - fovRef.current) * (1 - Math.exp(-dt / FOV_TIME_CONSTANT));
    // Narrow to PerspectiveCamera (the only kind Scene.tsx creates): R3F
    // types the store camera broadly and OrthographicCamera has no fov.
    // Skip the projection-matrix rebuild once settled — it's not free.
    if (
      camera instanceof THREE.PerspectiveCamera &&
      Math.abs(camera.fov - fovRef.current) > 0.01
    ) {
      camera.fov = fovRef.current;
      camera.updateProjectionMatrix();
    }

    // --- Follow / POV / Drive: lock onto a car. Free-flight input ignored. ---
    if (mode === "follow" || mode === "pov" || mode === "drive") {
      const carGroup =
        mode === "follow"
          ? followCarId
            ? carGroupsRef?.current.get(followCarId) ?? null
            : null
          : (carGroupsRef?.current.get("player") ?? null);
      if (!carGroup) {
        // Car gone (parked AI car removed, player unmounted mid-load): hold
        // the last pose this frame instead of writing garbage, and reset the
        // look-around state so a later re-entry starts centred.
        povYawOffsetRef.current = 0;
        povPitchOffsetRef.current = 0;
        hasPrevPlayerPosRef.current = false;
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
        if (!hasPrevPlayerPosRef.current) {
          camera.position.copy(tmpPos.current);
          followLookRef.current.copy(tmpLook.current);
          hasPrevPlayerPosRef.current = true;
        } else {
          camera.position.lerp(tmpPos.current, lerpK(0.94, dt));
          // Smooth the look target like drive mode does: AI cars update
          // their heading in discrete steps and an unsmoothed lookAt
          // telegraphs every one of them as a snap.
          followLookRef.current.lerp(tmpLook.current, lerpK(0.995, dt));
        }
        camera.lookAt(followLookRef.current);
      } else if (mode === "drive") {
        tmpPos.current
          .copy(carPos)
          .sub(tmpFwd.current.copy(fwd.current).multiplyScalar(9))
          .add(tmpUp.current.set(0, 4.5, 0));
        tmpLook.current
          .copy(carPos)
          .add(tmpFwd2.current.copy(fwd.current).multiplyScalar(6))
          .add(tmpUp.current.set(0, 1.2, 0));
        // Damped chase: position eases toward the ideal anchor and the look
        // target is smoothed in the same breath, so physics micro-jitter
        // arrives at the screen attenuated rather than 1:1.
        if (!hasPrevPlayerPosRef.current) {
          camera.position.copy(tmpPos.current);
          driveLookRef.current.copy(tmpLook.current);
          hasPrevPlayerPosRef.current = true;
        } else {
          camera.position.lerp(tmpPos.current, lerpK(0.99, dt));
          driveLookRef.current.lerp(tmpLook.current, lerpK(0.998, dt));
        }
        camera.lookAt(driveLookRef.current);
      } else {
        // POV: driver's-eye position inside the cabin (right-hand drive).
        // The eye is RIGID in car space — copied, never lerped. Smoothing a
        // car-attached point in world space makes the camera cut across the
        // body during turns and end up outside the car (the #20 regression);
        // a rigid copy physically cannot leave the cabin. Micro-jitter from
        // the physics step reads as road texture at these magnitudes.
        // The eye sits above the wheel rim looking level, so the wheel and
        // dash form a low cowl across the bottom of the frame and the road
        // fills the view (the wheel arc peeks in at the bottom right).
        const EYE_FWD = 0.3;
        const EYE_RIGHT = 0.42;
        const EYE_UP = 1.38;
        tmpEuler.current.set(0, yaw, pitch, "XYZ");
        tmpQuat.current.setFromEuler(tmpEuler.current);
        tmpFwd2.current.set(EYE_FWD, EYE_UP, -EYE_RIGHT).applyQuaternion(tmpQuat.current).add(carPos);
        camera.position.copy(tmpFwd2.current);

        // Re-centre the view while the car moves; measure speed from the
        // group itself so no external wiring is needed.
        let speed = 0;
        if (hasPrevPlayerPosRef.current && dt > 1e-5) {
          speed = prevPlayerPosRef.current.distanceTo(carPos) / dt;
        }
        prevPlayerPosRef.current.copy(carPos);
        hasPrevPlayerPosRef.current = true;
        if (speed > POV_RECENTER_MIN_SPEED && !povLookLockRef.current) {
          const k = lerpK(POV_RECENTER_SPEED, dt);
          // Recenter yaw only: pitch tracks ramps/slopes and the car's own
          // pitch is already composed into the gaze (see POV_PITCH_FOLLOW),
          // so easing pitch back fights the driver on every incline. Hold
          // Alt (POV_LOOK_LOCK_KEY) to freeze even yaw re-centering for a
          // blind-spot glance.
          povYawOffsetRef.current *= 1 - k;
        }

        // Look DIRECTION: compose the head-look offsets on top of the car
        // yaw, but only POV_PITCH_FOLLOW of the car's ramp pitch. The head
        // still turns with yaw (you look where the car points), yet climbing
        // a deck no longer swings the whole world up with the nose — the
        // gaze levels itself the way a real driver's does. premultiply keeps
        // the head offsets in cabin space (carQuat * headQuat).
        tmpEuler.current.set(0, yaw, pitch * POV_PITCH_FOLLOW, "XYZ");
        tmpQuatLook.current.setFromEuler(tmpEuler.current);
        tmpEuler.current.set(
          povPitchOffsetRef.current,
          povYawOffsetRef.current,
          0,
          "YXZ",
        );
        tmpQuat.current.setFromEuler(tmpEuler.current);
        tmpQuatLook.current.premultiply(tmpQuat.current);
        // Look target sits just below eye height at 8 units out: near-level
        // gaze keeps the road filling the frame while the slight downtilt
        // keeps the lane markings ahead of the car readable.
        tmpLook.current
          .set(EYE_FWD + 8, EYE_UP - 0.12, -EYE_RIGHT)
          .applyQuaternion(tmpQuatLook.current)
          .add(carPos);
        camera.lookAt(tmpLook.current);
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
