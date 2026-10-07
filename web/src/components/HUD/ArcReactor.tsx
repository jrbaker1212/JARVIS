/**
 * HUD core indicator — cyan neural ring (particle-orb skin).
 */
import { useStore } from "../../lib/store";

export default function ArcReactor() {
  const orb = useStore((s) => s.orbState);
  const cpu = useStore((s) => s.stats?.cpu ?? 0);
  const ram = useStore((s) => s.stats?.ram.percent ?? 0);
  const intensity = orb === "thinking" || orb === "speaking" ? 1 : 0.7;

  return (
    <div className="relative w-14 h-14 shrink-0">
      <svg viewBox="0 0 56 56" className="absolute inset-0 animate-spin_slow">
        <circle cx="28" cy="28" r="26" fill="none" stroke="rgba(0,229,255,0.45)" strokeWidth="0.6" strokeDasharray="2 3" />
      </svg>
      <svg viewBox="0 0 56 56" className="absolute inset-0">
        <circle cx="28" cy="28" r="22" fill="none" stroke="rgba(94,233,255,0.18)" strokeWidth="1.4" />
        <circle
          cx="28" cy="28" r="22"
          fill="none" stroke="#22d3ee" strokeWidth="1.4"
          strokeLinecap="round" strokeDasharray={`${(cpu / 100) * 138} 138`}
          transform="rotate(-90 28 28)"
          style={{ filter: "drop-shadow(0 0 4px rgba(34,211,238,0.7))" }}
        />
      </svg>
      <svg viewBox="0 0 56 56" className="absolute inset-0 animate-spin_rev">
        <circle cx="28" cy="28" r="17" fill="none" stroke="rgba(0,212,255,0.30)" strokeWidth="0.6" strokeDasharray="1 4" />
        <circle
          cx="28" cy="28" r="17"
          fill="none" stroke="#00d4ff" strokeWidth="0.9"
          strokeLinecap="round" strokeDasharray={`${(ram / 100) * 107} 107`}
          transform="rotate(-90 28 28)"
        />
      </svg>
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        style={{
          filter: `drop-shadow(0 0 ${3 + intensity * 4}px rgba(0,212,255,${0.55 + intensity * 0.35}))`,
        }}
      >
        <span
          className="font-techno font-bold tracking-[0.12em] text-[9px] leading-none"
          style={{ color: "#7df9ff", textShadow: "0 0 8px rgba(0,212,255,0.65), 0 0 14px rgba(125,249,255,0.35)" }}
        >
          CORE
        </span>
      </div>
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className="absolute w-px h-1.5"
          style={{
            top: "1px",
            left: "50%",
            background: i % 3 === 0 ? "rgba(125,249,255,0.75)" : i % 3 === 1 ? "rgba(34,211,238,0.75)" : "rgba(0,229,255,0.65)",
            transformOrigin: "50% 27px",
            transform: `translateX(-50%) rotate(${i * 30}deg)`,
          }}
        />
      ))}
    </div>
  );
}
