/**
 * JARVIS orb shell — React Three Fiber + WireframeGeometry lat/long lattice.
 */
import { Canvas } from "@react-three/fiber";
import { Suspense } from "react";
import { useStore, type OrbState } from "../../lib/store";
import OrbGlobe from "./OrbGlobe";

const STATE_CAPTION: Record<OrbState, string> = {
  idle: "",
  listening: "listening…",
  thinking: "thinking…",
  speaking: "speaking…",
};

export default function Orb() {
  const orbState = useStore((s) => s.orbState);
  const caption = STATE_CAPTION[orbState];

  return (
    <div className="absolute inset-0 z-[5] pointer-events-none flex flex-col items-center justify-center">
      <div
        className="relative w-[clamp(280px,38vmin,560px)] aspect-square rounded-full overflow-hidden"
        style={{ background: "radial-gradient(circle, rgba(11,15,26,0.2) 0%, #0b0f1a 72%)" }}
      >
        <Canvas
          dpr={[1, 2]}
          gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
          camera={{ position: [0, 0, 2.65], fov: 42, near: 0.1, far: 20 }}
          style={{ background: "transparent" }}
        >
          <color attach="background" args={["#0b0f1a"]} />
          <Suspense fallback={null}>
            <OrbGlobe />
          </Suspense>
        </Canvas>
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
