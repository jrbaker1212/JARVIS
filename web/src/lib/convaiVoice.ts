/**
 * ElevenLabs Conversational AI — primary duplex voice for Nexy.
 * Xbox headset I/O via SDK inputDeviceId / outputDeviceId (concrete ids only).
 */
import { Conversation } from "@elevenlabs/client";
import { nextId, useStore } from "./store";
import { grantXboxMicPermissionForLabels, mic, resolveConvaiXboxDevices } from "./voice";

const IRISH_VOICE_ID = "sgk995upfe3tYLvoGcBN";

let session: Conversation | null = null;
let starting = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastConnectionType: "webrtc" | "websocket" | null = null;
let sawAgentSpeaking = false;
let lastOutputDeviceId: string | null = null;

/** Prime Chromium/Electron playback + pin sink before ElevenLabs opens AudioContext. */
async function unlockConvaiPlayback(sinkId: string): Promise<void> {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctx) {
    const ctx = new Ctx();
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
    await ctx.resume().catch(() => undefined);
    await ctx.close().catch(() => undefined);
  }
  const probe = new Audio(
    "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA",
  );
  probe.volume = 0.05;
  probe.muted = false;
  const anyProbe = probe as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (sinkId && typeof anyProbe.setSinkId === "function") {
    await anyProbe.setSinkId(sinkId).catch(() => undefined);
  }
  await probe.play().catch(() => undefined);
  probe.pause();
  for (const el of document.querySelectorAll("audio")) {
    el.muted = false;
    el.volume = 1;
    void el.play().catch(() => undefined);
  }
}

export function isConvaiActive(): boolean {
  return useStore.getState().voicePipeline !== "legacy";
}

export function convaiSessionLive(): boolean {
  return session != null;
}

function scheduleReconnect(reason: string) {
  if (!isConvaiActive() || !useStore.getState().voiceEnabled) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startConvaiVoice({ reason: "auto-reconnect" });
  }, 2000);
}

type ConvaiStatus = { ready?: boolean; enabled?: boolean; voice_id?: string };

async function pinConvaiOutput(conv: Conversation, sinkId: string): Promise<void> {
  lastOutputDeviceId = sinkId;
  const voiceConv = conv as Conversation & {
    changeOutputDevice?: (cfg: { outputDeviceId: string }) => Promise<void>;
  };
  try {
    if (typeof voiceConv.changeOutputDevice === "function") {
      await voiceConv.changeOutputDevice({ outputDeviceId: sinkId });
      console.log("[ConvAI] changeOutputDevice ok", sinkId.slice(0, 12));
    }
  } catch (e) {
    console.warn("[ConvAI] changeOutputDevice failed", e);
  }
}

function buildSessionCallbacks(sinkId: string) {
  return {
    onConnect: ({ conversationId }: { conversationId: string }) => {
      console.log("[ConvAI] connected", conversationId, "via", lastConnectionType);
      useStore.getState().setConvaiConnected(true);
      useStore.getState().setMicEnabled(true);
      useStore.getState().setMicMode("armed");
      useStore.getState().setMicStatus(`Nexy connected (${lastConnectionType}) — Xbox`);
      useStore.getState().setVoiceProfile({
        name: "ElevenLabs ConvAI · Irish Flash",
        lang: "en-IE",
        tier: "cinematic",
      });
      if (session) void pinConvaiOutput(session, sinkId);
    },
    onDisconnect: () => {
      session = null;
      useStore.getState().setConvaiConnected(false);
      useStore.getState().setMicMode("dormant");
      useStore.getState().setMicStatus("Nexy voice reconnecting…");
      scheduleReconnect("disconnect");
    },
    onError: (message: unknown) => {
      console.error("[ConvAI] error", message);
      useStore.getState().setMicStatus(`ConvAI error: ${String(message).slice(0, 80)}`);
    },
    onModeChange: ({ mode }: { mode: string }) => {
      if (mode === "speaking") {
        sawAgentSpeaking = true;
        useStore.getState().setOrb("speaking");
        useStore.getState().setMicMode("speaking");
        useStore.getState().setMicStatus("Nexy speaking (ConvAI)…");
        if (session && lastOutputDeviceId) void pinConvaiOutput(session, lastOutputDeviceId);
      } else {
        useStore.getState().setOrb("idle");
        useStore.getState().setMicMode("armed");
        useStore.getState().setMicStatus("Nexy listening — Xbox");
      }
    },
    onMessage: (message: unknown) => {
      const text = typeof message === "string" ? message : (message as { message?: string })?.message;
      if (!text || !String(text).trim()) return;
      const role = String((message as { role?: string })?.role || "").toLowerCase();
      const trimmed = String(text).trim();
      useStore.getState().pushChat({
        id: nextId(),
        role: role === "user" ? "user" : "assistant",
        text: trimmed,
        ts: Date.now(),
      });
    },
    onAudio: () => {
      sawAgentSpeaking = true;
    },
  };
}

