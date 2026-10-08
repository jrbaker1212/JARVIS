/**
 * AMBIENT WORLD LAYER — sits behind everything.
 *  · Starfield canvas (drift + twinkle)
 *  · 3 very subtle warm blobs — pure CSS animation
 *  · soft edge vignette
 *
 * Pure presentation, pointer-events: none.
 */
import Starfield from "./Starfield";

export default function Atmosphere() {
  return (
    <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
      <Starfield />

      {/* Drifting mesh blobs — low opacity so stars stay primary */}
      <div className="atm-blob atm-blob-1" />
      <div className="atm-blob atm-blob-2" />
      <div className="atm-blob atm-blob-3" />

      {/* Soft edge falloff — frames the scene */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 90% 100% at 50% 50%, transparent 48%, rgba(3,3,5,0.72) 100%)",
        }}
      />
    </div>
  );
}
