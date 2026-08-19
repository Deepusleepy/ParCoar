import { useCallback, useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import * as THREE from "three";
import { FLOOR_HEIGHT, LOT_CENTER_X, LOT_CENTER_Z } from "./constants";

/**
 * Camera modes available to the user.
 * - `orbit`: free orbit/pan/zoom around a movable target (the default).
 * - `overview` / `floorN`: animated "jump" to a predefined framing; once
 *   settled, orbit is re-enabled so the user can look around from there.
 * - `follow`: chase cam locked behind & above a selected car.
 * - `pov`: first-person view from inside a selected car.
 * - `drive`: third-person chase cam behind the player car.
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

export interface CameraRigProps {
  mode: CameraMode;
  followCarId: string | null;
  /** Shared map of active-car id -> THREE.Group, populated by ActiveCarMesh. */
  carGroupsRef?: React.MutableRefObject<Map<string, THREE.Group>>;
  /** App-level controls ref (for the Reset View button). */
  controlsRef?: React.Ref<OrbitControlsImpl>;
  /** Initial orbit target (the default lot-center framing). */
  initialTarget: [number, number, number];
}

/** Predefined camera framings for the preset modes. */
const PRESETS: Record<
  "overview" | "floor0" | "floor1" | "floor2",
  { pos: THREE.Vector3; look: THREE.Vector3 }
> = {
  overview: {
    pos: new THREE.Vector3(LOT_CENTER_X, 80, LOT_CENTER_Z + 80),
    look: new THREE.Vector3(LOT_CENTER_X, (3 * FLOOR_HEIGHT) / 2, LOT_CENTER_Z),
  },
  floor0: {
    pos: new THREE.Vector3(LOT_CENTER_X + 30, 0 * FLOOR_HEIGHT + 15, LOT_CENTER_Z - 30),
    look: new THREE.Vector3(LOT_CENTER_X, 0 * FLOOR_HEIGHT + 2, LOT_CENTER_Z),
  },
  floor1: {
    pos: new THREE.Vector3(LOT_CENTER_X + 30, 1 * FLOOR_HEIGHT + 15, LOT_CENTER_Z - 30),
    look: new THREE.Vector3(LOT_CENTER_X, 1 * FLOOR_HEIGHT + 2, LOT_CENTER_Z),
  },
  floor2: {
    pos: new THREE.Vector3(LOT_CENTER_X + 30, 2 * FLOOR_HEIGHT + 15, LOT_CENTER_Z - 30),
    look: new THREE.Vector3(LOT_CENTER_X, 2 * FLOOR_HEIGHT + 2, LOT_CENTER_Z),
  },
};

/** Frame-rate-independent lerp factor: approaches 1 at `strength` per second.
 *  `strength` is clamped to [0, 1] because values > 1 make `(1 - strength)^dt`
 *  produce NaN for fractional `dt`, which corrupts the camera transform. */
function lerpK(strength: number, dt: number): number {
  const s = Math.max(0, Math.min(1, strength));
  return 1 - Math.pow(1 - s, dt);
}

/**
 * CameraRig owns the OrbitControls instance and drives the camera each frame
 * based on the current `mode`. In `orbit` mode the user is in full control
 * (pan/orbit/zoom). In every other mode OrbitControls is disabled and the
 * rig animates the camera directly; preset modes re-enable orbit once the
 * camera has settled so the user can look around from the chosen vantage.
 *
 * drei's OrbitControls only calls `controls.update()` when `enabled` is true,
 * so disabling it gives us a free hand to move the camera without fighting
 * the controls' internal spherical state.
 */
