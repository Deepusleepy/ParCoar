import { Suspense, memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { ActiveCar, CarColor, CarSize, LotData, LotNode } from "../types";
import {
  AISLE_SPACING,
  CAR_DIMS,
  CAR_Y_OFFSET,
  CAR_SPEED,
  COLOR_HEX,
  LANE_WIDTH,
  toWorld,
} from "./constants";
import { resolvePath } from "./paths";
import { getSpeedScale } from "./simSpeed";

const MODEL_PATHS: Record<CarSize, string> = {
  small: "/models/car_sport.glb",
  medium: "/models/car_sedan.glb",
  large: "/models/car_suv.glb",
};

const MODEL_LENGTH: Record<CarSize, number> = {
  small: 3.93,
  medium: 4.22,
  large: 4.16,
};

const MODEL_SCALE: Record<CarSize, number> = {
  small: CAR_DIMS.small.length / MODEL_LENGTH.small,
  medium: CAR_DIMS.medium.length / MODEL_LENGTH.medium,
  large: CAR_DIMS.large.length / MODEL_LENGTH.large,
};

const FORWARD_ROT = Math.PI / 2;
const NON_BODY = new Set(["Windows", "Black", "Grey", "Headlights", "TailLights"]);

useGLTF.preload(MODEL_PATHS.small);
useGLTF.preload(MODEL_PATHS.medium);
useGLTF.preload(MODEL_PATHS.large);

interface CarModelProps {
  color: CarColor;
  size: CarSize;
  highQuality?: boolean;
  onLoad?: (object: THREE.Object3D) => void;
}

function CarModelInner({ color, size, highQuality = true, onLoad }: CarModelProps) {
  const { scene } = useGLTF(MODEL_PATHS[size]);
  const hex = COLOR_HEX[color];

  const { bodyMaterial, glassMaterial, cloned } = useMemo(() => {
    const object = scene.clone();
    const body: THREE.MeshStandardMaterial = highQuality
      ? new THREE.MeshPhysicalMaterial({
          color: new THREE.Color(hex),
          metalness: 0.6,
          roughness: 0.35,
          clearcoat: 1,
          clearcoatRoughness: 0.08,
          envMapIntensity: 1.2,
        })
      : new THREE.MeshStandardMaterial({
          color: new THREE.Color(hex),
          metalness: 0.5,
          roughness: 0.4,
        });
    const glass: THREE.MeshStandardMaterial = highQuality
      ? new THREE.MeshPhysicalMaterial({
          color: new THREE.Color("#0a0e14"),
          metalness: 0,
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
        });

    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      const replaced = materials.map((material) => {
        if (!(material instanceof THREE.Material)) return material;
        if (material.name === "Windows") return glass;
        if (NON_BODY.has(material.name)) return material;
        return body;
      });
      child.material = replaced.length === 1 ? replaced[0] : replaced;
    });

    return { bodyMaterial: body, glassMaterial: glass, cloned: object };
  }, [scene, hex, highQuality]);

  useEffect(() => {
    return () => {
      bodyMaterial.dispose();
      glassMaterial.dispose();
    };
  }, [bodyMaterial, glassMaterial]);

  useEffect(() => {
    onLoad?.(cloned);
  }, [cloned, onLoad]);

  return (
    <primitive object={cloned} rotation={[0, FORWARD_ROT, 0]} scale={MODEL_SCALE[size]} />
  );
}

export const CarModel = (props: CarModelProps) => (
  <Suspense fallback={null}>
    <CarModelInner {...props} />
  </Suspense>
);

interface StaticCarProps {
  color: CarColor;
  size: CarSize;
  position: [number, number, number];
  rotationY: number;
}

export const StaticCar = ({ color, size, position, rotationY }: StaticCarProps) => (
  <group position={position} rotation={[0, rotationY, 0]}>
    <CarModel color={color} size={size} highQuality={false} />
  </group>
);

export interface ParkedCarInstance {
  slotNode: string;
  color: CarColor;
  size: CarSize;
  position: [number, number, number];
  rotationY: number;
}

