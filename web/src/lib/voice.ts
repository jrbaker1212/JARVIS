/**
 * Browser-side voice: SpeechSynthesis (TTS) + SpeechRecognition (STT).
 * Works without any backend mic â€” uses the browser microphone if present.
 * Degrades silently if the API is missing.
 */
import { useStore, type VoiceProfile } from "./store";

// --- TTS ---
// HARD RULE: browser SpeechSynthesis (Edge robot voice) is BANNED. Never touch window.speechSynthesis.
const SYNTH: SpeechSynthesis | null = null;

const JARVIS_VOICE_MATCHERS = [
  /microsoft ryan.*(?:online|natural)|ryan.*(?:online|natural)/i,
  /en-GB-Ryan/i,
  /microsoft george/i,
  /google uk english male/i,
  /\bDaniel\b/i,
  /\bOliver\b/i,
  /\bGeorge\b/i,
  /\bArthur\b/i,
  /\bRyan\b/i,
];

const LOWER_CONFIDENCE_VOICES = /female|hazel|susan|sonia|libby|zira|aria|jenny/i;

let cachedVoice: SpeechSynthesisVoice | null = null;
let activeAudio: HTMLAudioElement | null = null;
let activeAudioUrl: string | null = null;

// â”€â”€ Streaming TTS queue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Sentences are detected as they stream in. Each sentence is fetched
// independently from /api/tts and queued. Audio plays in order so the
// listener hears JARVIS in real time, not after the full text finishes.
//
// HARD GUARANTEE â€” only ONE audio source plays at a time:
//   â€¢ single shared HTMLAudioElement `playerAudio` (browser cannot play two
//     clips on one element). All streaming clips run through it serially.
//   â€¢ every queue mutation and every clip start gates on `streamGeneration`.
//     A cancel bumps the generation; any in-flight fetch / scheduled
//     advance from the previous generation drops on sight.
//   â€¢ cancel pauses the player FIRST, then clears the queue, then nukes any
//     legacy speakWithServerTts audio AND browser-SpeechSynthesis voice.
type QueuedClip = { url: string };
const ttsQueue: QueuedClip[] = [];
let ttsPlaying = false;
let activeUrl: string | null = null;
const playerAudio: HTMLAudioElement | null =
  typeof Audio !== "undefined" ? new Audio() : null;
if (playerAudio) {
  playerAudio.preload = "auto";
  playerAudio.volume = 1.0;
  playerAudio.muted = false;
  // Single global listeners â€” re-attaching per clip caused leak + race.
  playerAudio.addEventListener("ended", () => handleClipFinished("ended"));
  playerAudio.addEventListener("error", () => handleClipFinished("error"));
}

/** HARD RULE (Ryan): Xbox Controller headset ONLY for mic + speakers.
 * Strip/refuse fifine, Realtek, NVIDIA, Bluetooth, HDMI/DP monitors, Speakers. */
const XBOX_MIC_RE = /headset\s*microphone\s*\(\s*xbox\s*controller\s*\)|xbox\s*controller/i;
const XBOX_PLAY_RE = /headphones\s*\(\s*xbox\s*controller\s*\)/i;
const BLOCKED_AUDIO_RE = /fifine|realtek|nvidia|bluetooth|ultragear|hdmi|displayport|digital audio|stereo mix|speakers\s*\(/i;

export type XboxAudioDevices = {
  micId?: string;
  sinkId?: string;
  micLabel?: string;
  sinkLabel?: string;
  refused?: string[];
  ok: boolean;
};

let lastXboxAudio: XboxAudioDevices = { ok: false };

const XBOX_AUDIO_CACHE_KEY = "jarvis.xboxAudio.v1";
const FORCED_PLAYBACK_LABEL = "Headphones (Xbox Controller)";
const FORCED_MIC_LABEL = "Headset Microphone (Xbox Controller)";

type XboxAudioCache = { micId?: string; sinkId?: string; savedAt?: number };

let forcedAudioHints: { playback?: string; recording?: string } | null = null;

function loadXboxAudioCache(): XboxAudioCache {
  try {
    const raw = localStorage.getItem(XBOX_AUDIO_CACHE_KEY);
    return raw ? (JSON.parse(raw) as XboxAudioCache) : {};
  } catch {
    return {};
  }
}

function saveXboxAudioCache(micId?: string, sinkId?: string): void {
  if (!micId && !sinkId) return;
  try {
    localStorage.setItem(
      XBOX_AUDIO_CACHE_KEY,
      JSON.stringify({ micId, sinkId, savedAt: Date.now() } satisfies XboxAudioCache),
    );
  } catch {
    /* noop */
  }
}

function deviceAllowed(d: MediaDeviceInfo): boolean {
  if (!d.label) return true;
  return !BLOCKED_AUDIO_RE.test(d.label);
}

function labelMatchesForced(label: string, kind: "audioinput" | "audiooutput"): boolean {
  const target =
    kind === "audioinput"
      ? forcedAudioHints?.recording || FORCED_MIC_LABEL
      : forcedAudioHints?.playback || FORCED_PLAYBACK_LABEL;
  return label.toLowerCase().includes(target.toLowerCase()) || XBOX_PLAY_RE.test(label) || XBOX_MIC_RE.test(label);
}

async function loadForcedAudioHints(): Promise<void> {
  if (forcedAudioHints) return;
  try {
    const resp = await fetch("/api/audio/devices");
    if (resp.ok) {
      const j = (await resp.json()) as { playback?: string; recording?: string };
      forcedAudioHints = { playback: j.playback, recording: j.recording };
    }
  } catch {
    forcedAudioHints = { playback: FORCED_PLAYBACK_LABEL, recording: FORCED_MIC_LABEL };
  }
}

/** Brief Xbox mic open so Chromium exposes output deviceIds (post-reboot). */
async function primeXboxDeviceLabels(): Promise<void> {
  await loadForcedAudioHints();
  const cache = loadXboxAudioCache();
  let micId = cache.micId || lastXboxAudio.micId;
  if (!micId && navigator.mediaDevices?.enumerateDevices) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mic = devices.find(
      (d) =>
        d.kind === "audioinput" &&
        deviceAllowed(d) &&
        (labelMatchesForced(d.label, "audioinput") || XBOX_MIC_RE.test(d.label)),
    );
    micId = mic?.deviceId;
  }
  if (!micId) {
    console.warn("[TTS:audio] prime skipped — no Xbox mic id yet (arm mic once)");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: micId },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    stream.getTracks().forEach((t) => t.stop());
    console.log("[TTS:audio] primed device labels via Xbox mic");
  } catch (e) {
    console.warn("[TTS:audio] prime getUserMedia failed", e);
  }
}

