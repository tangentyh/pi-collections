import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Lines scrolled per mouse-wheel notch in fullscreen mode (default is 1). */
const WHEEL_LINES = 5;

/**
 * This directory is a distributable pi package (see package.json): install
 * it with `pi install ./extensions/scroll-speed`, via `pi install
 * git:...`/npm, or by adding it to the "packages" array in settings.json.
 * The repo's install.sh also symlinks extensions/ into
 * ~/.pi/agent/extensions/ for development, where pi auto-discovers each
 * subdirectory's index.ts.
 */

/**
 * The alt-screen renderer (fullscreen mode) owns wheel input and exposes a
 * mutable `wheelScrollLines` field. This is an internal pi-tui field, not a
 * documented setting — it may change in future versions.
 */
interface AltScreenLike {
  wheelScrollLines?: number;
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    // Capture the previously registered editor factory (if any) BEFORE
    // replacing it. Other extensions (e.g. focus-aware-blinking-cursor-and-border.ts) install their
    // own editor component; replacing it here would silently undo their
    // behavior, so delegate to it instead of creating a plain editor.
    const previousFactory = ctx.ui.getEditorComponent();

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      // Only the fullscreen alt-screen has this field; regular mode scrolls
      // via the terminal's own scrollback and is intentionally untouched.
      const altScreen = tui as AltScreenLike;
      if (typeof altScreen.wheelScrollLines === "number") {
        altScreen.wheelScrollLines = WHEEL_LINES;
      }
      // Preserve any previously installed custom editor.
      if (previousFactory) {
        return previousFactory(tui, theme, keybindings);
      }
      // Recreate the standard editor so nothing else changes.
      return new CustomEditor(tui, theme, keybindings);
    });
  });
}