export function ParkedCarField({ cars }: { cars: ParkedCarInstance[] }) {
  const bySize = useMemo(() => {
    const groups: Record<CarSize, ParkedCarInstance[]> = {
      small: [],
      medium: [],
      large: [],
    };
    for (const car of cars) groups[car.size].push(car);
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

const PARKED_CAPACITY = 512;

function ParkedCarSizeGroup({ size, cars }: { size: CarSize; cars: ParkedCarInstance[] }) {
  const { scene } = useGLTF(MODEL_PATHS[size]);

  const built = useMemo(() => {
    scene.updateMatrixWorld(true);
    const scale = MODEL_SCALE[size];
    const base = new THREE.Matrix4()
      .makeRotationY(FORWARD_ROT)
      .multiply(new THREE.Matrix4().makeScale(scale, scale, scale));

    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0.5,
      roughness: 0.4,
    });
    const glassMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#1a1d24"),
      metalness: 0.3,
      roughness: 0.1,
    });

    const meshes: {
      mesh: THREE.InstancedMesh;
      isBody: boolean;
      local: THREE.Matrix4;
    }[] = [];

    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const sourceMaterial = (
        Array.isArray(object.material) ? object.material[0] : object.material
      ) as THREE.Material | undefined;
      if (!sourceMaterial) return;
      const isBody = !NON_BODY.has(sourceMaterial.name);
      const material = isBody
        ? bodyMaterial
        : sourceMaterial.name === "Windows"
          ? glassMaterial
          : sourceMaterial;
      const mesh = new THREE.InstancedMesh(object.geometry, material, PARKED_CAPACITY);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      mesh.frustumCulled = false;
      meshes.push({
        mesh,
        isBody,
        local: new THREE.Matrix4().copy(base).multiply(object.matrixWorld),
      });
    });

    return { meshes, bodyMaterial, glassMaterial };
  }, [scene, size]);

  useEffect(() => {
    return () => {
      for (const { mesh } of built.meshes) mesh.dispose();
      built.bodyMaterial.dispose();
      built.glassMaterial.dispose();
    };
  }, [built]);

  useEffect(() => {
    const transform = new THREE.Matrix4();
    const rotation = new THREE.Matrix4();
    const color = new THREE.Color();
    const count = Math.min(cars.length, PARKED_CAPACITY);

    for (const { mesh, isBody, local } of built.meshes) {
      for (let index = 0; index < count; index++) {
        const car = cars[index];
        transform.makeTranslation(car.position[0], car.position[1], car.position[2]);
        transform.multiply(rotation.makeRotationY(car.rotationY)).multiply(local);
        mesh.setMatrixAt(index, transform);
        if (isBody) mesh.setColorAt(index, color.set(COLOR_HEX[car.color]));
      }
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }, [built, cars]);

  return (
    <group>
      {built.meshes.map(({ mesh }, index) => (
        <primitive key={index} object={mesh} />
      ))}
    </group>
  );
}

interface ActiveCarProps {
  car: ActiveCar;
  lot: LotData;
  onArrive: (carId: string, node: string) => void;
  carGroupsRef?: React.MutableRefObject<Map<string, THREE.Group>>;
}

function bayYaw(bay: LotNode): number {
  const aisleY = Math.round(bay.y / AISLE_SPACING) * AISLE_SPACING;
  return bay.y < aisleY ? Math.PI / 2 : -Math.PI / 2;
}

