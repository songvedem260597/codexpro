import { useEffect, useRef, useState } from "react";

export function useFrameCoalescedValue(value, enabled = true, resetKey = "") {
  const [visualValue, setVisualValue] = useState(value);
  const latest = useRef(value);
  const frame = useRef(0);
  const activeKey = useRef(resetKey);
  latest.current = value;

  useEffect(() => {
    const cancel = globalThis.cancelAnimationFrame || globalThis.clearTimeout;
    if (!enabled) {
      if (frame.current) cancel(frame.current);
      frame.current = 0;
      setVisualValue(value);
      return;
    }
    const schedule = globalThis.requestAnimationFrame || ((callback) => globalThis.setTimeout(callback, 16));
    if (!frame.current) {
      frame.current = schedule(() => {
        frame.current = 0;
        setVisualValue(latest.current);
      });
    }
  }, [enabled, resetKey, value]);

  useEffect(() => () => {
    if (!frame.current) return;
    const cancel = globalThis.cancelAnimationFrame || globalThis.clearTimeout;
    cancel(frame.current);
    frame.current = 0;
  }, []);

  if (activeKey.current !== resetKey) {
    activeKey.current = resetKey;
    return value;
  }
  return enabled ? visualValue : value;
}
