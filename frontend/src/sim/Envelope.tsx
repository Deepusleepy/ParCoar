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
  side: THREE.DoubleSide,
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

/** Openings in the west face, in world Z. The west face carries the entry
 *  (z=0), the exit (z=51) and both ramp crossings, and those need to stay
 *  open — but only those.
 *
 *  The spandrel used to be one band from z=4 to z=47, which left 17 units at
 *  the south end and 11 at the north with no spandrel AND no guardrail: a
 *  bare deck lip over a 15 and a 30 unit drop on the upper storeys. Openings
 *  are now cut to size and everything else on the face is closed. */
const WEST_OPENINGS: Array<[number, number]> = [
  [-5, 5],
  [46, 56],
];

/** Plan footprint of the stair/lift core, so the deck guardrails and the
 *  perimeter columns can avoid building inside it. */
export function coreFootprint(bounds: EnvelopeBounds) {
  const size = CORE_SIZE;
  return {
    minX: bounds.minX,
    maxX: bounds.minX + size,
    minZ: bounds.maxZ - size,
    maxZ: bounds.maxZ,
  };
}

/** Plan size of the stair/lift core (square, at the north-west corner). */
const CORE_SIZE = 6;
/** Height of the top storey's spandrel, which doubles as the roof parapet. */
const TOP_SPANDREL_H = 2.0;
/** How far the core rises above the roof parapet. A lift overrun and a stair
 *  head-house is a few units, not most of a storey: this was a full storey
 *  height, putting a blank 45-unit black tower 12.85 above a 32-unit
 *  building, which dominated the silhouette from every outside angle. */
const CORE_OVERRUN = 3.5;

/** Split a span into the pieces left after removing a set of openings. */
export function spansOutside(
  from: number,
  to: number,
  openings: Array<[number, number]>,
): Array<[number, number]> {
  let pieces: Array<[number, number]> = [[from, to]];
  for (const [a, b] of openings) {
    const next: Array<[number, number]> = [];
    for (const [s, e] of pieces) {
      if (b <= s || a >= e) { next.push([s, e]); continue; }
      if (a > s) next.push([s, a]);
      if (b < e) next.push([b, e]);
    }
    pieces = next;
  }
  return pieces.filter(([s, e]) => e - s > 0.05);
}

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
      const h = isTop ? TOP_SPANDREL_H : 1.0; // top storey: spandrel + parapet
      const yMid = y0 + h / 2;
      const capY = y0 + h + 0.075;

      spandrelParts.push(
        makeBox(w, h, 0.3, cx, yMid, minZ + 0.15), // south
        makeBox(w, h, 0.3, cx, yMid, maxZ - 0.15), // north
        makeBox(0.3, h, d, maxX - 0.15, yMid, cz), // east
      );
      // Lighter cap band, slightly wider so it reads as a precast coping.
      capParts.push(
        makeBox(w, 0.15, 0.36, cx, capY, minZ + 0.15),
        makeBox(w, 0.15, 0.36, cx, capY, maxZ - 0.15),
        makeBox(0.36, 0.15, d, maxX - 0.15, capY, cz),
      );
      // West face: everything except the entry, exit and ramp openings.
      for (const [z0, z1] of spansOutside(minZ, maxZ, WEST_OPENINGS)) {
        const len = z1 - z0;
        const mid = (z0 + z1) / 2;
        spandrelParts.push(makeBox(0.3, h, len, minX + 0.15, yMid, mid));
        capParts.push(makeBox(0.36, 0.15, len, minX + 0.15, capY, mid));
      }
    }
    const spandrel = mergeGeometries(spandrelParts, false) ?? new THREE.BufferGeometry();
    // The core's own coping, added below once its height is known.
    const capBands = capParts;

    // --- Stair/lift core at the NW corner (clear of the ramp on the west
    //     face and the turn loops on the east face). A full-height solid
    //     volume with a tall glazing strip on its south face so it reads as
    //     a lit stairwell, not a plain block. ---
    const coreSize = CORE_SIZE;
    const coreCx = minX + coreSize / 2;
    const coreCz = maxZ - coreSize / 2;
    const coreH = maxFloor * FLOOR_HEIGHT + TOP_SPANDREL_H + CORE_OVERRUN;
    const core = makeBox(coreSize, coreH, coreSize, coreCx, coreH / 2, coreCz);
    // Glazing strip on the south face (faces the building interior, -z).
    const glazeH = coreH - 6;
    // 4-wide pane lying flat against the core's south face (-z). Thin axis
    // is Z (depth 0.12), proud of the face by 0.06 so it sits on the outside
    // of the core rather than buried inside it.
    const coreGlazing = makeBox(4, glazeH, 0.12, coreCx, glazeH / 2 + 1.5, coreCz - coreSize / 2 - 0.06);

    capBands.push(
      makeBox(coreSize + 0.36, 0.18, coreSize + 0.36, coreCx, coreH + 0.09, coreCz),
    );
    const cap = mergeGeometries(capBands, false) ?? new THREE.BufferGeometry();

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
