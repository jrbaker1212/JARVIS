/**
 * JARVIS Orb — TecTimmy-style particle neural constellation.
 * Cyan/teal wireframe sphere on #0B0F1A — white-cyan core bloom, no face, no gold.
 */
import { useEffect, useRef } from "react";
import { useStore, type OrbState } from "../../lib/store";

const PALETTE: Record<
  OrbState,
  { node: string; core: string; speed: number; intensity: number; breathe: number }
> = {
  idle: {
    node: "#5ee9ff",
    core: "#e8fcff",
    speed: 0.35,
    intensity: 0.88,
    breathe: 1,
  },
  listening: {
    node: "#7df9ff",
    core: "#ffffff",
    speed: 0.55,
    intensity: 1.08,
    breathe: 1.15,
  },
  thinking: {
    node: "#22d3ee",
    core: "#ffffff",
    speed: 1.05,
    intensity: 1.22,
    breathe: 1.25,
  },
  speaking: {
    node: "#a5f3fc",
    core: "#ffffff",
    speed: 0.65,
    intensity: 1.38,
    breathe: 1.4,
  },
};

const STATE_CAPTION: Record<OrbState, string> = {
  idle: "",
  listening: "listening…",
  thinking: "thinking…",
  speaking: "speaking…",
};

const PARTICLE_COUNT = 320;
const NEIGHBORS = 5;

type Particle = {
  bx: number;
  by: number;
  bz: number;
  phase: number;
  size: number;
};

function buildKnnLinks(parts: Particle[], k: number): [number, number][] {
  const set = new Set<string>();
  const links: [number, number][] = [];
  for (let i = 0; i < parts.length; i++) {
    const dists: { j: number; d2: number }[] = [];
    for (let j = 0; j < parts.length; j++) {
      if (i === j) continue;
      const dx = parts[i].bx - parts[j].bx;
      const dy = parts[i].by - parts[j].by;
      const dz = parts[i].bz - parts[j].bz;
      dists.push({ j, d2: dx * dx + dy * dy + dz * dz });
    }
    dists.sort((a, b) => a.d2 - b.d2);
    for (let n = 0; n < Math.min(k, dists.length); n++) {
      const j = dists[n].j;
      const a = Math.min(i, j);
      const b = Math.max(i, j);
      const key = `${a}:${b}`;
      if (set.has(key)) continue;
      set.add(key);
      links.push([a, b]);
    }
  }
  return links;
}

