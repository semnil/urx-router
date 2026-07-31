// The macOS application menu's Edit ▸ Undo / Redo.
//
// Those two items are app-owned (src-tauri/src/lib.rs build_menu) because Tauri's
// predefined pair sends the AppKit `undo:` selector, which never reaches the page.
// This is the frontend half: it routes a click into the history, and pushes the items'
// enabled state and labels back out — the menu lives outside the document, so neither
// follows from a re-render the way the toolbar's does.
//
// Everything here is a no-op off the desktop shell, so callers need no platform test.
// Failures are logged rather than surfaced: the menu is a nicety, and a dialog for it
// would interrupt work it is not part of.

import {
  EDIT_MENU_EVENT,
  EDIT_UNDO_ID,
  isTauri,
  listenEvent,
  setEditMenuLabels,
  setEditMenuState,
} from "../core/platform";
import { errorText, onLangChange, t } from "../i18n";
import type { Direction } from "./history";

export interface EditMenuHooks {
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** Run the command, having let a focused text surface claim it first. */
  run: (kind: Direction) => void;
}

export interface EditMenu {
  /** Reflect the current undo / redo depth onto the items. */
  pushState: () => void;
}

export function installEditMenu(hooks: EditMenuHooks): EditMenu {
  const pushState = (): void => {
    if (!isTauri()) return;
    void setEditMenuState(hooks.canUndo(), hooks.canRedo()).catch((err) => {
      console.warn("edit menu state:", errorText(err));
    });
  };
  const pushLabels = (): void => {
    if (!isTauri()) return;
    void setEditMenuLabels(t().appMenu.undo, t().appMenu.redo).catch((err) => {
      console.warn("edit menu labels:", errorText(err));
    });
  };

  if (isTauri()) {
    void listenEvent<string>(EDIT_MENU_EVENT, (id) => hooks.run(id === EDIT_UNDO_ID ? "undo" : "redo"));
  }
  // The menu is built before the frontend loads, so it starts disabled and in English
  // until these first pushes; the language switch reaches it the same way.
  onLangChange(pushLabels);
  pushLabels();
  pushState();
  return { pushState };
}
