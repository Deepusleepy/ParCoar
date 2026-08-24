import { useEffect, useState } from "react";
import { WorldScene } from "./WorldScene";
import { SpectatorCamera } from "./SpectatorCamera";
import { WorldCar } from "./car/WorldCar";
import { WorldHUD } from "./WorldHUD";
import { runtime } from "./runtime";

/**
 * WorldApp — entry point for the open-world driving game at /world.
 *
 * Two camera modes, toggled with V:
 *  - drive (default): WorldCar owns the camera (chase cam).
 *  - fly: SpectatorCamera free-fly, for sightseeing and debugging.
 *
 * The HUD polls `runtime` (car position/speed, fly position, time of day)
 * at 10 Hz; nothing here re-renders per frame while driving.
 */
export function WorldApp() {
  const [mode, setMode] = useState(runtime.mode);

  // V toggles drive/fly. Bound here (outside Canvas) so it works without
  // pointer focus on the canvas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyV" && !e.repeat) {
        runtime.mode = runtime.mode === "drive" ? "fly" : "drive";
        setMode(runtime.mode);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden" }}>
      <WorldScene>{mode === "drive" ? <WorldCar /> : <SpectatorCamera />}</WorldScene>
      <WorldHUD mode={mode} />
    </div>
  );
}
