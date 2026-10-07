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
let lastStartError: string | null = null;
let lastConvaiError: string | null = null;
let lastStartAttemptMs = 0;
let reconnectBackoffMs = 3000;
let sessionEpoch = 0;
let pendingErrorTimer: ReturnType<typeof setTimeout> | null = null;
const USER_START_REASONS = new Set(["armMic", "console-force", "voice-toggle", "settings"]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function formatConvaiError(message: unknown): string {
  if (typeof message === "string") return message;
  if (message && typeof message === "object") {
    const o = message as Record<string, unknown>;
    const parts = [o.message, o.error, o.type, o.code, o.reason].filter(Boolean).map(String);
    if (parts.length) return parts.join(" — ");
    try {
      return JSON.stringify(message);
    } catch {
      return "[object]";
    }
  }
  return String(message);
}

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
    void startConvaiVoice({ reason: `auto-reconnect:${reason}` });
  }, reconnectBackoffMs);
}

type ConvaiStatus = { ready?: boolean; enabled?: boolean; voice_id?: string };

function reportConvaiClient(event: Record<string, unknown>): void {
  void fetch("/api/convai/client-report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  }).catch(() => undefined);
}

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

function buildSessionCallbacks(sinkId: string, epoch: number) {
  return {
    onConnect: ({ conversationId }: { conversationId: string }) => {
      if (epoch !== sessionEpoch) return;
      if (pendingErrorTimer) {
        clearTimeout(pendingErrorTimer);
        pendingErrorTimer = null;
      }
      console.log("[ConvAI] connected", conversationId, "via", lastConnectionType);
      reportConvaiClient({
        event: "connected",
        conversationId,
        connectionType: lastConnectionType,
        micStatus: useStore.getState().micStatus,
        outputDeviceId: lastOutputDeviceId,
      });
      useStore.getState().setConvaiConnected(true);
      useStore.getState().setWakeEnabled(true);
      useStore.getState().setMicEnabled(true);
      useStore.getState().setMicMode("armed");
      useStore.getState().setOrb("listening");
      useStore.getState().setMicStatus(`Nexy connected (${lastConnectionType}) — Xbox`);
      lastConvaiError = null;
      useStore.getState().setVoiceProfile({
        name: "ElevenLabs ConvAI · Irish Flash",
        lang: "en-IE",
        tier: "cinematic",
      });
      reconnectBackoffMs = 3000;
      if (session) void pinConvaiOutput(session, sinkId);
    },
    onDisconnect: () => {
      if (epoch !== sessionEpoch) return;
      session = null;
      useStore.getState().setConvaiConnected(false);
      useStore.getState().setMicEnabled(true);
      useStore.getState().setMicMode("armed");
      useStore.getState().setMicStatus("Nexy voice reconnecting…");
      scheduleReconnect("disconnect");
    },
    onError: (message: unknown) => {
      if (epoch !== sessionEpoch) return;
      const err = formatConvaiError(message);
      lastConvaiError = err;
      console.error("[ConvAI] error", message);
      reportConvaiClient({ event: "error", error: err, raw: message });
      reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, 30_000);
      if (pendingErrorTimer) clearTimeout(pendingErrorTimer);
      pendingErrorTimer = setTimeout(() => {
        pendingErrorTimer = null;
        if (epoch !== sessionEpoch || useStore.getState().convaiConnected) return;
        useStore.getState().setMicStatus(`ConvAI error: ${err.slice(0, 120)}`);
      }, 2800);
    },
    onModeChange: ({ mode }: { mode: string }) => {
      if (epoch !== sessionEpoch) return;
      if (mode === "speaking") {
        sawAgentSpeaking = true;
        reportConvaiClient({ event: "speaking", connectionType: lastConnectionType });
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
        ttsSource: role === "user" ? undefined : "convai",
      });
    },
    onAudio: () => {
      sawAgentSpeaking = true;
    },
  };
}