export function getActiveXboxAudio(): XboxAudioDevices {
  return lastXboxAudio;
}

/** Public filtered device list — Xbox only. Never surfaces blocked devices. */
export async function listAllowedAudioDevices(): Promise<{
  inputs: { deviceId: string; label: string }[];
  outputs: { deviceId: string; label: string }[];
}> {
  const empty = { inputs: [] as { deviceId: string; label: string }[], outputs: [] as { deviceId: string; label: string }[] };
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return empty;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices
      .filter((d) => d.kind === "audioinput" && /headset\s*microphone\s*\(\s*xbox\s*controller\s*\)/i.test(d.label) && !BLOCKED_AUDIO_RE.test(d.label))
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
    const outputs = devices
      .filter((d) => d.kind === "audiooutput" && XBOX_PLAY_RE.test(d.label) && !BLOCKED_AUDIO_RE.test(d.label))
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
    return { inputs, outputs };
  } catch {
    return empty;
  }
}

async function resolveXboxAudioDevices(): Promise<XboxAudioDevices> {
  try {
    await loadForcedAudioHints();
    if (!navigator.mediaDevices?.enumerateDevices) {
      lastXboxAudio = { ok: false, refused: ["enumerateDevices unavailable"] };
      return lastXboxAudio;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cache = loadXboxAudioCache();
    const refused = devices
      .filter((d) => (d.kind === "audioinput" || d.kind === "audiooutput") && d.label && BLOCKED_AUDIO_RE.test(d.label))
      .map((d) => `${d.kind}:${d.label}`);

    const pickMic = (): MediaDeviceInfo | undefined =>
      devices.find(
        (d) => d.kind === "audioinput" && /headset\s*microphone\s*\(\s*xbox\s*controller\s*\)/i.test(d.label),
      ) ||
      devices.find(
        (d) => d.kind === "audioinput" && labelMatchesForced(d.label, "audioinput") && deviceAllowed(d),
      ) ||
      devices.find((d) => d.kind === "audioinput" && XBOX_MIC_RE.test(d.label) && deviceAllowed(d)) ||
      (cache.micId
        ? devices.find((d) => d.kind === "audioinput" && d.deviceId === cache.micId && deviceAllowed(d))
        : undefined);

    let mic = pickMic();

    const pickSink = (groupId?: string): MediaDeviceInfo | undefined =>
      devices.find(
        (d) => d.kind === "audiooutput" && XBOX_PLAY_RE.test(d.label) && deviceAllowed(d),
      ) ||
      devices.find(
        (d) => d.kind === "audiooutput" && labelMatchesForced(d.label, "audiooutput") && deviceAllowed(d),
      ) ||
      (groupId
        ? devices.find(
            (d) => d.kind === "audiooutput" && d.groupId === groupId && deviceAllowed(d) && d.deviceId !== "default",
          )
        : undefined) ||
      (cache.sinkId
        ? devices.find((d) => d.kind === "audiooutput" && d.deviceId === cache.sinkId && deviceAllowed(d))
        : undefined);

    let sink = pickSink(mic?.groupId);

    const ok = Boolean(mic?.deviceId && sink?.deviceId);
    lastXboxAudio = {
      micId: mic?.deviceId,
      sinkId: sink?.deviceId,
      micLabel: mic?.label,
      sinkLabel: sink?.label,
      refused,
      ok,
    };
    if (ok) saveXboxAudioCache(mic!.deviceId, sink!.deviceId);
    console.log(
      "[TTS:audio] Xbox pin ok=%s mic=%s sink=%s refused=%d",
      ok,
      mic?.label || "NONE",
      sink?.label || "NONE",
      refused.length,
    );
    if (ok) {
      useStore.getState().setMicStatus(`Xbox: ${sink!.label} / ${mic!.label}`);
    }
    return lastXboxAudio;
  } catch (e) {
    console.warn("[TTS:audio] enumerateDevices failed", e);
    lastXboxAudio = { ok: false, refused: [String(e)] };
    return lastXboxAudio;
  }
}

async function pinPlayerSink(sinkId?: string): Promise<void> {
  if (!playerAudio || !sinkId) return;
  const anyAudio = playerAudio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof anyAudio.setSinkId !== "function") return;
  try {
    await anyAudio.setSinkId(sinkId);
    console.log("[TTS:audio] playerAudio sink pinned");
  } catch (e) {
    console.warn("[TTS:audio] setSinkId failed", e);
  }
}

/** Resolve Xbox output and pin the shared player — must finish before play(). */
async function ensurePlayerSinkPinned(): Promise<boolean> {
  let x = await resolveXboxAudioDevices();
  if (!x.sinkId) {
    await primeXboxDeviceLabels();
    x = await resolveXboxAudioDevices();
  }
  if (!x.sinkId) {
    console.error("[TTS:audio] Xbox headphones not found — refusing default-sink playback");
    return false;
  }
  await pinPlayerSink(x.sinkId);
  return true;
}

const streamState = { id: "", spokenChars: 0 };
let pendingFetches = 0;
let streamGeneration = 0;   // bumped on cancel â€” stale fetches compare this
let activeGeneration = 0;   // the generation that owns the currently-playing clip
const recentSegmentKeys = new Set<string>(); // gen|text dedupe within a burst

function voiceScore(voice: SpeechSynthesisVoice): number {
  const label = `${voice.name} ${voice.lang}`;
  const matcherIndex = JARVIS_VOICE_MATCHERS.findIndex((re) => re.test(label));
  let score = matcherIndex >= 0 ? 120 - matcherIndex * 10 : 0;
  if (/en-GB/i.test(label)) score += 35;
  if (/(?:natural|online|neural)/i.test(label)) score += 25;
  if (LOWER_CONFIDENCE_VOICES.test(label)) score -= 20;
  if (/^en/i.test(voice.lang)) score += 5;
  return score;
}

