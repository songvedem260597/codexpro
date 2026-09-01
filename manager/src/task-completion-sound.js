export const TASK_COMPLETION_SOUND = Object.freeze({
  startFrequency: 680,
  endFrequency: 420,
  peakGain: 0.028,
  attack: 0.004,
  duration: 0.075,
  closeDelayMs: 180
});

export function playTaskCompletionSound({
  AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
  setTimer = globalThis.setTimeout
} = {}) {
  if (typeof AudioContextClass !== "function" || typeof setTimer !== "function") return false;

  try {
    const context = new AudioContextClass();
    const play = () => {
      const startedAt = context.currentTime;
      const oscillator = context.createOscillator();
      const envelope = context.createGain();

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(TASK_COMPLETION_SOUND.startFrequency, startedAt);
      oscillator.frequency.exponentialRampToValueAtTime(
        TASK_COMPLETION_SOUND.endFrequency,
        startedAt + TASK_COMPLETION_SOUND.duration
      );
      envelope.gain.setValueAtTime(0.0001, startedAt);
      envelope.gain.linearRampToValueAtTime(
        TASK_COMPLETION_SOUND.peakGain,
        startedAt + TASK_COMPLETION_SOUND.attack
      );
      envelope.gain.exponentialRampToValueAtTime(
        0.0001,
        startedAt + TASK_COMPLETION_SOUND.duration
      );
      oscillator.connect(envelope);
      envelope.connect(context.destination);
      oscillator.start(startedAt);
      oscillator.stop(startedAt + TASK_COMPLETION_SOUND.duration);

      setTimer(() => Promise.resolve(context.close?.()).catch(() => {}), TASK_COMPLETION_SOUND.closeDelayMs);
    };

    if (context.state === "suspended" && typeof context.resume === "function") {
      void Promise.resolve(context.resume()).then(play).catch(() => context.close?.());
    } else {
      play();
    }
    return true;
  } catch {
    return false;
  }
}