async function openConvaiSession(
  status: ConvaiStatus,
  xbox: { micId: string; sinkId?: string; micLabel?: string; sinkLabel?: string },
  opts?: { reason?: string },
): Promise<Conversation> {
  // Agent firstMessage/language live on server — overrides here caused ElevenLabs "Server error: Unknown error".
  const overrides = {
    tts: { voiceId: status.voice_id || IRISH_VOICE_ID },
  };
  const sessionOpts: {
    textOnly: false;
    inputDeviceId: string;
    outputDeviceId?: string;
  } = { textOnly: false, inputDeviceId: xbox.micId };
  if (xbox.sinkId && xbox.sinkId !== "default" && xbox.sinkId !== "communications") {
    sessionOpts.outputDeviceId = xbox.sinkId;
  }
  const epoch = sessionEpoch;
  const callbacks = buildSessionCallbacks(sessionOpts.outputDeviceId || xbox.sinkId || "", epoch);

  const tokenResp = await fetch("/api/convai/conversation-token");
  if (!tokenResp.ok) {
    throw new Error(`token HTTP ${tokenResp.status}`);
  }
  const { token } = (await tokenResp.json()) as { token?: string };
  if (!token) throw new Error("missing conversation token");

  console.log(
    "[ConvAI] startSession voice Xbox in=%s out=%s (%s)",
    xbox.micLabel,
    xbox.sinkLabel,
    opts?.reason || "user",
  );

  try {
    lastConnectionType = "webrtc";
    const conv = await Conversation.startSession({
      conversationToken: token,
      connectionType: "webrtc",
      ...sessionOpts,
      overrides: overrides as never,
      ...callbacks,
    });
    const voiceConv = conv as Conversation & { setVolume?: (v: { volume: number }) => void };
    voiceConv.setVolume?.({ volume: 1 });
    return conv;
  } catch (webrtcErr) {
    console.warn("[ConvAI] WebRTC failed — WebSocket fallback", webrtcErr);
  }

  const urlResp = await fetch("/api/convai/signed-url");
  if (!urlResp.ok) throw new Error(`signed-url HTTP ${urlResp.status}`);
  const { signed_url: signedUrl } = (await urlResp.json()) as { signed_url?: string };
  if (!signedUrl) throw new Error("missing signed_url");

  lastConnectionType = "websocket";
  const conv = await Conversation.startSession({
    signedUrl,
    connectionType: "websocket",
    ...sessionOpts,
    overrides: overrides as never,
    ...callbacks,
  });
  const voiceConv = conv as Conversation & { setVolume?: (v: { volume: number }) => void };
  voiceConv.setVolume?.({ volume: 1 });
  return conv;
}

export async function forceConvaiAndStart(opts?: { reason?: string }) {
  useStore.getState().setVoicePipeline("convai");
  useStore.getState().setVoiceEnabled(true);
  useStore.getState().setWakeEnabled(true);
  if (useStore.getState().convaiConnected && session) {
    return {
      ok: true,
      connected: true,
      speaking: sawAgentSpeaking,
      micStatus: useStore.getState().micStatus,
      connectionType: lastConnectionType,
      outputDeviceId: lastOutputDeviceId,
      lastError: lastConvaiError,
    };
  }
  sawAgentSpeaking = false;
  const ok = await startConvaiVoice(opts);
  if (ok && !useStore.getState().convaiConnected) {
    await new Promise((r) => setTimeout(r, 8000));
  }
  return {
    ok,
    connected: useStore.getState().convaiConnected,
    speaking: sawAgentSpeaking,
    micStatus: useStore.getState().micStatus,
    connectionType: lastConnectionType,
    outputDeviceId: lastOutputDeviceId,
    lastError: lastConvaiError,
  };
}

export async function startConvaiVoice(opts?: { reason?: string }): Promise<boolean> {
  useStore.getState().setVoicePipeline("convai");
  if (!useStore.getState().voiceEnabled) {
    useStore.getState().setMicStatus("Voice muted in UI");
    return false;
  }
  if (starting) return useStore.getState().convaiConnected;
  if (session && useStore.getState().convaiConnected) {
    console.log("[ConvAI] already connected — skip start (%s)", opts?.reason || "");
    return true;
  }
  const reason = opts?.reason || "";
  const userInitiated = USER_START_REASONS.has(reason) || reason.startsWith("console");
  const since = Date.now() - lastStartAttemptMs;
  if (!userInitiated && since < 8000) {
    console.log("[ConvAI] debounced start (%s)", reason);
    return useStore.getState().convaiConnected;
  }
  if (session && !useStore.getState().convaiConnected) {
    try {
      await session.endSession();
    } catch {
      /* noop */
    }
    session = null;
    await sleep(450);
  }

  sessionEpoch += 1;
  lastStartAttemptMs = Date.now();
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
    if (!xbox.micId) {
      useStore.getState().setMicStatus("Xbox mic id missing for ConvAI");
      return false;
    }

    await sleep(500);
    if (xbox.sinkId) await unlockConvaiPlayback(xbox.sinkId);
    session = await openConvaiSession(status, {
      micId: xbox.micId,
      sinkId: xbox.sinkId,
      micLabel: xbox.micLabel,
      sinkLabel: xbox.sinkLabel,
    }, opts);
    if (xbox.sinkId) await pinConvaiOutput(session, xbox.sinkId);
    lastStartError = null;
    return true;
  } catch (e) {
    lastStartError = String(e);
    console.error("[ConvAI] start failed", e);
    session = null;
    useStore.getState().setConvaiConnected(false);
    useStore.getState().setMicStatus(`ConvAI start failed: ${String(e).slice(0, 100)}`);
    reportConvaiClient({ event: "start_failed", error: lastStartError });
    scheduleReconnect("start-failed");
    return false;
  } finally {
    starting = false;
  }
}

export async function stopConvaiVoice(): Promise<void> {
  sessionEpoch += 1;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pendingErrorTimer) {
    clearTimeout(pendingErrorTimer);
    pendingErrorTimer = null;
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
    lastStartError,
    lastConvaiError,
    audioElements: audios,
  };
}

export function getLastConvaiError(): string | null {
  return lastConvaiError;
}
