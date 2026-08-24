import { useMemo, useRef, type ReactNode } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
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
import { runtime } from "./runtime";
import {
  PIXEL_BUDGET,
  CAMERA_FAR,
  CAMERA_NEAR,
  CAMERA_FOV,
  SHADOW_MAP_SIZE,
} from "./constants";

/**
 * WorldScene — the R3F Canvas for the open world.
 *
 * Performance contract (this file is where the frame budget lives):
 *  - ONE shadow-casting directional light (the sun). The moon is a cheap
 *    shadowless fill light. Two shadow maps doubled the cost for no read.
 *  - No SSAO/N8AO: it cost ~40% of the frame for a subtle contact-darkening
 *    that fog, bloom, and textures already provide.
 *  - No logarithmic depth buffer: near/far 0.5/2000 has plenty of precision.
 *  - The PMREM sky environment is generated once per discrete sky state
 *    (timeOfDay quantized to 1/48) and cached, instead of re-rendering the
 *    env scene twice a second.
 *  - Streetlight light pools are fake (emissive ground decals owned by
 *    StreetFurniture), not real point lights — 9 shadowless point lights
 *    still cost per-pixel across every material in the scene.
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
const SHADOW_FRUSTUM = 90;

/** Time-of-day quantization for the env-map cache (48 steps per day). */
const ENV_TIME_STEPS = 48;

/**
 * DayNightDriver — applies the live day/night state to the scene's lights,
 * fog, background, and renderer exposure every frame. Also:
 *  - Moves the sun to follow the camera so the shadow frustum covers the
 *    area around the player, not just the origin.
 *  - Maintains a cached PMREM environment per quantized sky state so glass
 *    and metal reflect the actual sky without per-second render hitches.
 *  - Publishes timeOfDay to the shared runtime state for the DOM HUD.
 *  - KeyT jumps time forward 6 in-game hours (dawn/noon/dusk/midnight).
 */
function DayNightDriver({ stateRef }: { stateRef: DayNightRef }) {
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const moonRef = useRef<THREE.DirectionalLight>(null);
  const ambientRef = useRef<THREE.AmbientLight>(null);
  const hemiRef = useRef<THREE.HemisphereLight>(null);
  const sunTarget = useMemo(() => new THREE.Object3D(), []);
  const { scene, gl, camera } = useThree();

  // PMREM generator + tiny gradient sky scene for env map rendering.
  const pmrem = useMemo(() => new THREE.PMREMGenerator(gl), [gl]);
  const envScene = useMemo(() => {
    const s = new THREE.Scene();
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

  // Env-map cache keyed by quantized time-of-day. Each entry is a small
  // PMREM cube; 48 of these is a few MB at most.
  const envCache = useRef(new Map<number, THREE.Texture>());
  const lastEnvKey = useRef(-1);

  useMemo(() => {
    scene.add(sunTarget);
    return undefined;
  }, [scene, sunTarget]);

  // KeyT: skip 6 in-game hours. Bound on window (not the keyboard hook) so
  // it works regardless of canvas focus.
  useMemo(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyT" && !e.repeat) {
        stateRef.current.timeOfDay =
          (stateRef.current.timeOfDay + 0.25) % 1;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stateRef]);

  useFrame(() => {
    const s = stateRef.current;
    runtime.timeOfDay = s.timeOfDay;

    // Sun — position relative to the camera so shadows follow the player.
    if (sunRef.current) {
      const camPos = camera.position;
      sunRef.current.position.copy(s.sunPosition).add(camPos);
      sunTarget.position.copy(camPos);
      sunRef.current.target = sunTarget;
      sunRef.current.color.copy(s.sunColor);
      sunRef.current.intensity = s.sunIntensity;
    }

    // Moon — cheap shadowless fill light, opposite the sun. Gives night
    // geometry a cool directional modeling so it isn't flat black.
    if (moonRef.current) {
      const camPos = camera.position;
      moonRef.current.position
        .copy(s.sunPosition)
        .multiplyScalar(-1)
        .add(camPos);
      moonRef.current.target = sunTarget;
      const nightFactor = 1 - THREE.MathUtils.clamp(s.sunIntensity / 3.0, 0, 1);
      moonRef.current.intensity = nightFactor * 0.25;
    }

    // Ambient + hemisphere.
    if (ambientRef.current) {
      ambientRef.current.color.copy(s.ambientColor);
      ambientRef.current.intensity = s.ambientIntensity;
    }
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
    scene.background = null; // SkyDome owns the sky
    gl.toneMappingExposure = s.exposure;

    // Environment map: generate once per quantized sky state, reuse after.
    const envKey = Math.round(s.timeOfDay * ENV_TIME_STEPS) % ENV_TIME_STEPS;
    if (envKey !== lastEnvKey.current) {
      const cached = envCache.current.get(envKey);
      if (cached) {
        scene.environment = cached;
        lastEnvKey.current = envKey;
      } else if (envCache.current.size < ENV_TIME_STEPS + 8) {
        (envScene.mat.uniforms.topColor.value as THREE.Color).copy(s.skyTop);
        (envScene.mat.uniforms.horizonColor.value as THREE.Color).copy(
          s.skyHorizon,
        );
        const rt = pmrem.fromScene(envScene.scene, 0.04);
        envCache.current.set(envKey, rt.texture);
        scene.environment = rt.texture;
        lastEnvKey.current = envKey;
      }
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
        shadow-camera-far={400}
        shadow-camera-left={-SHADOW_FRUSTUM}
        shadow-camera-right={SHADOW_FRUSTUM}
        shadow-camera-top={SHADOW_FRUSTUM}
        shadow-camera-bottom={-SHADOW_FRUSTUM}
        shadow-bias={-0.0002}
        shadow-normalBias={0.04}
      />
      <directionalLight ref={moonRef} color="#a0b8d8" />
      <ambientLight ref={ambientRef} />
      <hemisphereLight ref={hemiRef} />
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
      {/* Post: Bloom carries the whole night identity (windows, neon,
          streetlight pools); Vignette adds focus. No AO — too expensive. */}
      <EffectComposer>
        <Bloom
          intensity={0.9}
          luminanceThreshold={0.55}
          luminanceSmoothing={0.35}
          mipmapBlur
        />
        <Vignette eskil={false} offset={0.25} darkness={0.55} />
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
      shadows
      dpr={dprForViewport()}
      gl={{
        antialias: false, // postprocessing owns the render target anyway
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.0,
        powerPreference: "high-performance",
      }}
      camera={{
        fov: CAMERA_FOV,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
        position: [0, 6, 130],
      }}
    >
      <SceneContents>{children}</SceneContents>
    </Canvas>
  );
}
