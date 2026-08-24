import { useMemo, useRef, type ReactNode } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { EffectComposer, Bloom, N8AO, Vignette } from "@react-three/postprocessing";
import { useDayNight, DayNightContext, type DayNightRef } from "./DayNight";
import { SkyDome } from "./SkyDome";
import { Ground } from "./Ground";
import { MtFuji } from "./MtFuji";
import { RoadNetwork } from "./RoadNetwork";
import { CityDistrict } from "./CityDistrict";
import { River } from "./River";
import { Town } from "./Town";
import { RaceTrack } from "./RaceTrack";
import { StreetFurniture } from "./StreetFurniture";
import { TrainLoop } from "./TrainLoop";
import {
  PIXEL_BUDGET,
  CAMERA_FAR,
  CAMERA_NEAR,
  CAMERA_FOV,
  SHADOW_MAP_SIZE,
  CITY_NS_ROADS,
  CITY_EW_ROADS,
} from "./constants";
import type { BloomEffect } from "postprocessing";

/**
 * WorldScene — the R3F Canvas for the open world.
 *
 * Sets up the renderer (ACES tone mapping, soft shadow maps, DPR cap, log
 * depth buffer), the camera (far plane 2000), a PMREM environment map
 * generated from the live sky gradient (so glass/metal surfaces reflect the
 * actual sky), post-processing (Bloom for neon glow, N8AO for contact
 * shadows, Vignette for mood), and the day/night driver that updates the
 * directional sun, ambient, hemisphere, fog, and exposure every frame.
 *
 * The shadow frustum follows the camera so shadows are crisp wherever the
 * spectator flies, instead of being pinned to the origin.
 */

/** DPR cap from the pixel budget. */
function dprForViewport(): number {
  if (typeof window === "undefined") return 1;
  const native = Math.min(window.devicePixelRatio || 1, 2);
  const area = window.innerWidth * window.innerHeight;
  if (area <= 0) return native;
  return Math.max(1, Math.min(native, Math.sqrt(PIXEL_BUDGET / area)));
}

/** Shadow frustum half-extent — tight for crisp shadows, follows camera. */
const SHADOW_FRUSTUM = 80;

/**
 * DayNightDriver — applies the live day/night state to the scene's lights,
 * fog, background, and renderer exposure every frame. Also:
 *  - Moves the sun target to follow the camera so the shadow frustum
 *    covers the area around the spectator, not just the origin.
 *  - Generates a PMREM environment map from the sky colors so glass and
 *    metal surfaces reflect the actual sky (fixes the "black glass" bug).
 */
