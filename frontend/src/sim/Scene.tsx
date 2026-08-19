import { memo, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { Canvas } from "@react-three/fiber";
import { Environment, Html } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
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
import { CameraRig, type CameraMode } from "./CameraRig";

/**
 * The three-stdlib OrbitControls instance, exposed so the app layer can
 * call `controls.reset()` from a DOM button outside the Canvas.
 */
export type OrbitControlsHandle = OrbitControlsImpl;

const FLOORS = [0, 1, 2];

/**
 * Scene sets up the React Three Fiber canvas, camera, lighting, fog and
 * orbit controls, then renders the parking lot environment. Any cars,
 * signboards or other dynamic content is passed in as `children` by the
 * app layer, so this component stays decoupled from the simulation state.
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
  // We sit high and to the front-left for a 3/4 aerial view.
  const cameraPos: [number, number, number] = [42, 78, -58];
  const target: [number, number, number] = [LOT_CENTER_X, (3 * FLOOR_HEIGHT) / 2, LOT_CENTER_Z];

  // Target object for the key directional light so its shadow frustum is
  // centered on the lot, not the world origin.
  const lightTarget = useMemo(() => {
    const obj = new THREE.Object3D();
    obj.position.set(LOT_CENTER_X, 0, LOT_CENTER_Z);
    return obj;
  }, []);

  return (
    <Canvas
      shadows
      dpr={[1, 1.5]}
      camera={{ position: cameraPos, fov: 45, near: 0.5, far: 400 }}
      gl={{
        antialias: true,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.15,
      }}
      onCreated={({ scene }) => {
        // Very dark blue-gray background (not a pure black void) with
        // subtle depth fog so distant floors fade slightly.
        scene.background = new THREE.Color(0x0a0b0e);
        scene.fog = new THREE.Fog(0x0a0b0e, 200, 500);
      }}
    >
      {/* Ambient + hemisphere fill lifted so lower floors are never pitch black. */}
      <ambientLight intensity={0.6} />
      <hemisphereLight args={["#5a6172", "#0a0c12", 0.95]} />

      {/* Key "sun" light with real shadows. The shadow camera frustum is
          bounded to the lot footprint to maximize shadow map resolution.
          Floor slabs are opaque (in ParkingLot) so shadows don't bleed
          through floors. */}
      <directionalLight
        position={[70, 110, 40]}
        intensity={1.4}
        target={lightTarget}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={10}
        shadow-camera-far={200}
        shadow-camera-left={-60}
        shadow-camera-right={60}
        shadow-camera-top={60}
        shadow-camera-bottom={-60}
        shadow-bias={-0.0005}
      />
      {/* Cool rim light from the opposite side for shape definition. */}
      <directionalLight position={[-50, 60, -40]} intensity={0.35} color="#9bb8ff" />

      {/* lightTarget must be added to the scene graph for the light to use it. */}
      <primitive object={lightTarget} />

      {/* Warm overhead point lights — one per floor, centered in Z and
          given enough range to cover the full lot depth (z spans -16..86).
          Intensity is doubled vs. the previous two-per-floor setup so total
          illumination is roughly preserved with a quarter of the lights. */}
      {FLOORS.map((f) => (
        <pointLight
          key={`oh-${f}`}
          position={[LOT_CENTER_X, f * FLOOR_HEIGHT + 11, LOT_CENTER_Z]}
          intensity={260}
          distance={120}
          decay={2}
          color="#fff4e6"
        />
      ))}

      {/* A single cool fill light under the first-floor slab to stop the
          ground storey reading as near-black. Upper floors rely on the
          overhead lights above plus ambient/hemisphere fill. */}
      <pointLight
        position={[LOT_CENTER_X, FLOOR_HEIGHT - 2.5, LOT_CENTER_Z]}
        intensity={160}
        distance={100}
        decay={2}
        color="#a8c0e0"
      />

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

      {/* Save the controls' default state after the target prop is applied,
          so reset() restores the lot-center framing, not world origin. */}
      <SaveControlsState controlsRef={controlsRef} />
    </Canvas>
  );
});

/**
 * Saves the OrbitControls default state (position0/target0/zoom0) *after*
 * the `target` prop has been applied, so `reset()` restores the lot-center
 * framing instead of the world origin [0,0,0] captured before target was set.
 *
 * Rendered as a child of <Scene> (inside Canvas) so it runs in the R3F
 * commit phase once the controls instance is mounted.
 */
function SaveControlsState({
  controlsRef,
}: {
  controlsRef?: React.Ref<OrbitControlsHandle>;
}) {
  useEffect(() => {
    // controlsRef is a Ref union (object ref or callback ref); only object
    // refs expose `.current`. Callback refs are no-ops here.
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
