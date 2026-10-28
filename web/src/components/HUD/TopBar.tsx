import { useEffect, useState } from "react";
import { useStore } from "../../lib/store";

export default function TopBar() {
  const [now, setNow] = useState(new Date());
  const health = useStore((s) => s.health);
  const connected = useStore((s) => s.connected);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const date = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });

  return (
    /* Frameless Electron: this strip is the window drag handle (~36px).
       Interactive controls inside MUST carry .app-no-drag. */
    <div className="absolute top-0 inset-x-0 z-40 select-none app-drag">
      <div className="h-9 flex items-center justify-between px-6">
        {/* LEFT - Identity */}
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div
                className={`w-2 h-2 rounded-full ${connected ? "bg-jarvis-ok animate-pulse_glow" : "bg-jarvis-danger"}`}
              />
              {connected && (
                <div className="absolute inset-0 w-2 h-2 rounded-full bg-jarvis-ok blur-md opacity-70" />
              )}
            </div>
            <span className="text-display text-[13px] tracking-[0.35em] font-medium">
              <span
                style={{
                  backgroundImage: "linear-gradient(135deg, #FF2E4D 0%, #D4AF37 50%, #2F8CFF 100%)",
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  color: "transparent",
                  WebkitTextFillColor: "transparent",
                  filter: "drop-shadow(0 0 8px rgba(212,175,55,0.45))",
                }}
              >
                KORT
              </span>
              <span className="text-[#6CC6FF]" style={{ textShadow: "0 0 10px rgba(108,198,255,0.55)" }}>//HUD</span>
            </span>
            <span className="text-mono text-[10px] text-[#6CC6FF]/90 px-1.5 py-0.5 border border-[#2F8CFF]/35 rounded-md">
              LOCAL
            </span>
          </div>
          <div className="hidden md:flex text-mono text-[10.5px] text-jarvis-ice/40 gap-4">
            <Stat label="MODEL" value={health?.model.model ?? "—"} />
            <Stat label="IMG"   value={health?.image_model ?? "—"} />
            <Stat label="PROV"  value={health?.model.provider ?? "—"} />
            <Stat label="TOOLS" value={String(health?.tools ?? 0)} />
            <Stat label="PLUG"  value={String(health?.plugins.length ?? 0)} />
          </div>
        </div>

        {/* RIGHT - Clock */}
        <div className="flex items-center gap-4">
          <div className="text-mono text-right leading-none tabular-nums">
            <div className="text-[13px] text-jarvis-ice glow-text tracking-wider">{time}</div>
            <div className="text-[9px] text-jarvis-ice/40 uppercase tracking-[0.2em] mt-0.5">{date}</div>
          </div>
        </div>
      </div>
      {/* Hairline gradient divider */}
      <div className="glass-divider" />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-jarvis-ice/30 uppercase tracking-[0.2em]">{label}</span>
      <span className="text-jarvis-cyan/85">{value}</span>
    </span>
  );
}
