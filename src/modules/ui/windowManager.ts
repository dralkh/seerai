/**
 * Detached Window Manager for SeerAI
 *
 * Manages the detached floating window state and lifecycle.
 * Allows the sidebar panel to be "popped out" into a standalone window.
 */

// Window state
let detachedWindow: Window | null = null;
let isDetached = false;
let savePositionTimer: ReturnType<typeof setTimeout> | null = null;

// Get config reference from addon
const getConfig = () => addon.data.config;

// Preference keys (using functions since addon might not be ready at module load)
const getPrefDetached = () => `${getConfig().prefsPrefix}.windowDetached`;
const getPrefWindowX = () => `${getConfig().prefsPrefix}.windowX`;
const getPrefWindowY = () => `${getConfig().prefsPrefix}.windowY`;
const getPrefWindowWidth = () => `${getConfig().prefsPrefix}.windowWidth`;
const getPrefWindowHeight = () => `${getConfig().prefsPrefix}.windowHeight`;

// Default window dimensions
const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 700;

export class DetachedWindowManager {
  /**
   * Check if the window is currently detached
   */
  static isDetached(): boolean {
    return isDetached && detachedWindow !== null && !detachedWindow.closed;
  }

  /**
   * Get the detached window instance
   */
  static getWindow(): Window | null {
    return this.isDetached() ? detachedWindow : null;
  }

  /**
   * Initialize from saved preferences
   */
  static initialize(): void {
    try {
      const wasDetached = Zotero.Prefs.get(getPrefDetached(), true) as boolean;
      if (wasDetached) {
        // Auto-detach on startup if it was detached before
        this.detach();
      }
    } catch (e) {
      Zotero.debug(`[seerai] WindowManager init error: ${e}`);
    }
  }

  /**
   * Detach the sidebar into a floating window
   */
  static detach(): void {
    if (this.isDetached()) {
      this.focusWindow();
      return;
    }

    try {
      // Get saved position or use defaults
      const x = (Zotero.Prefs.get(getPrefWindowX(), true) as number) || 100;
      const y = (Zotero.Prefs.get(getPrefWindowY(), true) as number) || 100;
      const width =
        (Zotero.Prefs.get(getPrefWindowWidth(), true) as number) ||
        DEFAULT_WIDTH;
      const height =
        (Zotero.Prefs.get(getPrefWindowHeight(), true) as number) ||
        DEFAULT_HEIGHT;

      // Open the detached window
      const mainWindow = Zotero.getMainWindow();
      const config = getConfig();
      detachedWindow = mainWindow.openDialog(
        `chrome://${config.addonRef}/content/detachedPanel.xhtml`,
        "seerai-detached",
        `chrome,titlebar,resizable,centerscreen,width=${width},height=${height},left=${x},top=${y}`,
        { manager: this },
      );

      if (detachedWindow) {
        isDetached = true;
        Zotero.Prefs.set(getPrefDetached(), true, true);

        // Save position on window move/resize
        detachedWindow.addEventListener("unload", () => {
          this.onWindowClose();
        });

        // Track window position changes. Debounced: a live resize fires
        // continuously and each save does four synchronous pref writes.
        detachedWindow.addEventListener("resize", () => {
          this.scheduleSaveWindowPosition();
        });
        detachedWindow.addEventListener("move", () => {
          this.scheduleSaveWindowPosition();
        });

        Zotero.debug("[seerai] Window detached successfully");

        // Trigger sidebar refresh to show "Open in Window" state
        this.notifySidebarStateChange();
      }
    } catch (e) {
      Zotero.debug(`[seerai] Error detaching window: ${e}`);
      isDetached = false;
      detachedWindow = null;
    }
  }

  /**
   * Attach the window back to sidebar
   */
  static attach(): void {
    if (!this.isDetached()) {
      return;
    }

    this.clearSavePositionTimer();
    this.saveWindowPosition();

    if (detachedWindow && !detachedWindow.closed) {
      detachedWindow.close();
    }

    isDetached = false;
    detachedWindow = null;
    Zotero.Prefs.set(getPrefDetached(), false, true);

    Zotero.debug("[seerai] Window attached back to sidebar");

    // Trigger sidebar refresh
    this.notifySidebarStateChange();
  }

