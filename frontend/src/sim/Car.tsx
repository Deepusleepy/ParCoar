import { Suspense, memo, useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { ActiveCar, CarColor, CarSize, LotData, LotNode } from "../types";
import {
  AISLE_SPACING,
  CAR_DIMS,
  CAR_Y_OFFSET,
  CAR_LENGTH,
  CAR_SPEED,
  COLOR_HEX,
  LANE_WIDTH,
  toWorld,
} from "./constants";
import { resolvePath } from "./paths";
import { getSpeedScale } from "./simSpeed";
import { isNodeEntryBlocked, readPlayerPos, readRoutePlan } from "../hooks/useSimulation";

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

/** Regex matching GLTF wheel node names across all three models. */
const WHEEL_NAME_RE = /(?:BackWheels|FrontLeftWheel|FrontRightWheel)/;

/** Wheel radius per size (from GLTF bounding-box analysis). */
const WHEEL_RADIUS: Record<CarSize, number> = {
  small: 0.185,
  medium: 0.173,
  large: 0.216,
};

/** Dark rubber material shared by all AI car wheels. */
const activeWheelMaterial = new THREE.MeshStandardMaterial({
  color: 0x1a1a1a,
  roughness: 0.85,
  metalness: 0.1,
});

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

/* ------------------------------------------------------------------ *
 *  Shared material cache
 * ------------------------------------------------------------------
 *  CarModelInner used to allocate one MeshPhysicalMaterial per body and
 *  one per glass inside its own useMemo, so N AI/static cars produced 2N
 *  material objects - each with its own uniform uploads and its own
 *  shader-program slot (clearcoat variants are among the heaviest
 *  standard materials). The cache below keys body materials by
 *  `${hex}|${quality}` and glass by quality alone (glass color is the
 *  constant #1a1d24), so the whole app settles to ~14 body + 2 glass
 *  materials regardless of car count. Cache entries live for the app
 *  lifetime - matching how ParkingLot/DrivableCar already treat
 *  module-scope materials - so active-car mount/unmount churn can no
 *  longer grow renderer.info.memory.materials.
 */
const bodyMaterialCache = new Map<string, THREE.MeshStandardMaterial>();
const glassMaterialCache = new Map<string, THREE.MeshStandardMaterial>();

function getBodyMaterial(hex: string, highQuality: boolean): THREE.MeshStandardMaterial {
  const key = `${hex}|${highQuality ? "hq" : "lq"}`;
  let material = bodyMaterialCache.get(key);
  if (!material) {
    material = highQuality
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
    bodyMaterialCache.set(key, material);
  }
  return material;
}

function getGlassMaterial(highQuality: boolean): THREE.MeshStandardMaterial {
  const key = highQuality ? "hq" : "lq";
  let material = glassMaterialCache.get(key);
  if (!material) {
    material = highQuality
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
    glassMaterialCache.set(key, material);
  }
  return material;
}

interface CarModelProps {
  color: CarColor;
  size: CarSize;
  highQuality?: boolean;
  onLoad?: (object: THREE.Object3D) => void;
}

function CarModelInner({ color, size, highQuality = true, onLoad }: CarModelProps) {
  const { scene } = useGLTF(MODEL_PATHS[size]);
  const hex = COLOR_HEX[color];

  // Materials come from the module-level cache (one body per color/quality,
  // one glass per quality) so mounting N cars no longer allocates 2N
  // PhysicalMaterials. The cache owns disposal; this component never disposes
  // the shared materials. Only the cloned scene is per-instance.
  const bodyMaterial = getBodyMaterial(hex, highQuality);
  const glassMaterial = getGlassMaterial(highQuality);

  const cloned = useMemo(() => {
    const object = scene.clone();
    // Near-opaque dark glass, opacity 1 / transparent:false. The old
    // half-transparent pane composited ground markings straight through the
    // shell (the "mirror is transparent" report) and dragged every car into
    // the transparent-sort lottery. Any residual alpha would still blend the
    // road behind the glass, so 1.0 it is: #1a1d24 at roughness 0.08 reads
    // as tinted glass purely through its environment reflections - the same
    // recipe the instanced parked path already renders correctly.
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = true;
      child.receiveShadow = true;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      const replaced = materials.map((material) => {
        if (!(material instanceof THREE.Material)) return material;
        if (material.name === "Windows") return glassMaterial;
        if (NON_BODY.has(material.name)) return material;
        return bodyMaterial;
      });
      child.material = replaced.length === 1 ? replaced[0] : replaced;
    });
    return object;
  }, [scene, bodyMaterial, glassMaterial]);

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

