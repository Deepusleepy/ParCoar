import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useGLTF } from "@react-three/drei";
import { useKeyboard } from "../../hooks/useKeyboard";
import { useDayNightState } from "../DayNight";
import { runtime } from "../runtime";
import { groundHeight } from "../groundHeight";
import { WORLD_HALF, BRIDGE_MODERN_X, BRIDGE_TRUSS_X, BRIDGE_WIDTH, RIVER_HALF_WIDTH } from "../constants";
import {
  SPORT_CAR,
  speedKmh,
  stepCar,
  type Box2,
  type CarBody,
  type WorldConstraints,
} from "./physics";
import { cityCollisionBoxes } from "../CityDistrict";

/**
 * WorldCar — the player's car in the open world, plus its chase camera.
 *
 * Physics runs at a fixed 120 Hz step (accumulator pattern) so handling is
 * identical at any frame rate. The car body is a plain mutable object; React
 * re-renders never happen during driving — the group transform is written
 * directly in useFrame, and the HUD polls `runtime` at 10 Hz.
 *
 * The chase camera lags the car with exponential damping, leads the look
 * target with speed, and widens FOV with speed — the standard arcade feel.
 * V toggles between drive and fly (spectator) modes; the fly camera lives
 * in SpectatorCamera.tsx and both modes publish to `runtime`.
 */

const FIXED_DT = 1 / 120;
const MAX_FRAME_DT = 0.1;

/** Spawn: on the NS road at x=0, at the EW road z=120, facing north (-Z). */
const SPAWN = { x: 0, z: 120, heading: Math.PI };

const WORLD: WorldConstraints = {
  boxes: [],
  worldHalf: WORLD_HALF,
  isWater: (x, z) => {
    // Same contract as groundHeight.isWater, inlined to avoid a second
    // bridge-corridor loop per physics step.
    if (Math.abs(z) >= RIVER_HALF_WIDTH) return false;
    return Math.abs(x - BRIDGE_MODERN_X) > BRIDGE_WIDTH / 2 &&
      Math.abs(x - BRIDGE_TRUSS_X) > BRIDGE_WIDTH / 2;
  },
  bridgeCorridors: [
    { x: BRIDGE_MODERN_X, halfWidth: BRIDGE_WIDTH / 2, zRange: 28 },
    { x: BRIDGE_TRUSS_X, halfWidth: BRIDGE_WIDTH / 2, zRange: 28 },
  ],
};

/** Chase camera tuning. */
const CAM = {
  distance: 8.2,
  height: 3.4,
  lookAhead: 5,
  lookUp: 1.2,
  posDamping: 4.5,
  fovBase: 62,
  fovSpeed: 14,
};

