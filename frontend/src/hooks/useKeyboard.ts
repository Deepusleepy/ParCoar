import { useRef, useEffect } from "react";

/**
 * Tracks which keyboard keys are currently held down.
 * Keys are indexed by `KeyboardEvent.code` (e.g. "KeyW", "KeyA").
 * Returns a stable ref whose `.current` map is mutated in place — read it
 * inside useFrame / event handlers without triggering re-renders.
 */

/** Game-relevant keys whose default browser action (scroll, etc.) we suppress. */
const PREVENT_DEFAULT_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

/** True when a keyboard event originated inside something the user types in.
 *  Swallowing W/A/S/D/Space/arrows unconditionally broke typing app-wide
 *  (search boxes, chat, selects) because these handlers run at window level.
 *  Buttons and the canvas are NOT editable, so driving keeps working after
 *  clicking anything. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

export function useKeyboard() {
  const keys = useRef<Record<string, boolean>>({});

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Let editable elements keep their keystrokes: no tracking, no
      // preventDefault. Keyup below always clears, so a key held while
      // entering an input can never stick down.
      if (isEditableTarget(e.target)) return;
      keys.current[e.code] = true;
      if (PREVENT_DEFAULT_KEYS.has(e.code)) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      keys.current[e.code] = false;
    };
    // Clear all keys on window blur so the car doesn't keep accelerating
    // when the user alt-tabs away while holding a key.
    const blur = () => { keys.current = {}; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  return keys;
}
