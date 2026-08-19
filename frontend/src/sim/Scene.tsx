import { memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Canvas } from "@react-three/fiber";
import { Environment, Html } from "@react-three/drei";
import * as THREE from "three";
import type { CarRosterEntry, NodeSign } from "../types";
import {
  FLOOR_HEIGHT,
  LOT_CENTER_X,
  LOT_CENTER_Z,
  LOT_MAX_Z,
  LOT_MIN_Z,
} from "./constants";
import { ParkingLot } from "./ParkingLot";
import { CameraRig, type CameraMode, type FlyControlsHandle } from "./CameraRig";

/**
 * Imperative handle exposed via `controlsRef`. App.tsx only ever calls
 * `controlsRef.current?.reset()` (the "Reset View" button); Scene.tsx calls
 * `saveState()` once after mount. Both are implemented on the free-fly rig's
 * handle (see CameraRig's `FlyControlsHandle`).
 */
export type OrbitControlsHandle = FlyControlsHandle;

const FLOORS = [0, 1, 2];

/* ------------------------------------------------------------------ *
 *  Lighting tuning
 * ------------------------------------------------------------------ *
 *  The garage is an enclosed concrete shell; the old rig flooded it with
 *  ambient + hemisphere 0.6/0.95 and a 1.4-intensity sun, washing everything
 *  to mid grey. We now keep the shell dark and let a small number of real
 *  lights + emissive ceiling strips carry the contrast.
 *
 *  Real-light inventory (every real light multiplies lit-material shading
 *  cost, so this is kept to a handful):
 *    - 1 directional "skylight", shadow-casting, weak (0.5)
 *    - 2 warm pointLights per floor for floors 0 & 1 (enclosed storeys)
 *    - 1 warm pointLight on floor 2 (open top storey, also lit by skylight)
 *  Total: 1 directional + 5 pointLights = 6 real lights (same count as the
 *  previous rig, which had 3 overhead + 1 fill + sun + rim = 6).
 *
 *  Visible light sources are emissive geometry (free): three InstancedMeshes
 *  of ceiling strip fixtures, one per floor — 3 draw calls total.
 */

/** Shadow frustum half-extents, centred on the lot. The footprint is ~55 wide
 *  x ~63 deep (constants: LOT_MIN_Z=-13, LOT_MAX_Z=64 -> depth 77 with the
 *  padded bounds). The old +/-60 (120x120) massively overshoot; this is
 *  retuned to the current footprint with a small margin. */
const SHADOW_HALF_X = 32;
const SHADOW_HALF_Z = (LOT_MAX_Z - LOT_MIN_Z) / 2 + 2;

/* ------------------------------------------------------------------ *
 *  Ceiling strip fixtures (emissive, instanced — free shading cost)
 * ------------------------------------------------------------------ */

/** Aisle centrelines in world Z (junction y * SCALE; SCALE=1). Aisles run
 *  along X at z = 0, 17, 34, 51 on every floor. */
const AISLE_Z = [0, 17, 34, 51];
/** Aisle X span (junctions run x=2.6..52; pad slightly inward). */
const AISLE_X_MIN = 4;
const AISLE_X_MAX = 50;
const AISLE_X_CENTER = (AISLE_X_MIN + AISLE_X_MAX) / 2;
/** Three fixture segments per aisle, with gaps, so it reads as real strip
 *  lighting rather than one plain bar. */
const SEG_LENGTH = 14;
const SEG_OFFSETS = [-16, 0, 16];
const INSTANCES_PER_FLOOR = AISLE_Z.length * SEG_OFFSETS.length; // 4 * 3 = 12
/** Only storeys with a slab above them get ceiling fixtures. */
const COVERED_FLOORS = FLOORS.slice(0, -1);

/** One InstancedMesh of ceiling strips per COVERED floor, mounted just below
 *  that floor's ceiling slab. The ceiling of storey N is the slab of floor
 *  N+1, whose underside sits at (N+1)*FLOOR_HEIGHT - 0.5; the strips hang 0.2
 *  below that.
 *
 *  The top storey has no slab above it, so it gets no strips. Hanging them
 *  there anyway left a row of bright bars floating unsupported in the sky,
 *  clearly visible from every outside camera angle. It is an open roof deck;
 *  the directional skylight already lights it. */