function voiceTier(voice: SpeechSynthesisVoice | null): VoiceProfile["tier"] {
  if (!voice) return "offline";
  const label = `${voice.name} ${voice.lang}`;
  if (/ryan|george|daniel|oliver|arthur|google uk english male/i.test(label)) return "cinematic";
  if (/en-GB|UK English|British/i.test(label)) return "british";
  return "fallback";
}

function publishVoiceProfile(voice: SpeechSynthesisVoice | null) {
  useStore.getState().setVoiceProfile(
    voice
      ? { name: voice.name, lang: voice.lang, tier: voiceTier(voice) }
      : { name: "No browser TTS voice", lang: "offline", tier: "offline" }
  );
}

function pickVoice(): SpeechSynthesisVoice | null {
  // Never use browser voices — ElevenLabs Irish Flash only.
  useStore.getState().setVoiceProfile({
    name: "ElevenLabs Irish Flash",
    lang: "en-IE",
    tier: "cinematic",
  });
  return null;
}

// speechSynthesis voiceschanged listener removed (Edge ban)

export function refreshVoiceProfile(): void {
  void refreshServerVoiceProfile();
  pickVoice();
}

export function currentVoiceProfile(): VoiceProfile | null {
  const voice = pickVoice();
  return voice ? { name: voice.name, lang: voice.lang, tier: voiceTier(voice) } : null;
}

async function refreshServerVoiceProfile(): Promise<void> {
  try {
    const resp = await fetch("/api/tts/status");
    if (!resp.ok) return;
    const status = await resp.json();
    if (status?.available) {
      useStore.getState().setVoiceProfile({
        name: status.provider === "elevenlabs" ? "ElevenLabs Irish Flash" : (status.label || "ElevenLabs Irish Flash"),
        lang: status.lang || "en-GB",
        tier: "cinematic",
      });
    }
  } catch {
    // browser voices remain the fallback
  }
}

function cleanSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/[*_`#>~]/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .trim();
}

function stopServerAudio() {
  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
  }
  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = null;
  }
}

async function speakWithServerTts(clean: string): Promise<boolean> {
  // Legacy path — route through the single-player queue (no second Audio()).
  speak(clean);
  return true;
}

export function speak(text: string): void {
  // Route ALL one-shot announcements through the streaming queue + single
  // shared HTMLAudioElement. The old path created a second Audio() via
  // speakWithServerTts and fell back to browser SpeechSynthesis (robot voice),
  // which double-played with streamSpeak and switched voices mid-reply.
  if (!useStore.getState().voiceEnabled) {
    console.log("[TTS] voice disabled, skipping");
    return;
  }
  const clean = cleanSpeechText(text);
  if (!clean) return;
  console.log("[TTS] speaking (queued):", clean.slice(0, 80));
  const id = `speak-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  streamSpeak(id, clean, true);
}

// â”€â”€ Streaming TTS API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Called from App.tsx as assistant tokens arrive. Detects newly-completed
// sentences (anything ending in . ! ? or newline) and queues each one
// for synthesis. On `isFinal`, flushes any trailing fragment too.
// Audio segments play strictly in order; later segments wait their turn.
export function streamSpeak(id: string, fullText: string, isFinal: boolean): void {
  if (!useStore.getState().voiceEnabled) {
    console.log("[TTS:stream] voice disabled, skip");
    return;
  }

  // New message â†’ reset queue + state so we don't blend two answers.
  if (id !== streamState.id) {
    console.log("[TTS:stream] NEW message id=%s â†’ cancel previous (was %s)", id, streamState.id);
    cancelStreamingTts();
    streamState.id = id;
    streamState.spokenChars = 0;
  }

  const clean = cleanSpeechText(fullText);
  const unseen = clean.slice(streamState.spokenChars);
  if (!unseen) {
    if (isFinal) maybeMarkStreamDone();
    return;
  }

  // Match runs of text terminated by sentence punctuation. Anything before
  // the last terminator is "complete" and safe to synthesize; the tail
  // (no terminator yet) waits for more tokens.
  const re = /[^.!?\n]+[.!?\n]+/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(unseen)) !== null) {
    const seg = m[0].trim();
    if (seg.length >= 3 && /[a-z0-9]/i.test(seg)) {
      console.log("[TTS:stream] SENTENCE detected (%d chars): \"%s\"", seg.length, seg.slice(0, 60));
      void fetchAndEnqueue(seg);
    }
    consumed = m.index + m[0].length;
  }
  streamState.spokenChars += consumed;

  if (isFinal) {
    const tail = clean.slice(streamState.spokenChars).trim();
    if (tail.length >= 2 && /[a-z0-9]/i.test(tail)) {
      console.log("[TTS:stream] FINAL flush tail (%d chars): \"%s\"", tail.length, tail.slice(0, 60));
      void fetchAndEnqueue(tail);
      streamState.spokenChars = clean.length;
    }
    maybeMarkStreamDone();
  }
}

function maybeMarkStreamDone(): void {
  // If everything fetched + played, nothing to do. The audio queue's own
  // playNext() will fire mic.onTtsEnd() and reset orb when it drains.
}

async function fetchAndEnqueue(text: string): Promise<void> {
  const gen = streamGeneration;     // snapshot â€” detect stale fetches
  const dedupeKey = `${gen}|${text}`;
  if (recentSegmentKeys.has(dedupeKey)) {
    console.log("[TTS:fetch] DUP drop gen=%d text=%s", gen, JSON.stringify(text.slice(0, 50)));
    return;
  }
  recentSegmentKeys.add(dedupeKey);
  // Bound memory: keep only current-generation keys
  for (const k of [...recentSegmentKeys]) {
    if (!k.startsWith(`${gen}|`)) recentSegmentKeys.delete(k);
  }
  pendingFetches++;
  console.log("[TTS:fetch] START gen=%d, pendingFetches=%d, text=%s", gen, pendingFetches, JSON.stringify(text.slice(0, 50)));
  try {
    const resp = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (gen !== streamGeneration) {
      console.log("[TTS:fetch] STALE (gen %d vs %d) â€” dropping", gen, streamGeneration);
      return;  // cancel happened while we were fetching
    }
    console.log("[TTS:fetch] response status=%d, gen=%d", resp.status, gen);
    if (!resp.ok) {
      console.warn("[TTS:fetch] server returned %d â€” dropping", resp.status);
      return;
    }
    const blob = await resp.blob();
    if (gen !== streamGeneration) {
      console.log("[TTS:fetch] STALE after blob â€” dropping");
      return;
    }
    console.log("[TTS:fetch] blob size=%d", blob.size);
    if (!blob.size) return;
    enqueueAudio(blob, gen);
  } catch (e) {
    console.warn("[TTS] segment fetch failed:", e);
  } finally {
    // Only decrement if this fetch belongs to the current generation.
    // Stale fetches (from a cancelled stream) must not touch the counter.
    if (gen === streamGeneration) {
      pendingFetches--;
      console.log("[TTS:fetch] END pendingFetches=%d", pendingFetches);
    } else {
      console.log("[TTS:fetch] END (stale gen=%d, not decrementing)", gen);
    }
  }
}

