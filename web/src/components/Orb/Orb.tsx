/**
 * JARVIS orb — React shell around ethanplusai/jarvis particle engine (jarvisOrb.ts).
 */
import { useEffect, useRef } from "react";
import { useStore, type OrbState } from "../../lib/store";
import { createJarvisOrb } from "./jarvisOrb";

const STATE_CAPTION: Record<OrbState, string> = {
  idle: "",
  listening: "listening…",
  thinking: "thinking…",
  speaking: "speaking…",
};

export default function Orb() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orbState = useStore((s) => s.orbState);
  const caption = STATE_CAPTION[orbState];

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;

    const orb = createJarvisOrb(canvas, stage, {
      getOrbState: () => useStore.getState().orbState,
      getAudioLevel: () => useStore.getState().audioLevel,
    });

    return () => orb.destroy();
  }, []);

  return (
    <div className="absolute inset-0 z-[5] pointer-events-none flex flex-col items-center justify-center">
      <div
        ref={stageRef}
        className="relative w-[clamp(280px,38vmin,560px)] aspect-square overflow-hidden rounded-full"
        style={{ background: "#0b0f1a" }}
      >
        <canvas ref={canvasRef} className="block h-full w-full" aria-hidden />
      </div>

      <div className="mt-2 flex flex-col items-center gap-0.5 text-center">
        {caption ? (
          <span
            className="font-sans text-sm tracking-wide text-[#5ee9ff]/90"
            style={{ textShadow: "0 0 10px rgba(0,212,255,0.35)" }}
          >
            {caption}
          </span>
        ) : null}
        <span className="font-mono text-[9px] tracking-[0.4em] text-[#475569]/90 uppercase">
          JARVIS
        </span>
      </div>
    </div>
  );
}
