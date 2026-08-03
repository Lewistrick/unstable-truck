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
  // Release is bound to window so a press started on the target still ends even
  // if the finger/cursor lifts elsewhere. But it must be a no-op when nothing
  // is held: otherwise every touchend on the page (tapping the minimap, the
  // nav arrows, buttons) would call preventDefault() and cancel the synthesized
  // click, breaking those controls on touch devices.
  const release = (e: Event) => {
    if (!state.held) return;
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
  window.addEventListener("touchend", release, { passive: false });
  window.addEventListener("touchcancel", release, { passive: false });
  target.addEventListener("contextmenu", (e) => e.preventDefault());

  return state;
}
