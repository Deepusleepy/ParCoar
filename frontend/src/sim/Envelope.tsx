import { memo, useEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { FLOOR_HEIGHT, PILLAR_COLOR, WALL_COLOR } from "./constants";

/** Building envelope: site apron, perimeter spandrels, stair/lift core, and
 *  roof parapet. Gives the floating slabs a read-as-finished shell without
 *  obstructing the gameplay view. Every storey's spandrel + cap is merged into
 *  one geometry each, so the whole envelope is 5 draw calls. */

export interface EnvelopeBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/* --- Module-scope materials (live for the app lifetime, never disposed) --- */

const MAT_APRON = new THREE.MeshStandardMaterial({
  color: "#12141a",
  roughness: 0.96,
  metalness: 0,
  envMapIntensity: 0.3,
});
const MAT_SPANDREL = new THREE.MeshStandardMaterial({
  color: WALL_COLOR,
  roughness: 0.92,
  metalness: 0,
  envMapIntensity: 0.3,
});
const MAT_SPANDREL_CAP = new THREE.MeshStandardMaterial({
  color: "#4a4d54",
  roughness: 0.8,
  envMapIntensity: 0.3,
});
const MAT_CORE = new THREE.MeshStandardMaterial({
  color: PILLAR_COLOR,
  roughness: 0.9,
  metalness: 0.1,
  envMapIntensity: 0.3,
});
const MAT_CORE_GLAZING = new THREE.MeshStandardMaterial({
  color: "#0a1622",
  emissive: "#0a1622",
  emissiveIntensity: 0.55,
  roughness: 0.4,
  metalness: 0.2,
  envMapIntensity: 0.3,
});

/** A BoxGeometry translated to (x, y, z). */
function makeBox(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.applyMatrix4(new THREE.Matrix4().setPosition(x, y, z));
  return g;
}

/** Z-range of the west-face spandrel. The west face carries the entry (z=0),
 *  exit (z=51), and the ramp crossings at both ends, so the spandrel only
 *  covers the middle band — leaving both end zones open for gates and ramp. */
const WEST_SPANDREL_Z0 = 4;
const WEST_SPANDREL_Z1 = 47;

export const Envelope = memo(function Envelope({
  bounds,
  floors,
}: {
  bounds: EnvelopeBounds;
  floors: number[];
}) {
  const { apron, spandrel, cap, core, coreGlazing } = useMemo(() => {
    const { minX, maxX, minZ, maxZ } = bounds;
    const w = maxX - minX;
    const d = maxZ - minZ;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const maxFloor = floors[floors.length - 1];

    // --- Site apron: a thick slab sitting just below the floor-0 slab,
    //     extending well past the footprint so the structure rests on a
    //     defined site surface instead of the void. Top at y=-0.52 to clear
    //     the floor slab bottom (-0.5) without z-fighting. ---
    const apronMargin = 12;
    const aw = w + apronMargin * 2;
    const ad = d + apronMargin * 2;
    const acx = cx;
    const acz = cz;
    const apron = makeBox(aw, 1.0, ad, acx, -1.02, acz);

    // --- Perimeter spandrel + cap band per storey. The top storey gets a
    //     taller spandrel that doubles as the roof parapet. The west face is
    //     the open entry/exit/ramp face, so it only gets a middle band. ---
    const spandrelParts: THREE.BufferGeometry[] = [];
    const capParts: THREE.BufferGeometry[] = [];
    for (const f of floors) {
      const y0 = f * FLOOR_HEIGHT;
      const isTop = f === maxFloor;
      const h = isTop ? 2.0 : 1.0; // top storey: spandrel + parapet
      const yMid = y0 + h / 2;
      const capY = y0 + h + 0.075;
      const westLen = WEST_SPANDREL_Z1 - WEST_SPANDREL_Z0;
      const westCz = (WEST_SPANDREL_Z0 + WEST_SPANDREL_Z1) / 2;

      spandrelParts.push(
        makeBox(w, h, 0.3, cx, yMid, minZ + 0.15), // south
        makeBox(w, h, 0.3, cx, yMid, maxZ - 0.15), // north
        makeBox(0.3, h, d, maxX - 0.15, yMid, cz), // east
        makeBox(0.3, h, westLen, minX + 0.15, yMid, westCz), // west middle
      );
      // Lighter cap band, slightly wider so it reads as a precast coping.
      capParts.push(
        makeBox(w, 0.15, 0.36, cx, capY, minZ + 0.15),
        makeBox(w, 0.15, 0.36, cx, capY, maxZ - 0.15),
        makeBox(0.36, 0.15, d, maxX - 0.15, capY, cz),
        makeBox(0.36, 0.15, westLen, minX + 0.15, capY, westCz),
      );
    }
    const spandrel = mergeGeometries(spandrelParts, false) ?? new THREE.BufferGeometry();
    const cap = mergeGeometries(capParts, false) ?? new THREE.BufferGeometry();

    // --- Stair/lift core at the NW corner (clear of the ramp on the west
    //     face and the turn loops on the east face). A full-height solid
    //     volume with a tall glazing strip on its south face so it reads as
    //     a lit stairwell, not a plain block. ---
    const coreSize = 6;
    const coreCx = minX + coreSize / 2;
    const coreCz = maxZ - coreSize / 2;
    const coreH = (maxFloor + 1) * FLOOR_HEIGHT;
    const core = makeBox(coreSize, coreH, coreSize, coreCx, coreH / 2, coreCz);
    // Glazing strip on the south face (faces the building interior, -z).
    const glazeH = coreH - 6;
    const coreGlazing = makeBox(0.12, glazeH, 4, coreCx, glazeH / 2 + 1.5, coreCz - coreSize / 2 + 0.06);

    return { apron, spandrel, cap, core, coreGlazing };
  }, [bounds, floors]);

  useEffect(() => {
    return () => {
      apron.dispose();
      spandrel.dispose();
      cap.dispose();
      core.dispose();
      coreGlazing.dispose();
    };
  }, [apron, spandrel, cap, core, coreGlazing]);

  return (
    <group>
      <mesh geometry={apron} material={MAT_APRON} receiveShadow />
      <mesh geometry={spandrel} material={MAT_SPANDREL} castShadow receiveShadow />
      <mesh geometry={cap} material={MAT_SPANDREL_CAP} />
      <mesh geometry={core} material={MAT_CORE} castShadow receiveShadow />
      <mesh geometry={coreGlazing} material={MAT_CORE_GLAZING} />
    </group>
  );
});
