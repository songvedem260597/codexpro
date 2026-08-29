export function profileCardBorderState({ connected, working, settling, rendererUnresponsive, networkState, rendererError, connectionInterrupted }) {
  if (!connected || rendererUnresponsive) return "error";
  if (working || settling) return "working";
  if (rendererError || connectionInterrupted) return "error";
  return "idle";
}
