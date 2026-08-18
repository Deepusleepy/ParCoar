import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { ActiveCar, LotData } from "../types";
import { ParkingLot, lotBounds } from "./ParkingLot";
import { ActiveCarMesh, StaticCar } from "./Car";
import { Signboard } from "./Signboard";
import { toWorld } from "./constants";
import type { ParkedCarData, SignboardData } from "../hooks/useSimulation";

interface SceneProps {
  lot: LotData;
  activeCars: ActiveCar[];
  preParked: ParkedCarData[];
  parked: ParkedCarData[];
  signboards: SignboardData[];
  onArrive: (carId: string, node: string) => void;
}

/** Compute world transform for a car sitting in a slot, facing the aisle. */
function slotTransform(lot: LotData, slotNode: string): {
  position: [number, number, number];
  rotationY: number;
} {
  const node = lot.nodes[slotNode];
  if (!node) return { position: [0, 0, 0], rotationY: 0 };
  const position = toWorld(node.x, node.y, node.floor);
  // Face the aisle (y=0). Slot at y<0 faces +z; slot at y>0 faces -z.
  const rotationY = node.y < 0 ? -Math.PI / 2 : Math.PI / 2;
  return { position, rotationY };
}

function SlotCars({
  lot,
  cars,
}: {
  lot: LotData;
  cars: ParkedCarData[];
}) {
  return (
    <>
      {cars.map((c) => {
        const { position, rotationY } = slotTransform(lot, c.slotNode);
        return (
          <StaticCar
            key={c.key}
            color={c.color}
            size={c.size}
            position={position}
            rotationY={rotationY}
          />
        );
      })}
    </>
  );
}

export function Scene({
  lot,
  activeCars,
  preParked,
  parked,
  signboards,
  onArrive,
}: SceneProps) {
  const bounds = lotBounds(lot);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = ((bounds.minFloor + bounds.maxFloor) / 2) * 15;
  const target: [number, number, number] = [cx, cy, 0];

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ position: [95, 52, 62], fov: 42, near: 0.5, far: 600 }}
      gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
      onCreated={({ scene }) => {
        scene.fog = new THREE.FogExp2(0x000000, 0.0042);
        scene.background = new THREE.Color(0x000000);
      }}
    >
      <ambientLight intensity={0.55} />
      <hemisphereLight args={["#3b3f4a", "#000000", 0.4]} />
      <directionalLight
        position={[60, 80, 40]}
        intensity={1.1}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-90}
        shadow-camera-right={90}
        shadow-camera-top={60}
        shadow-camera-bottom={-60}
        shadow-camera-near={1}
        shadow-camera-far={220}
        shadow-bias={-0.0005}
      />
      <directionalLight position={[-40, 50, -30]} intensity={0.25} />

      <ParkingLot lot={lot} />

      <SlotCars lot={lot} cars={preParked} />
      <SlotCars lot={lot} cars={parked} />

      {activeCars.map((car) => (
        <ActiveCarMesh
          key={car.id}
          car={car}
          lot={lot}
          onArrive={onArrive}
        />
      ))}

      {signboards.map((s) => (
        <Signboard
          key={s.key}
          nodeX={s.nodeX}
          nodeY={s.nodeY}
          floor={s.floor}
          carId={s.carId}
          color={s.color}
          plate={s.plate}
          direction={s.direction}
          slot={s.slot}
          slotFloor={s.slotFloor}
        />
      ))}

      <OrbitControls
        target={target}
        enableDamping
        dampingFactor={0.08}
        minDistance={30}
        maxDistance={220}
        maxPolarAngle={Math.PI / 2.05}
      />
    </Canvas>
  );
}
