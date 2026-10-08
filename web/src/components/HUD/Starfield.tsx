/**
 * Full-viewport starfield — cheap canvas layer behind all HUD panels.
 * ~300 stars, twinkle + slow drift with depth parallax; pauses when tab hidden.
 */
import { useEffect, useRef } from "react";

const STAR_COUNT = 300;

interface Star {
  x: number;
  y: number;
  z: number;
  r: number;
  phase: number;
  twinkleSpeed: number;
}

export default function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const starsRef = useRef<Star[]>([]);
  const rafRef = useRef(0);
  const pausedRef = useRef(false);
  const driftRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0;
    let h = 0;
    let dpr = 1;

    const seedStars = () => {
      starsRef.current = Array.from({ length: STAR_COUNT }, () => ({
        x: Math.random(),
        y: Math.random(),
        z: 0.12 + Math.random() * 0.88,
        r: 0.35 + Math.random() * 1.35,
        phase: Math.random() * Math.PI * 2,
        twinkleSpeed: 0.35 + Math.random() * 1.25,
      }));
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (starsRef.current.length === 0) seedStars();
    };

    const drawNebula = () => {
      const band = ctx.createLinearGradient(w * 0.05, h * 0.35, w * 0.95, h * 0.62);
      band.addColorStop(0, "rgba(20, 16, 32, 0)");
      band.addColorStop(0.42, "rgba(48, 38, 72, 0.045)");
      band.addColorStop(0.52, "rgba(72, 48, 88, 0.04)");
      band.addColorStop(1, "rgba(20, 16, 32, 0)");
      ctx.fillStyle = band;
      ctx.fillRect(0, 0, w, h);
    };

    const tick = (now: number) => {
      rafRef.current = 0;
      if (pausedRef.current) return;
      rafRef.current = requestAnimationFrame(tick);

      const t = now * 0.001;
      driftRef.current += 0.011;

      ctx.clearRect(0, 0, w, h);
      drawNebula();

      for (const s of starsRef.current) {
        const depth = s.z;
        const parallax = (1 - depth) * 0.12;
        const dx = Math.sin(t * 0.07 + s.phase) * 10 * parallax + driftRef.current * depth * 14;
        const dy = Math.cos(t * 0.05 + s.phase * 1.3) * 8 * parallax + driftRef.current * depth * 9;
        const px = ((s.x * w + dx) % w + w) % w;
        const py = ((s.y * h + dy) % h + h) % h;
        const twinkle = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * s.twinkleSpeed + s.phase));
        const alpha = twinkle * (0.22 + depth * 0.78);
        const radius = s.r * (0.65 + depth * 0.55);

        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 245, 220, ${alpha})`;
        ctx.fill();
      }
    };

    const onVisibility = () => {
      pausedRef.current = document.hidden;
      if (!pausedRef.current && !rafRef.current) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    resize();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full"
      aria-hidden
      style={{ pointerEvents: "none" }}
    />
  );
}