async function openConvaiSession(
  status: ConvaiStatus,
  xbox: { micId: string; sinkId: string; micLabel?: string; sinkLabel?: string },
  opts?: { reason?: string },
): Promise<Conversation> {
  const overrides = {
    agent: {
      firstMessage: "Nexy online on your Xbox headset. Ryan, can you hear me?",
      language: "en" as const,
    },
    tts: { voiceId: status.voice_id || IRISH_VOICE_ID },
  };
  const device = { inputDeviceId: xbox.micId, outputDeviceId: xbox.sinkId };
  const callbacks = buildSessionCallbacks(xbox.sinkId);

  const tokenResp = await fetch("/api/convai/conversation-token");
  if (!tokenResp.ok) {
    throw new Error(`token HTTP ${tokenResp.status}`);
  }
  const { token } = (await tokenResp.json()) as { token?: string };
  if (!token) throw new Error("missing conversation token");

  const inElectron = Boolean((window as unknown as { jarvis?: unknown }).jarvis);
  console.log("[ConvAI] startSession Xbox in=%s out=%s electron=%s (%s)", xbox.micLabel, xbox.sinkLabel, inElectron, opts?.reason || "user");

  // Electron: WebSocket audio path tends to be more reliable than WebRTC+setSinkId on hidden elements.
  if (inElectron) {
    const urlResp = await fetch("/api/convai/signed-url");
    if (urlResp.ok) {
      const { signed_url: signedUrl } = (await urlResp.json()) as { signed_url?: string };
      if (signedUrl) {
        lastConnectionType = "websocket";
        return Conversation.startSession({
          signedUrl,
          connectionType: "websocket",
          ...device,
          overrides: overrides as never,
          ...callbacks,
        });
      }
    }
  }

  try {
    lastConnectionType = "webrtc";
    return await Conversation.startSession({
      conversationToken: token,
      connectionType: "webrtc",
      ...device,
      overrides: overrides as never,
      ...callbacks,
    });
  } catch (webrtcErr) {
    console.warn("[ConvAI] WebRTC failed — WebSocket fallback", webrtcErr);
  }

  const urlResp = await fetch("/api/convai/signed-url");
  if (!urlResp.ok) throw new Error(`signed-url HTTP ${urlResp.status}`);
  const { signed_url: signedUrl } = (await urlResp.json()) as { signed_url?: string };
  if (!signedUrl) throw new Error("missing signed_url");

  lastConnectionType = "websocket";
  return Conversation.startSession({
    signedUrl,
    connectionType: "websocket",
    ...device,
    overrides: overrides as never,
    ...callbacks,
  });
}

export async function forceConvaiAndStart(opts?: { reason?: string }) {
  useStore.getState().setVoicePipeline("convai");
  useStore.getState().setVoiceEnabled(true);
  useStore.getState().setWakeEnabled(true);
  sawAgentSpeaking = false;
  const ok = await startConvaiVoice(opts);
  if (ok) await new Promise((r) => setTimeout(r, 14000));
  return {
    ok,
    connected: useStore.getState().convaiConnected,
    speaking: sawAgentSpeaking,
    micStatus: useStore.getState().micStatus,
    connectionType: lastConnectionType,
    outputDeviceId: lastOutputDeviceId,
  };
}

export async function startConvaiVoice(opts?: { reason?: string }): Promise<boolean> {
  useStore.getState().setVoicePipeline("convai");
  if (!useStore.getState().voiceEnabled) {
    useStore.getState().setMicStatus("Voice muted in UI");
    return false;
  }
  if (starting || session) return Boolean(session);

  starting = true;
  useStore.getState().setMicStatus("Nexy ConvAI connecting…");

  try {
    const status = (await fetch("/api/convai/status").then((r) => r.json())) as ConvaiStatus & { enabled?: boolean };
    if (status.enabled === false) {
      useStore.getState().setMicStatus("ConvAI disabled in config");
      return false;
    }
    if (!status.ready) await fetch("/api/convai/ensure-agent", { method: "POST" });

    mic.stop();
    await grantXboxMicPermissionForLabels();
    const xbox = await resolveConvaiXboxDevices();
    if (!xbox.micId || !xbox.sinkId) {
      useStore.getState().setMicStatus("Xbox concrete ids missing");
      return false;
    }
    if (xbox.micId === "default" || xbox.sinkId === "default") {
      useStore.getState().setMicStatus("Refusing default pseudo device ids for ConvAI");
      return false;
    }

    await unlockConvaiPlayback(xbox.sinkId);
    session = await openConvaiSession(status, {
      micId: xbox.micId,
      sinkId: xbox.sinkId,
      micLabel: xbox.micLabel,
      sinkLabel: xbox.sinkLabel,
    }, opts);
    await pinConvaiOutput(session, xbox.sinkId);
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
    } catch {
      /* noop */
    }
  }
  useStore.getState().setMicEnabled(false);
  useStore.getState().setMicMode("dormant");
  useStore.getState().setMicStatus("");
}

export async function convaiLiveDiag() {
  const audios = [...document.querySelectorAll("audio")].map((el, i) => ({
    i,
    paused: el.paused,
    muted: el.muted,
    volume: el.volume,
    sinkId: (el as HTMLAudioElement & { sinkId?: string }).sinkId ?? null,
    hasSrcObject: Boolean(el.srcObject),
  }));
  return {
    convaiConnected: useStore.getState().convaiConnected,
    micStatus: useStore.getState().micStatus,
    voicePipeline: useStore.getState().voicePipeline,
    voiceEnabled: useStore.getState().voiceEnabled,
    connectionType: lastConnectionType,
    sawAgentSpeaking,
    sessionLive: convaiSessionLive(),
    audioElements: audios,
  };
}

if (typeof window !== "undefined") {
  const g = globalThis as typeof globalThis & {
    __jarvisConvaiStart?: () => Promise<boolean>;
    __jarvisConvaiStop?: () => Promise<void>;
    __jarvisForceConvaiStart?: () => Promise<unknown>;
    __jarvisConvaiDiag?: () => Promise<unknown>;
  };
  g.__jarvisConvaiStart = () => startConvaiVoice({ reason: "console" });
  g.__jarvisConvaiStop = stopConvaiVoice;
  g.__jarvisForceConvaiStart = () => forceConvaiAndStart({ reason: "console-force" });
  g.__jarvisConvaiDiag = () => convaiLiveDiag();
}
