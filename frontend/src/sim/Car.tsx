import { Suspense, memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { ActiveCar, CarColor, CarSize, LotData } from "../types";
import { CAR_DIMS, CAR_Y_OFFSET, CAR_SPEED, COLOR_HEX, LANE_WIDTH, toWorld } from "./constants";
import { resolvePath } from "./paths";
/* ------------------------------------------------------------------ */
/*  GLTF model config                                                  */
/* ------------------------------------------------------------------ */

const MODEL_PATHS: Record<CarSize, string> = {
  small: "/models/car_sport.glb",
  medium: "/models/car_sedan.glb",
  large: "/models/car_suv.glb",
};

/** Natural model length along Z (from bounding box). */
const MODEL_LENGTH: Record<CarSize, number> = {
  small: 3.93,
  medium: 4.22,
  large: 4.16,
};

/** Uniform scale so the model length matches CAR_DIMS[size].length. */
const MODEL_SCALE: Record<CarSize, number> = {
  small: CAR_DIMS.small.length / MODEL_LENGTH.small,
  medium: CAR_DIMS.medium.length / MODEL_LENGTH.medium,
  large: CAR_DIMS.large.length / MODEL_LENGTH.large,
};

/** GLTF cars face +Z; the sim expects +X as forward. Rotate π/2 around Y. */
const FORWARD_ROT = Math.PI / 2;

/** Material names that are NOT body paint (keep as-is from the GLTF). */
const NON_BODY = new Set(["Windows", "Black", "Grey", "Headlights", "TailLights"]);

// Preload all three models so they're cached before first render.
useGLTF.preload(MODEL_PATHS.small);
useGLTF.preload(MODEL_PATHS.medium);
useGLTF.preload(MODEL_PATHS.large);

/* ------------------------------------------------------------------ */
/*  CarModel — loads a GLTF, clones it, recolors the body              */
/* ------------------------------------------------------------------ */

interface CarModelProps {
  color: CarColor;
  size: CarSize;
  /** When true (active cars) use MeshPhysicalMaterial with clearcoat + glass.
   *  When false (parked cars) use cheaper MeshStandardMaterial to cut fragment
   *  cost for the many static decorations. */
  highQuality?: boolean;
  /** Called with the cloned scene root after material replacement. */
  onLoad?: (obj: THREE.Object3D) => void;
}

function CarModelInner({ color, size, highQuality = true, onLoad }: CarModelProps) {
  const { scene } = useGLTF(MODEL_PATHS[size]);
  const hex = COLOR_HEX[color];

  const { bodyMat, glassMat, scene: cloned } = useMemo(() => {
    const s = scene.clone();

    // Body paint: glossy clearcoat for active cars, plain standard for parked.
    const body: THREE.MeshStandardMaterial = highQuality
      ? new THREE.MeshPhysicalMaterial({
          color: new THREE.Color(hex),
          metalness: 0.6,
          roughness: 0.35,
          clearcoat: 1.0,
          clearcoatRoughness: 0.08,
          envMapIntensity: 1.2,
        })
      : new THREE.MeshStandardMaterial({
          color: new THREE.Color(hex),
          metalness: 0.5,
          roughness: 0.4,
        });
    // Glass: tinted transparent for active cars, opaque for parked.
    const glass: THREE.MeshStandardMaterial = highQuality
      ? new THREE.MeshPhysicalMaterial({
          color: new THREE.Color("#0a0e14"),
          metalness: 0.0,
          roughness: 0.05,
          transparent: true,
          opacity: 0.5,
          ior: 1.45,
          envMapIntensity: 1.5,
        })
      : new THREE.MeshStandardMaterial({
          color: new THREE.Color("#1a1d24"),
          metalness: 0.3,
          roughness: 0.1,
          transparent: false,
          opacity: 1,
        });

    s.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.castShadow = true;
      obj.receiveShadow = true;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      const replaced = mats.map((m) => {
        if (!(m instanceof THREE.Material)) return m;
        if (m.name === "Windows") return glass;
        if (NON_BODY.has(m.name)) return m; // keep trim / lights / tires
        return body; // everything else = body paint
      });
      obj.material = replaced.length === 1 ? replaced[0] : replaced;
    });

    return { bodyMat: body, glassMat: glass, scene: s };
  }, [scene, hex, highQuality]);

  // Dispose GPU materials when the model unmounts.
  useEffect(() => {
    return () => {
      bodyMat.dispose();
      glassMat.dispose();
    };
  }, [bodyMat, glassMat]);

  // Notify parent of the cloned scene for wheel collection.
  useEffect(() => {
    if (onLoad) onLoad(cloned);
  }, [cloned, onLoad]);

  return (
    <primitive object={cloned} rotation={[0, FORWARD_ROT, 0]} scale={MODEL_SCALE[size]} />
  );
}

