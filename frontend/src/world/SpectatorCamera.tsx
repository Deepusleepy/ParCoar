import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useKeyboard } from "../hooks/useKeyboard";

/**
 * Free-fly spectator camera — the primary way the user interacts with the
 * world right now. The user is a spectator, not a driver.
 *
 * Controls:
 *  - WASD: move relative to look direction (W=forward, S=back, A=left, D=right)
 *  - Space / ShiftLeft: move straight up / down (Space=up, Shift=down)
 *  - Mouse drag: look around (yaw + pitch)
 *  - Scroll wheel: change move speed (slow to fast)
 *  - ShiftLeft (held while moving): 2× speed boost
 *
 * Movement is damped: the camera position lerps toward a target each frame
 * for smooth acceleration/deceleration. There is no collision — the camera
 * flies through everything.
 *
 * Start position: high up looking down at the world ([0, 50, 150] looking
 * at origin), so the user immediately sees sky, ground, and Mt. Fuji.
 */

/* ------------------------------------------------------------------ *
 *  Tuning
 * ------------------------------------------------------------------ */

/** Base move speed in world units / second. */
const BASE_SPEED = 30;
/** Minimum move speed (scroll wheel down). */
const MIN_SPEED = 5;
/** Maximum move speed (scroll wheel up). */
const MAX_SPEED = 300;
/** Speed step per scroll wheel notch. */
const SPEED_STEP = 1.25;
/** Boost multiplier when Shift is held while moving. */
const BOOST_MULT = 2.0;
/** Look sensitivity: radians per pixel of mouse drag. */
const LOOK_SENSITIVITY = 0.0028;
/** Pitch clamp: stop just shy of straight up/down so the view never flips. */
const PITCH_LIMIT = Math.PI / 2 - 0.05;
/** Position damping: fraction of the remaining gap closed per second.
 *  Higher = snappier, lower = floatier. 8.0 settles in ~0.4s. */
const DAMPING = 8.0;

/* ------------------------------------------------------------------ *
 *  Component
 * ------------------------------------------------------------------ */

export interface SpectatorCameraProps {
  /** Optional ref to receive the camera position each frame (for HUD). */
  cameraPosRef?: React.MutableRefObject<{ x: number; y: number; z: number } | null>;
}

