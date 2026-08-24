import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useDayNightState } from "./DayNight";
import {
  WORLD_SIZE,
  CITY_GROUND_Z,
  CITY_GROUND_DEPTH,
  CITY_PALETTE,
} from "./constants";
import {
  getAsphaltAlbedo,
  getAsphaltNormal,
  getAsphaltRoughness,
  disposeCityTextures,
} from "./CityTextures";

/**
 * CityGround — the textured asphalt plane under the Shibuya-style city.
 *
 * Replaces the flat-color city ground with a procedurally textured asphalt
 * surface: a CanvasTexture albedo (multi-octave noise + hairline cracks +
 * faded lane markings + oil stains), a matching normal map for crack relief,
 * and a roughness map with smoother oil patches. The texture tiles at ~8m
 * per repeat across the 600×280 plane so the detail density reads correctly
 * from both street level and overhead.
 *
 * The material color lerps between a day asphalt tone and a darkened night
 * tone every frame from the day/night state, so the ground darkens at night
 * without re-baking the texture. The plane receives shadows so building
 * shadows and contact AO read against the surface.
 */

// Day / night asphalt tones. Tint applied via material.color on top of the
// shared albedo texture, so the same texture serves both.
const ASPHALT_DAY = new THREE.Color(CITY_PALETTE.asphalt);
const ASPHALT_NIGHT = new THREE.Color(CITY_PALETTE.asphalt).multiplyScalar(0.18);

// Tile the texture at ~8m per repeat across the plane.
const METERS_PER_TILE = 8;
const REPEAT_X = WORLD_SIZE / METERS_PER_TILE; // 75
const REPEAT_Z = CITY_GROUND_DEPTH / METERS_PER_TILE; // 35

export function CityGround() {
  const stateRef = useDayNightState();
  const matRef = useRef<THREE.MeshStandardMaterial>(null);

  // One plane geometry, reused for the life of the component.
  const geometry = useMemo(
    () => new THREE.PlaneGeometry(WORLD_SIZE, CITY_GROUND_DEPTH, 1, 1),
    [],
  );

  // Procedural textures are cached singletons; clone for this material so we
  // can set repeat independently without affecting any other consumer.
  const textures = useMemo(() => {
    const albedo = getAsphaltAlbedo().clone();
    albedo.needsUpdate = true;
    albedo.repeat.set(REPEAT_X, REPEAT_Z);
    albedo.wrapS = THREE.RepeatWrapping;
    albedo.wrapT = THREE.RepeatWrapping;
    albedo.colorSpace = THREE.SRGBColorSpace;

    const normal = getAsphaltNormal().clone();
    normal.needsUpdate = true;
    normal.repeat.set(REPEAT_X, REPEAT_Z);
    normal.wrapS = THREE.RepeatWrapping;
    normal.wrapT = THREE.RepeatWrapping;
    normal.colorSpace = THREE.NoColorSpace;

    const roughness = getAsphaltRoughness().clone();
    roughness.needsUpdate = true;
    roughness.repeat.set(REPEAT_X, REPEAT_Z);
    roughness.wrapS = THREE.RepeatWrapping;
    roughness.wrapT = THREE.RepeatWrapping;
    roughness.colorSpace = THREE.NoColorSpace;

    return { albedo, normal, roughness };
  }, []);

  // Dispose cloned textures + geometry on unmount.
  useEffect(() => {
    return () => {
      textures.albedo.dispose();
      textures.normal.dispose();
      textures.roughness.dispose();
      geometry.dispose();
      // Drop the shared singleton references too once the ground is gone.
      disposeCityTextures();
    };
  }, [textures, geometry]);

  // Per-frame: shift the asphalt tint with the day/night cycle.
  useFrame(() => {
    const s = stateRef.current;
    // dayFactor: 1 at noon, 0 at night. Derived from sun intensity (0..3).
    const dayFactor = THREE.MathUtils.clamp(s.sunIntensity / 3, 0, 1);
    if (matRef.current) {
      matRef.current.color.copy(ASPHALT_NIGHT).lerp(ASPHALT_DAY, dayFactor);
    }
  });

  return (
    <mesh
      geometry={geometry}
      position={[0, 0, CITY_GROUND_Z]}
      rotation={[-Math.PI / 2, 0, 0]}
      receiveShadow
    >
      <meshStandardMaterial
        ref={matRef}
        map={textures.albedo}
        normalMap={textures.normal}
        roughnessMap={textures.roughness}
        color={CITY_PALETTE.asphalt}
        roughness={0.95}
        metalness={0}
        envMapIntensity={0.25}
      />
    </mesh>
  );
}
