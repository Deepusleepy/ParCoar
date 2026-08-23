import { Suspense, memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
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
import { isNodeEntryBlocked, readRoutePlan } from "../hooks/useSimulation";

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

/* ------------------------------------------------------------------ *
 *  Crease-aware normal smoothing
 * ------------------------------------------------------------------
 *  The Quaternius GLBs come out of obj2gltf with every hard edge split
 *  into duplicated vertices (~73% duplicated verts), so each panel shades
 *  like an isolated facet and random edges read across the body. Passing
 *  each mesh through toCreasedNormals() rebuilds averaged normals wherever
 *  the dihedral angle stays under 30°, restoring smooth shading on curved
 *  panels while genuine creases (door shutlines, wheel arches) stay crisp.
 *
 *  Strategy: CLONE-THEN-MODIFY, cached per source geometry. useGLTF caches
 *  scenes and scene.clone() SHARES geometry between all consumers, so
 *  mutating a geometry in place would couple every consumer to one call
 *  site (and toCreasedNormals writes its input in place when handed a
 *  non-indexed geometry). Instead each cached source is converted exactly
 *  once and the result lives in a WeakMap keyed by the source; AI cars
 *  here, the parked InstancedMesh field below, and the player exterior in
 *  DrivableCar all then share one smoothed instance and agree on shading.
 *  Entries live as long as the GLTF cache itself (app lifetime), matching
 *  how this codebase treats module-scope materials; because nothing is
 *  allocated per mount, active-car mount/unmount churn cannot grow GPU
 *  memory. Originals are never touched, so ActiveCar's wheel-geometry
 *  disposal path (which clones again per car) keeps working unchanged.
 */
/** Dihedral angle below which neighbouring faces shade as one surface. */
const CREASE_ANGLE = THREE.MathUtils.degToRad(30);

const smoothedGeometryCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

/** One material-sized piece of a car mesh, ready for instancing. */
export interface SmoothedPart {
  geometry: THREE.BufferGeometry;
  /** Index into the source mesh's material array. */
  materialIndex: number;
}

const smoothedPartsCache = new WeakMap<THREE.BufferGeometry, SmoothedPart[]>();

/**
 * Whole-mesh variant for meshes that keep their full multi-material draw
 * (AI CarModel, player exterior): normals smoothed, groups intact (three's
 * indexed path de-indexes via toNonIndexed(), which re-registers groups),
 * so the existing material array keeps driving per-group rendering.
 */
export function creaseSmoothed(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const cached = smoothedGeometryCache.get(source);
  if (cached) return cached;
  // Only the indexed path is safe to convert: with no index,
  // toCreasedNormals overwrites the SHARED normal attribute in place.
  const smoothed = source.index ? toCreasedNormals(source, CREASE_ANGLE) : source;
  smoothedGeometryCache.set(source, smoothed);
  return smoothed;
}

/**
 * Split an indexed mesh geometry into one geometry per material group.
 * ParkedCarSizeGroup needs this to instance body / glass / trim separately
 * without ever drawing the whole index buffer with one material. Normals
 * are left as-is from the GLTF; the crease smoothing from PR #14 made cars
 * look melted and cheap, so it was reverted.
 */
export function smoothedParts(source: THREE.BufferGeometry): SmoothedPart[] {
  const cached = smoothedPartsCache.get(source);
  if (cached) return cached;
  if (!source.index) {
    const fallback: SmoothedPart[] = [{ geometry: source, materialIndex: 0 }];
    smoothedPartsCache.set(source, fallback);
    return fallback;
  }
  const ranges =
    source.groups.length > 0
      ? source.groups
      : [{ start: 0, count: source.index.count, materialIndex: 0 }];
  const parts: SmoothedPart[] = ranges.map((group) => ({
    geometry: sliceIndexed(source, group.start, group.count),
    materialIndex: group.materialIndex ?? 0,
  }));
  smoothedPartsCache.set(source, parts);
  return parts;
}

/** Zero-copy view of one index range of an indexed geometry. Shares the
 *  source attribute objects; only the index buffer is narrowed. Safe as a
 *  toCreasedNormals input precisely because the view is still indexed. */
function sliceIndexed(
  source: THREE.BufferGeometry,
  start: number,
  count: number,
): THREE.BufferGeometry {
  const index = source.getIndex();
  if (!index || count <= 0) return source;
  const view = new THREE.BufferGeometry();
  for (const name of Object.keys(source.attributes)) {
    const attribute = source.getAttribute(name);
    if (attribute) view.setAttribute(name, attribute);
  }
  view.setIndex(
    new THREE.BufferAttribute(index.array.subarray(start, start + count), index.itemSize),
  );
  return view;
}

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
          metalness: 0.45,
          roughness: 0.45,
          clearcoat: 0.8,
          clearcoatRoughness: 0.15,
          envMapIntensity: 0.7,
        })
      : new THREE.MeshStandardMaterial({
          color: new THREE.Color(hex),
          metalness: 0.4,
          roughness: 0.45,
        });
    // Near-opaque dark glass, opacity 1 / transparent:false. The old
    // half-transparent pane composited ground markings straight through the
    // shell (the "mirror is transparent" report) and dragged every car into
    // the transparent-sort lottery. Any residual alpha would still blend the
    // road behind the glass, so 1.0 it is: #1a1d24 at roughness 0.08 reads
    // as tinted glass purely through its environment reflections - the same
    // recipe the instanced parked path already renders correctly.
    const glass: THREE.MeshStandardMaterial = highQuality
      ? new THREE.MeshPhysicalMaterial({
          color: new THREE.Color("#1a1d24"),
          metalness: 0.1,
          roughness: 0.1,
          envMapIntensity: 0.8,
        })
      : new THREE.MeshStandardMaterial({
          color: new THREE.Color("#1a1d24"),
          metalness: 0.1,
          roughness: 0.08,
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

interface ParkedMesh {
  mesh: THREE.InstancedMesh;
  isBody: boolean;
  local: THREE.Matrix4;
}

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
      metalness: 0.4,
      roughness: 0.45,
    });
    // Same near-opaque dark gloss as the per-car replacement glass above, so
    // a parked car's glazing matches the cars driving past it.
    const glassMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color("#1a1d24"),
      metalness: 0.1,
      roughness: 0.1,
    });

    // Classify PER MATERIAL GROUP, not per mesh node. A GLTF mesh node can
    // carry several material groups (body, windows, lights in one node);
    // classifying by material[0] and issuing ONE InstancedMesh for the node
    // made three draw the FULL index buffer with that material - every
    // parked car's windows/headlights/taillights rendered in body paint.
    // Each group now becomes its own InstancedMesh:
    //   (a) body-classified primitives share the white base material whose
    //       instances are tinted via setColorAt below, exactly as before;
    //   (b) everything else keeps its ORIGINAL opaque GLTF material, shared
    //       across all instances (Windows swaps to the dark glass).
    // Draw calls rise from ~1 to ~5 per size class - noise next to cars
    // that look like cars.
    interface ParkedPart {
      geometry: THREE.BufferGeometry;
      material: THREE.Material;
      isBody: boolean;
      local: THREE.Matrix4;
    }
    const parts: ParkedPart[] = [];
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = (
        Array.isArray(object.material) ? object.material : [object.material]
      ).filter((material): material is THREE.Material => material instanceof THREE.Material);
      if (materials.length === 0) return;
      const local = new THREE.Matrix4().copy(base).multiply(object.matrixWorld);
      for (const part of smoothedParts(object.geometry)) {
        // A group's materialIndex can point past the array on malformed
        // assets; clamp rather than crash the whole field.
        const sourceMaterial =
          materials[Math.min(part.materialIndex, materials.length - 1)];
        if (!sourceMaterial) continue;
        const isBody = !NON_BODY.has(sourceMaterial.name);
        const material = isBody
          ? bodyMaterial
          : sourceMaterial.name === "Windows"
            ? glassMaterial
            : sourceMaterial;
        parts.push({
          geometry: part.geometry,
          material,
          isBody,
          local,
        });
      }
    });

    const meshes: ParkedMesh[] = parts.map(({ geometry, material, isBody, local }) => {
      const mesh = new THREE.InstancedMesh(geometry, material, PARKED_CAPACITY);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      mesh.frustumCulled = false;
      return { mesh, isBody, local };
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
  // Remaining nodes of the server-approved route AFTER the leg currently
  // being driven, plus the version of the last adopted plan so a fresh
  // reply replaces what remains of the queue instead of merging with it.
  const upcomingNodes = useRef<string[]>([]);
  const planVersion = useRef(0);
  /** Node the car is waiting to roll into while its entry is blocked. */
  const heldNode = useRef<string | null>(null);
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

    // Adopt the latest server-approved continuation wholesale. A new
    // version replaces whatever remains of the previous route - never
    // merges with it - and releases any boundary hold, since the server's
    // newest word supersedes the decision being waited on. Unknown node
    // ids are dropped so crossings never resolve against a missing node.
    const plan = readRoutePlan(car);
    if (plan && plan.version !== planVersion.current) {
      planVersion.current = plan.version;
      upcomingNodes.current = plan.upcoming.filter((id) => id in lot.nodes);
      heldNode.current = null;
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

    let points = waypoints.current;
    if (points.length < 2) {
      // Standstill: if a route plan was cached (e.g. the entry road was
      // blocked when the server replied), try to depart every frame instead
      // of waiting for the next server reply. This mirrors the heldNode
      // retry that mid-route crossings use, so standstill-to-moving
      // transitions are frame-gated (~16ms) not reply-gated (~400ms).
      if (car.fromNode === car.toNode) {
        const nextNode = heldNode.current ?? upcomingNodes.current.shift() ?? null;
        if (nextNode !== null) {
          if (!isNodeEntryBlocked(car, nextNode, upcomingNodes.current[0])) {
            heldNode.current = null;
            car.toNode = nextNode;
            car.status = "routing";
            // Re-resolve waypoints for the new leg on the next frame.
            currentLeg.current = "";
            return;
          }
          // Still blocked: hold the node and retry next frame.
          heldNode.current = nextNode;
        }
      }
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

    let segmentCount = points.length - 1;
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

        // Roll straight into the next queued leg when the server route
        // continues past this node. Only a genuinely final arrival - bay,
        // exit, or a route starved of continuations - reports back to the
        // backend; intermediate crossings ride on the periodic state sends
        // instead of blocking on one round trip per hop.
        const nextNode = heldNode.current ?? upcomingNodes.current.shift() ?? null;
        if (nextNode !== null) {
          const prevFrom = car.fromNode;
          const prevTo = car.toNode;
          car.progress = 0;
          car.fromNode = prevTo;
          car.toNode = nextNode;
          if (isNodeEntryBlocked(car, nextNode, upcomingNodes.current[0])) {
            // Occupied ahead: undo the crossing and hold at the boundary,
            // retrying on later frames. This physical gate mirrors the
            // hook's standstill check so queueing discipline survives cars
            // no longer stopping at every node. The index/progress writes
            // above are rolled back too, or the next frame would read past
            // the finished leg's waypoints.
            car.fromNode = prevFrom;
            car.toNode = prevTo;
            // The body rests at the far end of the finished leg.
            car.progress = 1;
            heldNode.current = nextNode;
            segmentIndex.current -= 1;
            // Cap at 1 (not += 1) so progress doesn't grow unboundedly while
            // held. The old += 1 restored the pre-crossing value, but each
            // frame then added speed on top, so a car held for N frames
            // accumulated N * speed * dt / segLen of excess progress. When
            // released, that excess hurled the car forward in a single jump
            // — the "hopping" artefact. Capping at 1 keeps the car pinned at
            // the segment boundary; the while loop re-checks the block every
            // frame and only a tiny residual (speed*dt/segLen) carries over
            // when the road clears.
            segmentProgress.current = 1;
            object.rotation.y = targetRotation.current;
            object.rotation.z = targetPitch.current;
            return;
          }
          heldNode.current = null;
          // Carry overshoot from the finished leg into the new one so the
          // crossing stays continuous at any frame rate.
          const carried = Math.max(
            segmentProgress.current * points[segmentCount - 1].distanceTo(points[segmentCount]),
            0,
          );
          const resolved = resolvePath(lot.nodes[prevTo], lot.nodes[nextNode], lot);
          waypoints.current = resolved;
          currentLeg.current = `${prevTo}>${nextNode}`;
          segmentIndex.current = 0;
          segmentProgress.current = resolved.length > 1
            ? Math.min(carried / Math.max(resolved[0].distanceTo(resolved[1]), 0.001), 1)
            : 0;
          points = waypoints.current;
          segmentCount = points.length - 1;
          continue;
        }

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
