import { useEffect, useMemo, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { ActiveCar, LotData } from "../types";
import { readRoutePlan } from "../hooks/useSimulation";
import { resolvePath } from "./paths";
import { toWorld, CAR_Y_OFFSET, CAR_SPEED, FLOOR_HEIGHT } from "./constants";

const TRUCK_MODEL_PATH = "/models/truck_quaternius.glb";

/** Rotation to align the model's +Z forward with the path system's heading
 *  convention (atan2(-dz, dx)). Same as FORWARD_ROT in Car.tsx. */
const FORWARD_ROT = Math.PI / 2;

/** Truck matches car speed so it doesn't interrupt traffic flow. */
const TRUCK_SPEED = CAR_SPEED;

/** Scale factor to fit the truck body into the lane. The raw GLTF body is
 *  2.71 units wide; the largest car is 1.80. At 2.71 the truck has only 0.32
 *  units of guardrail clearance and clips on curves. Scaling to 0.85 brings
 *  the body to ~2.30 wide — still clearly a truck, but with 0.53 units of
 *  clearance instead of 0.32. */
const TRUCK_SCALE = 0.85;

/** Wheel radius for spin animation (from GLTF bounding-box analysis, after
 *  TRUCK_SCALE is applied). */
const WHEEL_RADIUS = 0.45 * TRUCK_SCALE;

/** Distance-based look-ahead for heading. Longer than AI cars (3) because
 *  the truck is a longer vehicle and needs to aim further ahead to turn
 *  smoothly without the tail swinging wide. */
const LOOK_AHEAD = 5;

/** Pre-allocated spin axis (the GLTF cylinder axle in mesh-local space).
 *  Hoisted to avoid per-frame allocation. */
const SPIN_AXIS = new THREE.Vector3(1, 0, 0);

/** Create a CanvasTexture with "BANIYA" branding text. Returns a texture
 *  that can be applied to a plane mesh flush against the truck body. The
 *  canvas has a transparent background so only the text shows. */
function createBrandingTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f0f0f0";
  ctx.font = "bold 90px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("BANIYA", canvas.width / 2, canvas.height / 2 + 4);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/** Shared branding texture (created once, reused across all truck instances). */
let brandingTexture: THREE.CanvasTexture | null = null;
function getBrandingTexture(): THREE.CanvasTexture {
  if (!brandingTexture) brandingTexture = createBrandingTexture();
  return brandingTexture;
}

interface GarbageTruckProps {
  car: ActiveCar;
  lot: LotData;
  onArrive: (carId: string, node: string) => void;
  /** Shared map of car groups for camera follow. The truck registers itself
   *  here under its car.id so the follow camera can lock onto it. */
  carGroupsRef?: React.MutableRefObject<Map<string, THREE.Group>>;
}

/** A fun roaming garbage truck. Spawned by a button, drives from entry to
 *  exit along the road graph, plays music while active, despawns at exit.
 *  Uses the same route plan mechanism as AI cars (readRoutePlan) but renders
 *  a single GLTF model instead of instanced meshes. */
export function GarbageTruck({ car, lot, onArrive, carGroupsRef }: GarbageTruckProps) {
  const { scene } = useGLTF(TRUCK_MODEL_PATH);

  // Clone the scene once so we don't mutate the cached original.
  // Also recenter each wheel mesh's geometry at its hub so that spinning
  // the wheel node's quaternion rotates the wheel in place rather than
  // orbiting it around the node origin. The GLTF wheel meshes have their
  // vertices offset from the origin (the hub is not at 0,0,0 in mesh
  // space), so without recentering, spin causes the wheels to swing
  // outward and appear detached/floating.
  const cloned = useMemo(() => {
    const c = scene.clone(true);
    // Bake FORWARD_ROT and TRUCK_SCALE into the root so the group rotation
    // alone orients it and the body fits within the lane (raw body is 2.71
    // wide; scaled to ~1.79 to match large car clearance).
    c.rotation.y = FORWARD_ROT;
    c.scale.setScalar(TRUCK_SCALE);
    c.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
      // Recenter wheel geometry at the hub. The wheel nodes have
      // translation [0,0,0] but the mesh vertices are offset, so the
      // hub center is not at the node origin. We clone the geometry,
      // translate the clone so the hub is at the origin, then set the
      // node's position to the hub center in parent (RootNode) space so
      // the wheel stays in place when spinning.
      //
      // CRITICAL: scene.clone(true) shares geometry references (three.js
      // Mesh.copy assigns this.geometry = source.geometry, not a clone).
      // We must clone the geometry before translating, or we corrupt the
      // cached useGLTF scene — same pattern as Car.tsx line 661.
      if (
        obj.name === "FrontWheel_R" ||
        obj.name === "FrontWheel_L" ||
        obj.name === "BackWheels"
      ) {
        const recentered = obj.geometry.clone();
        recentered.computeBoundingBox();
        const bb = recentered.boundingBox!;
        // Hub center in mesh-local space.
        const centerMesh = new THREE.Vector3();
        bb.getCenter(centerMesh);
        // Recenter geometry: translate so hub is at origin.
        recentered.translate(-centerMesh.x, -centerMesh.y, -centerMesh.z);
        obj.geometry = recentered;
        // Compute hub center in parent (RootNode) space by applying the
        // node's scale and quaternion to the mesh-space center.
        const centerParent = centerMesh.clone();
        centerParent.multiplyScalar(obj.scale.x); // uniform scale
        centerParent.applyQuaternion(obj.quaternion);
        // Set the node's position so the wheel stays at its original spot.
        obj.position.copy(centerParent);
      }
    });
    return c;
  }, [scene]);

  const groupRef = useRef<THREE.Group>(null);

  // Wheel spin: store each wheel's original quaternion so we can apply spin
  // in the wheel's local space without overwriting the model's baked rotation.
  // The GLTF wheel nodes carry a -90° X quaternion that orients the cylinder
  // correctly on the axle. The cylinder's axle is along X in mesh-local
  // space (the thin dimension of the wheel bounding box). We spin around X
  // to roll the wheel forward, preserving the baked orientation.
  const wheelData = useRef<
    { obj: THREE.Object3D; origQuat: THREE.Quaternion; spinQuat: THREE.Quaternion }[]
  >([]);

  useEffect(() => {
    if (!cloned) return;
    wheelData.current = [];
    cloned.traverse((obj) => {
      if (
        obj.name === "FrontWheel_R" ||
        obj.name === "FrontWheel_L" ||
        obj.name === "BackWheels"
      ) {
        wheelData.current.push({
          obj,
          origQuat: obj.quaternion.clone(),
          spinQuat: new THREE.Quaternion(),
        });
      }
    });
  }, [cloned]);

  // Route state — mirrors ActiveRuntime in Car.tsx for smooth movement.
  const routeState = useRef({
    currentLeg: "",
    waypoints: [] as THREE.Vector3[],
    segmentIndex: 0,
    segmentProgress: 0,
    planVersion: 0,
    upcomingNodes: [] as string[],
    heldNode: null as string | null,
    targetRotation: 0,
    targetPitch: 0,
    wheelSpin: 0,
    arrived: false,
  });

  // Scratch vectors to avoid per-frame allocation.
  const lookAheadTarget = useRef(new THREE.Vector3());

  // Latest lot/onArrive via refs for useFrame.
  const lotRef = useRef(lot);
  const onArriveRef = useRef(onArrive);
  lotRef.current = lot;
  onArriveRef.current = onArrive;

  // Register/unregister the truck group in carGroupsRef so the follow camera
  // can lock onto it. The camera rig reads from this map by car id.
  useEffect(() => {
    const group = groupRef.current;
    if (group && carGroupsRef) {
      carGroupsRef.current.set(car.id, group);
    }
    return () => {
      carGroupsRef?.current.delete(car.id);
    };
  }, [car.id, carGroupsRef]);

  // --- Audio: loop a music file while the truck is active ---
  // Uses a plain HTML5 Audio element (not Three.js positional audio) for
  // simplicity and type compatibility. The song plays on loop while the
  // truck is in the scene.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const el = new Audio("/audio/garbage-truck.mp3");
    el.loop = true;
    el.volume = 0.4;
    el.play().catch(() => {
      // File not found or autoplay blocked — silent truck.
    });
    audioRef.current = el;
    return () => {
      el.pause();
      el.src = "";
      audioRef.current = null;
    };
  }, []);

  useFrame((_, dt) => {
    const group = groupRef.current;
    if (!group) return;
    const rt = routeState.current;
    if (rt.arrived) return;

    const lotNow = lotRef.current;
    const onArriveNow = onArriveRef.current;
    const fromNode = lotNow.nodes[car.fromNode];
    const toNode = lotNow.nodes[car.toNode];
    if (!fromNode || !toNode) return;

    // Adopt the latest server-approved route plan.
    const plan = readRoutePlan(car);
    if (plan && plan.version !== rt.planVersion) {
      rt.planVersion = plan.version;
      rt.upcomingNodes = plan.upcoming.filter((id) => id in lotNow.nodes);
      rt.heldNode = null;
    }

    // Resolve waypoints when the leg changes.
    const legKey = `${car.fromNode}>${car.toNode}`;
    if (legKey !== rt.currentLeg) {
      rt.currentLeg = legKey;
      rt.segmentIndex = 0;
      rt.segmentProgress = 0;
      rt.waypoints =
        car.fromNode !== car.toNode ? resolvePath(fromNode, toNode, lotNow) : [];
    }

    let points = rt.waypoints;
    if (points.length < 2) {
      // Standstill: try to depart using the next queued node.
      if (car.fromNode === car.toNode) {
        const nextNode = rt.heldNode ?? rt.upcomingNodes.shift() ?? null;
        if (nextNode !== null) {
          rt.heldNode = null;
          car.toNode = nextNode;
          car.status = "routing";
          rt.currentLeg = "";
        }
      }
      return;
    }

    let segmentCount = points.length - 1;

    // Advance along the current segment.
    const a0 = points[rt.segmentIndex];
    const b0 = points[rt.segmentIndex + 1];
    const segLen0 = a0.distanceTo(b0);
    if (segLen0 > 1e-6) {
      rt.segmentProgress += (TRUCK_SPEED * dt) / segLen0;
    }

    // Segment complete → advance, with length rescaling to keep speed
    // constant across segments of different lengths (same as Car.tsx:976-977).
    // Also carries overshoot across leg boundaries for continuous motion
    // (same as Car.tsx:947-962).
    while (rt.segmentProgress >= 1) {
      const oldLength = points[rt.segmentIndex].distanceTo(points[rt.segmentIndex + 1]);
      rt.segmentProgress -= 1;
      rt.segmentIndex++;

      if (rt.segmentIndex >= segmentCount) {
        // Reached the end of this leg.
        const last = points[segmentCount];
        group.position.set(last.x, last.y + CAR_Y_OFFSET, last.z);

        const nextNode = rt.upcomingNodes.shift() ?? null;
        if (nextNode !== null) {
          // Carry overshoot into the new leg for continuous motion.
          const carried = Math.max(
            rt.segmentProgress * points[segmentCount - 1].distanceTo(points[segmentCount]),
            0,
          );
          car.fromNode = car.toNode;
          car.toNode = nextNode;
          const resolved = resolvePath(
            lotNow.nodes[car.fromNode],
            lotNow.nodes[nextNode],
            lotNow,
          );
          rt.waypoints = resolved;
          rt.currentLeg = `${car.fromNode}>${nextNode}`;
          rt.segmentIndex = 0;
          rt.segmentProgress = resolved.length > 1
            ? Math.min(carried / Math.max(resolved[0].distanceTo(resolved[1]), 0.001), 1)
            : 0;
          points = rt.waypoints;
          segmentCount = points.length - 1;
          continue;
        }

        // Final arrival — despawn via onArrive.
        rt.arrived = true;
        group.position.set(
          toWorld(toNode.x, toNode.y, toNode.floor)[0],
          toNode.floor * FLOOR_HEIGHT + CAR_Y_OFFSET,
          toWorld(toNode.x, toNode.y, toNode.floor)[2],
        );
        onArriveNow(car.id, car.toNode);
        return;
      }

      // Rescale progress to the new segment length.
      const newLength = points[rt.segmentIndex].distanceTo(points[rt.segmentIndex + 1]);
      if (newLength > 0.001) rt.segmentProgress *= oldLength / newLength;
    }

    // Interpolate position along the current segment.
    const a = points[rt.segmentIndex];
    const b = points[rt.segmentIndex + 1];
    const progress = rt.segmentProgress;
    car.progress = segmentCount > 0 ? (rt.segmentIndex + progress) / segmentCount : 0;
    group.position.set(
      a.x + (b.x - a.x) * progress,
      a.y + (b.y - a.y) * progress + CAR_Y_OFFSET,
      a.z + (b.z - a.z) * progress,
    );

    // Distance-based look-ahead (same as Car.tsx:991-1015). Walks along the
    // polyline by LOOK_AHEAD units and interpolates the target point, so the
    // aim point glides continuously instead of jumping between waypoints.
    let remaining = LOOK_AHEAD;
    let lookIndex = rt.segmentIndex;
    let lookProgress = rt.segmentProgress;
    while (remaining > 0 && lookIndex < segmentCount) {
      const current = points[lookIndex];
      const next = points[lookIndex + 1];
      const remainder = (1 - lookProgress) * current.distanceTo(next);
      if (remainder <= remaining) {
        remaining -= remainder;
        lookIndex++;
        lookProgress = 0;
      } else {
        lookProgress += remaining / current.distanceTo(next);
        remaining = 0;
      }
    }

    const target = lookIndex < segmentCount
      ? lookAheadTarget.current.set(
          points[lookIndex].x + (points[lookIndex + 1].x - points[lookIndex].x) * lookProgress,
          points[lookIndex].y + (points[lookIndex + 1].y - points[lookIndex].y) * lookProgress,
          points[lookIndex].z + (points[lookIndex + 1].z - points[lookIndex].z) * lookProgress,
        )
      : points[segmentCount];

    const dx = target.x - group.position.x;
    const dy = target.y - (group.position.y - CAR_Y_OFFSET);
    const dz = target.z - group.position.z;
    const horizontal = Math.hypot(dx, dz);
    if (horizontal > 1e-4) {
      rt.targetRotation = Math.atan2(-dz, dx);
      rt.targetPitch = Math.atan2(dy, horizontal);
    }

    // Smooth rotation toward target (same factors as Car.tsx:1029-1030).
    let rotDiff = rt.targetRotation - group.rotation.y;
    while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
    while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
    group.rotation.y += rotDiff * Math.min(1, dt * 10);
    group.rotation.z += (rt.targetPitch - group.rotation.z) * Math.min(1, dt * 6);

    // Wheel spin: the GLTF wheel cylinder's axle is along X in mesh-local
    // space (the thin dimension). Spin around X to roll forward, preserving
    // the baked -90° quaternion that orients the wheel on the axle.
    // This matches the AI car approach where FORWARD_ROT maps the GLTF axle
    // (X) to the lateral axis, and spin is applied around that axis.
    rt.wheelSpin += (TRUCK_SPEED / WHEEL_RADIUS) * dt;
    for (const wd of wheelData.current) {
      wd.spinQuat.setFromAxisAngle(SPIN_AXIS, rt.wheelSpin);
      wd.obj.quaternion.copy(wd.origQuat).multiply(wd.spinQuat);
    }
  });

  // Branding texture (created once, shared).
  const brandTex = useMemo(() => getBrandingTexture(), []);

  // Branding plane dimensions (in scene-local space, before TRUCK_SCALE).
  // The side panel is ~4 units long (Z from -3.05 to 2.19 minus cab area),
  // ~1.5 units tall (Y from 0.5 to 2.5). We place a 3.0 x 0.8 plane on each
  // side, centered on the box body behind the cab.
  const SIDE_W = 3.0 * TRUCK_SCALE;
  const SIDE_H = 0.8 * TRUCK_SCALE;
  const SIDE_Y = 1.7 * TRUCK_SCALE;
  const SIDE_Z = -0.4 * TRUCK_SCALE; // centered on box body, behind cab
  const SIDE_X = 1.36 * TRUCK_SCALE; // just outside the body surface
  const BACK_W = 1.8 * TRUCK_SCALE;
  const BACK_H = 0.6 * TRUCK_SCALE;
  const BACK_Y = 1.6 * TRUCK_SCALE;
  const BACK_Z = -3.06 * TRUCK_SCALE;

  return (
    <group ref={groupRef}>
      <primitive object={cloned} />
      {/* "Baniya" branding as textured planes flush against the truck body.
          The wrapper group replicates the baked FORWARD_ROT so positions are
          in scene-local coords (X=width, Y=height, Z=length). Planes use
          transparent canvas textures so only the text shows — like vinyl
          lettering painted on the truck. */}
      <group rotation-y={FORWARD_ROT}>
        {/* Right side — plane facing +X (outward) */}
        <mesh position={[SIDE_X, SIDE_Y, SIDE_Z]} rotation-y={Math.PI / 2}>
          <planeGeometry args={[SIDE_W, SIDE_H]} />
          <meshBasicMaterial map={brandTex} transparent depthWrite={false} />
        </mesh>
        {/* Left side — plane facing -X (outward), texture mirrored */}
        <mesh position={[-SIDE_X, SIDE_Y, SIDE_Z]} rotation-y={-Math.PI / 2}>
          <planeGeometry args={[SIDE_W, SIDE_H]} />
          <meshBasicMaterial map={brandTex} transparent depthWrite={false} />
        </mesh>
        {/* Back — plane facing -Z (rearward) */}
        <mesh position={[0, BACK_Y, BACK_Z]} rotation-y={Math.PI}>
          <planeGeometry args={[BACK_W, BACK_H]} />
          <meshBasicMaterial map={brandTex} transparent depthWrite={false} />
        </mesh>
      </group>
    </group>
  );
}

useGLTF.preload(TRUCK_MODEL_PATH);