export const ParkedCarField = memo(function ParkedCarField({ cars }: { cars: ParkedCarInstance[] }) {
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
});

const PARKED_CAPACITY = 512;

interface ParkedMesh {
  mesh: THREE.InstancedMesh;
  isBody: boolean;
  local: THREE.Matrix4;
}

const ParkedCarSizeGroup = memo(function ParkedCarSizeGroup({ size, cars }: { size: CarSize; cars: ParkedCarInstance[] }) {
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
      // Reset the incremental slot bookkeeping so a rebuilt `built` (or a
      // remount) starts from a clean slate instead of indexing into the
      // now-disposed InstancedMeshes.
      slotsRef.current.clear();
      freeIndicesRef.current.length = 0;
      nextIndexRef.current = 0;
    };
  }, [built]);

  // Incremental slot -> instance-index bookkeeping. Kept in refs so the
  // write effect below can diff the incoming `cars` list against what is
  // already on the GPU and touch only the instances that actually changed,
  // instead of rewriting every instance matrix + colour and recomputing the
  // bounding sphere on every park/depart. The spawn (3s) and depart (2s)
  // loops beat against each other; their full-rewrite storms clustered
  // every ~6s and stalled the main thread for several frames, which the
  // dt-clamped chase camera then read as a periodic jitter burst.
  interface SlotEntry {
    index: number;
    color: CarColor;
    px: number;
    py: number;
    pz: number;
    rotY: number;
  }
  const slotsRef = useRef<Map<string, SlotEntry>>(new Map());
  const freeIndicesRef = useRef<number[]>([]);
  const nextIndexRef = useRef(0);

  const scratch = useMemo(
    () => ({
      transform: new THREE.Matrix4(),
      rotation: new THREE.Matrix4(),
      color: new THREE.Color(),
      // Zero-scale matrix used to tombstone a freed instance so it renders
      // nothing without disturbing the indices of the cars still live.
      degenerate: new THREE.Matrix4().makeScale(0, 0, 0),
    }),
    [],
  );

  useEffect(() => {
    const slots = slotsRef.current;
    const freeIndices = freeIndicesRef.current;
    const newSlots = new Set<string>();
    let changed = false;
    let maxIndex = -1;

    type Op =
      | { kind: "write"; index: number; car: ParkedCarInstance }
      | { kind: "tombstone"; index: number };
    const ops: Op[] = [];

    // Pass 1: assign/update every car in the new list.
    for (const car of cars) {
      newSlots.add(car.slotNode);
      const existing = slots.get(car.slotNode);
      if (!existing) {
        const free = freeIndices.pop();
        const index = free ?? nextIndexRef.current;
        if (index >= PARKED_CAPACITY) continue; // field full; drop excess
        nextIndexRef.current = Math.max(nextIndexRef.current, index + 1);
        slots.set(car.slotNode, {
          index,
          color: car.color,
          px: car.position[0],
          py: car.position[1],
          pz: car.position[2],
          rotY: car.rotationY,
        });
        ops.push({ kind: "write", index, car });
        changed = true;
        if (index > maxIndex) maxIndex = index;
      } else {
        const moved =
          existing.px !== car.position[0] ||
          existing.py !== car.position[1] ||
          existing.pz !== car.position[2] ||
          existing.rotY !== car.rotationY;
        const recolored = existing.color !== car.color;
        if (moved || recolored) {
          existing.color = car.color;
          existing.px = car.position[0];
          existing.py = car.position[1];
          existing.pz = car.position[2];
          existing.rotY = car.rotationY;
          ops.push({ kind: "write", index: existing.index, car });
          changed = true;
        }
        if (existing.index > maxIndex) maxIndex = existing.index;
      }
    }

    // Pass 2: tombstone any car that left the list, recycling its index.
    for (const [slot, entry] of slots) {
      if (newSlots.has(slot)) continue;
      ops.push({ kind: "tombstone", index: entry.index });
      slots.delete(slot);
      freeIndices.push(entry.index);
      changed = true;
    }

    if (!changed) return;

    const { transform, rotation, color, degenerate } = scratch;
    for (const { mesh, isBody, local } of built.meshes) {
      for (const op of ops) {
        if (op.kind === "write") {
          transform.makeTranslation(op.car.position[0], op.car.position[1], op.car.position[2]);
          transform.multiply(rotation.makeRotationY(op.car.rotationY)).multiply(local);
          mesh.setMatrixAt(op.index, transform);
          if (isBody) mesh.setColorAt(op.index, color.set(COLOR_HEX[op.car.color]));
        } else {
          mesh.setMatrixAt(op.index, degenerate);
        }
      }
      mesh.count = Math.min(maxIndex + 1, PARKED_CAPACITY);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // computeBoundingSphere skipped: frustumCulled is false on these
      // meshes, so the sphere is never used for culling, and parked cars
      // are never raycast. Recomputing it per park/depart was a pure cost.
    }
  }, [built, cars, scratch]);

  return (
    <group>
      {built.meshes.map(({ mesh }, index) => (
        <primitive key={index} object={mesh} />
      ))}
    </group>
  );
});