export const ActiveCarMesh = memo(function ActiveCarMesh({
  car,
  lot,
  onArrive,
  carGroupsRef,
}: ActiveCarProps) {
  const group = useRef<THREE.Group>(null);
  const targetRotation = useRef(0);
  const targetPitch = useRef(0);
  const seeded = useRef(false);
  const waypoints = useRef<THREE.Vector3[]>([]);
  const segmentIndex = useRef(0);
  const segmentProgress = useRef(0);
  const currentLeg = useRef("");
  const wheelMeshes = useRef<THREE.Object3D[]>([]);
  const clonedWheelGeometries = useRef<Set<THREE.BufferGeometry>>(new Set());
  const lookAheadPoint = useRef(new THREE.Vector3());

  useEffect(() => {
    return () => {
      carGroupsRef?.current.delete(car.id);
      // Wheel centring clones GLTF geometries per active car. Dispose those
      // clones when the car parks/leaves so long-running traffic does not grow
      // renderer.info.memory.geometries forever.
      for (const geometry of clonedWheelGeometries.current) geometry.dispose();
      clonedWheelGeometries.current.clear();
    };
  }, [car.id, carGroupsRef]);

  const handleModelLoad = useCallback((object: THREE.Object3D) => {
    const isWheelName = (name: string) => {
      const lower = name.toLowerCase();
      return lower.includes("wheel") || lower.includes("tire") || lower.includes("rim");
    };

    const roots: THREE.Object3D[] = [];
    object.traverse((child) => {
      if (!isWheelName(child.name)) return;
      if (child.parent && isWheelName(child.parent.name)) return;
      roots.push(child);
    });

    for (const root of roots) {
      if (root.userData.wheelCentred) continue;
      root.userData.wheelCentred = true;
      const box = new THREE.Box3();
      root.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.geometry.computeBoundingBox();
        const bounds = child.geometry.boundingBox?.clone();
        if (!bounds) return;
        bounds.translate(child.position);
        box.union(bounds);
      });
      if (box.isEmpty()) continue;
      const centre = box.getCenter(new THREE.Vector3());

      root.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const geometry = child.geometry.clone();
        geometry.translate(-centre.x, -centre.y, -centre.z);
        child.geometry = geometry;
        clonedWheelGeometries.current.add(geometry);
      });
      root.position.add(centre);
    }

    wheelMeshes.current = roots;
  }, []);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 30);
    const object = group.current;
    if (!object) return;

    if (carGroupsRef) carGroupsRef.current.set(car.id, object);
    if (object.name !== car.id) object.name = car.id;

    const fromNode = lot.nodes[car.fromNode];
    const toNode = lot.nodes[car.toNode];
    if (!fromNode || !toNode) return;

    if (!seeded.current) {
      seeded.current = true;
      if (fromNode.type === "slot") {
        const yaw = bayYaw(fromNode);
        object.rotation.y = yaw;
        targetRotation.current = yaw;
      }
    }

    const legKey = `${car.fromNode}>${car.toNode}`;
    if (legKey !== currentLeg.current) {
      currentLeg.current = legKey;
      segmentIndex.current = 0;
      segmentProgress.current = 0;
      waypoints.current = car.fromNode !== car.toNode
        ? resolvePath(fromNode, toNode, lot)
        : [];
    }

    const points = waypoints.current;
    if (points.length < 2) {
      const world = toWorld(fromNode.x, fromNode.y, fromNode.floor);
      const offset = fromNode.type === "slot" ? 0 : LANE_WIDTH / 2;
      const yaw = object.rotation.y;
      object.position.set(
        world[0] - Math.sin(yaw) * offset,
        world[1] + CAR_Y_OFFSET,
        world[2] - Math.cos(yaw) * offset,
      );
      return;
    }

    const segmentCount = points.length - 1;
    const index = segmentIndex.current;
    const first = points[index];
    const second = points[index + 1];
    const segmentLength = first.distanceTo(second);
    const speed = CAR_SPEED * getSpeedScale();
    segmentProgress.current += (speed * dt) / Math.max(segmentLength, 0.001);

    while (segmentProgress.current >= 1) {
      const oldLength = points[segmentIndex.current].distanceTo(points[segmentIndex.current + 1]);
      segmentProgress.current -= 1;
      segmentIndex.current++;

      if (segmentIndex.current >= segmentCount) {
        const last = points[segmentCount];
        object.position.set(last.x, last.y + CAR_Y_OFFSET, last.z);
        object.rotation.y = toNode.type === "slot" ? bayYaw(toNode) : targetRotation.current;
        object.rotation.z = targetPitch.current;
        segmentIndex.current = 0;
        segmentProgress.current = 0;
        waypoints.current = [];
        car.progress = 0;
        car.fromNode = car.toNode;
        onArrive(car.id, car.toNode);
        return;
      }

      const newLength = points[segmentIndex.current].distanceTo(points[segmentIndex.current + 1]);
      if (newLength > 0.001) segmentProgress.current *= oldLength / newLength;
    }

    const activeIndex = segmentIndex.current;
    const a = points[activeIndex];
    const b = points[activeIndex + 1];
    const progress = segmentProgress.current;
    car.progress = segmentCount > 0 ? (activeIndex + progress) / segmentCount : 0;
    object.position.set(
      a.x + (b.x - a.x) * progress,
      a.y + (b.y - a.y) * progress + CAR_Y_OFFSET,
      a.z + (b.z - a.z) * progress,
    );

    const LOOK_AHEAD = 3;
    let remaining = LOOK_AHEAD;
    let lookIndex = segmentIndex.current;
    let lookProgress = segmentProgress.current;
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
      ? lookAheadPoint.current.set(
          points[lookIndex].x + (points[lookIndex + 1].x - points[lookIndex].x) * lookProgress,
          points[lookIndex].y + (points[lookIndex + 1].y - points[lookIndex].y) * lookProgress,
          points[lookIndex].z + (points[lookIndex + 1].z - points[lookIndex].z) * lookProgress,
        )
      : points[points.length - 1];

    const dx = target.x - object.position.x;
    const dy = target.y - (object.position.y - CAR_Y_OFFSET);
    const dz = target.z - object.position.z;
    const horizontal = Math.hypot(dx, dz);
    if (horizontal > 1e-4) {
      targetRotation.current = Math.atan2(-dz, dx);
      targetPitch.current = Math.atan2(dy, horizontal);
    }

    let rotationDifference = targetRotation.current - object.rotation.y;
    while (rotationDifference > Math.PI) rotationDifference -= Math.PI * 2;
    while (rotationDifference < -Math.PI) rotationDifference += Math.PI * 2;
    object.rotation.y += rotationDifference * Math.min(1, dt * 10);
    object.rotation.z += (targetPitch.current - object.rotation.z) * Math.min(1, dt * 6);

    const wheelRadius = 0.28 * MODEL_SCALE[car.size];
    const wheelSpin = ((CAR_SPEED * getSpeedScale()) / wheelRadius) * dt;
    for (const wheel of wheelMeshes.current) wheel.rotation.x += wheelSpin;
  });

  return (
    <group ref={group}>
      <CarModel color={car.color} size={car.size} highQuality onLoad={handleModelLoad} />
    </group>
  );
});
