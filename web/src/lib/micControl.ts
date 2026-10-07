/**
 * Shared mic arm/disarm used by CommandBar, Widget, Settings, and cold-start
 * wake restore. ConvAI mode uses ElevenLabs duplex; legacy uses local STT/TTS.
 */
import { startConvaiVoice, stopConvaiVoice, isConvaiActive } from "./convaiVoice";
import { mic, unlockHudAudio } from "./voice";
import { useStore, nextId } from "./store";
import { wsClient } from "./ws";

function jarvisWake() {
  try { (window as any).jarvis?.send?.("jarvis:wake"); } catch { /* noop */ }
}

export async function armMic(): Promise<void> {
  if (useStore.getState().voicePipeline === "convai") {
    useStore.getState().setWakeEnabled(true);
    useStore.getState().setVoiceEnabled(true);
    const ok = await startConvaiVoice({ reason: "armMic" });
    if (ok) jarvisWake();
    return;
  }

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
  if (isConvaiActive()) {
    void stopConvaiVoice();
    useStore.getState().setWakeEnabled(false);
    return;
  }
  mic.stop();
  useStore.getState().setWakeEnabled(false);
}