function bayYaw(bay: LotNode): number {
  const aisleY = Math.round(bay.y / AISLE_SPACING) * AISLE_SPACING;
  return bay.y < aisleY ? Math.PI / 2 : -Math.PI / 2;
}

/* ------------------------------------------------------------------ *
 *  Instanced active AI cars
 * ------------------------------------------------------------------
 *  Active AI cars used to render as one cloned GLTF scene per car, each
 *  with its own materials and its own useFrame callback: 20 cars meant
 *  ~100 draw calls, 20 PhysicalMaterials, 20 frame callbacks, and 20
 *  per-car wheel-geometry clones. The path below collapses all of that
 *  to ~5 InstancedMesh draw calls per size class (15 total) driven by a
 *  single useFrame, with one shared body material (tinted per instance
 *  via setColorAt) and one shared glass material. Wheel spin is dropped
 *  - the original centring clones existed only to make spin rotate about
 *  the hub, and wheels on moving traffic are barely visible, so the
 *  whole per-car wheel-geometry churn disappears with it.
 *
 *  Per-car driving state (waypoints, segment index, route plan, etc.)
 *  lives in a Map keyed by car id and is preserved across renders, so
 *  the driving logic is identical to the old per-car useFrame - only the
 *  rendering and the callback count change. A lightweight THREE.Group
 *  per car holds the transform the camera rig reads (carGroupsRef), so
 *  the follow/POV contract is unchanged; those groups are not added to
 *  the scene graph, they are just transform holders updated each frame.
 */
const ACTIVE_CAPACITY = 64;

/** One shared body material for all active AI cars; tinted per instance. */
const activeBodyMaterial = new THREE.MeshPhysicalMaterial({
  color: 0xffffff,
  metalness: 0.45,
  roughness: 0.45,
  clearcoat: 0.8,
  clearcoatRoughness: 0.15,
  envMapIntensity: 0.7,
});
/** One shared glass material for all active AI cars. */
const activeGlassMaterial = new THREE.MeshPhysicalMaterial({
  color: new THREE.Color("#1a1d24"),
  metalness: 0.1,
  roughness: 0.1,
  envMapIntensity: 0.8,
});

interface ActiveMesh {
  mesh: THREE.InstancedMesh;
  isBody: boolean;
  local: THREE.Matrix4;
}

/** A wheel InstancedMesh with its hub-center offset and steer flag. */
interface ActiveWheelMesh {
  mesh: THREE.InstancedMesh;
  /** Hub center in the car's local space (after FORWARD_ROT + scale). */
  center: THREE.Vector3;
  /** Whether this wheel steers (front wheels only). */
  steers: boolean;
}

interface ActiveSizeBuild {
  meshes: ActiveMesh[];
  wheelMeshes: ActiveWheelMesh[];
}