  /**
   * Toggle between detached and attached states
   */
  static toggle(): void {
    if (this.isDetached()) {
      this.attach();
    } else {
      this.detach();
    }
  }

  /**
   * Bring the detached window to foreground
   */
  static focusWindow(): void {
    if (this.isDetached() && detachedWindow) {
      detachedWindow.focus();
    } else {
      // If not detached, detach it
      this.detach();
    }
  }

  /**
   * Handle window close event
   */
  private static onWindowClose(): void {
    this.clearSavePositionTimer();
    this.saveWindowPosition();
    isDetached = false;
    detachedWindow = null;
    Zotero.Prefs.set(getPrefDetached(), false, true);

    // Trigger sidebar refresh
    this.notifySidebarStateChange();
  }

  /**
   * Debounced position save — a live resize/move fires events continuously and
   * each save performs four synchronous pref writes.
   */
  private static scheduleSaveWindowPosition(): void {
    if (savePositionTimer !== null) {
      clearTimeout(savePositionTimer);
    }
    savePositionTimer = setTimeout(() => {
      savePositionTimer = null;
      this.saveWindowPosition();
    }, 250);
  }

  private static clearSavePositionTimer(): void {
    if (savePositionTimer !== null) {
      clearTimeout(savePositionTimer);
      savePositionTimer = null;
    }
  }

  /**
   * Save the current window position to preferences
   */
  private static saveWindowPosition(): void {
    if (detachedWindow && !detachedWindow.closed) {
      try {
        Zotero.Prefs.set(getPrefWindowX(), detachedWindow.screenX, true);
        Zotero.Prefs.set(getPrefWindowY(), detachedWindow.screenY, true);
        Zotero.Prefs.set(getPrefWindowWidth(), detachedWindow.outerWidth, true);
        Zotero.Prefs.set(
          getPrefWindowHeight(),
          detachedWindow.outerHeight,
          true,
        );
      } catch (e) {
        Zotero.debug(`[seerai] Error saving window position: ${e}`);
      }
    }
  }

  /**
   * Notify sidebar to refresh its state
   */
  private static notifySidebarStateChange(): void {
    // Trigger a Zotero item pane refresh to update sidebar
    try {
      const zp = Zotero.getActiveZoteroPane();
      if (zp && zp.itemsView) {
        // Force a re-render of the item pane sections
        const selectedItems = zp.getSelectedItems();
        if (selectedItems.length > 0) {
          // Try to trigger itemsView refresh - use type assertion since Zotero types may be incomplete
          (zp.itemsView as any).refreshAndMaintainSelection?.();
        }
      }
    } catch (e) {
      Zotero.debug(`[seerai] Error notifying sidebar: ${e}`);
    }
  }

  /**
   * Get the container element for rendering the UI
   * Returns either the detached window's container or null
   */
  static getDetachedContainer(): HTMLElement | null {
    if (!this.isDetached() || !detachedWindow) {
      return null;
    }
    return detachedWindow.document?.getElementById(
      "seerai-container",
    ) as HTMLElement | null;
  }

  /**
   * Register the keyboard shortcut for toggle/focus
   */
  static registerShortcut(): void {
    // This will be called from hooks.ts
    ztoolkit.Keyboard.register((ev, keyOptions) => {
      // Ctrl+Shift+S (or Cmd+Shift+S on Mac)
      if (
        keyOptions.keyboard?.equals("control,shift,s") ||
        keyOptions.keyboard?.equals("meta,shift,s")
      ) {
        ev.preventDefault();
        if (this.isDetached()) {
          this.focusWindow();
        } else {
          this.detach();
        }
      }
    });

    Zotero.debug("[seerai] Keyboard shortcut Ctrl+Shift+S registered");
  }
}
