import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { ActiveCar, CarColor, CarSize, LotData } from "../types";
import { CAR_DIMS, CAR_Y_OFFSET, COLOR_HEX, toWorld } from "./constants";

interface CarModelProps {
  color: CarColor;
  size: CarSize;
  /** When true, add subtle headlights/taillights. */
  lights?: boolean;
}

/**
 * A simple 3D car: box body, smaller cabin, four wheel cylinders.
 * Length axis is +x. Origin at the car center on the ground.
 */
export const CarModel = ({ color, size, lights = true }: CarModelProps) => {
  const { length, width, height } = CAR_DIMS[size];
  const hex = COLOR_HEX[color];
  const bodyY = height / 2 + 0.3;
  const cabinY = height + 0.45;
  const cabinLen = length * 0.5;
  const wheelR = 0.32;
  const wheelW = 0.22;
  const wheelX = length / 2 - 0.6;
  const wheelZ = width / 2 - 0.1;

  return (
    <group>
      {/* Body */}
      <mesh position={[0, bodyY, 0]} castShadow>
        <boxGeometry args={[length, height, width]} />
        <meshStandardMaterial
          color={hex}
          roughness={0.35}
          metalness={0.55}
        />
      </mesh>
      {/* Cabin */}
      <mesh position={[0, cabinY, 0]} castShadow>
        <boxGeometry args={[cabinLen, height * 0.55, width * 0.82]} />
        <meshStandardMaterial
          color={hex}
          roughness={0.2}
          metalness={0.7}
        />
      </mesh>
      {/* Windshield tint */}
      <mesh position={[cabinLen / 2 - 0.05, cabinY, 0]}>
        <boxGeometry args={[0.04, height * 0.45, width * 0.78]} />
        <meshStandardMaterial color="#0b0c10" roughness={0.1} metalness={0.9} />
      </mesh>
      <mesh position={[-cabinLen / 2 + 0.05, cabinY, 0]}>
        <boxGeometry args={[0.04, height * 0.45, width * 0.78]} />
        <meshStandardMaterial color="#0b0c10" roughness={0.1} metalness={0.9} />
      </mesh>
      {/* Wheels */}
      {[
        [wheelX, wheelR, wheelZ],
        [wheelX, wheelR, -wheelZ],
        [-wheelX, wheelR, wheelZ],
        [-wheelX, wheelR, -wheelZ],
      ].map((p, i) => (
        <mesh
          key={i}
          position={p as [number, number, number]}
          rotation={[0, 0, Math.PI / 2]}
          castShadow
        >
          <cylinderGeometry args={[wheelR, wheelR, wheelW, 16]} />
          <meshStandardMaterial color="#0a0a0a" roughness={0.8} />
        </mesh>
      ))}
      {lights && (
        <>
          {/* Headlights (+x front) */}
          <mesh position={[length / 2 + 0.01, bodyY, width / 3]}>
            <boxGeometry args={[0.04, 0.18, 0.3]} />
            <meshStandardMaterial
              color="#fffbe6"
              emissive="#fff3c0"
              emissiveIntensity={1.2}
            />
          </mesh>
          <mesh position={[length / 2 + 0.01, bodyY, -width / 3]}>
            <boxGeometry args={[0.04, 0.18, 0.3]} />
            <meshStandardMaterial
              color="#fffbe6"
              emissive="#fff3c0"
              emissiveIntensity={1.2}
            />
          </mesh>
          {/* Taillights (-x rear) */}
          <mesh position={[-length / 2 - 0.01, bodyY, width / 3]}>
            <boxGeometry args={[0.04, 0.16, 0.28]} />
            <meshStandardMaterial
              color="#ff2d2d"
              emissive="#ff0000"
              emissiveIntensity={0.9}
            />
          </mesh>
          <mesh position={[-length / 2 - 0.01, bodyY, -width / 3]}>
            <boxGeometry args={[0.04, 0.16, 0.28]} />
            <meshStandardMaterial
              color="#ff2d2d"
              emissive="#ff0000"
              emissiveIntensity={0.9}
            />
          </mesh>
        </>
      )}
    </group>
  );
};

interface StaticCarProps {
  color: CarColor;
  size: CarSize;
  position: [number, number, number];
  rotationY: number;
}

/** A non-moving car placed at a fixed world transform. */
export const StaticCar = ({ color, size, position, rotationY }: StaticCarProps) => (
  <group position={position} rotation={[0, rotationY, 0]}>
    <CarModel color={color} size={size} />
  </group>
);

interface ActiveCarProps {
  car: ActiveCar;
  lot: LotData;
  onArrive: (carId: string, node: string) => void;
}

/**
 * An active car that animates between graph nodes using useFrame lerp.
 * Calls onArrive when it reaches its target node.
 */
export const ActiveCarMesh = ({ car, lot, onArrive }: ActiveCarProps) => {
  const group = useRef<THREE.Group>(null);
  const arrived = useRef(true);
  const targetRot = useRef(0);

  // Sync ref targets whenever the car's route leg changes.
  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;

    const fromNode = lot.nodes[car.fromNode];
    const toNode = lot.nodes[car.toNode];
    if (!fromNode || !toNode) return;

    const fromW = toWorld(fromNode.x, fromNode.y, fromNode.floor);
    const toW = toWorld(toNode.x, toNode.y, toNode.floor);

    // New leg detected: reset progress tracking.
    if (arrived.current && car.toNode !== car.fromNode) {
      arrived.current = false;
      const dx = toW[0] - fromW[0];
      const dz = toW[2] - fromW[2];
      if (Math.hypot(dx, dz) > 1e-4) {
        targetRot.current = Math.atan2(-dz, dx);
      }
    }

    if (!arrived.current) {
      // Advance progress (frame-rate independent).
      const dist = Math.hypot(
        toW[0] - fromW[0],
        toW[2] - fromW[2],
        (toW[1] - fromW[1]) * 0.5,
      );
      const speed = 7; // lot units / sec
      const step = (speed * delta) / Math.max(dist, 0.001);
      car.progress = Math.min(1, car.progress + step);

      const p = car.progress;
      g.position.set(
        fromW[0] + (toW[0] - fromW[0]) * p,
        fromW[1] + (toW[1] - fromW[1]) * p + CAR_Y_OFFSET,
        fromW[2] + (toW[2] - fromW[2]) * p,
      );

      // Smoothly rotate toward target heading.
      let cur = g.rotation.y;
      let tgt = targetRot.current;
      let diff = tgt - cur;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      g.rotation.y = cur + diff * Math.min(1, delta * 6);

      if (car.progress >= 1) {
        arrived.current = true;
        car.progress = 0;
        car.fromNode = car.toNode;
        onArrive(car.id, car.toNode);
      }
    } else {
      // Stationary: sit at current node.
      g.position.set(fromW[0], fromW[1] + CAR_Y_OFFSET, fromW[2]);
    }
  });

  return (
    <group ref={group}>
      <CarModel color={car.color} size={car.size} />
    </group>
  );
};