function DayNightDriver({ stateRef }: { stateRef: DayNightRef }) {
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const moonRef = useRef<THREE.DirectionalLight>(null);
  const ambientRef = useRef<THREE.AmbientLight>(null);
  const hemiRef = useRef<THREE.HemisphereLight>(null);
  const sunTarget = useMemo(() => new THREE.Object3D(), []);
  const moonTarget = useMemo(() => new THREE.Object3D(), []);
  const { scene, gl, camera } = useThree();

  // PMREM generator for environment maps from the sky gradient.
  const pmrem = useMemo(() => new THREE.PMREMGenerator(gl), [gl]);
  // Reusable scene for env map rendering.
  const envScene = useMemo(() => {
    const s = new THREE.Scene();
    // A large sphere with a gradient shader for the env map.
    const geo = new THREE.SphereGeometry(100, 16, 8);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color("#4a90e0") },
        horizonColor: { value: new THREE.Color("#b8d0f0") },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vDir;
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        void main() {
          float t = smoothstep(0.0, 0.45, vDir.y);
          gl_FragColor = vec4(mix(horizonColor, topColor, t), 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
    });
    s.add(new THREE.Mesh(geo, mat));
    return { scene: s, mat };
  }, []);

  // Register the sun + moon target objects.
  useMemo(() => {
    scene.add(sunTarget);
    scene.add(moonTarget);
    return undefined;
  }, [scene, sunTarget, moonTarget]);

  // Throttle env map updates (every ~0.5s, not every frame).
  const envUpdateTimer = useRef(0);
  const envMapRef = useRef<THREE.Texture | null>(null);

  useFrame((_, delta) => {
    const s = stateRef.current;

    // Sun (directional light) — position relative to camera for shadow coverage.
    if (sunRef.current) {
      // Place the sun relative to the camera so shadows follow the spectator.
      const camPos = camera.position;
      sunRef.current.position.copy(s.sunPosition).multiplyScalar(200).add(camPos);
      sunTarget.position.copy(camPos);
      sunRef.current.target = sunTarget;
      sunRef.current.color.copy(s.sunColor);
      sunRef.current.intensity = s.sunIntensity;
      // Update shadow camera to follow.
      if (sunRef.current.shadow.camera) {
        const sc = sunRef.current.shadow.camera as THREE.OrthographicCamera;
        sc.left = -SHADOW_FRUSTUM;
        sc.right = SHADOW_FRUSTUM;
        sc.top = SHADOW_FRUSTUM;
        sc.bottom = -SHADOW_FRUSTUM;
        sc.updateProjectionMatrix();
      }
    }

    // Moon (second directional light) — opposite the sun, cool blue-white.
    // Provides subtle directional illumination at night so buildings aren't
    // flat black. Intensity is derived from the sun: 0 in daylight, ~0.3 at
    // full night. Follows the camera target like the sun for even coverage.
    if (moonRef.current) {
      const camPos = camera.position;
      // Moon sits opposite the sun direction.
      const moonDir = s.sunPosition.clone().multiplyScalar(-1).normalize();
      moonRef.current.position.copy(moonDir).multiplyScalar(200).add(camPos);
      moonTarget.position.copy(camPos);
      moonRef.current.target = moonTarget;
      // dayFactor = sunIntensity / 3.0 (see DayNight.updateState).
      const nightFactor = 1 - THREE.MathUtils.clamp(s.sunIntensity / 3.0, 0, 1);
      moonRef.current.intensity = nightFactor * 0.3;
      // Only run the moon's shadow pass at night — saves a shadow render
      // pass during the day when the moon intensity is zero anyway.
      moonRef.current.castShadow = nightFactor > 0.01;
      if (moonRef.current.shadow.camera) {
        const mc = moonRef.current.shadow.camera as THREE.OrthographicCamera;
        mc.left = -SHADOW_FRUSTUM;
        mc.right = SHADOW_FRUSTUM;
        mc.top = SHADOW_FRUSTUM;
        mc.bottom = -SHADOW_FRUSTUM;
        mc.updateProjectionMatrix();
      }
    }

    // Ambient.
    if (ambientRef.current) {
      ambientRef.current.color.copy(s.ambientColor);
      ambientRef.current.intensity = s.ambientIntensity;
    }

    // Hemisphere — tie ground color to actual ground palette.
    if (hemiRef.current) {
      hemiRef.current.color.copy(s.hemiSky);
      hemiRef.current.groundColor.copy(s.hemiGround);
      hemiRef.current.intensity = s.hemiIntensity;
    }

    // Fog.
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.color.copy(s.fogColor);
      scene.fog.near = s.fogNear;
      scene.fog.far = s.fogFar;
    }

    // Background = null (the SkyDome handles the sky).
    scene.background = null;

    // Exposure.
    gl.toneMappingExposure = s.exposure;

    // Update environment map from sky colors (throttled).
    envUpdateTimer.current += delta;
    if (envUpdateTimer.current > 0.5) {
      envUpdateTimer.current = 0;
      (envScene.mat.uniforms.topColor.value as THREE.Color).copy(s.skyTop);
      (envScene.mat.uniforms.horizonColor.value as THREE.Color).copy(s.skyHorizon);
      const newEnv = pmrem.fromScene(envScene.scene, 0.04);
      if (envMapRef.current) envMapRef.current.dispose();
      envMapRef.current = newEnv.texture;
      scene.environment = newEnv.texture;
    }
  });

  return (
    <>
      <directionalLight
        ref={sunRef}
        castShadow
        shadow-mapSize-width={SHADOW_MAP_SIZE}
        shadow-mapSize-height={SHADOW_MAP_SIZE}
        shadow-camera-near={1}
        shadow-camera-far={500}
        shadow-camera-left={-SHADOW_FRUSTUM}
        shadow-camera-right={SHADOW_FRUSTUM}
        shadow-camera-top={SHADOW_FRUSTUM}
        shadow-camera-bottom={-SHADOW_FRUSTUM}
        shadow-bias={-0.0002}
        shadow-normalBias={0.04}
        shadow-radius={4}
      />
      <directionalLight
        ref={moonRef}
        color="#a0b8d8"
        castShadow
        shadow-mapSize-width={SHADOW_MAP_SIZE}
        shadow-mapSize-height={SHADOW_MAP_SIZE}
        shadow-camera-near={1}
        shadow-camera-far={500}
        shadow-camera-left={-SHADOW_FRUSTUM}
        shadow-camera-right={SHADOW_FRUSTUM}
        shadow-camera-top={SHADOW_FRUSTUM}
        shadow-camera-bottom={-SHADOW_FRUSTUM}
        shadow-bias={-0.0002}
        shadow-normalBias={0.04}
        shadow-radius={4}
      />
      <ambientLight ref={ambientRef} />
      <hemisphereLight ref={hemiRef} />
    </>
  );
}

