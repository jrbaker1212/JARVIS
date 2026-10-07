/**
 * ElevenLabs Conversational AI — primary duplex voice for Nexy.
 * Replaces HTMLAudio + /api/tts + local STT for day-to-day talk.
 * Xbox headset I/O via SDK inputDeviceId / outputDeviceId.
 */
import { Conversation } from "@elevenlabs/client";
import { nextId, useStore } from "./store";
import { ensureXboxDevicesResolved } from "./voice";

const IRISH_VOICE_ID = "sgk995upfe3tYLvoGcBN";

let session: Conversation | null = null;
let starting = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function isConvaiActive(): boolean {
  return useStore.getState().voicePipeline === "convai";
}

export function convaiSessionLive(): boolean {
  return session != null;
}

function scheduleReconnect(reason: string) {
  if (!isConvaiActive() || !useStore.getState().voiceEnabled) return;
  if (reconnectTimer) return;
  console.log("[ConvAI] reconnect scheduled:", reason);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startConvaiVoice({ reason: "auto-reconnect" });
  }, 2000);
}

export async function startConvaiVoice(opts?: { reason?: string }): Promise<boolean> {
  if (!isConvaiActive()) return false;
  if (!useStore.getState().voiceEnabled) {
    useStore.getState().setMicStatus("Voice muted");
    return false;
  }
  if (starting) return false;
  if (session) return true;

  starting = true;
  useStore.getState().setMicStatus("Nexy voice connecting…");

  try {
    const statusResp = await fetch("/api/convai/status");
    const status = (await statusResp.json()) as {
      ready?: boolean;
      enabled?: boolean;
      voice_id?: string;
    };
    if (!status.enabled) {
      useStore.getState().setMicStatus("ConvAI disabled in config");
      return false;
    }
    if (!status.ready) {
      await fetch("/api/convai/ensure-agent", { method: "POST" });
    }

    const xbox = await ensureXboxDevicesResolved();
    if (!xbox.micId || !xbox.sinkId) {
      useStore.getState().setMicStatus("Xbox headset not ready for Nexy voice");
      return false;
    }

    const tokenResp = await fetch("/api/convai/conversation-token");
    if (!tokenResp.ok) {
      const err = await tokenResp.json().catch(() => ({}));
      useStore.getState().setMicStatus(`ConvAI token failed: ${(err as { error?: string }).error || tokenResp.status}`);
      return false;
    }
    const { token } = (await tokenResp.json()) as { token?: string };
    if (!token) {
      useStore.getState().setMicStatus("ConvAI token missing");
      return false;
    }

    console.log("[ConvAI] startSession WebRTC Xbox in=%s out=%s (%s)", xbox.micLabel, xbox.sinkLabel, opts?.reason || "user");

    session = await Conversation.startSession({
      conversationToken: token,
      connectionType: "webrtc",
      inputDeviceId: xbox.micId,
      outputDeviceId: xbox.sinkId,
      overrides: {
        agent: {
          firstMessage: "Nexy online. Go ahead, Ryan.",
          language: "en",
        },
        tts: {
          voiceId: status.voice_id || IRISH_VOICE_ID,
        },
      },
      onConnect: ({ conversationId }) => {
        console.log("[ConvAI] connected", conversationId);
        useStore.getState().setConvaiConnected(true);
        useStore.getState().setMicEnabled(true);
        useStore.getState().setMicMode("armed");
        useStore.getState().setMicStatus("Nexy listening (ElevenLabs) — Xbox headset");
        useStore.getState().setVoiceProfile({
          name: "ElevenLabs ConvAI · Irish Flash",
          lang: "en-IE",
          tier: "cinematic",
        });
      },
      onDisconnect: () => {
        console.warn("[ConvAI] disconnected");
        session = null;
        useStore.getState().setConvaiConnected(false);
        useStore.getState().setMicMode("dormant");
        useStore.getState().setMicStatus("Nexy voice reconnecting…");
        scheduleReconnect("disconnect");
      },
      onError: (message) => {
        console.error("[ConvAI] error", message);
        useStore.getState().setMicStatus(`ConvAI error: ${String(message).slice(0, 80)}`);
      },
      onModeChange: ({ mode }) => {
        if (mode === "speaking") {
          useStore.getState().setOrb("speaking");
          useStore.getState().setMicMode("speaking");
          useStore.getState().setMicStatus("Nexy speaking…");
        } else {
          useStore.getState().setOrb("idle");
          useStore.getState().setMicMode("armed");
          useStore.getState().setMicStatus("Nexy listening — Xbox headset");
        }
      },
      onMessage: (message) => {
        const text = typeof message === "string" ? message : (message as { message?: string })?.message;
        if (!text || !String(text).trim()) return;
        const role = String((message as { role?: string })?.role || "").toLowerCase();
        if (role === "user") {
          useStore.getState().pushChat({
            id: nextId(),
            role: "user",
            text: String(text).trim(),
            ts: Date.now(),
          });
        } else {
          useStore.getState().pushChat({
            id: nextId(),
            role: "assistant",
            text: String(text).trim(),
            ts: Date.now(),
          });
        }
      },
    });

    return true;
  } catch (e) {
    console.error("[ConvAI] start failed", e);
    session = null;
    useStore.getState().setConvaiConnected(false);
    useStore.getState().setMicStatus(`ConvAI start failed: ${String(e).slice(0, 100)}`);
    scheduleReconnect("start-failed");
    return false;
  } finally {
    starting = false;
  }
}

export async function stopConvaiVoice(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const s = session;
  session = null;
  useStore.getState().setConvaiConnected(false);
  if (s) {
    try {
      await s.endSession();
    } catch (e) {
      console.warn("[ConvAI] endSession", e);
    }
  }
  useStore.getState().setMicEnabled(false);
  useStore.getState().setMicMode("dormant");
  useStore.getState().setMicStatus("");
}

if (typeof window !== "undefined") {
  (window as unknown as {
    __jarvisConvaiStart?: () => Promise<boolean>;
    __jarvisConvaiStop?: () => Promise<void>;
  }).__jarvisConvaiStart = () => startConvaiVoice({ reason: "console" });
  (window as unknown as { __jarvisConvaiStop?: () => Promise<void> }).__jarvisConvaiStop = stopConvaiVoice;
}
