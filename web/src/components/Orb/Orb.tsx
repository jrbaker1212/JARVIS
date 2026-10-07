/**
 * JARVIS Orb — TecTimmy-style particle neural constellation.
 * Cyan/teal wireframe sphere on #0B0F1A — white-cyan core bloom, no face, no gold.
 */
import { useEffect, useRef } from "react";
import { useStore, type OrbState } from "../../lib/store";

const PALETTE: Record<
  OrbState,
  { node: string; line: string; core: string; speed: number; intensity: number; link: number; breathe: number }
> = {
  idle: {
    node: "#5ee9ff",
    line: "rgba(0, 212, 255, 0.28)",
    core: "#e8fcff",
    speed: 0.35,
    intensity: 0.82,
    link: 0.34,
    breathe: 1,
  },
  listening: {
    node: "#7df9ff",
    line: "rgba(94, 233, 255, 0.42)",
    core: "#ffffff",
    speed: 0.55,
    intensity: 1.05,
    link: 0.36,
    breathe: 1.15,
  },
  thinking: {
    node: "#22d3ee",
    line: "rgba(34, 211, 238, 0.48)",
    core: "#ffffff",
    speed: 1.05,
    intensity: 1.18,
    link: 0.38,
    breathe: 1.25,
  },
  speaking: {
    node: "#a5f3fc",
    line: "rgba(125, 249, 255, 0.52)",
    core: "#ffffff",
    speed: 0.65,
    intensity: 1.35,
    link: 0.37,
    breathe: 1.4,
  },
};

const STATE_CAPTION: Record<OrbState, string> = {
  idle: "",
  listening: "listening…",
  thinking: "thinking…",
  speaking: "speaking…",
};

const PARTICLE_COUNT = 260;

type Particle = {
  bx: number;
  by: number;
  bz: number;
  phase: number;
  size: number;
};

function buildLinks(parts: Particle[], maxDist: number): [number, number][] {
  const maxD2 = maxDist * maxDist;
  const links: [number, number][] = [];
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const dx = parts[i].bx - parts[j].bx;
      const dy = parts[i].by - parts[j].by;
      const dz = parts[i].bz - parts[j].bz;
      if (dx * dx + dy * dy + dz * dz <= maxD2) links.push([i, j]);
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
    const jitter = 0.04 + Math.random() * 0.06;
    out.push({
      bx: x * r * (0.92 + jitter * 0.3),
      by: y * r * (0.92 + jitter * 0.3),
      bz: z * r * (0.92 + jitter * 0.3),
      phase: Math.random() * Math.PI * 2,
      size: 0.55 + Math.random() * 1.1,
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
  const wrapRef = useRef<HTMLDivElement>(null);
  const particlesRef = useRef<Particle[] | null>(null);
  const linksRef = useRef<[number, number][]>([]);
  const smoothRef = useRef({
    speed: PALETTE.idle.speed,
    intensity: PALETTE.idle.intensity,
    audio: 0,
    link: PALETTE.idle.link,
    breathe: PALETTE.idle.breathe,
  });
  const orbState = useStore((s) => s.orbState);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let raf = 0;
    let t0 = performance.now();
    let w = 0;
    let h = 0;
    let dpr = 1;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = wrap.getBoundingClientRect();
      w = Math.max(280, rect.width);
      h = Math.max(280, rect.height);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const radius = Math.min(w, h) * 0.36;
      const parts = fibonacciSphere(PARTICLE_COUNT, radius);
      particlesRef.current = parts;
      linksRef.current = buildLinks(parts, radius * 0.38);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const draw = (now: number) => {
      t0 = now;
      const st = useStore.getState();
      const pal = PALETTE[st.orbState];
      const sm = smoothRef.current;
      const k = 0.07;
      sm.speed += (pal.speed - sm.speed) * k;
      sm.intensity += (pal.intensity * (1 + st.audioLevel * 0.55) - sm.intensity) * k;
      sm.audio += (st.audioLevel - sm.audio) * k * 2.2;
      sm.link += (pal.link - sm.link) * k;
      sm.breathe += (pal.breathe - sm.breathe) * k;

      const parts = particlesRef.current;
      if (!parts) {
        raf = requestAnimationFrame(draw);
        return;
      }

      const cx = w / 2;
      const cy = h / 2;
      const time = now * 0.001;
      const rotY = time * sm.speed * 0.9;
      const rotX = time * sm.speed * 0.35 + 0.4;
      const audioPulse = sm.audio * 0.22;
      const breathe = 1 + Math.sin(time * 1.6 * sm.breathe) * 0.035 + audioPulse;

      ctx.clearRect(0, 0, w, h);

      // Soft core bloom (canvas layer)
      const coreR = Math.min(w, h) * (0.14 + sm.audio * 0.06);
      const bloom = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.8);
      bloom.addColorStop(0, `rgba(255,255,255,${0.55 * sm.intensity + sm.audio * 0.35})`);
      bloom.addColorStop(0.2, `rgba(125,249,255,${0.35 * sm.intensity})`);
      bloom.addColorStop(0.55, `rgba(0,212,255,${0.12 * sm.intensity})`);
      bloom.addColorStop(1, "rgba(11,15,26,0)");
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 2.8, 0, Math.PI * 2);
      ctx.fill();

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

        // Y rotation
        const x1 = x * cosY - z * sinY;
        const z1 = x * sinY + z * cosY;
        x = x1;
        z = z1;
        // X rotation
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
          size: p.size * perspective * (0.85 + sm.audio * 0.35),
        });
      }

      projected.sort((a, b) => a.z - b.z);

      const [lr, lg, lb] = hexToRgb(pal.node);
      const byIndex = new Map<number, (typeof projected)[0]>();
      for (const p of projected) byIndex.set(p.i, p);

      // Neural wireframe links (precomputed 3D adjacency)
      ctx.lineCap = "round";
      for (const [ia, ib] of linksRef.current) {
        const pa = byIndex.get(ia);
        const pb = byIndex.get(ib);
        if (!pa || !pb) continue;
        const depth = (pa.z + pb.z) * 0.5;
        const alpha = (0.12 + sm.intensity * 0.28) * (0.35 + (depth + 120) / 240);
        ctx.strokeStyle = `rgba(${lr},${lg},${lb},${alpha})`;
        ctx.lineWidth = 0.45 + sm.intensity * 0.25;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }

      // Nodes
      for (const p of projected) {
        const depthNorm = (p.z + 140) / 280;
        const alpha = 0.25 + depthNorm * 0.75;
        const glow = p.size * (1.2 + sm.intensity * 0.5);
        ctx.fillStyle = `rgba(${lr},${lg},${lb},${alpha * 0.35})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, glow * 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = depthNorm > 0.72 ? pal.core : pal.node;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Hot center
      const hot = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      hot.addColorStop(0, `rgba(255,255,255,${0.92 + sm.audio * 0.08})`);
      hot.addColorStop(0.35, `rgba(186,249,255,${0.55 * sm.intensity})`);
      hot.addColorStop(1, "rgba(0,212,255,0)");
      ctx.fillStyle = hot;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
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
    <div
      ref={wrapRef}
      className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center"
    >
      <div className="relative w-[clamp(280px,38vmin,560px)] aspect-square">
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background:
              "radial-gradient(circle at center, rgba(0,212,255,0.22) 0%, rgba(14,165,233,0.08) 35%, transparent 62%)",
            filter: "blur(14px)",
            opacity: 0.85,
          }}
        />
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
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