function enqueueAudio(blob: Blob, gen: number): void {
  // Final-instant generation check â€” if a cancel slipped in after the
  // fetch resolved but before this synchronous push, drop the blob.
  if (gen !== streamGeneration) {
    console.log("[TTS:enqueue] STALE (gen %d vs %d) â€” drop %d bytes", gen, streamGeneration, blob.size);
    return;
  }
  const url = URL.createObjectURL(blob);
  ttsQueue.push({ url });
  console.log("[TTS:enqueue] queued blob %d bytes, queueLen=%d, ttsPlaying=%s", blob.size, ttsQueue.length, ttsPlaying);
  if (!ttsPlaying) void playNext();
}

function releaseActive() {
  if (activeUrl) {
    try { URL.revokeObjectURL(activeUrl); } catch { /* noop */ }
    activeUrl = null;
  }
}

function handleClipFinished(_reason: "ended" | "error") {
  // Called when the shared <audio> element finishes (or errors) a clip.
  // Ignore if a cancel bumped the generation while this clip was playing â€”
  // the queue/state already advanced and a new burst may be running.
  if (activeGeneration !== streamGeneration) {
    console.log("[TTS:play] %s ignored (stale gen %d vs %d)", _reason, activeGeneration, streamGeneration);
    releaseActive();
    return;
  }
  releaseActive();
  ttsPlaying = false;
  void playNext();
}

let playNextChain: Promise<void> = Promise.resolve();

function playNext(): void {
  playNextChain = playNextChain.then(() => playNextAsync()).catch((e) => {
    console.warn("[TTS:play] playNextAsync failed", e);
    ttsPlaying = false;
  });
}

async function playNextAsync(): Promise<void> {
  if (!playerAudio) {
    ttsQueue.length = 0;
    ttsPlaying = false;
    return;
  }
  if (ttsPlaying && activeGeneration === streamGeneration) {
    return;
  }
  const next = ttsQueue.shift();
  if (!next) {
    ttsPlaying = false;
    releaseActive();
    console.log("[TTS:play] queue empty, pendingFetches=%d", pendingFetches);
    if (pendingFetches <= 0) {
      if (useStore.getState().orbState === "speaking") useStore.getState().setOrb("idle");
      mic.onTtsEnd();
    } else {
      const wakeGen = streamGeneration;
      setTimeout(() => {
        if (wakeGen === streamGeneration && !ttsPlaying) playNext();
      }, 60);
    }
    return;
  }
  try {
    playerAudio.pause();
  } catch {
    /* noop */
  }
  releaseActive();

  activeUrl = next.url;
  activeGeneration = streamGeneration;
  ttsPlaying = true;
  console.log("[TTS:play] playing clip, remaining=%d, gen=%d", ttsQueue.length, activeGeneration);
  if (useStore.getState().orbState !== "speaking") {
    useStore.getState().setOrb("speaking");
    mic.onTtsStart();
  }
  playerAudio.volume = 1.0;
  playerAudio.muted = false;

  const pinned = await ensurePlayerSinkPinned();
  const startGen = activeGeneration;
  if (startGen !== streamGeneration) {
    ttsPlaying = false;
    return;
  }
  if (!pinned) {
    console.warn("[TTS:play] no Xbox sink — dropping clip");
    try {
      URL.revokeObjectURL(next.url);
    } catch {
      /* noop */
    }
    ttsPlaying = false;
    playNext();
    return;
  }

  playerAudio.src = next.url;
  try {
    playerAudio.load();
  } catch {
    /* noop */
  }
  try {
    await playerAudio.play();
  } catch (err) {
    console.warn("[TTS:play] play() rejected:", err);
    if (startGen !== streamGeneration) return;
    handleClipFinished("error");
  }
}

export function cancelStreamingTts(): void {
  // Pause the shared player FIRST â€” guarantees no two clips ever overlap
  // because the OS only ever plays ONE element at a time.
  if (playerAudio) {
    try {
      playerAudio.pause();
      playerAudio.currentTime = 0;
      // Clear src so the element doesn't hold a reference to a revoked URL.
      playerAudio.removeAttribute("src");
      playerAudio.load();
    } catch { /* noop */ }
  }
  releaseActive();
  // Drop every queued URL.
  for (const c of ttsQueue) {
    try { URL.revokeObjectURL(c.url); } catch { /* noop */ }
  }
  ttsQueue.length = 0;
  ttsPlaying = false;
  // Also kill legacy speak() audio and any browser SpeechSynthesis.
  stopServerAudio();
  try { SYNTH?.cancel(); } catch { /* noop */ }
  // Bump generation so all stale fetches / timeouts / play() promises
  // recognize themselves and bail.
  streamGeneration++;
  recentSegmentKeys.clear();
  activeGeneration = streamGeneration;
  pendingFetches = 0;
  streamState.id = "";
  streamState.spokenChars = 0;
  console.log("[TTS:cancel] reset â€” generation now %d", streamGeneration);
}

function speakWithBrowserTts(_clean: string): void {
  // HARD DISABLED â€” Edge/browser SpeechSynthesis produces the robot voice.
  // Provider is elevenlabs; never speak via window.speechSynthesis.
  console.warn("[TTS] speakWithBrowserTts blocked (elevenlabs-only; no Edge fallback)");
  return;
}

export function stopSpeaking() {
  stopServerAudio();
  cancelStreamingTts();
  SYNTH?.cancel();
}

