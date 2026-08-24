import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useDayNightState } from "./DayNight";

/**
 * A large procedural sky dome. A sphere of radius 800 rendered with BackSide
 * and a custom shader that paints:
 *   - a 3-stop sky gradient (horizon -> mid-sky -> zenith) from day/night state
 *   - a visible sun disk + glow halo that moves with the sun direction
 *   - procedural FBM clouds that drift over time and shift color by time of day
 *   - a moon (opposite the sun) visible at night
 *   - a hashed star field in the upper hemisphere that fades in at night
 *
 * Colors and sun direction are fed from the day/night state every frame so the
 * sky transitions smoothly through dawn, noon, sunset, and night. A uTime
 * uniform advances every frame for cloud drift and star twinkle.
 *
 * The dome is rendered with depthWrite=false, fog=false, and toneMapped=false
 * so it never occludes geometry, never gets fogged, and its colors are used
 * as-is (the tone mapper would otherwise darken the sky).
 */

const SKY_RADIUS = 800;

const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    // Use the local position (before any rotation) as the view direction.
    // The dome is centered on the camera so it never parallax-shifts.
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vDir;

  uniform float uTime;
  uniform vec3 topColor;      // zenith
  uniform vec3 horizonColor;  // horizon
  uniform vec3 sunDir;        // normalized direction to the sun
  uniform vec3 sunColor;      // sun light color (warm near horizon, white at noon)

  /* ---------- hash / noise ---------- */

  float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x),
      mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  // 3-octave fractal brownian motion for cloud shapes.
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * noise2(p);
      p = p * 2.03 + 13.7;
      a *= 0.5;
    }
    return v;
  }

  // 3D hash for deterministic star positions on the dome.
  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = dir.y; // +1 zenith, 0 horizon, -1 nadir

    // How "up" the sun is: 1 when sun is well above horizon, 0 at night.
    float sunUp = smoothstep(-0.06, 0.12, sunDir.y);
    // Sunset factor: peaks when the sun is near the horizon.
    float sunsetFactor = (1.0 - clamp(abs(sunDir.y) * 4.0, 0.0, 1.0)) * sunUp;

    /* ---------- sky gradient: horizon -> mid -> zenith ---------- */
    vec3 midColor = mix(horizonColor, topColor, 0.45);
    float tMid = smoothstep(0.0, 0.22, h);
    float tTop = smoothstep(0.18, 0.75, h);
    vec3 sky = mix(horizonColor, midColor, tMid);
    sky = mix(sky, topColor, tTop);

    /* ---------- sun disk + glow halo ---------- */
    float sunDot = max(dot(dir, sunDir), 0.0);
    // Broad soft halo + tighter inner glow.
    float halo = pow(sunDot, 6.0) * 0.35 + pow(sunDot, 48.0) * 0.9;
    // Sharp circular disk (~2.5 degree radius) so it reads as a real sun.
    float disk = smoothstep(0.9990, 0.9996, sunDot);
    vec3 sunCore = mix(vec3(1.0, 0.92, 0.6), vec3(1.0, 0.98, 0.9), 0.4);
    sky += (sunCore * disk * 2.5 + sunColor * halo * 0.7) * sunUp;

    /* ---------- moon (opposite the sun) ---------- */
    vec3 moonDir = -sunDir;
    float moonDot = max(dot(dir, moonDir), 0.0);
    float moonHalo = pow(moonDot, 32.0) * 0.35;
    float moonDisk = smoothstep(0.9991, 0.9996, moonDot);
    float moonVis = 1.0 - sunUp; // visible only at night
    vec3 moonCol = vec3(0.82, 0.88, 1.0);
    sky += (moonCol * moonDisk * 1.3 + moonCol * moonHalo * 0.5) * moonVis;

    /* ---------- stars (upper hemisphere only) ---------- */
    if (h > 0.0) {
      // Quantize the view direction into cells; each cell may hold one star.
      vec3 sp = floor(dir * 220.0);
      float sh = hash3(sp);
      // Sparse: ~few hundred stars over the upper hemisphere.
      float star = step(0.9978, sh);
      // Twinkle + per-star brightness variation.
      float twinkle = 0.65 + 0.35 * sin(uTime * 2.5 + sh * 100.0);
      float bright = star * twinkle * (0.4 + 0.6 * fract(sh * 53.0));
      // Fade in at night, fade out near the horizon.
      float starFade = (1.0 - sunUp) * smoothstep(0.0, 0.12, h);
      sky += vec3(0.9, 0.95, 1.0) * bright * starFade * 1.6;
    }

    /* ---------- procedural drifting clouds ---------- */
    // Project the view ray onto a flat cloud layer using its xz / elevation.
    float ch = max(h, 0.02);
    vec2 cloudUV = dir.xz / ch;
    cloudUV *= 0.55;
    // Slow drift over time.
    cloudUV += vec2(uTime * 0.004, uTime * 0.0025);
    float cloud = fbm(cloudUV);
    // Coverage ~50%: threshold in the middle of the FBM range.
    cloud = smoothstep(0.46, 0.74, cloud);
    // Fade clouds near the horizon (avoid a hard seam) and near the zenith.
    float cloudMask = smoothstep(0.0, 0.12, h) * (1.0 - smoothstep(0.55, 0.95, h));
    cloud *= cloudMask;

    // Cloud color by time of day: dark at night, white/grey by day,
    // pink/orange near sunrise/sunset.
    vec3 cloudNight = vec3(0.10, 0.11, 0.16);
    vec3 cloudDay = vec3(1.0, 1.0, 1.0);
    vec3 cloudSunset = vec3(1.0, 0.55, 0.38);
    vec3 cloudCol = mix(cloudNight, cloudDay, sunUp);
    cloudCol = mix(cloudCol, cloudSunset, sunsetFactor * 0.75);
    // Subtle self-shading from the FBM value.
    cloudCol *= 0.82 + 0.18 * cloud;

    sky = mix(sky, cloudCol, cloud * 0.85);

    gl_FragColor = vec4(sky, 1.0);
  }
`;

export function SkyDome() {
  const stateRef = useDayNightState();
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const { camera } = useThree();

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      topColor: { value: new THREE.Color("#4a90e0") },
      horizonColor: { value: new THREE.Color("#b8d0f0") },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunColor: { value: new THREE.Color("#fff5e0") },
    }),
    [],
  );

  useFrame((_, delta) => {
    const mat = materialRef.current;
    if (!mat) return;
    const s = stateRef.current;
    mat.uniforms.uTime.value += delta;
    (mat.uniforms.topColor.value as THREE.Color).copy(s.skyTop);
    (mat.uniforms.horizonColor.value as THREE.Color).copy(s.skyHorizon);
    // Sun direction: normalize the world-space sun position.
    (mat.uniforms.sunDir.value as THREE.Vector3)
      .copy(s.sunPosition)
      .normalize();
    (mat.uniforms.sunColor.value as THREE.Color).copy(s.sunColor);
    // Follow the camera so the dome never parallax-shifts.
    if (meshRef.current) {
      meshRef.current.position.copy(camera.position);
    }
  });

  return (
    <mesh ref={meshRef} frustumCulled={false} renderOrder={-1}>
      <sphereGeometry args={[SKY_RADIUS, 64, 32]} />
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        side={THREE.BackSide}
        depthWrite={false}
        fog={false}
        toneMapped={false}
      />
    </mesh>
  );
}
