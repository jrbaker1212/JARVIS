/**
 * Before React mount: speak-aloud + ConvAI on (Ryan: Settings TTS off = silent HUD).
 */
import "./convaiGlobals";
import { useStore } from "./store";

const STORE_KEY = "jarvis.store.v1";

function patchPersistedStore(): void {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    if (!parsed.state) return;
    parsed.state.voicePipeline = "convai";
    parsed.state.voiceEnabled = true;
    localStorage.setItem(STORE_KEY, JSON.stringify(parsed));
  } catch {
    /* noop */
  }
}

patchPersistedStore();
useStore.getState().setVoicePipeline("convai");
useStore.getState().setVoiceEnabled(true);