// --- STT (Server-side via MediaRecorder + /api/stt) ---
// Wake-word gated: every utterance is transcribed, but ONLY utterances
// that contain "nexy" / "hey nexy" (or fuzzy nexty/nexi) are forwarded to the chat. Other
// speech is discarded silently so the model never reacts to ambient talk.
// Once awake the mic stays "armed" for FOLLOWUP_WINDOW_MS so quick
// follow-ups don't need to repeat the wake word.

// VAD constants. SILENCE_THRESHOLD is the *floor* below which audio counts
// as silence; the actual detection threshold floats up dynamically based on
// a noise baseline learned during the first second of every mic session.
const SILENCE_THRESHOLD   = 0.05;
const SILENCE_TIMEOUT_MS  = 2000;      // silence this long = end of utterance
const MIN_RECORDING_MS    = 350;       // ignore clips shorter than this
const MAX_RECORDING_MS    = 8_000;     // force-flush clips longer than this
const BASELINE_WINDOW_MS  = 1_000;     // learn ambient noise level over 1 s
const BASELINE_MULTIPLIER = 1.8;       // require lvl > baseline * mult to count as voice

// â”€â”€ Speak-time cancel ("mute mic except cancel") â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// While JARVIS is speaking the mic is muted to normal commands â€” VAD is paused
// so we never transcribe ambient talk or our own TTS. We keep ONE ear open for
// a stop word: a sustained, clearly-louder-than-ambient voice (echo residue
// won't survive the sustain window) triggers a short "cancel-probe" recording.
// That probe is checked ONLY for "cancel"/"stop" â€” TTS keeps playing unless a
// stop word is actually heard. Probe audio is NEVER submitted as a chat.
const BARGE_IN_MULTIPLIER = 3.2;       // voice must exceed baseline * this
const BARGE_IN_FLOOR      = 0.12;      // and clear this absolute level
const BARGE_IN_SUSTAIN_MS = 220;       // for this long, continuously
// Stop words that cut TTS when heard during a cancel-probe.
const CANCEL_RE = /\b(?:cancel|nevermind|never\s*mind|shut\s*up|stop(?:\s+(?:talking|speaking))?|be\s+quiet|quiet|enough|hush)\b/i;
const CANCEL_PROBE_MS = 1600;          // how long to listen for the stop word