/**
 * StreetlightPools — warm point lights placed at every city road
 * intersection (CITY_NS_ROADS × CITY_EW_ROADS). They only emit at night
 * (driven by streetlightIntensity) and give the ground visible light pools
 * so the player can see where they're driving. One light per intersection
 * keeps the grid evenly lit.
 */
const STREETLIGHT_POOLS: ReadonlyArray<[number, number, number]> = (() => {
  const pools: Array<[number, number, number]> = [];
  for (const x of CITY_NS_ROADS) {
    for (const z of CITY_EW_ROADS) {
      pools.push([x, 8, z]);
    }
  }
  return pools;
})();

function StreetlightPools({ stateRef }: { stateRef: DayNightRef }) {
  const refs = useRef<THREE.PointLight[]>([]);
  useFrame(() => {
    const intensity = stateRef.current.streetlightIntensity;
    for (const l of refs.current) {
      if (l) l.intensity = intensity * 12;
    }
  });
  return (
    <>
      {STREETLIGHT_POOLS.map((pos, i) => (
        <pointLight
          key={i}
          ref={(l) => {
            if (l) refs.current[i] = l;
          }}
          position={pos}
          color="#ffb066"
          distance={20}
          decay={2}
          intensity={0}
        />
      ))}
    </>
  );
}

/**
 * Inner scene contents — rendered inside the Canvas with the day/night
 * context provided.
 */
function SceneContents({ children }: { children: ReactNode }) {
  const stateRef = useDayNight();

  return (
    <DayNightContext.Provider value={stateRef}>
      <DayNightDriver stateRef={stateRef} />
      <StreetlightPools stateRef={stateRef} />
      <SkyDome />
      <Ground />
      <MtFuji />
      <RoadNetwork />
      <CityDistrict />
      <River />
      <Town />
      <RaceTrack />
      <StreetFurniture />
      <TrainLoop />
      {children}
      {/* Post-processing: Bloom for neon glow, N8AO for contact shadows, Vignette for mood */}
      <EffectComposer>
        <N8AO aoRadius={8} intensity={1.5} distanceFalloff={0.5} />
        <Bloom
          intensity={0.8}
          luminanceThreshold={0.6}
          luminanceSmoothing={0.3}
          mipmapBlur
        />
        <Vignette eskil={false} offset={0.2} darkness={0.6} />
      </EffectComposer>
    </DayNightContext.Provider>
  );
}

export interface WorldSceneProps {
  children?: ReactNode;
}

export function WorldScene({ children }: WorldSceneProps) {
  return (
    <Canvas
      shadows="soft"
      dpr={dprForViewport()}
      gl={{
        antialias: true,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.0,
        logarithmicDepthBuffer: true,
      }}
      camera={{
        fov: CAMERA_FOV,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
        position: [0, 50, 150],
      }}
    >
      <SceneContents>{children}</SceneContents>
    </Canvas>
  );
}