export function SpectatorCamera({ cameraPosRef }: SpectatorCameraProps) {
  const { camera, gl } = useThree();
  const keys = useKeyboard();

  // Persistent state (mutated in place, no re-renders).
  const yawRef = useRef(0);
  const pitchRef = useRef(-0.35); // looking slightly down at the world
  const speedRef = useRef(BASE_SPEED);
  const targetPosRef = useRef(new THREE.Vector3(0, 50, 150));
  const isDraggingRef = useRef(false);
  const lastPointerRef = useRef({ x: 0, y: 0 });

  // Reusable temporaries (avoid per-frame allocation).
  const moveDir = useMemo(() => new THREE.Vector3(), []);
  const forward = useMemo(() => new THREE.Vector3(), []);
  const right = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  // Set initial camera orientation on mount.
  useEffect(() => {
    camera.position.set(0, 50, 150);
    // Look toward origin from [0, 50, 150].
    const dir = new THREE.Vector3(0, 0, 0).sub(camera.position).normalize();
    yawRef.current = Math.atan2(dir.x, dir.z);
    pitchRef.current = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    targetPosRef.current.copy(camera.position);
  }, [camera]);

  // Debug camera control — allows external scripts (Playwright) to teleport
  // the camera by dispatching a "devin-camera-set" event on window.
  useEffect(() => {
    const onCameraSet = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      const pos = detail.pos || detail.cam;
      const look = detail.look || detail.lookAt;
      if (pos) {
        camera.position.set(pos[0], pos[1], pos[2]);
        targetPosRef.current.set(pos[0], pos[1], pos[2]);
      }
      if (look) {
        const dir = new THREE.Vector3(look[0], look[1], look[2])
          .sub(camera.position)
          .normalize();
        // Three.js camera forward is -Z, so yaw = atan2(-dir.x, -dir.z)
        // to make the camera actually face the target.
        yawRef.current = Math.atan2(-dir.x, -dir.z);
        pitchRef.current = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      }
    };
    window.addEventListener("devin-camera-set", onCameraSet);
    return () => window.removeEventListener("devin-camera-set", onCameraSet);
  }, [camera]);

  // Mouse drag look + scroll speed on the canvas element.
  useEffect(() => {
    const dom = gl.domElement;

    const onPointerDown = (e: PointerEvent) => {
      isDraggingRef.current = true;
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      dom.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isDraggingRef.current) return;
      const dx = e.clientX - lastPointerRef.current.x;
      const dy = e.clientY - lastPointerRef.current.y;
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      // Yaw left/right, pitch up/down. Standard FPS: drag right = look right,
      // drag up = look up. In Three.js YXZ, positive yaw rotates CCW (left),
      // so we subtract dx to make drag-right = look-right.
      yawRef.current -= dx * LOOK_SENSITIVITY;
      // Positive pitch tilts the camera down in YXZ, so we subtract dy:
      // drag up (dy<0) → pitch increases → look up.
      pitchRef.current -= dy * LOOK_SENSITIVITY;
      pitchRef.current = THREE.MathUtils.clamp(
        pitchRef.current,
        -PITCH_LIMIT,
        PITCH_LIMIT,
      );
    };

    const onPointerUp = (e: PointerEvent) => {
      isDraggingRef.current = false;
      try {
        dom.releasePointerCapture(e.pointerId);
      } catch {
        // Pointer may already be released; ignore.
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1 / SPEED_STEP : SPEED_STEP;
      speedRef.current = THREE.MathUtils.clamp(
        speedRef.current * factor,
        MIN_SPEED,
        MAX_SPEED,
      );
    };

    dom.addEventListener("pointerdown", onPointerDown);
    dom.addEventListener("pointermove", onPointerMove);
    dom.addEventListener("pointerup", onPointerUp);
    dom.addEventListener("pointercancel", onPointerUp);
    dom.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      dom.removeEventListener("pointerdown", onPointerDown);
      dom.removeEventListener("pointermove", onPointerMove);
      dom.removeEventListener("pointerup", onPointerUp);
      dom.removeEventListener("pointercancel", onPointerUp);
      dom.removeEventListener("wheel", onWheel);
    };
  }, [gl]);

  useFrame((_, delta) => {
    const k = keys.current;

    // --- Look direction from yaw/pitch (YXZ Euler order) ---
    const yaw = yawRef.current;
    const pitch = pitchRef.current;
    // Forward vector on the XZ plane (yaw only) for WASD movement.
    // Three.js camera looks down -Z by default; with YXZ Euler and yaw about
    // Y, the camera's forward direction is (-sin(yaw), 0, -cos(yaw)).
    forward.set(-Math.sin(yaw), 0, -Math.cos(yaw)).normalize();
    // Right vector = forward × up.
    right.crossVectors(forward, up).normalize();

    // --- Build movement input from keys ---
    moveDir.set(0, 0, 0);
    if (k["KeyW"]) moveDir.add(forward);
    if (k["KeyS"]) moveDir.sub(forward);
    if (k["KeyD"]) moveDir.add(right);
    if (k["KeyA"]) moveDir.sub(right);
    if (k["Space"]) moveDir.add(up);
    // Shift doubles as "down" when not used as a boost. But the task says
    // Shift = go faster. We need a separate down key. Use ShiftLeft for
    // boost and KeyC for down (common in free-fly cameras).
    if (k["KeyC"]) moveDir.sub(up);

    // Speed: base × boost if Shift held.
    let speed = speedRef.current;
    if (k["ShiftLeft"] || k["ShiftRight"]) speed *= BOOST_MULT;

    // Normalize horizontal movement so diagonal isn't faster.
    if (moveDir.lengthSq() > 0) {
      moveDir.normalize().multiplyScalar(speed * delta);
      targetPosRef.current.add(moveDir);
    }

    // --- Damped position (lerp toward target) ---
    const t = 1 - Math.exp(-DAMPING * delta);
    camera.position.lerp(targetPosRef.current, t);

    // --- Apply orientation as YXZ Euler (yaw about world up, pitch about local X) ---
    camera.rotation.order = "YXZ";
    camera.rotation.set(pitch, yaw, 0);

    // --- Publish position to the HUD ref ---
    if (cameraPosRef) {
      cameraPosRef.current = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
    }
  });

  return null;
}