// Whisper hallucinations to suppress (mirror of server filter).
const HALLUCINATION_RE = /^\s*(?:thanks?[\s,.!?]*(?:for\s+watching|for\s+listening)?[\s,.!?]*(?:everyone|guys|all)?[\s,.!?]*|thank\s+you[\s,.!?]*(?:for\s+watching|for\s+listening|so\s+much)?[\s,.!?]*|(?:please\s+)?(?:like\s*(?:and\s+)?)?subscribe[\s,.!?]*(?:to\s+my\s+channel)?[\s,.!?]*|bye(?:\s*bye)?[\s,.!?]*|goodbye[\s,.!?]*|(?:see|catch)\s+you\s+(?:later|next\s+time)[\s,.!?]*|you[\s,.!?]*|[.!?,â€¦\sâ™ªâ™«]+)\s*$/i;
// Non-lexical interjections / vocal noise (throat-clears, "oh", "uh", "hmm").
// In the armed follow-up window these would otherwise auto-submit as a chat
// and cancel any in-flight task. Drop them â€” they carry no command.
const FILLER_RE = /^\s*(?:oh+|uh+|um+|hmm+|hm|ah+|aha|eh+|mm+|er+|huh|ugh|oof|whoa|oops|mhm|uh[\s-]*huh|oh\s+my|yeah|yep|nope|hu)[\s,.!?â€¦]*$/i;
const FOLLOWUP_WAKE_MS  = 10_000;
const FOLLOWUP_REPLY_MS = 20_000;
// VAD often chops one spoken sentence into 2+ STT clips on short pauses.
// Buffer submissions this long and join consecutive clips into ONE chat, so a
// mid-sentence pause doesn't fire twice (the 2nd request cancelling the 1st).
const STT_COALESCE_MS = 800;
const SLEEP_PHRASES = /\b(?:stop listening|go to sleep|nexy stop|sleep mode|nevermind|never mind|that's all|that is all)\b/i;

// --- Fuzzy wake-word detection ----------------------------------------------
// Canonical wake: "Hey Nexy" (also ok/okay/yo/hi/ay + Nexy).
// Whisper often mishears "nexy" as nexty / nexi / nexie / nexey / nexti.
// jarvis / jervis / charvis are intentionally NOT matched anymore.
// Accept via:
//   1. strict regex on nexy / nexty / nexi family
//   2. shape regex: n + optional vowel + x + t? + y/i/ie
//   3. Levenshtein â‰¤ 1 from nexy / nexty / nexi
const WAKE_SHAPE_RE = /\b(?:hey|ok|okay|yo|hi|ay)?\s*n[aeiouy]?x(?:t)?[yi]e?\b/i;
const WAKE_STRICT_RE = /\b(?:hey|ok|okay|yo|hi|ay)?\s*n\.?e\.?x\.?(?:t\.?)?[yi]e?\b/i;
const WAKE_CANONICALS = ["nexy", "nexty", "nexi", "nexie", "nexey", "nexti"];

function levenshtein(a: string, b: string): number {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp: number[] = Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function isNexyLike(token: string): boolean {
  const t = token.toLowerCase().replace(/[^a-z]/g, "");
  if (!t || t.length < 3 || t.length > 7) return false;
  // Explicit allowlist (primary fuzzy variants)
  if (WAKE_CANONICALS.includes(t)) return true;
  // Shape: n + optional vowel + x + optional t + y/i/ie
  if (/^n[aeiouy]?x(?:t)?[yi]e?$/.test(t)) return true;
  // Tight edit distance from primary forms (drop jarvis family entirely)
  return WAKE_CANONICALS.slice(0, 3).some((c) => levenshtein(t, c) <= 1);
}

function detectWake(text: string): boolean {
  if (WAKE_STRICT_RE.test(text) || WAKE_SHAPE_RE.test(text)) return true;
  // Token-level Levenshtein fallback â€” catches odd Whisper outputs like
  // "Nexty," "Nexi," "Nexie," etc. Does NOT match jarvis/jervis/charvis.
  for (const tok of text.split(/[\s,.\!\?\-:;'"]+/)) {
    if (isNexyLike(tok)) return true;
  }
  return false;
}

function stripWakeWord(text: string): string {
  // Strip strict / shape match first (optional filler + nexy-family)
  let out = text.replace(/^\s*(?:hey|ok|okay|yo|hi|ay)?\s*n\.?e\.?x\.?(?:t\.?)?[yi]e?[\s,.\-:!?]*/i, "");
  if (out !== text) return out.trim();
  // Strip fuzzy first-token if Nexy-like
  const m = out.match(/^\s*(\S+)[\s,.\-:!?]*/);
  if (m && isNexyLike(m[1])) {
    out = out.slice(m[0].length);
    // Also peel a leading filler like "hey/ok" (rare order: "Nexy hey ...")
    const m2 = out.match(/^\s*(\S+)[\s,.\-:!?]*/);
    if (m2 && /^(?:hey|ok|okay|yo|hi|ay)$/i.test(m2[1])) {
      out = out.slice(m2[0].length);
    }
  } else {
    // Strip leading filler then fuzzy
    const mf = out.match(/^\s*(hey|ok|okay|yo|hi|ay)\s+(\S+)[\s,.\-:!?]*/i);
    if (mf && isNexyLike(mf[2])) out = out.slice(mf[0].length);
  }
  return out.trim();
}

export class JarvisMic {
  private analyser: AnalyserNode | null = null;
  private audioCtx: AudioContext | null = null;
  private rafId: number | null = null;
  private stream: MediaStream | null = null;

  // Recording state
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private isRecording = false;
  private recordingStartTime = 0;
  private silenceStart = 0;
  // Rolling ambient noise floor â€” learned during the first second of every
  // session so we can distinguish actual speech from constant background
  // hum (fans, A/C, traffic) that would otherwise pin the VAD open forever.
  private baselineLvl = 0;
  private baselineSamples = 0;
  private baselineStartedAt = 0;
  private _wantListening = false;
  private _onTranscript: ((text: string, isFinal: boolean) => void) | null = null;
  private _onWake: ((phrase: string) => void) | null = null;
  private _transcribing = false;
  private _coalesceBuf: string[] = [];
  private _coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  // Wake-word gate
  private _awakeUntil = 0;        // unix ms; while now < this, accept everything
  private _ttsActive = false;     // JARVIS is talking â€” mic muted except "cancel"
  private _loudRunStart = 0;      // unix ms the current loud-while-speaking run began
  private _recordingIsProbe = false;  // current capture is a cancel-probe (never submit)
  private _probeTimer: ReturnType<typeof setTimeout> | null = null;

  // Called from voice.speak() when TTS begins / ends.
  onTtsStart() {
    this._ttsActive = true;
    this._loudRunStart = 0;
    // Drop any in-flight capture (would otherwise pick up JARVIS itself).
    if (this.isRecording) this._stopRecording();
    if (this._wantListening) {
      useStore.getState().setMicMode("speaking");
      useStore.getState().setMicStatus(
        useStore.getState().bargeIn
          ? "JARVIS speaking Â· say â€œcancelâ€ to stop"
          : "JARVIS speaking Â· mic muted",
      );
    }
  }

  onTtsEnd() {
    this._ttsActive = false;
    this._loudRunStart = 0;
    // Tear down any cancel-probe still in flight; its audio must never submit.
    if (this._probeTimer) { clearTimeout(this._probeTimer); this._probeTimer = null; }
    if (this.isRecording) this._stopRecording();
    // After JARVIS finishes, arm a generous follow-up window so the user
    // can reply naturally â€” no second wake word needed.
    this._awakeUntil = Date.now() + FOLLOWUP_REPLY_MS;
    if (this._wantListening) {
      useStore.getState().setMicMode("armed");
      useStore.getState().setMicStatus(`armed Â· ${Math.round(FOLLOWUP_REPLY_MS/1000)}s to reply`);
    }
  }

  // The user spoke up while JARVIS is talking. Start a brief recording that is
  // checked ONLY for a stop word â€” TTS keeps playing meanwhile. If no stop word
  // is heard the audio is discarded; it is never submitted as a chat.
  private _startCancelProbe() {
    this._loudRunStart = 0;
    if (this.isRecording || this._transcribing) return;
    console.log("[STT] loud voice while speaking â€” cancel-probe armed");
    this._startRecording();
    this._recordingIsProbe = true;
    if (this._probeTimer) clearTimeout(this._probeTimer);
    this._probeTimer = setTimeout(() => {
      this._probeTimer = null;
      this._stopRecording();
    }, CANCEL_PROBE_MS);
    if (this._wantListening) {
      useStore.getState().setMicStatus("listening for â€œcancelâ€â€¦");
    }
  }

  available(): boolean {
    return Boolean(navigator.mediaDevices?.getUserMedia);
  }

  async start(onTranscript: (text: string, isFinal: boolean) => void, onWake?: (phrase: string) => void) {
    if (this._wantListening) return;
    this._wantListening = true;
    this._onTranscript = onTranscript;
    this._onWake = onWake ?? null;
    await this._initAudio();
  }

  stop() {
    this._wantListening = false;
    this._onTranscript = null;
    this._onWake = null;
    this._awakeUntil = 0;
    // Drop any buffered STT clips + cancel a pending coalesce flush so a late
    // submission can't fire after the mic is stopped.
    if (this._coalesceTimer) { clearTimeout(this._coalesceTimer); this._coalesceTimer = null; }
    this._coalesceBuf = [];
    // Tear down a cancel-probe if one is running.
    if (this._probeTimer) { clearTimeout(this._probeTimer); this._probeTimer = null; }
    this._recordingIsProbe = false;
    this._loudRunStart = 0;
    this._stopRecording();
    this._stopAudioMeter();
    useStore.getState().setMicEnabled(false);
    useStore.getState().setMicMode("dormant");
    useStore.getState().setMicStatus("");
    useStore.getState().setOrb("idle");
  }

  private async _initAudio() {
    try {
      // Echo cancellation is what makes barge-in viable: it strips most of
      // JARVIS's own TTS out of the mic signal so we don't transcribe
      // ourselves or false-trigger the interrupt detector.
      // HARD RULE: Xbox Controller headset mic ONLY — never fifine / other defaults.
      const xbox = await resolveXboxAudioDevices();
      const audioConstraints: MediaTrackConstraints = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
      };
      if (xbox.micId) {
        audioConstraints.deviceId = { exact: xbox.micId };
        console.log("[STT] pinning mic to", xbox.micLabel);
      } else {
        console.warn("[STT] Xbox Controller mic not found — refusing non-Xbox fallback");
        useStore.getState().setMicStatus("Xbox mic missing");
        return;
      }
      if (!xbox.sinkId) {
        console.warn("[STT] Xbox Headphones sink not found — refusing non-Xbox output");
        useStore.getState().setMicStatus("Xbox headphones missing");
        return;
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });
      await pinPlayerSink(xbox.sinkId);
      useStore.getState().setMicStatus(`Xbox active: ${xbox.sinkLabel} + ${xbox.micLabel}`);
    } catch (e) {
      console.warn("getUserMedia denied", e);
      useStore.getState().setMicStatus("mic blocked");
      return;
    }

    this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    // Electron/Chromium often starts AudioContext suspended; without resume
    // the analyser reads zeros and VAD never opens a recording -> silent mic.
    try { await this.audioCtx.resume(); } catch { /* noop */ }
    const src = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.4;  // faster response to level changes
    src.connect(this.analyser);

    useStore.getState().setMicEnabled(true);
    useStore.getState().setOrb("listening");
    useStore.getState().setMicStatus("calibrating micâ€¦");

    // Reset baseline state for this session.
    this.baselineLvl = 0;
    this.baselineSamples = 0;
    this.baselineStartedAt = Date.now();

    const freqData = new Uint8Array(this.analyser.frequencyBinCount);
    const tick = () => {
      if (!this.analyser || !this._wantListening) return;
      this.analyser.getByteFrequencyData(freqData);
      let sum = 0;
      for (let i = 0; i < freqData.length; i++) sum += freqData[i];
      const lvl = sum / freqData.length / 255;
      useStore.getState().setAudioLevel(lvl);

      // â”€â”€ Baseline learning. Only samples taken before any voice has been
      //    detected count, so we learn the real ambient noise floor.
      const elapsed = Date.now() - this.baselineStartedAt;
      if (elapsed < BASELINE_WINDOW_MS && !this.isRecording) {
        this.baselineSamples++;
        this.baselineLvl =
          (this.baselineLvl * (this.baselineSamples - 1) + lvl) / this.baselineSamples;
        if (elapsed >= BASELINE_WINDOW_MS - 33 && this._wantListening) {
          useStore.getState().setMicStatus(
            `listening Â· noise floor ${(this.baselineLvl * 100).toFixed(1)}%`,
          );
        }
      }

      // Dynamic threshold: max(floor, baseline * multiplier). If the room
      // is loud, the threshold rises so we still detect speech as the
      // crossing event rather than pinning the VAD open permanently.
      const voiceThr = Math.max(
        SILENCE_THRESHOLD,
        this.baselineLvl * BASELINE_MULTIPLIER,
      );

      // Voice activity detection â€” paused while JARVIS is speaking so we
      // never transcribe our own TTS output.
      if (!this._ttsActive) {
        this._loudRunStart = 0;
        if (lvl > voiceThr) {
          this.silenceStart = 0;
          if (!this.isRecording && !this._transcribing) {
            this._startRecording();
          }
        } else if (this.isRecording) {
          if (!this.silenceStart) {
            this.silenceStart = Date.now();
          } else if (Date.now() - this.silenceStart > SILENCE_TIMEOUT_MS) {
            this._stopRecording();
          }
        }
        // Hard cap on recording length so very long utterances still flush
        // for transcription even if the user never reaches a silent moment.
        if (
          this.isRecording &&
          Date.now() - this.recordingStartTime > MAX_RECORDING_MS
        ) {
          this._stopRecording();
        }
      } else if (useStore.getState().bargeIn) {
        // JARVIS is speaking; mic is muted to normal commands. Keep one ear
        // open for a stop word: a sustained, clearly-louder-than-ambient voice
        // (transient echo residue won't survive the sustain window) arms a
        // short cancel-probe. TTS keeps playing unless the probe hears "cancel".
        const loudThr = Math.max(BARGE_IN_FLOOR, this.baselineLvl * BARGE_IN_MULTIPLIER);
        if (lvl > loudThr) {
          if (!this._loudRunStart) {
            this._loudRunStart = Date.now();
          } else if (
            Date.now() - this._loudRunStart > BARGE_IN_SUSTAIN_MS &&
            !this.isRecording && !this._transcribing
          ) {
            this._startCancelProbe();
          }
        } else {
          this._loudRunStart = 0;
        }
      }

      this.rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  private _startRecording() {
    if (!this.stream || this.isRecording) return;
    // Default: a normal capture. _startCancelProbe() flips this true after.
    this._recordingIsProbe = false;

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";

    try {
      this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    } catch (e) {
      console.warn("MediaRecorder init failed:", e);
      return;
    }

    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.onstop = () => {
      const duration = Date.now() - this.recordingStartTime;
      // Snapshot probe-ness now â€” onTtsEnd may clear it before transcription.
      const wasProbe = this._recordingIsProbe;
      this._recordingIsProbe = false;
      if (duration >= MIN_RECORDING_MS && this.chunks.length > 0) {
        const blob = new Blob(this.chunks, { type: this.recorder?.mimeType || "audio/webm" });
        this._transcribe(blob, wasProbe);
      }
      this.chunks = [];
    };

    this.recorder.start(100);
    this.isRecording = true;
    this.recordingStartTime = Date.now();
    this.silenceStart = 0;
    useStore.getState().setMicStatus("recordingâ€¦");
    console.log("[STT] recording started");
  }

  private _stopRecording() {
    if (!this.isRecording || !this.recorder) return;
    this.isRecording = false;
    try {
      if (this.recorder.state === "recording") {
        this.recorder.stop();
      }
    } catch { /* noop */ }
    this.recorder = null;
  }

  private async _transcribe(blob: Blob, isCancelProbe = false) {
    if (this._transcribing) return;
    this._transcribing = true;
    useStore.getState().setMicStatus(isCancelProbe ? "listening for â€œcancelâ€â€¦" : "transcribingâ€¦");
    console.log("[STT] sending", blob.size, "bytes for transcription", isCancelProbe ? "(cancel-probe)" : "");

    try {
      const form = new FormData();
      form.append("audio", blob, "speech.webm");

      const resp = await fetch("/api/stt", { method: "POST", body: form });
      const result = await resp.json();

      console.log("[STT] result:", result);

      // Cancel-probe: user spoke up while JARVIS was talking. ONLY a stop word
      // does anything here â€” this audio is never forwarded to the chat.
      if (isCancelProbe) {
        const probe = (result?.text || "").trim();
        if (probe && CANCEL_RE.test(probe)) {
          console.log("[STT] cancel word while speaking â€” cutting TTS:", probe);
          cancelStreamingTts();
          this._ttsActive = false;
          this._loudRunStart = 0;
          this._awakeUntil = Date.now() + FOLLOWUP_WAKE_MS;
          useStore.getState().setMicMode("armed");
        } else {
          console.log("[STT] cancel-probe, no stop word â€” ignoring:", probe || "(empty)");
        }
        return;   // probe audio is never submitted
      }

      if (result.text && this._onTranscript) {
        const text = result.text.trim();
        if (!text) return;
        // Client-side guard against Whisper's YouTube-outro hallucinations.
        // Server already filters them, this catches any that slip through.
        if (HALLUCINATION_RE.test(text)) {
          console.log("[STT] discarded hallucination:", text);
          return;
        }
        // Pure vocal noise (oh / uh / hmm) â€” never submit. Without this an
        // ambient "oh" in the armed window cancels whatever JARVIS is running.
        if (FILLER_RE.test(text)) {
          console.log("[STT] ignored filler:", text);
          return;
        }

        // Sleep command always wins â€” drop to dormant immediately.
        if (SLEEP_PHRASES.test(text)) {
          this._awakeUntil = 0;
          useStore.getState().setMicMode("dormant");
          useStore.getState().setMicStatus("dormant â€” say â€œHey Nexyâ€ to wake");
          return;
        }

        const now = Date.now();
        const hasWake = detectWake(text);
        const inFollowup = now < this._awakeUntil;

        if (!hasWake && !inFollowup) {
          // Ambient speech â€” drop. Brief visual feedback then back to dormant.
          useStore.getState().setMicMode("dormant");
          useStore.getState().setMicStatus(`(ignored) "${text.slice(0, 40)}"`);
          setTimeout(() => {
            if (this._wantListening && useStore.getState().micMode === "dormant") {
              useStore.getState().setMicStatus("listening Â· say â€œHey Nexyâ€");
            }
          }, 1200);
          return;
        }

        // Strip wake word so model sees just the command body.
        const cleaned = stripWakeWord(text);
        if (!cleaned) {
          // Bare wake word â€” arm short window, no submission.
          this._awakeUntil = now + FOLLOWUP_WAKE_MS;
          useStore.getState().setMicMode("armed");
          useStore.getState().setMicStatus("awake Â· awaiting command");
          this._onWake?.(text);
          return;
        }

        // Real submission. Extend window so the user can continue
        // refining the request without re-saying the wake word.
        this._awakeUntil = now + FOLLOWUP_WAKE_MS;
        useStore.getState().setMicMode("armed");
        this._onWake?.(text);
        this._queueSubmit(cleaned);
      }
    } catch (e) {
      console.error("[STT] transcription failed:", e);
    } finally {
      this._transcribing = false;
      if (this._wantListening) {
        // If JARVIS is still speaking (probe didn't cancel), restore the
        // speaking status rather than the idle listening prompt.
        if (this._ttsActive) {
          useStore.getState().setMicStatus(
            useStore.getState().bargeIn
              ? "JARVIS speaking Â· say â€œcancelâ€ to stop"
              : "JARVIS speaking Â· mic muted",
          );
        } else {
          useStore.getState().setMicStatus("listening Â· say â€œHey Nexyâ€");
        }
      }
    }
  }

  // Buffer a real submission and (re)start the coalesce timer. Consecutive
  // clips within STT_COALESCE_MS join into one chat; armed window stays alive.
  private _queueSubmit(text: string) {
    this._coalesceBuf.push(text);
    if (this._coalesceTimer) clearTimeout(this._coalesceTimer);
    useStore.getState().setMicStatus("â€¦");
    this._coalesceTimer = setTimeout(() => this._flushCoalesce(), STT_COALESCE_MS);
  }

  private _flushCoalesce() {
    if (this._coalesceTimer) { clearTimeout(this._coalesceTimer); this._coalesceTimer = null; }
    const joined = this._coalesceBuf.join(" ").replace(/\s+/g, " ").trim();
    this._coalesceBuf = [];
    if (joined && this._onTranscript) this._onTranscript(joined, true);
  }

  private _stopAudioMeter() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
    this.analyser = null;
    this.stream = null;
    useStore.getState().setAudioLevel(0);
  }
}

export const mic = new JarvisMic();


/** Electron HUD helpers — unlock HTMLAudio + force-speak without Edge. */
export async function unlockHudAudio(): Promise<void> {
  try {
    await loadForcedAudioHints();
    if (playerAudio) {
      playerAudio.muted = false;
      playerAudio.volume = 1.0;
    }
    await ensurePlayerSinkPinned();
    const silent = new Audio(
      "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA",
    );
    silent.volume = 0.01;
    const sinkId = lastXboxAudio.sinkId;
    const anySilent = silent as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (sinkId && typeof anySilent.setSinkId === "function") {
      await anySilent.setSinkId(sinkId).catch(() => undefined);
    }
    await silent.play().catch(() => undefined);
    silent.pause();
  } catch (e) {
    console.warn("[TTS] unlockHudAudio failed", e);
  }
}

if (typeof window !== "undefined") {
  (window as unknown as { __jarvisSpeak?: (t: string) => void; __jarvisUnlockAudio?: () => Promise<void> }).__jarvisSpeak = (t: string) => {
    try { useStore.getState().setVoiceEnabled(true); } catch { /* noop */ }
    void unlockHudAudio().finally(() => speak(t));
  };
  (window as unknown as { __jarvisUnlockAudio?: () => Promise<void> }).__jarvisUnlockAudio = unlockHudAudio;
}