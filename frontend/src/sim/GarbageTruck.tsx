import { useEffect, useMemo, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { ActiveCar, LotData } from "../types";
import { readRoutePlan } from "../hooks/useSimulation";
import { resolvePath } from "./paths";
import { toWorld, CAR_Y_OFFSET, FLOOR_HEIGHT } from "./constants";

const TRUCK_MODEL_PATH = "/models/truck_quaternius.glb";

/** Rotation to align the model's +Z forward with the path system's heading
 *  convention (atan2(-dz, dx)). Same as FORWARD_ROT in Car.tsx. */
const FORWARD_ROT = Math.PI / 2;

/** Truck is slower than cars — it's a heavy garbage truck, not a sports car. */
const TRUCK_SPEED = 4;

/** Wheel radius for spin animation (from GLTF bounding-box analysis). */
const WHEEL_RADIUS = 0.45;

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
  const cloned = useMemo(() => {
    const c = scene.clone(true);
    // Bake FORWARD_ROT into the root so the group rotation alone orients it.
    c.rotation.y = FORWARD_ROT;
    c.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
    return c;
  }, [scene]);

  const groupRef = useRef<THREE.Group>(null);

  // Wheel spin: store each wheel's original quaternion so we can apply spin
  // in the wheel's local space without overwriting the model's baked rotation.
  // The GLTF wheel nodes carry a -90° X quaternion that orients the cylinder
  // correctly on the axle. Setting rotation.x directly would overwrite it and
  // flip the wheels sideways (the bug in the first version).
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

  // Route state (mirrors ActiveRuntime in Car.tsx, simplified).
  const routeState = useRef({
    currentLeg: "",
    waypoints: [] as THREE.Vector3[],
    segmentIndex: 0,
    segmentProgress: 0,
    planVersion: 0,
    upcomingNodes: [] as string[],
    heldNode: null as string | null,
    targetRotation: 0,
    wheelSpin: 0,
    arrived: false,
  });

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

    const points = rt.waypoints;
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

    // Advance along the current segment.
    const a = points[rt.segmentIndex];
    const b = points[rt.segmentIndex + 1];
    const segLen = a.distanceTo(b);
    if (segLen > 1e-6) {
      rt.segmentProgress += (TRUCK_SPEED * dt) / segLen;
    }

    // Segment complete → advance to next segment or arrive.
    while (rt.segmentProgress >= 1 && rt.segmentIndex < points.length - 2) {
      rt.segmentProgress -= 1;
      rt.segmentIndex += 1;
    }

    if (rt.segmentProgress >= 1) {
      rt.segmentProgress = 1;
      const arrivedNode = car.toNode;
      const nextNode = rt.upcomingNodes.shift() ?? null;
      if (nextNode !== null) {
        car.fromNode = arrivedNode;
        car.toNode = nextNode;
        rt.currentLeg = "";
        rt.segmentProgress = 0;
      } else {
        // Final arrival — despawn via onArrive.
        rt.arrived = true;
        group.position.set(
          toWorld(toNode.x, toNode.y, toNode.floor)[0],
          toNode.floor * FLOOR_HEIGHT + CAR_Y_OFFSET,
          toWorld(toNode.x, toNode.y, toNode.floor)[2],
        );
        onArriveNow(car.id, arrivedNode);
        return;
      }
      return;
    }

    // Interpolate position along the current segment.
    const px = a.x + (b.x - a.x) * rt.segmentProgress;
    const py = a.y + (b.y - a.y) * rt.segmentProgress;
    const pz = a.z + (b.z - a.z) * rt.segmentProgress;
    group.position.set(px, py + CAR_Y_OFFSET, pz);

    // Compute heading from a look-ahead point.
    const lookIdx = Math.min(rt.segmentIndex + 1, points.length - 1);
    const target = points[lookIdx];
    const dx = target.x - group.position.x;
    const dz = target.z - group.position.z;
    if (Math.hypot(dx, dz) > 1e-4) {
      rt.targetRotation = Math.atan2(-dz, dx);
    }

    // Smooth rotation toward target.
    let rotDiff = rt.targetRotation - group.rotation.y;
    while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
    while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
    group.rotation.y += rotDiff * Math.min(1, dt * 6);

    // Wheel spin: apply spin in each wheel's local space (around Y, the
    // cylinder's axle in the modeling frame) on top of the original
    // orientation quaternion. This preserves the -90° X rotation that
    // orients the wheel on the axle while adding the rolling spin.
    rt.wheelSpin += (TRUCK_SPEED / WHEEL_RADIUS) * dt;
    const spinAxis = new THREE.Vector3(0, 1, 0);
    for (const wd of wheelData.current) {
      wd.spinQuat.setFromAxisAngle(spinAxis, rt.wheelSpin);
      wd.obj.quaternion.copy(wd.origQuat).multiply(wd.spinQuat);
    }
  });

  return (
    <group ref={groupRef}>
      <primitive object={cloned} />
    </group>
  );
}

useGLTF.preload(TRUCK_MODEL_PATH);