export function CameraRig({
  mode,
  followCarId,
  carGroupsRef,
  controlsRef,
  initialTarget,
}: CameraRigProps) {
  const camera = useThree((s) => s.camera);
  // Internal handle so useFrame can read the controls imperatively.
  const internal = useRef<OrbitControlsImpl | null>(null);

  // Forward the controls instance to both our ref and the app's controlsRef.
  const setRef = useCallback(
    (inst: OrbitControlsImpl | null) => {
      internal.current = inst;
      if (controlsRef && typeof controlsRef === "object") {
        (controlsRef as React.MutableRefObject<OrbitControlsImpl | null>).current = inst;
      }
    },
    [controlsRef],
  );

  // Set the initial orbit target once on mount. Doing this imperatively
  // (instead of via the `target` prop) decouples the target from the render
  // cycle so user panning isn't reset by re-renders.
  useEffect(() => {
    const controls = internal.current;
    if (!controls) return;
    controls.target.set(initialTarget[0], initialTarget[1], initialTarget[2]);
    controls.update();
  }, []); // mount only — intentionally excludes initialTarget

  // Animate presets until the camera is close to the target framing.
  const animatingRef = useRef(true);
  const modeRef = useRef<CameraMode>(mode);
  useEffect(() => {
    // Any mode switch (re)arms the preset animation; follow/pov always track.
    animatingRef.current = true;
    modeRef.current = mode;
  }, [mode]);

  // Reusable temp vectors to avoid per-frame allocation.
  const tmpPos = useRef(new THREE.Vector3());
  const tmpLook = useRef(new THREE.Vector3());
  const fwd = useRef(new THREE.Vector3());
  const tmpFwd = useRef(new THREE.Vector3());
  const tmpFwd2 = useRef(new THREE.Vector3());
  const tmpUp = useRef(new THREE.Vector3());
  const tmpEuler = useRef(new THREE.Euler());
  const tmpQuat = useRef(new THREE.Quaternion());

  useFrame((_, delta) => {
    const controls = internal.current;
    if (!controls) return;
    const dt = Math.min(delta, 1 / 30);

    // --- Orbit: hand control to the user. ---
    if (mode === "orbit") {
      controls.enabled = true;
      return;
    }

    // --- Follow / POV / Drive: lock onto a car. ---
    if (mode === "follow" || mode === "pov" || mode === "drive") {
      // POV/drive modes drive the player car (registered by DrivableCar);
      // follow mode tracks a selected AI car by id.
      const carGroup =
        mode === "follow"
          ? followCarId
            ? carGroupsRef?.current.get(followCarId) ?? null
            : null
          : (carGroupsRef?.current.get("player") ?? null);
      if (!carGroup) {
        // Car gone (parked / despawned): release control so the user isn't
        // frozen on a stale frame.
        controls.enabled = true;
        return;
      }
      controls.enabled = false;

      const yaw = carGroup.rotation.y;
      const pitch = carGroup.rotation.z;
      // Car model faces +X at yaw 0; rotation about Y maps +X -> (cos, 0, -sin).
      // Incorporate pitch so the camera tilts with the car on ramps.
      fwd.current.set(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.sin(yaw) * Math.cos(pitch)).normalize();
      const carPos = carGroup.position;

      if (mode === "follow") {
        // Chase cam: behind the car along its forward axis, raised.
        // Height of 9 (vs 7 before) lifts the camera above the floor surface
        // so the view shows the scene ahead, not a flat expanse of floor.
        tmpPos.current
          .copy(carPos)
          .sub(tmpFwd.current.copy(fwd.current).multiplyScalar(14))
          .add(tmpUp.current.set(0, 9, 0));
        // Look slightly ahead of the car so the view leads the motion.
        tmpLook.current
          .copy(carPos)
          .add(tmpFwd2.current.copy(fwd.current).multiplyScalar(5))
          .add(tmpUp.current.set(0, 1.5, 0));

        const k = lerpK(0.9, dt);
        camera.position.lerp(tmpPos.current, k);
        // Keep the controls target in sync so a later switch to orbit is
        // framed on the car, then orient the camera toward it.
        controls.target.lerp(tmpLook.current, k);
        camera.lookAt(controls.target);
      } else if (mode === "drive") {
        // Third-person chase cam: higher and further back for parking visibility.
        tmpPos.current
          .copy(carPos)
          .sub(tmpFwd.current.copy(fwd.current).multiplyScalar(9))
          .add(tmpUp.current.set(0, 4.5, 0));
        tmpLook.current
          .copy(carPos)
          .add(tmpFwd2.current.copy(fwd.current).multiplyScalar(6))
          .add(tmpUp.current.set(0, 1.2, 0));
        const k = lerpK(0.98, dt); // responsive follow so the view keeps up
        camera.position.lerp(tmpPos.current, k);
        controls.target.lerp(tmpLook.current, k);
        camera.lookAt(controls.target);
      } else {
        // POV: driver's-eye position inside the cabin.
        // Right-hand drive: the driver sits on the right side of the car.
        // At yaw 0 (facing +X) the driver's right is -Z, so the right vector
        // in world space is (-sin(yaw), 0, -cos(yaw)).
        //
        // The eye offset is built in car-local space (forward/right/up) then
        // transformed by the car's full rotation (yaw about Y, then pitch
        // about Z) so the camera tilts with the car on ramps.
        const EYE_FWD = 0.3; // at the steering wheel, ahead of car origin
        const EYE_RIGHT = 0.42; // toward the driver (right) side
        const EYE_UP = 1.22; // eye height below roof (1.38), above wheel (1.12)
        // Local-space eye offset: +X forward, -Z toward driver (right), +Y up.
        // Reuse tmpPos as localEye, tmpLook as localLook to avoid allocation.
        tmpPos.current.set(EYE_FWD, EYE_UP, -EYE_RIGHT);
        // Look nearly level through the windshield (center at y≈1.08), with a
        // slight downward tilt so the road is visible ahead of the hood.
        tmpLook.current.set(EYE_FWD + 14, EYE_UP - 0.25, -EYE_RIGHT);
        // Build the car's rotation: yaw (about Y) then pitch (about Z), in the
        // order three.js applies them for a +X-facing car (Euler XYZ default).
        // Reuse pre-allocated quaternion/euler.
        tmpEuler.current.set(0, yaw, pitch, "XYZ");
        tmpQuat.current.setFromEuler(tmpEuler.current);
        // Save local offsets before applying quaternion.
        const lex = tmpPos.current.x, ley = tmpPos.current.y, lez = tmpPos.current.z;
        const llx = tmpLook.current.x, lly = tmpLook.current.y, llz = tmpLook.current.z;
        tmpPos.current.applyQuaternion(tmpQuat.current).add(carPos);
        tmpLook.current.set(llx, lly, llz).applyQuaternion(tmpQuat.current).add(carPos);

        // POV mode — rigid attachment, no smoothing. Lerping lags the car and
        // lets the camera clip through walls; a direct snap keeps it locked.
        camera.position.copy(tmpPos.current);
        controls.target.copy(tmpLook.current);
        camera.lookAt(tmpLook.current);
        // Restore tmpPos for next frame (it was mutated).
        tmpPos.current.set(lex, ley, lez);
      }
      return;
    }

    // --- Presets (overview / floorN): animated jump, then free orbit. ---
    const preset = PRESETS[mode];
    if (!preset) {
      controls.enabled = true;
      return;
    }

    if (!animatingRef.current) {
      // Settled: let the user orbit from the preset vantage.
      controls.enabled = true;
      return;
    }

    controls.enabled = false;
    const k = lerpK(0.9, dt);
    camera.position.lerp(preset.pos, k);
    controls.target.lerp(preset.look, k);
    camera.lookAt(controls.target);

    // Close enough -> stop animating and hand control back.
    if (
      camera.position.distanceTo(preset.pos) < 0.6 &&
      controls.target.distanceTo(preset.look) < 0.6
    ) {
      animatingRef.current = false;
      controls.enabled = true;
    }
  });

  return (
    <OrbitControls
      ref={setRef}
      enableDamping
      dampingFactor={0.08}
      autoRotate={false}
      minDistance={10}
      maxDistance={320}
      minPolarAngle={0.04} // ~2° — allow near-top-down view
      maxPolarAngle={Math.PI * 0.62} // ~112° — see the bottom floor from below horizontal
    />
  );
}
