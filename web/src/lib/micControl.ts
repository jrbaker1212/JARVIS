/**
 * Shared mic arm/disarm used by CommandBar, Widget, Settings, and cold-start
 * wake restore. Keeps wake-word + STT path consistent across entry points.
 */
import { mic, unlockHudAudio } from "./voice";
import { useStore, nextId } from "./store";
import { wsClient } from "./ws";

function jarvisWake() {
  try { (window as any).jarvis?.send?.("jarvis:wake"); } catch { /* noop */ }
}

export async function armMic(): Promise<void> {
  if (useStore.getState().micEnabled) {
    useStore.getState().setWakeEnabled(true);
    return;
  }
  useStore.getState().setWakeEnabled(true);
  await unlockHudAudio();
  await mic.start(
    (text, isFinal) => {
      if (isFinal && text.trim()) {
        const trimmed = text.trim();
        useStore.getState().pushChat({
          id: nextId(),
          role: "user",
          text: trimmed,
          ts: Date.now(),
        });
        wsClient.chat(trimmed);
      }
    },
    (phrase) => {
      console.log("wake phrase:", phrase);
      jarvisWake();
    },
  );
}

export function disarmMic(): void {
  mic.stop();
  useStore.getState().setWakeEnabled(false);
}