function fibonacciSphere(n: number, r: number): Particle[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: Particle[] = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const x = Math.cos(theta) * rad;
    const z = Math.sin(theta) * rad;
    const shell = 0.88 + Math.random() * 0.14;
    out.push({
      bx: x * r * shell,
      by: y * r * shell,
      bz: z * r * shell,
      phase: Math.random() * Math.PI * 2,
      size: 0.9 + Math.random() * 1.4,
    });
  }
  return out;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export default function Orb() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Inner orb stage — must match canvas layout box (NOT full-screen wrap). */
  const stageRef = useRef<HTMLDivElement>(null);
  const particlesRef = useRef<Particle[] | null>(null);
  const linksRef = useRef<[number, number][]>([]);
  const smoothRef = useRef({
    speed: PALETTE.idle.speed,
    intensity: PALETTE.idle.intensity,
    audio: 0,
    breathe: PALETTE.idle.breathe,
  });
  const orbState = useStore((s) => s.orbState);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = stage.getBoundingClientRect();
      w = Math.max(1, rect.width);
      h = Math.max(1, rect.height);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const radius = Math.min(w, h) * 0.38;
      const parts = fibonacciSphere(PARTICLE_COUNT, radius);
      particlesRef.current = parts;
      linksRef.current = buildKnnLinks(parts, NEIGHBORS);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(stage);

    const draw = (now: number) => {
      const st = useStore.getState();
      const pal = PALETTE[st.orbState];
      const sm = smoothRef.current;
      const k = 0.07;
      sm.speed += (pal.speed - sm.speed) * k;
      sm.intensity += (pal.intensity * (1 + st.audioLevel * 0.55) - sm.intensity) * k;
      sm.audio += (st.audioLevel - sm.audio) * k * 2.2;
      sm.breathe += (pal.breathe - sm.breathe) * k;

      const parts = particlesRef.current;
      if (!parts || w < 8 || h < 8) {
        raf = requestAnimationFrame(draw);
        return;
      }

      const cx = w / 2;
      const cy = h / 2;
      const time = now * 0.001;
      const rotY = time * sm.speed * 0.9;
      const rotX = time * sm.speed * 0.35 + 0.4;
      const audioPulse = sm.audio * 0.22;
      const breathe = 1 + Math.sin(time * 1.6 * sm.breathe) * 0.04 + audioPulse;
      const sizeScale = Math.max(1, Math.min(w, h) / 280);

      ctx.clearRect(0, 0, w, h);

      const sinY = Math.sin(rotY);
      const cosY = Math.cos(rotY);
      const sinX = Math.sin(rotX);
      const cosX = Math.cos(rotX);

      const projected: { x: number; y: number; z: number; i: number; size: number }[] = [];

      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const wobble =
          Math.sin(time * 2.2 + p.phase) * 2.5 * sm.intensity +
          Math.cos(time * 1.7 + p.phase * 1.3) * 1.8;
        let x = p.bx * breathe + wobble * 0.015 * p.bx;
        let y = p.by * breathe + wobble * 0.015 * p.by;
        let z = p.bz * breathe + wobble * 0.015 * p.bz;

        const x1 = x * cosY - z * sinY;
        const z1 = x * sinY + z * cosY;
        x = x1;
        z = z1;
        const y2 = y * cosX - z * sinX;
        const z2 = y * sinX + z * cosX;
        y = y2;
        z = z2;

        const perspective = 420 / (420 - z);
        projected.push({
          x: cx + x * perspective,
          y: cy + y * perspective,
          z,
          i,
          size: p.size * perspective * sizeScale * (0.95 + sm.audio * 0.4),
        });
      }

      projected.sort((a, b) => a.z - b.z);

      const [lr, lg, lb] = hexToRgb(pal.node);
      const byIndex = new Map<number, (typeof projected)[0]>();
      for (const p of projected) byIndex.set(p.i, p);

      ctx.globalCompositeOperation = "lighter";

      ctx.lineCap = "round";
      for (const [ia, ib] of linksRef.current) {
        const pa = byIndex.get(ia);
        const pb = byIndex.get(ib);
        if (!pa || !pb) continue;
        const depth = (pa.z + pb.z) * 0.5;
        const depthNorm = Math.max(0.15, (depth + 160) / 320);
        const alpha = (0.22 + sm.intensity * 0.38) * depthNorm;
        ctx.strokeStyle = `rgba(${lr},${lg},${lb},${Math.min(0.95, alpha)})`;
        ctx.lineWidth = (0.65 + sm.intensity * 0.35) * sizeScale;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }

      for (const p of projected) {
        const depthNorm = Math.max(0.2, (p.z + 160) / 320);
        const alpha = 0.35 + depthNorm * 0.65;
        const glowR = p.size * (2.2 + sm.intensity * 0.6);
        ctx.fillStyle = `rgba(${lr},${lg},${lb},${alpha * 0.45})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, glowR, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = depthNorm > 0.68 ? pal.core : pal.node;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1.1, p.size * 0.85), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      ctx.globalCompositeOperation = "source-over";

      const coreR = Math.min(w, h) * (0.11 + sm.audio * 0.05);
      const bloom = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3.2);
      bloom.addColorStop(0, `rgba(255,255,255,${0.75 * sm.intensity + sm.audio * 0.25})`);
      bloom.addColorStop(0.18, `rgba(186,249,255,${0.42 * sm.intensity})`);
      bloom.addColorStop(0.45, `rgba(0,212,255,${0.14 * sm.intensity})`);
      bloom.addColorStop(1, "rgba(11,15,26,0)");
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 3.2, 0, Math.PI * 2);
      ctx.fill();

      const hot = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 1.15);
      hot.addColorStop(0, `rgba(255,255,255,${0.88 + sm.audio * 0.1})`);
      hot.addColorStop(0.5, `rgba(125,249,255,${0.35 * sm.intensity})`);
      hot.addColorStop(1, "rgba(0,212,255,0)");
      ctx.fillStyle = hot;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 1.15, 0, Math.PI * 2);
      ctx.fill();

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const caption = STATE_CAPTION[orbState];

  return (
    <div className="absolute inset-0 z-[5] pointer-events-none flex flex-col items-center justify-center">
      <div
        ref={stageRef}
        className="relative w-[clamp(280px,38vmin,560px)] aspect-square"
      >
        <div
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{
            background:
              "radial-gradient(circle at center, rgba(0,212,255,0.12) 0%, rgba(14,165,233,0.05) 40%, transparent 68%)",
            filter: "blur(10px)",
            opacity: 0.65,
          }}
        />
        <canvas
          ref={canvasRef}
          className="absolute inset-0 block h-full w-full"
          aria-hidden
        />
      </div>

      <div className="mt-2 flex flex-col items-center gap-1 text-center">
        {caption ? (
          <span
            className="font-sans text-sm tracking-wide text-[#5ee9ff]"
            style={{ textShadow: "0 0 12px rgba(0,212,255,0.45)" }}
          >
            {caption}
          </span>
        ) : null}
        <span className="font-mono text-[10px] tracking-[0.35em] text-[#64748b] uppercase">
          JARVIS
        </span>
      </div>
    </div>
  );
}
