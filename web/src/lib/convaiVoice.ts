/**
 * ElevenLabs Conversational AI — primary duplex voice for Nexy.
 * Xbox headset I/O via SDK inputDeviceId / outputDeviceId (concrete ids only).
 */
import { Conversation } from "@elevenlabs/client";
import { nextId, useStore } from "./store";
import { grantXboxMicPermissionForLabels, mic, resolveConvaiXboxDevices } from "./voice";

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
let startInFlight: Promise<boolean> | null = null;
let lastElevenLabsErrorContext: Record<string, unknown> | null = null;
const USER_START_REASONS = new Set(["armMic", "console-force", "voice-toggle", "settings"]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type ConvaiErrorContext = {
  errorType?: string;
  code?: string | number;
  debugMessage?: string;
  details?: unknown;
};

function formatConvaiError(message: unknown, context?: ConvaiErrorContext): string {
  const ctxParts: string[] = [];
  if (context?.errorType) ctxParts.push(`type=${context.errorType}`);
  if (context?.code != null && context.code !== "") ctxParts.push(`code=${context.code}`);
  if (context?.debugMessage) ctxParts.push(String(context.debugMessage));
  if (context?.details != null) {
    try {
      ctxParts.push(typeof context.details === "string" ? context.details : JSON.stringify(context.details));
    } catch {
      ctxParts.push("[details]");
    }
  }

  let base = "";
  if (typeof message === "string") base = message;
  else if (message && typeof message === "object") {
    const o = message as Record<string, unknown>;
    const parts = [o.message, o.error, o.type, o.code, o.reason].filter(Boolean).map(String);
    base = parts.length ? parts.join(" — ") : "";
    if (!base) {
      try {
        base = JSON.stringify(message);
      } catch {
        base = "[object]";
      }
    }
  } else base = String(message);

  if (ctxParts.length) return `${base} (${ctxParts.join("; ")})`;
  return base;
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
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
  if (starting || startInFlight) return;
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
    onError: (message: unknown, context?: ConvaiErrorContext) => {
      if (epoch !== sessionEpoch) return;
      lastElevenLabsErrorContext = context ? { ...context } : null;
      const err = formatConvaiError(message, context);
      lastConvaiError = err;
      console.error("[ConvAI] error", message, context);
      reportConvaiClient({
        event: "error",
        error: err,
        rawMessage: message,
        elevenLabs: context ?? null,
      });
      reconnectBackoffMs = Math.min(reconnectBackoffMs * 2, 30_000);
      if (pendingErrorTimer) clearTimeout(pendingErrorTimer);
      pendingErrorTimer = setTimeout(() => {
        pendingErrorTimer = null;
        if (epoch !== sessionEpoch || useStore.getState().convaiConnected) return;
        useStore.getState().setMicStatus(`ConvAI error: ${err.slice(0, 160)}`);
      }, 2800);
    },
    onDebug: (parsedEvent: unknown) => {
      if (epoch !== sessionEpoch) return;
      const ev = parsedEvent as { type?: string; error_event?: Record<string, unknown> };
      if (ev?.type === "error" && ev.error_event) {
        reportConvaiClient({ event: "debug_error_event", error_event: ev.error_event });
      }
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
  // Voice + language live on the ElevenLabs agent — client overrides caused empty server error events.
  const sessionOpts: {
    textOnly: false;
    inputDeviceId: string;
    outputDeviceId?: string;
    clientTools?: Record<string, (p: any) => Promise<string>>;
  } = { textOnly: false, inputDeviceId: xbox.micId };
  // memlock 2026-10-13: Nexy's only write path (nexey-memory) as ConvAI client tools.
  sessionOpts.clientTools = {
    memory_write: async (p: any) => {
      const r = await fetch("/api/nexey-memory/write", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: p?.content, kind: p?.kind, filename: p?.filename }) });
      const j = await r.json().catch(() => ({}));
      return r.ok ? `saved to nexey-memory/${j.file}` : `refused: ${j.error || r.status}`;
    },
    memory_read: async (p: any) => {
      const q = p?.filename ? `?filename=${encodeURIComponent(p.filename)}` : "";
      const j = await (await fetch(`/api/nexey-memory/read${q}`)).json().catch(() => ({}));
      return j.ok ? (j.text || "(empty)") : `refused: ${j.error}`;
    },
    memory_list: async () => {
      const j = await (await fetch("/api/nexey-memory/list")).json().catch(() => ({}));
      return (j.files || []).map((f: any) => f.file).join("\n") || "(no entries yet)";
    },
  };
  if (xbox.sinkId && xbox.sinkId !== "default" && xbox.sinkId !== "communications") {
    sessionOpts.outputDeviceId = xbox.sinkId;
  }
  const epoch = sessionEpoch;
  const callbacks = buildSessionCallbacks(sessionOpts.outputDeviceId || xbox.sinkId || "", epoch);

  const tokenResp = await fetch("/api/convai/conversation-token");
  const tokenStatus = tokenResp.status;
  if (!tokenResp.ok) {
    const body = await tokenResp.text().catch(() => "");
    throw new Error(`ElevenLabs token proxy HTTP ${tokenStatus}: ${body.slice(0, 200)}`);
  }
  const { token } = (await tokenResp.json()) as { token?: string };
  if (!token) throw new Error(`ElevenLabs token proxy HTTP ${tokenStatus}: missing token field`);

  reportConvaiClient({
    event: "token_ok",
    httpStatus: tokenStatus,
    tokenLen: token.length,
    reason: opts?.reason,
  });

  console.log(
    "[ConvAI] startSession voice Xbox in=%s out=%s tokenHTTP=%s (%s)",
    xbox.micLabel,
    xbox.sinkLabel,
    tokenStatus,
    opts?.reason || "user",
  );

  try {
    lastConnectionType = "webrtc";
    const conv = await Conversation.startSession({
      conversationToken: token,
      connectionType: "webrtc",
      ...sessionOpts,
      ...callbacks,
    });
    const voiceConv = conv as Conversation & { setVolume?: (v: { volume: number }) => void };
    voiceConv.setVolume?.({ volume: 1 });
    return conv;
  } catch (webrtcErr) {
    console.warn("[ConvAI] WebRTC failed — WebSocket fallback", webrtcErr);
  }

  const urlResp = await fetch("/api/convai/signed-url");
  const signedHttp = urlResp.status;
  if (!urlResp.ok) {
    const body = await urlResp.text().catch(() => "");
    throw new Error(`ElevenLabs signed-url proxy HTTP ${signedHttp}: ${body.slice(0, 200)}`);
  }
  const { signed_url: signedUrl } = (await urlResp.json()) as { signed_url?: string };
  if (!signedUrl) throw new Error(`ElevenLabs signed-url proxy HTTP ${signedHttp}: missing signed_url`);

  lastConnectionType = "websocket";
  const conv = await Conversation.startSession({
    signedUrl,
    connectionType: "websocket",
    ...sessionOpts,
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
  if (startInFlight) return startInFlight;
  startInFlight = startConvaiVoiceInner(opts).finally(() => {
    startInFlight = null;
  });
  return startInFlight;
}

async function startConvaiVoiceInner(opts?: { reason?: string }): Promise<boolean> {
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

  clearReconnectTimer();
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
    lastElevenLabsErrorContext,
    audioElements: audios,
  };
}

export function getLastConvaiError(): string | null {
  return lastConvaiError;
}
