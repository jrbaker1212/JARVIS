/**
 * Shared mic arm/disarm used by CommandBar, Widget, Settings, and cold-start
 * wake restore. ConvAI mode uses ElevenLabs duplex; legacy uses local STT/TTS.
 */
import { forceConvaiAndStart, stopConvaiVoice } from "./convaiVoice";
import { mic } from "./voice";
import { useStore } from "./store";

function jarvisWake() {
  try { (window as any).jarvis?.send?.("jarvis:wake"); } catch { /* noop */ }
}

export async function armMic(): Promise<void> {
  useStore.getState().setVoicePipeline("convai");
  mic.stop();
  useStore.getState().setWakeEnabled(true);
  useStore.getState().setVoiceEnabled(true);
  const r = await forceConvaiAndStart({ reason: "armMic" });
  if (r.ok) jarvisWake();
}

export function disarmMic(): void {
  mic.stop();
  void stopConvaiVoice();
  useStore.getState().setWakeEnabled(false);
}