/** Core car model component (wrapped in Suspense for GLTF loading). */
export const CarModel = (props: CarModelProps) => (
  <Suspense fallback={null}>
    <CarModelInner {...props} />
  </Suspense>
);

/* ------------------------------------------------------------------ */
/*  Existing exports used by Scene.tsx / App.tsx                       */
/* ------------------------------------------------------------------ */

interface StaticCarProps {
  color: CarColor;
  size: CarSize;
  position: [number, number, number];
  rotationY: number;
}

/** A non-moving car placed at a fixed world transform. */
export const StaticCar = ({ color, size, position, rotationY }: StaticCarProps) => (
  <group position={position} rotation={[0, rotationY, 0]}>
    <CarModel color={color} size={size} highQuality={false} />
  </group>
);

/* ------------------------------------------------------------------ */
/*  ParkedCarField — instanced renderer for all static parked cars     */
/* ------------------------------------------------------------------ */

/** A single parked car's placement, precomputed in world space. */
export interface ParkedCarInstance {
  slotNode: string;
  color: CarColor;
  size: CarSize;
  position: [number, number, number];
  rotationY: number;
}

/** Instanced renderer for every parked car (pre-parked + newly parked).
 *  Walks each of the three GLTF models once and builds one InstancedMesh per
 *  mesh in the model, so ~96 cars draw in ~18 calls instead of ~400 (each
 *  cloned scene previously made two fresh materials + a shader setup).
 *  Body paint uses per-instance colour via setColorAt; trim (windows, lights,
 *  tires) shares one material per mesh with no per-instance colour. */
export function ParkedCarField({ cars }: { cars: ParkedCarInstance[] }) {
  const bySize = useMemo(() => {
    const groups: Record<CarSize, ParkedCarInstance[]> = { small: [], medium: [], large: [] };
    for (const c of cars) groups[c.size].push(c);
    return groups;
  }, [cars]);
  return (
    <>
      <ParkedCarSizeGroup size="small" cars={bySize.small} />
      <ParkedCarSizeGroup size="medium" cars={bySize.medium} />
      <ParkedCarSizeGroup size="large" cars={bySize.large} />
    </>
  );
}