function CeilingFixtures() {
  const meshRefs = [
    useRef<THREE.InstancedMesh>(null),
    useRef<THREE.InstancedMesh>(null),
  ];

  // One shared box geometry + one emissive material for all floors.
  const geometry = useMemo(() => new THREE.BoxGeometry(SEG_LENGTH, 0.1, 0.32), []);
  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0x000000,
        emissive: new THREE.Color(0xfff2e0),
        emissiveIntensity: 1.5,
        roughness: 1,
        metalness: 0,
        // Read as a bright source rather than being tonemapped back to grey.
        toneMapped: false,
      }),
    [],
  );

  // Write instance matrices once for every floor's InstancedMesh. A single
  // effect (rather than one per floor) keeps the hook count stable.
  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    COVERED_FLOORS.forEach((floor, fi) => {
      const mesh = meshRefs[fi].current;
      if (!mesh) return;
      const ceilY = (floor + 1) * FLOOR_HEIGHT - 0.7;
      let i = 0;
      for (const z of AISLE_Z) {
        for (const ox of SEG_OFFSETS) {
          m.makeTranslation(AISLE_X_CENTER + ox, ceilY, z);
          mesh.setMatrixAt(i, m);
          i += 1;
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
    });
  }, []);

  return (
    <>
      {COVERED_FLOORS.map((f, fi) => (
        <instancedMesh
          key={`fixtures-${f}`}
          ref={meshRefs[fi]}
          args={[geometry, material, INSTANCES_PER_FLOOR]}
          frustumCulled={false}
        />
      ))}
    </>
  );
}

/**
 * Scene sets up the React Three Fiber canvas, camera, lighting, fog and the
 * free-fly camera rig, then renders the parking lot environment. Any cars,
 * signboards or other dynamic content is passed in as `children` by the app
 * layer, so this component stays decoupled from the simulation state.
 *
 * `controlsRef` lets the app reset the camera: pass a ref here and call
 * `controlsRef.current?.reset()` from a button.
 */
