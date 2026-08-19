import { memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Canvas } from "@react-three/fiber";
import { Billboard, Environment, Html, Text } from "@react-three/drei";
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

/** Device pixel ratio capped so the shaded pixel count stays within budget.
 *  Returns native density for ordinary window sizes and backs off on very
 *  large ones instead of quietly rendering ten-plus megapixels a frame. */
const PIXEL_BUDGET = 4_500_000;
function dprForViewport(): number {
  if (typeof window === "undefined") return 1;
  const native = Math.min(window.devicePixelRatio || 1, 2);
  const area = window.innerWidth * window.innerHeight;
  if (area <= 0) return native;
  return Math.max(1, Math.min(native, Math.sqrt(PIXEL_BUDGET / area)));
}

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
 *  Visible light sources are emissive geometry (free): two InstancedMeshes
 *  per covered floor (a dark housing + an emissive lamp panel), so 4 draw
 *  calls total for ceiling fixtures across the two enclosed storeys.
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

/** A batten-style ceiling fixture: a matte near-black housing whose top is
 *  flush against the slab above (so it reads as mounted, not hovering), with
 *  an emissive lamp panel recessed into its underside only. The lamp is
 *  slightly narrower than the housing so a dark rim shows around the glowing
 *  face, selling the "recessed" read.
 *
 *  The ceiling of storey N is the slab of floor N+1, whose underside sits at
 *  (N+1)*FLOOR_HEIGHT - 0.5. The housing top is placed exactly there (flush
 *  mount — no drop stem needed), so each fixture is visibly attached to the
 *  slab rather than floating.
 *
 *  The top storey has no slab above it, so it gets no fixtures. Hanging them
 *  there anyway left a row of bright bars floating unsupported in the sky,
 *  clearly visible from every outside camera angle. It is an open roof deck;
 *  the directional skylight already lights it.
 *
 *  Two InstancedMeshes per covered floor (housing + lamp) sharing one
 *  geometry and one material each across floors — 4 draw calls total, no
 *  real lights added. */
const HOUSING_HEIGHT = 0.3;
const HOUSING_WIDTH = 0.5;
const HOUSING_TOP_Y = (floor: number) => (floor + 1) * FLOOR_HEIGHT - 0.5;
const HOUSING_CENTER_Y = (floor: number) => HOUSING_TOP_Y(floor) - HOUSING_HEIGHT / 2;
// Lamp sits just inside the housing's underside face, slightly inset in X/Z
// so the dark housing rim frames it.
const LAMP_LENGTH = SEG_LENGTH - 0.4;
const LAMP_WIDTH = 0.34;
const LAMP_THICKNESS = 0.06;
const LAMP_CENTER_Y = (floor: number) => HOUSING_TOP_Y(floor) - HOUSING_HEIGHT + LAMP_THICKNESS / 2;

function CeilingFixtures() {
  const housingRefs = [
    useRef<THREE.InstancedMesh>(null),
    useRef<THREE.InstancedMesh>(null),
  ];
  const lampRefs = [
    useRef<THREE.InstancedMesh>(null),
    useRef<THREE.InstancedMesh>(null),
  ];

  // One shared geometry + material per role, reused across both floors.
  const housingGeometry = useMemo(
    () => new THREE.BoxGeometry(SEG_LENGTH, HOUSING_HEIGHT, HOUSING_WIDTH),
    [],
  );
  const housingMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        // Matte near-black matching the garage palette (CEILING_COLOR).
        color: 0x0a0b0e,
        roughness: 0.9,
        metalness: 0,
      }),
    [],
  );
  const lampGeometry = useMemo(
    () => new THREE.BoxGeometry(LAMP_LENGTH, LAMP_THICKNESS, LAMP_WIDTH),
    [],
  );
  const lampMaterial = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: 0x000000,
        emissive: new THREE.Color(0xfff2e0),
        // Tone mapping re-enabled: with toneMapped:false the emissive was
        // jumping straight to sRGB white and clipping to a flat disc. Keeping
        // toneMapped:true lets ACESFilmic curve the bright value so the lamp
        // reads as bright warm white while retaining shading, and the
        // surrounding ceiling picks up a soft falloff instead of a hard
        // white blob. Intensity tuned high enough to still read as a source.
        emissiveIntensity: 2.6,
        roughness: 1,
        metalness: 0,
        toneMapped: true,
      }),
    [],
  );

  // Write instance matrices once for every floor's two InstancedMeshes. A
  // single effect (rather than one per floor) keeps the hook count stable.
  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    COVERED_FLOORS.forEach((floor, fi) => {
      const housing = housingRefs[fi].current;
      const lamp = lampRefs[fi].current;
      if (!housing || !lamp) return;
      const housingY = HOUSING_CENTER_Y(floor);
      const lampY = LAMP_CENTER_Y(floor);
      let i = 0;
      for (const z of AISLE_Z) {
        for (const ox of SEG_OFFSETS) {
          const x = AISLE_X_CENTER + ox;
          m.makeTranslation(x, housingY, z);
          housing.setMatrixAt(i, m);
          m.makeTranslation(x, lampY, z);
          lamp.setMatrixAt(i, m);
          i += 1;
        }
      }
      housing.instanceMatrix.needsUpdate = true;
      lamp.instanceMatrix.needsUpdate = true;
    });
  }, []);

  return (
    <>
      {COVERED_FLOORS.map((f, fi) => (
        <group key={`fixtures-${f}`}>
          <instancedMesh
            ref={housingRefs[fi]}
            args={[housingGeometry, housingMaterial, INSTANCES_PER_FLOOR]}
            frustumCulled={false}
          />
          <instancedMesh
            ref={lampRefs[fi]}
            args={[lampGeometry, lampMaterial, INSTANCES_PER_FLOOR]}
            frustumCulled={false}
          />
        </group>
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
  // Floor labels are camera-facing billboards, which reads well from outside
  // but puts enormous unforeshortened text across the aisle when the camera is
  // down inside the garage driving a car.
  const inCar = cameraMode === "pov" || cameraMode === "drive" || cameraMode === "follow";

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
      /* Pixel budget rather than a flat cap. A flat 1.5 made everything look
         slightly out of focus; a flat 2 on a large Retina display means well
         over ten million shaded pixels per frame with shadows on, which is
         its own kind of slow. This renders at native density on normal
         windows and steps down only when the window is genuinely huge. */
      dpr={dprForViewport()}
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

      {/* Floor labels, standing at the front edge of each storey.
          These were drei <Html> with distanceFactor, which is DOM scaled by
          camera distance: fine from far away, but flying close blew a single
          label up to fill half the screen. In-world text scales the way
          everything else in the scene does. */}
      {!inCar && FLOORS.map((f) => (
        <Billboard
          key={`flabel${f}`}
          position={[LOT_CENTER_X, f * FLOOR_HEIGHT + 5, LOT_MIN_Z - 4]}
        >
        <Text
          fontSize={2}
          color="#ffffff"
          anchorX="center"
          anchorY="middle"
          letterSpacing={0.18}
          outlineWidth={0.06}
          outlineColor="#000000"
        >
          {`FLOOR ${String.fromCharCode(65 + f)}`}
        </Text>
        </Billboard>
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
