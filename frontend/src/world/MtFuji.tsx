import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useDayNightState } from "./DayNight";
import { FUJI_Z, FUJI_HEIGHT, FUJI_WIDTH, FUJI_Y } from "./constants";

/**
 * Mt. Fuji — a camera-facing billboard far to the north.
 *
 * The silhouette is painted ONCE into a canvas texture (concave profile,
 * irregular snow line, snow fingers, base haze alpha), and a small shader
 * tints it per time of day (white snow at noon, pink at sunset, dark at
 * night) and blends the base into the live sky color for atmospheric
 * perspective. The old fully-procedural shader produced a glowing dome with
 * staircase edges — painting the shape up front looks like a mountain.
 *
 * Texture channels: R = slope shading (0.72..1), G = snow mask, A = alpha.
 */

const TEX_W = 1024;
const TEX_H = 512;

function paintFuji(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext("2d")!;

  // Deterministic noise for the ridge and snow line.
  const rand = (seed: number) => {
    const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };

  // Concave height profile: gentle near the peak, steep at the base — the
  // recognizable Fuji silhouette. Slight asymmetry.
  const profile = (u: number) => {
    const asym = 0.018 * Math.sin(u * Math.PI);
    const t = Math.abs(u - 0.5 + asym) * 2; // 0 center → 1 edge
    return Math.pow(Math.max(0, 1 - t), 1.55);
  };

  const img = ctx.createImageData(TEX_W, TEX_H);
  const data = img.data;
  for (let px = 0; px < TEX_W; px++) {
    const u = px / (TEX_W - 1);
    const h = profile(u);
    // Ridge line with fine noise, in texture-Y pixels.
    const ridgeY = TEX_H - h * (TEX_H - 20) - 10;
    // Column-wise snow line: ~38% of the visible height, jagged.
    const snowJag =
      (rand(px) - 0.5) * 14 + (rand(Math.floor(px / 7)) - 0.5) * 22;
    const snowY = ridgeY + h * (TEX_H - 20) * 0.38 + snowJag;
    // Slope shading: right-facing slope lighter (sun from the right).
    const shade =
      0.78 + (u - 0.5 + 0.5) * 0.2 + (rand(Math.floor(px / 13)) - 0.5) * 0.05;

    for (let py = 0; py < TEX_H; py++) {
      const i = (py * TEX_W + px) * 4;
      if (py < ridgeY) {
        data[i + 3] = 0; // sky
        continue;
      }
      // Snow mask: above the jagged snow line, plus fingers reaching below.
      const finger =
        rand(Math.floor(px / 5) * 31 + Math.floor(py / 6)) > 0.93 &&
        py < snowY + 26;
      const snow = py <= snowY || finger ? 1 : 0;
      data[i] = Math.max(0, Math.min(255, shade * 255)); // R shade
      data[i + 1] = snow * 255; // G snow mask
      // Base haze: fade alpha out over the bottom 5% so the mountain
      // melts into the horizon instead of ending in a hard cut.
      const v = py / TEX_H;
      data[i + 3] = v > 0.95 ? Math.max(0, (1 - v) / 0.05) * 255 : 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uMap;
  uniform vec3 uBodyColor;
  uniform vec3 uSnowColor;
  uniform vec3 uSkyColor;

  void main() {
    vec4 t = texture2D(uMap, vUv);
    if (t.a < 0.01) discard;

    vec3 col = mix(uBodyColor * t.r * 1.25, uSnowColor, t.g);

    // Atmospheric haze: blend toward the live sky color near the base.
    float haze = smoothstep(0.55, 0.02, vUv.y);
    col = mix(col, uSkyColor, haze * 0.8);

    gl_FragColor = vec4(col, t.a);
  }
`;

// Color targets for the snow cap through the day.
const SNOW_DAY = new THREE.Color("#f7f6f2");
const SNOW_SUNSET = new THREE.Color("#ff9a6a");
const SNOW_NIGHT = new THREE.Color("#232336");

// Body color base (blue-grey).
const FUJI_BODY = new THREE.Color("#5a6a7c");

export function MtFuji() {
  const stateRef = useDayNightState();
  const { camera } = useThree();
  const groupRef = useRef<THREE.Group>(null);
  const matRef = useRef<THREE.ShaderMaterial>(null);

  const texture = useMemo(() => paintFuji(), []);
  const uniforms = useMemo(
    () => ({
      uMap: { value: texture },
      uBodyColor: { value: FUJI_BODY.clone() },
      uSnowColor: { value: SNOW_DAY.clone() },
      uSkyColor: { value: new THREE.Color("#b8d0f0") },
    }),
    [texture],
  );

  useFrame(() => {
    const s = stateRef.current;
    const mat = matRef.current;
    const grp = groupRef.current;
    if (!mat || !grp) return;

    // Y-billboard: face the camera in the XZ plane only.
    const dx = camera.position.x - grp.position.x;
    const dz = camera.position.z - grp.position.z;
    grp.rotation.y = Math.atan2(dx, dz);

    // Snow cap color: day → sunset → night, driven by sun elevation.
    const elev = Math.sin((s.timeOfDay - 0.25) * Math.PI * 2);
    const sunsetFactor = THREE.MathUtils.clamp(1 - Math.abs(elev) * 3, 0, 1);
    const nightFactor = THREE.MathUtils.clamp(-elev * 2, 0, 1);
    mat.uniforms.uSnowColor.value
      .copy(SNOW_DAY)
      .lerp(SNOW_SUNSET, sunsetFactor)
      .lerp(SNOW_NIGHT, nightFactor);

    // Body darkens at night.
    const dayFactor = THREE.MathUtils.clamp(s.sunIntensity / 3, 0, 1);
    mat.uniforms.uBodyColor.value
      .copy(FUJI_BODY)
      .multiplyScalar(0.35 + dayFactor * 0.65);

    // Haze target = current horizon color.
    (mat.uniforms.uSkyColor.value as THREE.Color).copy(s.skyHorizon);
  });

  return (
    <group ref={groupRef} position={[0, FUJI_Y, FUJI_Z]}>
      <mesh frustumCulled={false}>
        <planeGeometry args={[FUJI_WIDTH, FUJI_HEIGHT]} />
        <shaderMaterial
          ref={matRef}
          uniforms={uniforms}
          vertexShader={vertexShader}
          fragmentShader={fragmentShader}
          transparent
          depthWrite={false}
          fog={false}
          toneMapped
        />
      </mesh>
    </group>
  );
}