export const Scene = memo(function Scene({
  children,
  controlsRef,
  cameraMode = "orbit",
  followCarId = null,
  carGroupsRef,
  nodeSigns,
  carRoster,
}: {
  children: ReactNode;
  controlsRef?: React.Ref<OrbitControlsHandle>;
  cameraMode?: CameraMode;
  followCarId?: string | null;
  carGroupsRef?: React.MutableRefObject<Map<string, THREE.Group>>;
  nodeSigns?: NodeSign[];
  carRoster?: CarRosterEntry[];
}) {
  // Camera framing: the lot spans roughly x[0,45], z[-16,88], y[0,45].
  // We start high and to the front-left for a 3/4 aerial view; the free-fly
  // rig reorients to face the lot centre on mount.
  const cameraPos: [number, number, number] = [42, 78, -58];
  const target: [number, number, number] = [LOT_CENTER_X, (3 * FLOOR_HEIGHT) / 2, LOT_CENTER_Z];

  // Target object for the skylight so its shadow frustum is centred on the
  // lot, not the world origin.
  const lightTarget = useMemo(() => {
    const obj = new THREE.Object3D();
    obj.position.set(LOT_CENTER_X, 0, LOT_CENTER_Z);
    return obj;
  }, []);

  return (
    <Canvas
      /* "percentage" -> THREE.PCFShadowMap. The Canvas default (PCFSoftShadowMap)
         is deprecated in three 0.185 and logs a warning every frame; this
         explicit type stops the spam. */
      shadows="percentage"
      dpr={[1, 1.5]}
      camera={{ position: cameraPos, fov: 45, near: 0.1, far: 500 }}
      gl={{
        antialias: true,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.15,
      }}
      onCreated={({ scene }) => {
        // Very dark blue-gray background (not a pure black void) with subtle
        // depth fog so distant floors fade slightly.
        scene.background = new THREE.Color(0x0a0b0e);
        scene.fog = new THREE.Fog(0x0a0b0e, 200, 500);
        // Keep the city environment for car-paint reflections but cut its
        // ambient lift so it stops flattening the mid tones.
        scene.environmentIntensity = 0.35;
      }}
    >
      {/* Ambient + hemisphere cut hard so the shell reads dark and the real
          lights + emissive strips carry contrast. */}
      <ambientLight intensity={0.15} />
      <hemisphereLight args={["#3a4258", "#05060a", 0.18]} />

      {/* Single shadow-casting directional "skylight" — weak, cool, retuned
          to the lot footprint. Floor slabs are opaque so shadows don't bleed
          between storeys. */}
      <directionalLight
        position={[60, 90, 30]}
        intensity={0.5}
        color="#cfd8ff"
        target={lightTarget}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={10}
        shadow-camera-far={220}
        shadow-camera-left={-SHADOW_HALF_X}
        shadow-camera-right={SHADOW_HALF_X}
        shadow-camera-top={SHADOW_HALF_Z}
        shadow-camera-bottom={-SHADOW_HALF_Z}
        shadow-bias={-0.0005}
      />

      {/* lightTarget must be in the scene graph for the light to use it. */}
      <primitive object={lightTarget} />

      {/* Warm overhead point lights — 2 per enclosed storey (floors 0 & 1),
          1 on the open top storey (floor 2). `distance` is sized to cover the
          footprint (~55 x 63) so the pools reach the corners. */}
      {FLOORS.map((f) => {
        const ceilY = (f + 1) * FLOOR_HEIGHT - 1.0;
        const count = f < 2 ? 2 : 1;
        return Array.from({ length: count }, (_, i) => (
          <pointLight
            key={`oh-${f}-${i}`}
            position={[
              LOT_CENTER_X,
              ceilY,
              LOT_CENTER_Z + (count === 1 ? 0 : (i === 0 ? -16 : 16)),
            ]}
            intensity={190}
            distance={58}
            decay={2}
            color="#fff2e0"
          />
        ));
      })}

      {/* Visible ceiling strip fixtures (emissive, instanced). */}
      <CeilingFixtures />

      {/* Environment map for car-paint clearcoat reflections. Wrapped in
          Suspense because the preset loads asynchronously. */}
      <Suspense fallback={null}>
        <Environment preset="city" background={false} />
      </Suspense>

      {/* Dark ground plane below the garage for grounding/depth. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[LOT_CENTER_X, -3, (LOT_MIN_Z + LOT_MAX_Z) / 2]}
        receiveShadow
      >
        <planeGeometry args={[400, 220]} />
        <meshStandardMaterial color="#08090c" roughness={1} metalness={0} />
      </mesh>

      {/* The parking garage environment. */}
      <ParkingLot nodeSigns={nodeSigns} carRoster={carRoster} />

      {/* Bright, billboarded floor labels on the camera-facing edge of each
          storey. (ParkingLot renders its own small corner labels; these are
          the prominent, always-readable ones.) Html is DOM, so it always
          faces the screen and scales with distance via distanceFactor. */}
      {FLOORS.map((f) => (
        <Html
          key={`flabel${f}`}
          position={[LOT_CENTER_X, f * FLOOR_HEIGHT + 6, LOT_MIN_Z - 2]}
          center
          distanceFactor={100}
          occlude={false}
          zIndexRange={[20, 0]}
        >
          <div
            style={{
              color: "#ffffff",
              fontSize: "16px",
              fontWeight: 800,
              letterSpacing: "0.22em",
              whiteSpace: "nowrap",
              pointerEvents: "none",
              textShadow:
                "0 1px 6px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,0.9)",
            }}
          >
            FLOOR {String.fromCharCode(65 + f)}
          </div>
        </Html>
      ))}

      {/* Dynamic content (cars, signboards, ...) injected by the app. */}
      {children}

      <CameraRig
        controlsRef={controlsRef}
        mode={cameraMode}
        followCarId={followCarId}
        carGroupsRef={carGroupsRef}
        initialTarget={target}
      />

      {/* saveState() is a no-op on the free-fly rig; kept so the call site in
          App/Scene stays valid. */}
      <SaveControlsState controlsRef={controlsRef} />
    </Canvas>
  );
});

/**
 * Calls `saveState()` on the controls handle after mount. On the free-fly rig
 * this is a no-op (there is no saved spherical state to restore), but the
 * call site is kept so `controlsRef` consumers stay valid.
 */
function SaveControlsState({
  controlsRef,
}: {
  controlsRef?: React.Ref<OrbitControlsHandle>;
}) {
  useEffect(() => {
    if (controlsRef && typeof controlsRef === "object") {
      controlsRef.current?.saveState();
    }
  }, [controlsRef]);
  return null;
}

/**
 * Suspense fallback rendered inside the Canvas while GLTF car models load.
 * A simple centered "Loading" overlay on a dark backdrop (no animation, to
 * avoid pegging the GPU on high-refresh displays).
 */
export function SceneLoadingFallback() {
  return (
    <Html fullscreen zIndexRange={[30, 0]}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0b0e",
          color: "#e5e7eb",
          fontSize: "14px",
          fontWeight: 600,
          letterSpacing: "0.14em",
          pointerEvents: "none",
        }}
      >
        LOADING
      </div>
    </Html>
  );
}