function buildActiveSize(size: CarSize, scene: THREE.Object3D): ActiveSizeBuild {
  scene.updateMatrixWorld(true);
  const scale = MODEL_SCALE[size];
  const base = new THREE.Matrix4()
    .makeRotationY(FORWARD_ROT)
    .multiply(new THREE.Matrix4().makeScale(scale, scale, scale));

  // Classify per material group, exactly like ParkedCarSizeGroup: body
  // groups share the white base material (tinted per instance), Windows
  // groups share the dark glass, and the rest keep their original GLTF
  // material (shared via the useGLTF cache across every consumer).
  interface ActivePart {
    geometry: THREE.BufferGeometry;
    material: THREE.Material;
    isBody: boolean;
    local: THREE.Matrix4;
  }
  const parts: ActivePart[] = [];
  const wheelParts: { geometry: THREE.BufferGeometry; center: THREE.Vector3; steers: boolean }[] = [];
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;

    // Detect wheel meshes and handle separately from body parts.
    if (WHEEL_NAME_RE.test(object.name)) {
      // Compute the wheel's hub center in the car's local space (after
      // FORWARD_ROT + scale), then recenter the geometry so the hub sits
      // at the origin. This lets us spin the wheel in place by composing
      // translate(hubCenter) * rotateY(spin) around the hub.
      const local = new THREE.Matrix4().copy(base).multiply(object.matrixWorld);
      object.geometry.computeBoundingBox();
      const bb = object.geometry.boundingBox!;
      const centerLocal = new THREE.Vector3();
      bb.getCenter(centerLocal);
      // Apply the same local transform to the center point.
      centerLocal.applyMatrix4(local);

      // Recenter the geometry at its own center, then apply the local
      // transform (FORWARD_ROT + scale + mesh-local). The resulting
      // geometry has vertices centered at the hub, ready for per-wheel
      // spin/steer rotation.
      const recentered = object.geometry.clone();
      recentered.translate(-bb.min.x - (bb.max.x - bb.min.x) / 2,
                           -bb.min.y - (bb.max.y - bb.min.y) / 2,
                           -bb.min.z - (bb.max.z - bb.min.z) / 2);
      // Bake the local transform (FORWARD_ROT + scale) into the geometry
      // so the wheel mesh's instance matrix can be a simple translate.
      recentered.applyMatrix4(new THREE.Matrix4().makeRotationY(FORWARD_ROT));
      recentered.applyMatrix4(new THREE.Matrix4().makeScale(scale, scale, scale));
      // Bake the mesh's own scene-local transform (object.matrixWorld
      // relative to the scene root) so wheels at different positions in
      // the GLTF are correctly placed.
      // object.matrixWorld is the world matrix; we need the local matrix
      // (relative to the scene root, which is the GLTF scene). Since the
      // scene root has identity transform, world = local.
      recentered.applyMatrix4(object.matrixWorld);

      const steers = /Front/.test(object.name);
      wheelParts.push({ geometry: recentered, center: centerLocal, steers });
      return;
    }

    const materials = (
      Array.isArray(object.material) ? object.material : [object.material]
    ).filter((material): material is THREE.Material => material instanceof THREE.Material);
    if (materials.length === 0) return;
    const local = new THREE.Matrix4().copy(base).multiply(object.matrixWorld);
    for (const part of smoothedParts(object.geometry)) {
      const sourceMaterial =
        materials[Math.min(part.materialIndex, materials.length - 1)];
      if (!sourceMaterial) continue;
      const isBody = !NON_BODY.has(sourceMaterial.name);
      const material = isBody
        ? activeBodyMaterial
        : sourceMaterial.name === "Windows"
          ? activeGlassMaterial
          : sourceMaterial;
      parts.push({ geometry: part.geometry, material, isBody, local });
    }
  });

  const meshes: ActiveMesh[] = parts.map(({ geometry, material, isBody, local }) => {
    const mesh = new THREE.InstancedMesh(geometry, material, ACTIVE_CAPACITY);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0;
    mesh.frustumCulled = false;
    return { mesh, isBody, local };
  });

  const wheelMeshes: ActiveWheelMesh[] = wheelParts.map(({ geometry, center, steers }) => {
    const mesh = new THREE.InstancedMesh(geometry, activeWheelMaterial, ACTIVE_CAPACITY);
    mesh.castShadow = true;
    mesh.count = 0;
    mesh.frustumCulled = false;
    return { mesh, center, steers };
  });

  return { meshes, wheelMeshes };
}

/** Per-car driving state, preserved across renders for one active AI car. */
interface ActiveRuntime {
  car: ActiveCar;
  size: CarSize;
  /** Instance index within this car's size-class InstancedMeshes. */
  index: number;
  seeded: boolean;
  targetRotation: number;
  targetPitch: number;
  currentLeg: string;
  waypoints: THREE.Vector3[];
  segmentIndex: number;
  segmentProgress: number;
  // Remaining nodes of the server-approved route AFTER the leg currently
  // being driven, plus the version of the last adopted plan so a fresh
  // reply replaces what remains of the queue instead of merging with it.
  upcomingNodes: string[];
  planVersion: number;
  /** Node the car is waiting to roll into while its entry is blocked. */
  heldNode: string | null;
  /** Transform holder the camera rig reads via carGroupsRef. Not in the
   *  scene graph; only its position/rotation are updated each frame. */
  group: THREE.Group;
  lookAhead: THREE.Vector3;
  /** Accumulated wheel spin angle (radians). Updated each frame. */
  wheelSpin: number;
  /** Current steering angle for front wheels (radians). */
  wheelSteer: number;
  /** Previous frame's rotation.y, for computing steer delta. */
  prevRotationY: number;
}

/**
 * Advance one active car's driving logic by one frame. Ported verbatim
 * from the old per-car ActiveCarMesh useFrame (minus the wheel spin and
 * the per-frame carGroupsRef/name writes, which now happen on mount via
 * the sync effect). Writes the resulting pose to rt.group so the camera
 * rig and the instance-matrix pass can both read it.
 */
