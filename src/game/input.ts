export interface InputState {
  held: boolean;
}

/** Single-button input: spacebar or mouse/touch press-and-hold on `target`. */
export function createInput(target: HTMLElement): InputState {
  const state: InputState = { held: false };

  const press = (e: Event) => {
    state.held = true;
    e.preventDefault();
  };
  const release = (e: Event) => {
    state.held = false;
    e.preventDefault();
  };

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.repeat) press(e);
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") release(e);
  });

  target.addEventListener("mousedown", press);
  window.addEventListener("mouseup", release);
  target.addEventListener("touchstart", press, { passive: false });
  window.addEventListener("touchend", release);
  window.addEventListener("touchcancel", release);
  target.addEventListener("contextmenu", (e) => e.preventDefault());

  return state;
}