function ParkedCarSizeGroup({ size, cars }: { size: CarSize; cars: ParkedCarInstance[] }) {
  const { scene } = useGLTF(MODEL_PATHS[size]);

  const built = useMemo(() => {
    if (cars.length === 0) return null;
    // Refresh world matrices so each mesh's model-space transform is current.
    // The GLTF scene root has identity transform, so mesh.matrixWorld is the
    // mesh's transform relative to the model origin (what we want to bake in).
    scene.updateMatrixWorld(true);
    const scale = MODEL_SCALE[size];
    const scaleMat = new THREE.Matrix4().makeScale(scale, scale, scale);
    const forwardMat = new THREE.Matrix4().makeRotationY(FORWARD_ROT);

    // One shared body material. White base so instanceColor multiplies through
    // to the actual car colour. Matches the parked-car MeshStandardMaterial.
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0.5,
      roughness: 0.4,
    });
    // One shared glass material for Windows (matches parked-car look: dark,
    // opaque). Other NON_BODY trim keeps its original GLTF material.
    const glassMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#1a1d24"),
      metalness: 0.3,
      roughness: 0.1,
      transparent: false,
      opacity: 1,
    });

    const meshes: THREE.InstancedMesh[] = [];
    const tmpMat = new THREE.Matrix4();
    const ryMat = new THREE.Matrix4();
    const tmpColor = new THREE.Color();

    scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      const srcMat = mats[0] as THREE.Material | undefined;
      if (!srcMat) return;
      const isBody = !NON_BODY.has(srcMat.name);
      // Body -> shared white standard mat (per-instance colour below).
      // Windows -> shared dark glass mat. Other trim -> original GLTF mat
      // (shared with the GLTF cache, so we must NOT dispose it).
      const material = isBody ? bodyMat : srcMat.name === "Windows" ? glassMat : srcMat;

      const im = new THREE.InstancedMesh(obj.geometry, material, cars.length);
      im.castShadow = true;
      im.receiveShadow = true;

      // Base transform baked into every instance: the model's forward rotation
      // (GLTF faces +Z, sim expects +X), uniform model scale, and this mesh's
      // own local transform within the GLTF scene.
      const base = new THREE.Matrix4().copy(forwardMat).multiply(scaleMat).multiply(obj.matrixWorld);

      for (let i = 0; i < cars.length; i++) {
        const car = cars[i];
        tmpMat.makeTranslation(car.position[0], car.position[1], car.position[2]);
        ryMat.makeRotationY(car.rotationY);
        tmpMat.multiply(ryMat).multiply(base);
        im.setMatrixAt(i, tmpMat);
        if (isBody) {
          tmpColor.set(COLOR_HEX[car.color]);
          im.setColorAt(i, tmpColor);
        }
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      meshes.push(im);
    });

    const dispose = () => {
      // Dispose instance buffers and the materials we own. Do NOT dispose the
      // geometries (shared with the GLTF cache / active cars) or the original
      // GLTF trim materials (shared with the cache).
      for (const im of meshes) im.dispose();
      bodyMat.dispose();
      glassMat.dispose();
    };
    return { meshes, dispose };
  }, [scene, cars, size]);

  useEffect(() => {
    if (!built) return;
    return () => built.dispose();
  }, [built]);

  if (!built) return null;
  return (
    <group>
      {built.meshes.map((im, i) => (
        <primitive key={i} object={im} />
      ))}
    </group>
  );
}

interface ActiveCarProps {
  car: ActiveCar;
  lot: LotData;
  onArrive: (carId: string, node: string) => void;
  /** Shared map (id -> Group) that the camera rig reads to follow/POV cars. */
  carGroupsRef?: React.MutableRefObject<Map<string, THREE.Group>>;
}

/**
 * An active car that animates along resolved waypoints between graph nodes.
 * Waypoints follow the actual road geometry (aisle lane offset, turn
 * semicircles, ramp spiral curves) instead of cutting straight from A to B.
 * Calls onArrive when it reaches the final waypoint of a leg.
 *
 * Leg changes are detected inside useFrame (not useEffect) because the
 * simulation mutates `car.fromNode`/`car.toNode` in place without triggering
 * a React re-render.
 */
