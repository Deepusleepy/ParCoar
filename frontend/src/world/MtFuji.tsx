import { useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useDayNightState } from "./DayNight";
import { FUJI_Z, FUJI_HEIGHT, FUJI_WIDTH, FUJI_Y } from "./constants";

/**
 * Mt. Fuji as a billboard plane far to the north (Z=FUJI_Z). The mountain is
 * drawn in the fragment shader as a symmetric triangle with a snow cap. The
 * billboard rotates around Y only to face the camera, so it stays upright
 * regardless of the camera's pitch.
 *
 * The body color is a hazy blue-grey that blends toward the sky color near
 * the base (atmospheric perspective). The snow cap shifts from off-white at
 * day to pink-orange at sunset to near-black at night.
 */

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  varying vec2 vUv;
  uniform vec3 bodyColor;
  uniform vec3 snowColor;
  uniform vec3 skyColor;

  // Hash for procedural snow edge irregularity.
  float hash(float n) { return fract(sin(n) * 43758.5453); }
  float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    vec2 uv = vUv;
    // Concave mountain profile: power curve makes slopes steep at base,
    // gentle near the peak (like real Fuji). Slight asymmetry for character.
    float asym = 0.02 * sin(uv.x * 3.14159);
    float edge = 1.0 - pow(2.0 * abs(uv.x - 0.5 + asym), 1.5);
    edge = max(edge, 0.0);
    // Discard everything above the silhouette (transparent sky).
    if (uv.y > edge) discard;

    // Snow cap with irregular, undulating snow line.
    float snowLine = edge * 0.55;
    float jaggle1 = (hash(floor(uv.x * 32.0)) - 0.5) * 0.14;
    float jaggle2 = (hash(floor(uv.x * 80.0)) - 0.5) * 0.06;
    bool isSnow = uv.y > snowLine + jaggle1 + jaggle2;

    // Occasional snow fingers below the main snow line.
    if (!isSnow) {
      float finger = hash2(floor(vec2(uv.x * 40.0, uv.y * 20.0)));
      if (finger > 0.92 && uv.y > snowLine - 0.08) isSnow = true;
    }

    vec3 col = isSnow ? snowColor : bodyColor;

    // Atmospheric haze: the mountain is hazed, more so at the base. Kept
    // subtle so the base doesn't glow into a white bloom at the horizon.
    float haze = smoothstep(0.75, 0.0, uv.y); // 1 at base, 0 at 75% up
    col = mix(col, skyColor, haze * 0.55);
    // Even the snow gets a little haze at the base.
    if (isSnow) {
      col = mix(col, skyColor, haze * 0.25);
    }

    // Ridge shading: darker on the left-facing slope, lighter on the right,
    // to give the cone 3D form (simulated sun from the right).
    if (!isSnow) {
      float slope = smoothstep(0.0, 1.0, (uv.x - 0.5) * 2.0);
      col *= 0.75 + slope * 0.35;
    }

    // Fade the very bottom edge to transparent so Fuji blends into the
    // sky/horizon instead of having a hard cardboard cutout edge.
    float baseAlpha = smoothstep(0.0, 0.04, uv.y);

    gl_FragColor = vec4(col, baseAlpha);
  }
`;

// Color targets for the snow cap through the day. Kept off-white/blue-grey
// so the cap doesn't blow out into a white bloom at the horizon.
const SNOW_DAY = new THREE.Color("#bfc1c4");
const SNOW_SUNSET = new THREE.Color("#ff9a6a");
const SNOW_NIGHT = new THREE.Color("#1a1a2a");

// Body color base (dark blue-grey). Haze blends it toward sky at the base.
const FUJI_BODY = new THREE.Color("#4a5666");

export function MtFuji() {
  const stateRef = useDayNightState();
  const { camera } = useThree();
  const groupRef = useRef<THREE.Group>(null);
  const matRef = useRef<THREE.ShaderMaterial>(null);

  const uniforms = useMemo(
    () => ({
      bodyColor: { value: FUJI_BODY.clone() },
      snowColor: { value: SNOW_DAY.clone() },
      skyColor: { value: new THREE.Color("#b8d0f0") },
    }),
    [],
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
    // sunsetFactor peaks near the horizon (elev ~0), nightFactor when below.
    const elev = Math.sin((s.timeOfDay - 0.25) * Math.PI * 2);
    const sunsetFactor = THREE.MathUtils.clamp(1 - Math.abs(elev) * 3, 0, 1);
    const nightFactor = THREE.MathUtils.clamp(-elev * 2, 0, 1);
    (mat.uniforms.snowColor.value as THREE.Color)
      .copy(SNOW_DAY)
      .lerp(SNOW_SUNSET, sunsetFactor)
      .lerp(SNOW_NIGHT, nightFactor);

    // Body color darkens at night.
    const dayFactor = THREE.MathUtils.clamp(s.sunIntensity / 3, 0, 1);
    (mat.uniforms.bodyColor.value as THREE.Color)
      .copy(FUJI_BODY)
      .multiplyScalar(0.3 + dayFactor * 0.7);

    // Sky color for haze blending = current horizon color.
    (mat.uniforms.skyColor.value as THREE.Color).copy(s.skyHorizon);
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
          side={THREE.DoubleSide}
          depthWrite={true}
          transparent
          fog={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}