export function WorldCar() {
  const keys = useKeyboard();
  const stateRef = useDayNightState();
  const { camera } = useThree();
  const groupRef = useRef<THREE.Group>(null);
  const wheelRefs = useRef<THREE.Object3D[]>([]);
  const frontWheelRefs = useRef<THREE.Object3D[]>([]);
  const headlightMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const taillightMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const beamRef = useRef<THREE.Mesh>(null);

  const gltf = useGLTF("/models/car_sport.glb");
  const carScene = useMemo(() => gltf.scene.clone(true), [gltf.scene]);

  // Collect wheel meshes once the clone exists.
  useEffect(() => {
    wheelRefs.current = [];
    frontWheelRefs.current = [];
    carScene.traverse((o) => {
      if (o instanceof THREE.Mesh && /wheel/i.test(o.name)) {
        wheelRefs.current.push(o);
        if (/front/i.test(o.name)) frontWheelRefs.current.push(o);
      }
    });
  }, [carScene]);

  // Physics body — plain mutable state, no React.
  const body = useRef<CarBody>({ ...SPAWN, vx: 0, vz: 0 });
  const accum = useRef(0);
  const wheelSpin = useRef(0);
  const camPos = useRef(new THREE.Vector3(SPAWN.x, 4, SPAWN.z - CAM.distance));
  const camLook = useRef(new THREE.Vector3(SPAWN.x, 1, SPAWN.z));
  const smoothedY = useRef(0);

  // Register collision boxes from the static world (city buildings now,
  // town houses when Town exports them).
  useEffect(() => {
    const boxes: Box2[] = [...cityCollisionBoxes];
    // Town houses register themselves into townCollisionBoxes if present.
    const townBoxes = (
      globalThis as { __townCollisionBoxes?: Box2[] }
    ).__townCollisionBoxes;
    if (townBoxes) boxes.push(...townBoxes);
    WORLD.boxes = boxes;
  }, []);

  useEffect(() => {
    // Publish initial state.
    runtime.carX = body.current.x;
    runtime.carZ = body.current.z;
    runtime.carHeading = body.current.heading;
  }, []);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, MAX_FRAME_DT);
    const k = keys.current;

    // --- input ---
    const throttle = k["KeyW"] || k["ArrowUp"] ? 1 : 0;
    const brake = k["KeyS"] || k["ArrowDown"] ? 1 : 0;
    const steer = (k["KeyA"] || k["ArrowLeft"] ? 1 : 0) + (k["KeyD"] || k["ArrowRight"] ? -1 : 0);
    const handbrake = !!k["Space"];

    // --- fixed-step physics ---
    accum.current += delta;
    let collided = false;
    while (accum.current >= FIXED_DT) {
      const r = stepCar(
        body.current,
        { throttle, brake, steer, handbrake },
        SPORT_CAR,
        WORLD,
        FIXED_DT,
      );
      if (r.collided) collided = true;
      accum.current -= FIXED_DT;
    }

    // --- ground follow (bridges ramp) ---
    const g = groundHeight(body.current.x, body.current.z);
    smoothedY.current += (g - smoothedY.current) * Math.min(1, 10 * delta);

    // --- write the group transform ---
    const grp = groupRef.current;
    if (grp) {
      grp.position.set(body.current.x, smoothedY.current, body.current.z);
      grp.rotation.y = body.current.heading;
    }

    // --- wheels: spin with speed, steer the fronts ---
    const vf = forwardSpeedOf(body.current);
    wheelSpin.current += vf * delta * 2.2;
    for (const w of wheelRefs.current) w.rotation.x = wheelSpin.current;
    for (const w of frontWheelRefs.current) w.rotation.y = -steer * 0.42;

    // --- lights: headlights + light pool at night, brake lights ---
    const s = stateRef.current;
    const night = s.streetlightIntensity;
    if (headlightMatRef.current) {
      headlightMatRef.current.emissiveIntensity = 0.08 + night * 5;
    }
    if (taillightMatRef.current) {
      taillightMatRef.current.emissiveIntensity =
        0.12 + night * 2 + (brake > 0 ? 3.5 : 0);
    }
    if (beamRef.current) {
      const mat = beamRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = night * 0.22;
      beamRef.current.visible = night > 0.02;
    }

    // --- chase camera ---
    const b = body.current;
    const [fx, fz] = [Math.sin(b.heading), Math.cos(b.heading)];
    const speedT = Math.min(Math.hypot(b.vx, b.vz) / SPORT_CAR.maxSpeed, 1);
    const dist = CAM.distance + speedT * 1.6;
    const desiredX = b.x - fx * dist;
    const desiredZ = b.z - fz * dist;
    const desiredY = smoothedY.current + CAM.height + speedT * 0.4;
    const t = 1 - Math.exp(-CAM.posDamping * delta);
    camPos.current.x += (desiredX - camPos.current.x) * t;
    camPos.current.y += (desiredY - camPos.current.y) * t;
    camPos.current.z += (desiredZ - camPos.current.z) * t;
    camera.position.copy(camPos.current);
    camLook.current.x += (b.x + fx * CAM.lookAhead - camLook.current.x) * t;
    camLook.current.y += (smoothedY.current + CAM.lookUp - camLook.current.y) * t;
    camLook.current.z += (b.z + fz * CAM.lookAhead - camLook.current.z) * t;
    camera.lookAt(camLook.current);
    const cam = camera as THREE.PerspectiveCamera;
    const targetFov = CAM.fovBase + speedT * CAM.fovSpeed;
    if (Math.abs(cam.fov - targetFov) > 0.01) {
      cam.fov += (targetFov - cam.fov) * Math.min(1, 3 * delta);
      cam.updateProjectionMatrix();
    }

    // --- publish to HUD runtime ---
    runtime.carX = b.x;
    runtime.carZ = b.z;
    runtime.carHeading = b.heading;
    runtime.carSpeedKmh = speedKmh(b);
    void collided; // crash SFX hook point (audio phase)
  });

  return (
    <group ref={groupRef} position={[SPAWN.x, 0, SPAWN.z]}>
      <primitive object={carScene} />

      {/* Headlight dots + brake lights — emissive boxes so bloom catches them */}
      <mesh position={[0.62, 0.62, 2.05]}>
        <boxGeometry args={[0.34, 0.14, 0.06]} />
        <meshStandardMaterial
          ref={headlightMatRef}
          color="#fff8e0"
          emissive="#fff3c0"
          emissiveIntensity={0.4}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[-0.62, 0.62, 2.05]}>
        <boxGeometry args={[0.34, 0.14, 0.06]} />
        <meshStandardMaterial
          color="#fff8e0"
          emissive="#fff3c0"
          emissiveIntensity={0.4}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[0.6, 0.66, -2.02]}>
        <boxGeometry args={[0.4, 0.12, 0.06]} />
        <meshStandardMaterial
          ref={taillightMatRef}
          color="#ff2222"
          emissive="#ff1a1a"
          emissiveIntensity={0.6}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[-0.6, 0.66, -2.02]}>
        <boxGeometry args={[0.4, 0.12, 0.06]} />
        <meshStandardMaterial
          color="#ff2222"
          emissive="#ff1a1a"
          emissiveIntensity={0.6}
          toneMapped={false}
        />
      </mesh>

      {/* Headlight pool — additive decal on the ground ahead, night only */}
      <mesh ref={beamRef} position={[0, 0.06, 6.5]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[7, 11]} />
        <meshBasicMaterial
          color="#ffe8b0"
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

/** Signed forward speed along the heading. */
function forwardSpeedOf(b: CarBody): number {
  return b.vx * Math.sin(b.heading) + b.vz * Math.cos(b.heading);
}