export const ActiveCarMesh = memo(function ActiveCarMesh({ car, lot, onArrive, carGroupsRef }: ActiveCarProps) {
  const group = useRef<THREE.Group>(null);
  const targetRot = useRef(0);
  const targetPitchRef = useRef(0);
  const waypointsRef = useRef<THREE.Vector3[]>([]);
  const segIndexRef = useRef(0);
  const segProgressRef = useRef(0);
  const legRef = useRef<string>("");
  const wheelMeshesRef = useRef<THREE.Object3D[]>([]);
  const tmpLookAhead = useRef(new THREE.Vector3());

  // Publish this car's group so the camera rig (follow/POV) can read its
  // live transform. Cleared on unmount so stale entries don't linger.
  useEffect(() => {
    return () => {
      carGroupsRef?.current.delete(car.id);
    };
  }, [car.id, carGroupsRef]);

  // Collect wheel meshes from the GLTF model and re-center them so they spin
  // in place. GLTF car models have wheel nodes with no transform — the mesh
  // vertices are positioned at the actual wheel location, offset from the
  // node's origin (the car center). Without re-centering, rotating the node
  // swings the wheel in a giant arc around the car center (causing z-fighting
  // flicker and making wheels invisible). We compute the mesh's bounding-box
  // center, translate the geometry so vertices are centered at the node
  // origin, then move the node to that center — so rotation spins in place.
  // IMPORTANT: scene.clone() shares geometries across all car instances of
  // the same model. We MUST clone the geometry before translating, otherwise
  // the first car translates the shared geometry and subsequent cars get
  // already-translated geometry (bounding box center = origin → wheel ends
  // up at the car center).
  const handleModelLoad = useCallback((obj: THREE.Object3D) => {
    const wheels: THREE.Object3D[] = [];
    obj.traverse((child) => {
      const name = child.name.toLowerCase();
      if (name.includes("wheel") || name.includes("tire") || name.includes("rim")) {
        // Re-center the wheel so its pivot is at the wheel's actual center.
        if (child instanceof THREE.Mesh) {
          // Clone the geometry — scene.clone() shares geometries, so without
          // this every car of the same model would share the translated geo.
          child.geometry = child.geometry.clone();
          child.geometry.computeBoundingBox();
          const box = child.geometry.boundingBox!;
          const center = new THREE.Vector3();
          box.getCenter(center);
          // Translate geometry so the center is at the origin, then offset
          // the node position so the wheel stays in its original location.
          child.geometry.translate(-center.x, -center.y, -center.z);
          child.position.copy(center);
        }
        wheels.push(child);
      }
    });
    wheelMeshesRef.current = wheels;
  }, []);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 30);
    const g = group.current;
    if (!g) return;

    // Register the group every frame (cheap) so the rig always has a handle.
    if (carGroupsRef) carGroupsRef.current.set(car.id, g);

    const fromNode = lot.nodes[car.fromNode];
    const toNode = lot.nodes[car.toNode];
    if (!fromNode || !toNode) return;

    // Detect leg changes (including the in-place mutations from useSimulation).
    const legKey = `${car.fromNode}>${car.toNode}`;
    if (legKey !== legRef.current) {
      legRef.current = legKey;
      segIndexRef.current = 0;
      segProgressRef.current = 0;
      waypointsRef.current =
        car.fromNode !== car.toNode ? resolvePath(fromNode, toNode, lot) : [];
    }

    const wps = waypointsRef.current;

    // Stationary: sit at the current node, in the driving lane (offset to
    // the right of the car's heading by LANE_WIDTH/2). Without the lane
    // offset the car would jump ~2.25 units sideways from its arrival
    // position (which is in the lane) to the centerline, causing a visible
    // "ghosting" flicker for one frame.
    if (wps.length < 2) {
      const w = toWorld(fromNode.x, fromNode.y, fromNode.floor);
      const yaw = g.rotation.y;
      // Right vector of the heading = (-sin(yaw), 0, -cos(yaw)).
      // Lane offset = right * LANE_WIDTH/2 (right-hand driving).
      g.position.set(
        w[0] - Math.sin(yaw) * LANE_WIDTH / 2,
        w[1] + CAR_Y_OFFSET,
        w[2] - Math.cos(yaw) * LANE_WIDTH / 2,
      );
      return;
    }

    const segCount = wps.length - 1;

    // Advance along the current segment (frame-rate independent).
    const i = segIndexRef.current;
    const a = wps[i];
    const b = wps[i + 1];
    const segLen = a.distanceTo(b);
    const step = (CAR_SPEED * dt) / Math.max(segLen, 0.001);
    segProgressRef.current += step;

    while (segProgressRef.current >= 1) {
      const oldLen = wps[segIndexRef.current].distanceTo(wps[segIndexRef.current + 1]);
      segProgressRef.current -= 1;
      segIndexRef.current++;
      // Arrived at the final waypoint: complete the leg.
      if (segIndexRef.current >= segCount) {
        const last = wps[segCount];
        g.position.set(last.x, last.y + CAR_Y_OFFSET, last.z);
        // Snap rotation to the final target so the transition to the
        // fixed-rotation ParkedCarMesh (±π/2) doesn't show a visual pop
        // when the smoothing hasn't fully converged.
        g.rotation.y = targetRot.current;
        g.rotation.z = targetPitchRef.current;
        segIndexRef.current = 0;
        segProgressRef.current = 0;
        waypointsRef.current = [];
        car.progress = 0;
        car.fromNode = car.toNode;
        onArrive(car.id, car.toNode);
        return;
      }
      // Rescale the leftover progress to the new segment length so speed
      // stays frame-rate independent across segment boundaries.
      const newLen = wps[segIndexRef.current].distanceTo(wps[segIndexRef.current + 1]);
      if (newLen > 0.001) segProgressRef.current *= oldLen / newLen;
    }

    // Interpolate position along the current segment.
    const ii = segIndexRef.current;
    const aa = wps[ii];
    const bb = wps[ii + 1];
    const p = segProgressRef.current;
    g.position.set(
      aa.x + (bb.x - aa.x) * p,
      aa.y + (bb.y - aa.y) * p + CAR_Y_OFFSET,
      aa.z + (bb.z - aa.z) * p,
    );

    // Face a look-ahead point on the path instead of the current segment
    // direction. This makes the target rotation change continuously through
    // curves (rather than jumping at each waypoint), eliminating the angular
    // velocity oscillation that caused turning jitter.
    const LOOK_AHEAD = 3.0;
    let remaining = LOOK_AHEAD;
    let laIdx = segIndexRef.current;
    let laP = segProgressRef.current;
    while (remaining > 0 && laIdx < segCount) {
      const cur = wps[laIdx];
      const next = wps[laIdx + 1];
      const segRem = (1 - laP) * cur.distanceTo(next);
      if (segRem <= remaining) {
        remaining -= segRem;
        laIdx++;
        laP = 0;
      } else {
        laP += remaining / cur.distanceTo(next);
        remaining = 0;
      }
    }
    const laPoint = laIdx < segCount
      ? tmpLookAhead.current.set(
          wps[laIdx].x + (wps[laIdx + 1].x - wps[laIdx].x) * laP,
          wps[laIdx].y + (wps[laIdx + 1].y - wps[laIdx].y) * laP,
          wps[laIdx].z + (wps[laIdx + 1].z - wps[laIdx].z) * laP,
        )
      : wps[wps.length - 1];
    const dx = laPoint.x - g.position.x;
    const dy = laPoint.y - (g.position.y - CAR_Y_OFFSET);
    const dz = laPoint.z - g.position.z;
    const horiz = Math.hypot(dx, dz);
    if (horiz > 1e-4) {
      targetRot.current = Math.atan2(-dz, dx);
      targetPitchRef.current = Math.atan2(dy, horiz);
    }
    let diff = targetRot.current - g.rotation.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    g.rotation.y += diff * Math.min(1, dt * 10);
    const pitchDiff = targetPitchRef.current - g.rotation.z;
    g.rotation.z += pitchDiff * Math.min(1, dt * 6);

    // Spin wheels (GLTF wheel meshes rotate about their local axle axis).
    // The axle direction varies by model; most GLTF cars use X or Z.
    // We rotate about X which is the most common axle for car wheels.
    // Angular velocity = v / r. GLB wheel radius is 0.28 in model space,
    // scaled by MODEL_SCALE[size] to world units.
    const wheelRadius = 0.28 * MODEL_SCALE[car.size];
    const wheelSpin = (CAR_SPEED / wheelRadius) * dt;
    for (const wheel of wheelMeshesRef.current) {
      wheel.rotation.x += wheelSpin;
    }
  });

  return (
    <group ref={group}>
      <CarModel color={car.color} size={car.size} highQuality onLoad={handleModelLoad} />
    </group>
  );
});
