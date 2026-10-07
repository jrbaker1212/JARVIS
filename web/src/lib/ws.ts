import { nextId, useStore } from "./store";
import { speak } from "./voice";

type WSMessage = Record<string, any>;

const HEARTBEAT_MS = 25_000;
const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 15_000;

class JarvisWS {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private reconnectAttempt = 0;
  private intentionalClose = false;
  private pendingOutbound: WSMessage[] = [];
  private listeners: Set<(m: WSMessage) => void> = new Set();

  constructor(url?: string) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this.url = url ?? `${proto}//${location.host}/ws`;
  }

  connect() {
    if (this.ws) {
      const rs = this.ws.readyState;
      if (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) {
        return;
      }
      // Dead socket — drop reference so we don't leak handlers.
      try {
        this.ws.onopen = null;
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
      } catch {
        /* noop */
      }
      this.ws = null;
    }
    this.intentionalClose = false;
    try {
      console.log("[WS] connecting", this.url);
      this.ws = new WebSocket(this.url);
    } catch (e) {
      console.error("[WS] connect failed", e);
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      console.log("[WS] open");
      this.reconnectAttempt = 0;
      useStore.getState().setConnected(true);
      useStore.getState().setVoiceEnabled(true);
      void import("./convaiVoice").then((m) => {
        if (useStore.getState().voicePipeline !== "legacy" && !useStore.getState().convaiConnected) {
          void m.startConvaiVoice({ reason: "ws-reconnect" });
        }
      });
      this.startHeartbeat();
      this.send({ type: "ping" });
      this.flushPending();
    };
    this.ws.onclose = (ev) => {
      console.warn(
        "[WS] closed code=%s reason=%s clean=%s",
        ev.code,
        ev.reason || "(none)",
        ev.wasClean,
      );
      this.stopHeartbeat();
      useStore.getState().setConnected(false);
      this.ws = null;
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };
    this.ws.onerror = () => {
      console.warn("[WS] error (close will follow)");
    };
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        this.dispatch(msg);
      } catch (e) {
        console.warn("bad ws message", ev.data);
      }
    };
  }

  /** Force a fresh socket (e.g. after Electron show / network online). */
  reconnect() {
    this.intentionalClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
    this.intentionalClose = false;
    this.connect();
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: "ping" });
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer != null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer != null) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * Math.pow(1.6, this.reconnectAttempt),
    );
    this.reconnectAttempt++;
    console.log("[WS] reconnect in %dms (attempt %d)", Math.round(delay), this.reconnectAttempt);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  send(msg: WSMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        console.warn("[WS] send failed — queueing", e);
        this.pendingOutbound.push(msg);
        this.scheduleReconnect();
      }
      return;
    }
    if (msg.type !== "ping") {
      this.pendingOutbound.push(msg);
    }
    this.connect();
  }

  private flushPending() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const batch = this.pendingOutbound.splice(0, this.pendingOutbound.length);
    for (const msg of batch) {
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        console.warn("[WS] flush failed", e);
        this.pendingOutbound.unshift(msg);
        break;
      }
    }
  }

  subscribe(fn: (m: WSMessage) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private streamingId: string | null = null;
  private taskChatId: string | null = null;

  /** Mirror a swarm-tagged event into the SwarmRun store entry. */
  private handleSwarmEvent(m: WSMessage) {
    const sid: string | undefined = m.swarm_id;
    if (!sid) return;
    const runId = sid.split(":")[0];
    const st = useStore.getState();
    if (m.type === "task_start") {
      st.updateSwarmTask(runId, sid, { status: "running", preview: m.text });
    } else if (m.type === "tool_proposed") {
      st.updateSwarmTask(runId, sid, {
        status: "running",
        tool: m.tool,
        preview: m.preview,
      });
    } else if (m.type === "task_progress") {
      st.updateSwarmTask(runId, sid, { preview: m.text });
    } else if (m.type === "tool_result") {
      st.updateSwarmTask(runId, sid, {
        status: m.ok ? "ok" : "fail",
        result: m.text,
        endedAt: Date.now(),
      });
    } else if (m.type === "task_end") {
      if (m.ok === false) {
        st.updateSwarmTask(runId, sid, { status: "fail", endedAt: Date.now() });
      }
    } else if (m.type === "error") {
      st.updateSwarmTask(runId, sid, {
        status: "fail",
        result: m.text,
        endedAt: Date.now(),
      });
    }
  }

  private dispatch(m: WSMessage) {
    const st = useStore.getState();
    if (m.swarm_id) {
      this.handleSwarmEvent(m);
    }
    if (m.type === "info" && m.swarm === true && Array.isArray(m.tasks)) {
      const runId: string = (m.swarm_run_id as string) || nextId();
      st.startSwarm({
        id: runId,
        ts: Date.now(),
        active: true,
        tasks: (m.tasks as { id: string; label: string; tool: string }[]).map((t) => ({
          id: t.id,
          label: t.label,
          tool: t.tool,
          status: "pending",
          startedAt: Date.now(),
        })),
      });
    }
    if (m.type === "info" && m.swarm === true && Array.isArray(m.summary)) {
      const runId: string | undefined = m.swarm_run_id;
      if (runId) st.finishSwarm(runId);
    }

    switch (m.type) {
      case "pong":
        break;
      case "info":
        st.pushChat({ id: nextId(), role: "info", text: m.text, ts: Date.now() });
        break;
      case "error":
        st.pushChat({ id: nextId(), role: "error", text: m.text, ts: Date.now() });
        st.setOrb("idle");
        break;
      case "user":
        break;
      case "assistant": {
        if (this.streamingId) {
          const cid = this.streamingId;
          st.finalizeChat(cid, m.text);
          useStore.setState((s) => ({
            chat: s.chat.map((c) => (c.id === cid ? { ...c, ttsSource: "hud" as const } : c)),
          }));
          this.streamingId = null;
        } else {
          st.pushChat({ id: nextId(), role: "assistant", text: m.text, ts: Date.now(), ttsSource: "hud" });
        }
        st.setOrb("speaking");
        setTimeout(() => {
          if (useStore.getState().orbState === "speaking") useStore.getState().setOrb("idle");
        }, 2500);
        break;
      }
      case "stream_begin": {
        const id = nextId();
        this.streamingId = id;
        st.pushChat({ id, role: "assistant", text: "", ts: Date.now(), streaming: true, ttsSource: "hud" });
        st.setOrb("speaking");
        break;
      }
      case "stream_delta":
        if (this.streamingId && typeof m.text === "string") {
          st.appendChatText(this.streamingId, m.text);
        }
        break;
      case "stream_end":
        if (this.streamingId) {
          st.finalizeChat(this.streamingId);
        }
        break;
      case "thinking":
        st.setOrb("thinking");
        break;
      case "tool_proposed":
        st.pushTool({
          id: nextId(),
          tool: m.tool,
          permission: m.permission,
          preview: m.preview,
          args: m.args || {},
          status: "proposed",
          ts: Date.now(),
        });
        break;
      case "task_start":
        {
          const toolName = (m.text || "").split(":")[0].trim();
          const tools = useStore.getState().tools.slice().reverse();
          const target = tools.find((t) => t.tool === toolName && t.status === "proposed");
          if (target) {
            st.updateTool(target.id, { status: "running", preview: m.text });
          } else {
            st.pushTool({
              id: nextId(),
              tool: toolName,
              permission: "safe",
              preview: m.text,
              args: {},
              status: "running",
              ts: Date.now(),
            });
          }
          const TASK_ANNOUNCE: Record<string, string> = {
            image_generate:  "Generating image now, sir. Stand by…",
            image_to_3d:     "Converting image to 3D model, sir. This will take a moment…",
            text_to_3d:      "Generating 3D model from text, sir. Stand by…",
            web_search:      "Searching the web, sir…",
            image_search:    "Searching for images, sir…",
            video_search:    "Searching for videos, sir…",
            browser_open:    "Opening page, sir…",
            run_shell:       "Running command, sir…",
            shell:           "Running command, sir…",
            search_memory:   "Searching memory, sir…",
            memory_galaxy:   "Building memory map, sir…",
          };
          const msg = TASK_ANNOUNCE[toolName];
          if (msg) {
            this.taskChatId = nextId();
            st.pushChat({ id: this.taskChatId, role: "info", text: msg, ts: Date.now() });
            speak(msg);
          }
        }
        break;
      case "task_progress": {
        const progressText = m.text || "";
        if (this.taskChatId) {
          st.updateChat(this.taskChatId, progressText);
        } else {
          st.pushChat({ id: nextId(), role: "info", text: progressText, ts: Date.now() });
        }
        break;
      }
      case "task_end": {
        const tools = useStore.getState().tools.slice().reverse();
        const target = tools.find((t) => t.status === "running");
        if (target) st.updateTool(target.id, { status: m.ok ? "ok" : "fail" });
        this.taskChatId = null;
        break;
      }
      case "tool_result": {
        const tools = useStore.getState().tools.slice().reverse();
        const target = tools.find((t) => t.tool === m.tool && (t.status === "running" || t.status === "proposed"));
        if (target) {
          st.updateTool(target.id, {
            status: m.ok ? "ok" : "fail",
            result: m.text,
            duration_s: m.duration_s,
          });
        }
        if (m.ok) st.advancePlan();
        break;
      }
      case "media": {
        const items = Array.isArray(m.items) ? m.items : [];
        const kind = (m.kind || "search") as any;
        const card: any = {
          id: nextId(),
          kind,
          items,
          summary: m.summary || "",
          tool: m.tool,
          query: m.args?.query || m.args?.url,
          ts: Date.now(),
          expanded: kind === "page" ? 0 : null,
        };
        if (kind === "galaxy") {
          card.galaxy = { nodes: items, clusters: m.clusters || [] };
        }
        st.pushMedia(card);
        break;
      }
      case "plan":
        st.setPlan({ text: m.text || "", steps: Array.isArray(m.steps) ? m.steps : [] });
        break;
      case "suggestions":
        st.setSuggestions(Array.isArray(m.items) ? m.items : []);
        break;
      case "confirm_request":
        st.pushConfirm({
          id: m.id,
          tool: m.tool,
          permission: m.permission,
          preview: m.preview,
          args: m.args || {},
        });
        break;
      case "done":
        if (useStore.getState().orbState === "thinking") useStore.getState().setOrb("idle");
        st.completePlan();
        break;
    }
    for (const fn of this.listeners) fn(m);
  }

  chat(text: string) {
    const st = useStore.getState();
    const attachments = st.pendingAttachments.length ? st.pendingAttachments : undefined;
    st.clearPlan();
    st.clearSuggestions();
    this.send({ type: "chat", text, attachments });
    if (attachments) st.clearAttachments();
  }
  command(cmd: string) {
    this.send({ type: "command", command: cmd });
  }
  confirm(id: string, approved: boolean) {
    this.send({ type: "confirm", id, approved });
  }
  agent(name: string) {
    this.send({ type: "agent", name: name });
  }
  cancel() {
    this.send({ type: "cancel" });
  }
}

export const wsClient = new JarvisWS();
