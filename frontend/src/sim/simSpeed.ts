/**
 * Global time scale for everything that moves.
 *
 * This is a plain mutable module value rather than React state on purpose:
 * it is read inside useFrame, sixty times a second, by every car in the
 * scene. Threading it through props or context would re-render the whole car
 * tree every time the slider moved, which is the opposite of what a speed
 * control is for.
 *
 * 0 means paused. Nothing else in the simulation needs to know about pausing:
 * a car with no speed does not arrive, so it never asks for its next
 * instruction, and the whole thing simply stops where it is.
 */
let scale = 1;

export function getSpeedScale(): number {
  return scale;
}

export function setSpeedScale(next: number): void {
  scale = Math.max(0, next);
}
