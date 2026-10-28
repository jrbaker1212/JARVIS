/**
 * Kort core emblem — red/gold/neon-blue ring (Diagnostics header badge).
 */
import { useStore } from "../../lib/store";
import { HUD_PALETTE } from "../../lib/hudTheme";

export default function ArcReactor() {
  const orb = useStore((s) => s.orbState);
  const cpu = useStore((s) => s.stats?.cpu ?? 0);
  const ram = useStore((s) => s.stats?.ram.percent ?? 0);
  const intensity = orb === "thinking" || orb === "speaking" ? 1 : 0.7;

  return (
    <div className="relative w-14 h-14 shrink-0">
      <svg viewBox="0 0 56 56" className="absolute inset-0 animate-spin_slow">
        <defs>
          <linearGradient id="kortRingOuter" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#FF2E4D" />
            <stop offset="50%" stopColor="#D4AF37" />
            <stop offset="100%" stopColor="#2F8CFF" />
          </linearGradient>
        </defs>
        <circle
          cx="28"
          cy="28"
          r="26"
          fill="none"
          stroke="url(#kortRingOuter)"
          strokeWidth="0.6"
          strokeDasharray="2 3"
        />
      </svg>
      <svg viewBox="0 0 56 56" className="absolute inset-0">
        <defs>
          <linearGradient id="kortRingCpu" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#FF2E4D" />
            <stop offset="50%" stopColor="#D4AF37" />
            <stop offset="100%" stopColor="#2F8CFF" />
          </linearGradient>
        </defs>
        <circle cx="28" cy="28" r="22" fill="none" stroke="rgba(255,210,122,0.2)" strokeWidth="1.4" />
        <circle
          cx="28" cy="28" r="22"
          fill="none" stroke="url(#kortRingCpu)" strokeWidth="1.4"
          strokeLinecap="round" strokeDasharray={`${(cpu / 100) * 138} 138`}
          transform="rotate(-90 28 28)"
          style={{ filter: "drop-shadow(0 0 4px rgba(212,175,55,0.75))" }}
        />
      </svg>
      <svg viewBox="0 0 56 56" className="absolute inset-0 animate-spin_rev">
        <circle
          cx="28"
          cy="28"
          r="17"
          fill="none"
          stroke={HUD_PALETTE.blueHi}
          strokeOpacity={0.35}
          strokeWidth="0.6"
          strokeDasharray="1 4"
        />
        <circle
          cx="28" cy="28" r="17"
          fill="none" stroke={HUD_PALETTE.blueHi} strokeWidth="0.9"
          strokeLinecap="round" strokeDasharray={`${(ram / 100) * 107} 107`}
          transform="rotate(-90 28 28)"
        />
      </svg>
      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        style={{
          filter: `drop-shadow(0 0 ${3 + intensity * 4}px rgba(255,46,77,${0.5 + intensity * 0.35})) drop-shadow(0 0 ${3 + intensity * 4}px rgba(47,140,255,${0.5 + intensity * 0.35}))`,
        }}
      >
        <span
          className="font-techno font-bold leading-none select-none"
          style={{
            fontSize: "1.375rem",
            backgroundImage: "linear-gradient(135deg, #FF2E4D 0%, #D4AF37 50%, #2F8CFF 100%)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
            WebkitTextFillColor: "transparent",
          }}
          aria-label="Kort core"
        >
          K
        </span>
      </div>
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className="absolute w-px h-1.5"
          style={{
            top: "1px",
            left: "50%",
            background:
              i % 3 === 0
                ? "rgba(255,46,77,0.8)"
                : i % 3 === 1
                  ? "rgba(212,175,55,0.8)"
                  : "rgba(47,140,255,0.8)",
            transformOrigin: "50% 27px",
            transform: `translateX(-50%) rotate(${i * 30}deg)`,
          }}
        />
      ))}
    </div>
  );
}