function stepActiveCar(
  rt: ActiveRuntime,
  dt: number,
  lot: LotData,
  onArrive: (carId: string, node: string) => void,
): void {
  const object = rt.group;
  const car = rt.car;
  const fromNode = lot.nodes[car.fromNode];
  const toNode = lot.nodes[car.toNode];
  if (!fromNode || !toNode) return;

  if (!rt.seeded) {
    rt.seeded = true;
    if (fromNode.type === "slot") {
      const yaw = bayYaw(fromNode);
      object.rotation.y = yaw;
      rt.targetRotation = yaw;
    }
  }

  // Adopt the latest server-approved continuation wholesale. A new
  // version replaces whatever remains of the previous route - never
  // merges with it - and releases any boundary hold, since the server's
  // newest word supersedes the decision being waited on. Unknown node
  // ids are dropped so crossings never resolve against a missing node.
  const plan = readRoutePlan(car);
  if (plan && plan.version !== rt.planVersion) {
    rt.planVersion = plan.version;
    rt.upcomingNodes = plan.upcoming.filter((id) => id in lot.nodes);
    rt.heldNode = null;
  }

  const legKey = `${car.fromNode}>${car.toNode}`;
  if (legKey !== rt.currentLeg) {
    rt.currentLeg = legKey;
    rt.segmentIndex = 0;
    rt.segmentProgress = 0;
    rt.waypoints = car.fromNode !== car.toNode
      ? resolvePath(fromNode, toNode, lot)
      : [];
  }

  let points = rt.waypoints;
  if (points.length < 2) {
    // Standstill: if a route plan was cached (e.g. the entry road was
    // blocked when the server replied), try to depart every frame instead
    // of waiting for the next server reply. This mirrors the heldNode
    // retry that mid-route crossings use, so standstill-to-moving
    // transitions are frame-gated (~16ms) not reply-gated (~400ms).
    if (car.fromNode === car.toNode) {
      const nextNode = rt.heldNode ?? rt.upcomingNodes.shift() ?? null;
      if (nextNode !== null) {
        if (!isNodeEntryBlocked(car, nextNode, rt.upcomingNodes[0])) {
          rt.heldNode = null;
          car.toNode = nextNode;
          car.status = "routing";
          // Re-resolve waypoints for the new leg on the next frame.
          rt.currentLeg = "";
          return;
        }
        // Still blocked: hold the node and retry next frame.
        rt.heldNode = nextNode;
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
  const speed = CAR_SPEED * getSpeedScale();

  // Per-frame player gate: the node-entry gate (isNodeEntryBlocked) only
  // runs at graph crossings, so once an AI car has entered a leg it would
  // drive the whole leg without re-checking the player and could overlap a
  // player that moved into its lane mid-leg. Hold the car this frame when
  // the player is ahead in the same lane within a few car lengths.
  //
  // The resolved waypoints carry the lane shift, but the player's position
  // is physics-based (NOT lane-shifted). So we compute lateral from the
  // SEGMENT CENTERLINE (midpoint of sa->sb), not from the AI car's
  // lane-shifted position. We use SIGNED lateral to distinguish same-lane
  // from oncoming-lane, and a radial guard to handle turn nodes where the
  // forward projection onto the current segment is near zero even though
  // the player has moved far away on a perpendicular leg.
  const pp = readPlayerPos();
  if (pp && Math.abs(pp.floor - fromNode.floor) < 1) {
    const si = rt.segmentIndex;
    const sa = points[si];
    const sb = points[si + 1];
    const sabx = sb.x - sa.x;
    const sabz = sb.z - sa.z;
    const sLen = Math.hypot(sabx, sabz);
    if (sLen > 1e-4) {
      const sux = sabx / sLen;
      const suz = sabz / sLen;
      // Use the segment midpoint as the centerline reference point.
      const midX = (sa.x + sb.x) / 2;
      const midZ = (sa.z + sb.z) / 2;
      const svx = pp.x - midX;
      const svz = pp.z - midZ;
      const sRadial = Math.hypot(svx, svz);
      // Radial guard: player too far away to be a collision risk.
      if (sRadial > CAR_LENGTH * 2) {
        // skip gate
      } else {
        const sForward = svx * sux + svz * suz;
        const sLateral = svx * suz - svz * sux; // signed: + = same, - = oncoming
        // Player clearly in the oncoming lane — pass.
        // Player too far laterally on same side (off road, e.g. in a slot) — pass.
        // Player behind — pass.
        // Player ahead in same lane within stopping distance — block.
        if (
          sLateral > -LANE_WIDTH * 0.4 &&
          sLateral < LANE_WIDTH &&
          sForward > -CAR_LENGTH * 0.5 &&
          sForward < CAR_LENGTH * 1.5
        ) {
          car.progress =
            segmentCount > 0 ? (rt.segmentIndex + rt.segmentProgress) / segmentCount : 0;
          return;
        }
      }
    }
  }

  rt.segmentProgress += (speed * dt) / Math.max(
    points[rt.segmentIndex].distanceTo(points[rt.segmentIndex + 1]),
    0.001,
  );

  while (rt.segmentProgress >= 1) {
    const oldLength = points[rt.segmentIndex].distanceTo(points[rt.segmentIndex + 1]);
    rt.segmentProgress -= 1;
    rt.segmentIndex++;

    if (rt.segmentIndex >= segmentCount) {
      const last = points[segmentCount];
      object.position.set(last.x, last.y + CAR_Y_OFFSET, last.z);

      // Roll straight into the next queued leg when the server route
      // continues past this node. Only a genuinely final arrival - bay,
      // exit, or a route starved of continuations - reports back to the
      // backend; intermediate crossings ride on the periodic state sends
      // instead of blocking on one round trip per hop.
      const nextNode = rt.heldNode ?? rt.upcomingNodes.shift() ?? null;
      if (nextNode !== null) {
        const prevFrom = car.fromNode;
        const prevTo = car.toNode;
        car.progress = 0;
        car.fromNode = prevTo;
        car.toNode = nextNode;
        if (isNodeEntryBlocked(car, nextNode, rt.upcomingNodes[0])) {
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
          rt.heldNode = nextNode;
          rt.segmentIndex -= 1;
          // Cap at 1 (not += 1) so progress doesn't grow unboundedly while
          // held. The old += 1 restored the pre-crossing value, but each
          // frame then added speed on top, so a car held for N frames
          // accumulated N * speed * dt / segLen of excess progress. When
          // released, that excess hurled the car forward in a single jump
          // — the "hopping" artefact. Capping at 1 keeps the car pinned at
          // the segment boundary; the while loop re-checks the block every
          // frame and only a tiny residual (speed*dt/segLen) carries over
          // when the road clears.
          rt.segmentProgress = 1;
          object.rotation.y = rt.targetRotation;
          object.rotation.z = rt.targetPitch;
          return;
        }
        rt.heldNode = null;
        // Carry overshoot from the finished leg into the new one so the
        // crossing stays continuous at any frame rate.
        const carried = Math.max(
          rt.segmentProgress * points[segmentCount - 1].distanceTo(points[segmentCount]),
          0,
        );
        const resolved = resolvePath(lot.nodes[prevTo], lot.nodes[nextNode], lot);
        rt.waypoints = resolved;
        rt.currentLeg = `${prevTo}>${nextNode}`;
        rt.segmentIndex = 0;
        rt.segmentProgress = resolved.length > 1
          ? Math.min(carried / Math.max(resolved[0].distanceTo(resolved[1]), 0.001), 1)
          : 0;
        points = rt.waypoints;
        segmentCount = points.length - 1;
        continue;
      }

      object.rotation.y = toNode.type === "slot" ? bayYaw(toNode) : rt.targetRotation;
      object.rotation.z = rt.targetPitch;
      rt.segmentIndex = 0;
      rt.segmentProgress = 0;
      rt.waypoints = [];
      car.progress = 0;
      car.fromNode = car.toNode;
      onArrive(car.id, car.toNode);
      return;
    }

    const newLength = points[rt.segmentIndex].distanceTo(points[rt.segmentIndex + 1]);
    if (newLength > 0.001) rt.segmentProgress *= oldLength / newLength;
  }

  const activeIndex = rt.segmentIndex;
  const a = points[activeIndex];
  const b = points[activeIndex + 1];
  const progress = rt.segmentProgress;
  car.progress = segmentCount > 0 ? (activeIndex + progress) / segmentCount : 0;
  object.position.set(
    a.x + (b.x - a.x) * progress,
    a.y + (b.y - a.y) * progress + CAR_Y_OFFSET,
    a.z + (b.z - a.z) * progress,
  );

  const LOOK_AHEAD = 3;
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
    ? rt.lookAhead.set(
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
    rt.targetRotation = Math.atan2(-dz, dx);
    rt.targetPitch = Math.atan2(dy, horizontal);
  }

  let rotationDifference = rt.targetRotation - object.rotation.y;
  while (rotationDifference > Math.PI) rotationDifference -= Math.PI * 2;
  while (rotationDifference < -Math.PI) rotationDifference += Math.PI * 2;
  object.rotation.y += rotationDifference * Math.min(1, dt * 10);
  object.rotation.z += (rt.targetPitch - object.rotation.z) * Math.min(1, dt * 6);

  // --- Wheel spin & steer computation ---
  // Spin: angular velocity = linear speed / wheel radius. The car moves
  // at `speed` units/sec, so the wheels rotate at speed/radius rad/sec.
  const radius = WHEEL_RADIUS[rt.size];
  rt.wheelSpin += (speed / radius) * dt;
  // Steer: derive from the heading change rate. A positive rotation
  // delta means turning left (in three.js Y-up, +Y rotation is
  // counter-clockwise when viewed from above = left turn). Scale to a
  // visual steer angle and clamp to ~0.5 rad (~28°).
  const headingDelta = object.rotation.y - rt.prevRotationY;
  rt.prevRotationY = object.rotation.y;
  if (dt > 1e-4) {
    const headingRate = headingDelta / dt;
    const targetSteer = THREE.MathUtils.clamp(headingRate * 0.12, -0.5, 0.5);
    // Smooth the steer angle so it doesn't snap.
    rt.wheelSteer += (targetSteer - rt.wheelSteer) * Math.min(1, dt * 8);
  }
}

interface ActiveCarFieldProps {
  cars: ActiveCar[];
  lot: LotData;
  onArrive: (carId: string, node: string) => void;
  carGroupsRef?: React.MutableRefObject<Map<string, THREE.Group>>;
}

const SIZES: CarSize[] = ["small", "medium", "large"];

export const ActiveCarField = memo(function ActiveCarField({
  cars,
  lot,
  onArrive,
  carGroupsRef,
}: ActiveCarFieldProps) {
  const smallScene = useGLTF(MODEL_PATHS.small).scene;
  const mediumScene = useGLTF(MODEL_PATHS.medium).scene;
  const largeScene = useGLTF(MODEL_PATHS.large).scene;

  const builds = useMemo(
    () => ({
      small: buildActiveSize("small", smallScene),
      medium: buildActiveSize("medium", mediumScene),
      large: buildActiveSize("large", largeScene),
    }),
    [smallScene, mediumScene, largeScene],
  );

  const runtimes = useRef(new Map<string, ActiveRuntime>());
  // Latest lot/onArrive are read inside useFrame via refs so the single
  // frame callback always sees current values without re-subscribing.
  const lotRef = useRef(lot);
  const onArriveRef = useRef(onArrive);
  lotRef.current = lot;
  onArriveRef.current = onArrive;

  const scratch = useMemo(
    () => ({
      transform: new THREE.Matrix4(),
      rotationY: new THREE.Matrix4(),
      rotationZ: new THREE.Matrix4(),
      color: new THREE.Color(),
    }),
    [],
  );

  // Scratch matrices for wheel instance composition (allocated once).
  const wheelScratch = useMemo(
    () => ({
      translate: new THREE.Matrix4(),
      steer: new THREE.Matrix4(),
      spin: new THREE.Matrix4(),
    }),
    [],
  );

  // Sync the runtime map with the cars array: add new cars, drop gone
  // cars, and reassign per-size instance indices contiguously. The
  // carGroupsRef map is kept in lockstep so the camera rig can follow a
  // car by id; the per-car group is created once on first sight and
  // deleted when the car leaves, replacing the old per-frame Map.set and
  // object.name writes that ran inside useFrame.
  useEffect(() => {
    const map = runtimes.current;
    const seen = new Set<string>();
    const bySize: Record<CarSize, ActiveCar[]> = { small: [], medium: [], large: [] };
    for (const car of cars) {
      if (car.player) continue;
      if (car.truck) continue; // truck has its own component
      seen.add(car.id);
      bySize[car.size].push(car);
    }
    for (const id of Array.from(map.keys())) {
      if (!seen.has(id)) {
        map.delete(id);
        carGroupsRef?.current.delete(id);
      }
    }
    for (const size of SIZES) {
      bySize[size].forEach((car, index) => {
        let rt = map.get(car.id);
        if (!rt) {
          rt = {
            car,
            size,
            index,
            seeded: false,
            targetRotation: 0,
            targetPitch: 0,
            currentLeg: "",
            waypoints: [],
            segmentIndex: 0,
            segmentProgress: 0,
            upcomingNodes: [],
            planVersion: 0,
            heldNode: null,
            group: new THREE.Group(),
            lookAhead: new THREE.Vector3(),
            wheelSpin: 0,
            wheelSteer: 0,
            prevRotationY: 0,
          };
          rt.group.name = car.id;
          map.set(car.id, rt);
          carGroupsRef?.current.set(car.id, rt.group);
        } else {
          // Car objects are stable references in practice (the sim mutates
          // them in place), but keep the reference fresh in case a future
          // change replaces them - driving state is preserved regardless.
          rt.car = car;
          rt.index = index;
        }
      });
    }
  }, [cars, carGroupsRef]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 30);
    const lotNow = lotRef.current;
    const onArriveNow = onArriveRef.current;

    // Step every active car's driving logic in one tight loop, reusing the
    // same scratch set across all cars (each car writes to its own group).
    for (const rt of runtimes.current.values()) {
      stepActiveCar(rt, dt, lotNow, onArriveNow);
    }

    // Write instance matrices per size build. Cars of a size are collected
    // in index order so instance i maps to runtime i; the per-part local
    // matrix already carries FORWARD_ROT + scale + the mesh's scene-local
    // transform, so the instance matrix is just translate * Ry * Rz * local
    // (Rz carries the ramp pitch the old group.rotation.z held).
    const { transform, rotationY, rotationZ, color } = scratch;
    // Scratch matrices for wheel composition (allocated once per frame).
    const wScratch = wheelScratch;
    for (const size of SIZES) {
      const build = builds[size];
      const sizeRts: ActiveRuntime[] = [];
      for (const rt of runtimes.current.values()) {
        if (rt.size === size) sizeRts[rt.index] = rt;
      }
      const count = sizeRts.length;
      for (const { mesh, isBody, local } of build.meshes) {
        for (let i = 0; i < count; i++) {
          const rt = sizeRts[i];
          if (!rt) continue;
          const g = rt.group;
          transform.makeTranslation(g.position.x, g.position.y, g.position.z);
          transform.multiply(rotationY.makeRotationY(g.rotation.y));
          transform.multiply(rotationZ.makeRotationZ(g.rotation.z));
          transform.multiply(local);
          mesh.setMatrixAt(i, transform);
          if (isBody) mesh.setColorAt(i, color.set(COLOR_HEX[rt.car.color]));
        }
        mesh.count = count;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }

      // Write wheel instance matrices. Each wheel's matrix is:
      //   translate(carPos) * rotateY(heading) * rotateZ(pitch)
      //   * translate(hubCenter) * rotateY(steer) * rotateZ(-spin)
      // The geometry is already recentered at the hub and has FORWARD_ROT
      // + scale baked in. FORWARD_ROT maps the GLTF axle (X) to Z, so
      // the spin rotates around Z (the lateral axle in car-local space).
      // The steer rotates front wheels around Y (vertical) before the
      // spin. The spin sign is negative to match the player car's
      // `rotation.y -= wheelSpin` convention (forward = clockwise from
      // +Z).
      for (const { mesh, center, steers } of build.wheelMeshes) {
        for (let i = 0; i < count; i++) {
          const rt = sizeRts[i];
          if (!rt) continue;
          const g = rt.group;
          transform.makeTranslation(g.position.x, g.position.y, g.position.z);
          transform.multiply(rotationY.makeRotationY(g.rotation.y));
          transform.multiply(rotationZ.makeRotationZ(g.rotation.z));
          transform.multiply(wScratch.translate.makeTranslation(center.x, center.y, center.z));
          if (steers) {
            transform.multiply(wScratch.steer.makeRotationY(rt.wheelSteer));
          }
          transform.multiply(wScratch.spin.makeRotationZ(-rt.wheelSpin));
          mesh.setMatrixAt(i, transform);
        }
        mesh.count = count;
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  });

  return (
    <group>
      {builds.small.meshes.map(({ mesh }, index) => (
        <primitive key={`active-s${index}`} object={mesh} />
      ))}
      {builds.medium.meshes.map(({ mesh }, index) => (
        <primitive key={`active-m${index}`} object={mesh} />
      ))}
      {builds.large.meshes.map(({ mesh }, index) => (
        <primitive key={`active-l${index}`} object={mesh} />
      ))}
      {builds.small.wheelMeshes.map(({ mesh }, index) => (
        <primitive key={`active-sw${index}`} object={mesh} />
      ))}
      {builds.medium.wheelMeshes.map(({ mesh }, index) => (
        <primitive key={`active-mw${index}`} object={mesh} />
      ))}
      {builds.large.wheelMeshes.map(({ mesh }, index) => (
        <primitive key={`active-lw${index}`} object={mesh} />
      ))}
    </group>
  );
});
