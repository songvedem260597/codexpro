export const RETURN_TO_MANAGER_ACCELERATOR = "CommandOrControl+Shift+M";

export function focusManagerWindow(win) {
  if (!win || typeof win.isDestroyed !== "function" || win.isDestroyed()) return false;
  if (typeof win.isMinimized === "function" && win.isMinimized() && typeof win.restore === "function") win.restore();
  if (typeof win.show === "function") win.show();
  if (typeof win.focus === "function") win.focus();
  if (typeof win.moveTop === "function") win.moveTop();
  return true;
}

export function registerReturnToManagerShortcut({ globalShortcut, getWindow, accelerator = RETURN_TO_MANAGER_ACCELERATOR } = {}) {
  if (!globalShortcut || typeof globalShortcut.register !== "function") throw new Error("globalShortcut.register is required");
  if (typeof getWindow !== "function") throw new Error("getWindow is required");

  const handler = () => focusManagerWindow(getWindow());
  const registered = Boolean(globalShortcut.register(accelerator, handler));
  let disposed = false;

  return {
    accelerator,
    registered,
    trigger: handler,
    unregister() {
      if (disposed) return;
      disposed = true;
      if (registered && typeof globalShortcut.unregister === "function") globalShortcut.unregister(accelerator);
    }
  };
}
