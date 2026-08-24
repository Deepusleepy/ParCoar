import { useRef } from "react";
import { WorldScene } from "./WorldScene";
import { SpectatorCamera } from "./SpectatorCamera";
import { WorldHUD } from "./WorldHUD";

/**
 * WorldApp — entry point for the open-world driving game at /world.
 *
 * Renders the WorldScene (R3F Canvas) with the SpectatorCamera inside, plus
 * the WorldHUD overlay (minimap, time, location, controls hint).
 *
 * The HUD reads the camera position via a shared ref so it can display the
 * spectator's location on the minimap without per-frame React re-renders.
 */
export function WorldApp() {
  const cameraPosRef = useRef<{ x: number; y: number; z: number } | null>(null);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden" }}>
      <WorldScene>
        <SpectatorCamera cameraPosRef={cameraPosRef} />
      </WorldScene>

      {/* HUD overlay */}
      <WorldHUD cameraPosRef={cameraPosRef} />
    </div>
  );
}
