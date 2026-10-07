/**
 * JARVIS Orb — TecTimmy-style particle neural constellation.
 * Clean Fibonacci sphere lattice (latitude rings + short meridians), not dense k-NN spaghetti.
 */
import { useEffect, useRef } from "react";
import { useStore, type OrbState } from "../../lib/store";

const PALETTE: Record<
  OrbState,
  { node: string; core: string; speed: number; intensity: number; breathe: number }
> = {
  idle:      { node: "#67e8f9", core: "#f0fdff", speed: 0.22, intensity: 0.9,  breathe: 1 },
  listening: { node: "#7df9ff", core: "#ffffff", speed: 0.32, intensity: 1.05, breathe: 1.08 },
  thinking:  { node: "#22d3ee", core: "#ffffff", speed: 0.48, intensity: 1.15, breathe: 1.12 },
  speaking:  { node: "#a5f3fc", core: "#ffffff", speed: 0.38, intensity: 1.28, breathe: 1.18 },
};

const STATE_CAPTION: Record<OrbState, string> = {
  idle: "",
  listening: "listening…",
  thinking: "thinking…",
  speaking: "speaking…",
};

/** Even Fibonacci shell — primary visible lattice */
const SHELL_COUNT = 198;
/** Tight inner core nodes (bloom only, minimal links) */
const CORE_COUNT = 24;
const LAT_BANDS = 16;

type Particle = {
  bx: number;
  by: number;
  bz: number;
  phase: number;
  size: number;
  layer: "shell" | "core";
};

function addLink(
  parts: Particle[],
  r: number,
  set: Set<string>,
  out: [number, number][],
  a: number,
  b: number,
  maxEdge: number,
  minDot: number,
) {
  if (a === b) return;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const key = `${lo}:${hi}`;
  if (set.has(key)) return;

  const dx = parts[lo].bx - parts[hi].bx;
  const dy = parts[lo].by - parts[hi].by;
  const dz = parts[lo].bz - parts[hi].bz;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 > maxEdge * maxEdge) return;

  const dot = (parts[lo].bx * parts[hi].bx + parts[lo].by * parts[hi].by + parts[lo].bz * parts[hi].bz) / (r * r);
  if (dot < minDot) return;

  set.add(key);
  out.push([lo, hi]);
}

/** Geodesic-style mesh: spiral + latitude rings + one meridian hop per band. */
function buildSphereLattice(parts: Particle[], r: number, shellEnd: number): [number, number][] {
  const set = new Set<string>();
  const links: [number, number][] = [];
  const maxEdge = r * 0.17;
  const minDot = 0.68;

  for (let i = 0; i < shellEnd - 1; i++) {
    addLink(parts, r, set, links, i, i + 1, maxEdge * 1.05, minDot);
  }

  const buckets: number[][] = Array.from({ length: LAT_BANDS }, () => []);
  for (let i = 0; i < shellEnd; i++) {
    const y = parts[i].by / r;
    const b = Math.min(LAT_BANDS - 1, Math.floor(((y + 1) / 2) * LAT_BANDS));
    buckets[b].push(i);
  }

  for (const bucket of buckets) {
    if (bucket.length < 2) continue;
    bucket.sort(
      (a, b) => Math.atan2(parts[a].bz, parts[a].bx) - Math.atan2(parts[b].bz, parts[b].bx),
    );
    for (let k = 0; k < bucket.length - 1; k++) {
      addLink(parts, r, set, links, bucket[k], bucket[k + 1], maxEdge, minDot);
    }
  }

  for (let b = 0; b < LAT_BANDS - 1; b++) {
    for (const i of buckets[b]) {
      let best = -1;
      let bestD = Infinity;
      for (const j of buckets[b + 1]) {
        const dx = parts[i].bx - parts[j].bx;
        const dy = parts[i].by - parts[j].by;
        const dz = parts[i].bz - parts[j].bz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD) {
          bestD = d2;
          best = j;
        }
      }
      if (best >= 0) addLink(parts, r, set, links, i, best, maxEdge, minDot);
    }
  }

  // Inner core: short ring only
  const coreStart = shellEnd;
  for (let i = coreStart; i < parts.length - 1; i++) {
    addLink(parts, r * 0.12, set, links, i, i + 1, r * 0.09, 0.2);
  }
  if (parts.length > coreStart + 2) {
    addLink(parts, r * 0.12, set, links, parts.length - 1, coreStart, r * 0.09, 0.2);
  }

  return links;
}

function fibonacciSphere(n: number, r: number, layer: Particle["layer"], sizeBase: number): Particle[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: Particle[] = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const x = Math.cos(theta) * rad;
    const z = Math.sin(theta) * rad;
    out.push({
      bx: x * r,
      by: y * r,
      bz: z * r,
      phase: (i / n) * Math.PI * 2,
      size: sizeBase + (i % 2) * 0.25,
      layer,
    });
  }
  return out;
}

function buildParticles(r: number): Particle[] {
  const shell = fibonacciSphere(SHELL_COUNT, r, "shell", 1.05);
  const core = fibonacciSphere(CORE_COUNT, r * 0.11, "core", 1.35);
  return [...shell, ...core.map((p) => ({ ...p, layer: "core" as const }))];
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export default function Orb() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const particlesRef = useRef<Particle[] | null>(null);
  const linksRef = useRef<[number, number][]>([]);
  const shellEndRef = useRef(SHELL_COUNT);
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

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = stage.getBoundingClientRect();
      w = Math.max(1, rect.width);
      h = Math.max(1, rect.height);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const radius = Math.min(w, h) * 0.36;
      const parts = buildParticles(radius);
      particlesRef.current = parts;
      shellEndRef.current = SHELL_COUNT;
      linksRef.current = buildSphereLattice(parts, radius, SHELL_COUNT);
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
      sm.intensity += (pal.intensity * (1 + st.audioLevel * 0.45) - sm.intensity) * k;
      sm.audio += (st.audioLevel - sm.audio) * k * 2;
      sm.breathe += (pal.breathe - sm.breathe) * k;

      const parts = particlesRef.current;
      if (!parts || w < 8 || h < 8) {
        raf = requestAnimationFrame(draw);
        return;
      }

      const cx = w / 2;
      const cy = h / 2;
      const time = now * 0.001;
      const rotY = time * sm.speed;
      const rotX = time * sm.speed * 0.28 + 0.35;
      const breathe = 1 + Math.sin(time * 1.2) * 0.018 + sm.audio * 0.12;
      const sizeScale = Math.max(1, Math.min(w, h) / 300);

      ctx.clearRect(0, 0, w, h);

      const sinY = Math.sin(rotY);
      const cosY = Math.cos(rotY);
      const sinX = Math.sin(rotX);
      const cosX = Math.cos(rotX);

      type Proj = { x: number; y: number; z: number; i: number; size: number; layer: Particle["layer"] };
      const projected: Proj[] = [];

      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const wobble = Math.sin(time * 1.6 + p.phase) * (p.layer === "core" ? 0.4 : 1.2);
        let x = p.bx * breathe + (p.bx / (Math.hypot(p.bx, p.by, p.bz) || 1)) * wobble * 0.008;
        let y = p.by * breathe + (p.by / (Math.hypot(p.bx, p.by, p.bz) || 1)) * wobble * 0.008;
        let z = p.bz * breathe + (p.bz / (Math.hypot(p.bx, p.by, p.bz) || 1)) * wobble * 0.008;

        const x1 = x * cosY - z * sinY;
        const z1 = x * sinY + z * cosY;
        x = x1;
        z = z1;
        const y2 = y * cosX - z * sinX;
        const z2 = y * sinX + z * cosX;
        y = y2;
        z = z2;

        const perspective = 440 / (440 - z);
        projected.push({
          x: cx + x * perspective,
          y: cy + y * perspective,
          z,
          i,
          size: p.size * perspective * sizeScale * (p.layer === "core" ? 1.15 : 1),
          layer: p.layer,
        });
      }

      const [lr, lg, lb] = hexToRgb(pal.node);
      const byIndex = new Map<number, Proj>();
      for (const p of projected) byIndex.set(p.i, p);

      const drawLinks = (back: boolean) => {
        ctx.lineCap = "round";
        for (const [ia, ib] of linksRef.current) {
          const pa = byIndex.get(ia);
          const pb = byIndex.get(ib);
          if (!pa || !pb) continue;
          const midZ = (pa.z + pb.z) * 0.5;
          const isBack = midZ < 0;
          if (isBack !== back) continue;

          const depthNorm = Math.max(0.08, Math.min(1, (midZ + 140) / 260));
          const alpha = (back ? 0.06 : 0.14) * depthNorm * sm.intensity;
          ctx.strokeStyle = `rgba(${lr},${lg},${lb},${alpha})`;
          ctx.lineWidth = (back ? 0.28 : 0.42) * sizeScale;
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
        }
      };

      const drawNodes = (back: boolean) => {
        for (const p of projected) {
          const isBack = p.z < 0;
          if (isBack !== back) continue;
          const depthNorm = Math.max(0.1, Math.min(1, (p.z + 140) / 260));
          const alpha = (back ? 0.18 : 0.55) * depthNorm;
          const glowR = p.size * (p.layer === "core" ? 2.8 : 2.1);
          ctx.fillStyle = `rgba(${lr},${lg},${lb},${alpha * 0.35})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, glowR, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = p.layer === "core" || depthNorm > 0.62 ? pal.core : pal.node;
          ctx.globalAlpha = alpha;
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(0.9, p.size * 0.75), 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      };

      const coreR = Math.min(w, h) * (0.1 + sm.audio * 0.04);
      const ambient = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3.5);
      ambient.addColorStop(0, `rgba(255,255,255,${0.32 * sm.intensity + sm.audio * 0.15})`);
      ambient.addColorStop(0.22, `rgba(186,249,255,${0.2 * sm.intensity})`);
      ambient.addColorStop(0.55, `rgba(0,212,255,${0.06 * sm.intensity})`);
      ambient.addColorStop(1, "rgba(11,15,26,0)");
      ctx.fillStyle = ambient;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 3.5, 0, Math.PI * 2);
      ctx.fill();

      drawLinks(true);
      drawNodes(true);
      drawLinks(false);
      drawNodes(false);

      const hot = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 1.25);
      hot.addColorStop(0, `rgba(255,255,255,${0.92 + sm.audio * 0.06})`);
      hot.addColorStop(0.35, `rgba(186,249,255,${0.45 * sm.intensity})`);
      hot.addColorStop(0.75, `rgba(0,212,255,${0.08 * sm.intensity})`);
      hot.addColorStop(1, "rgba(11,15,26,0)");
      ctx.fillStyle = hot;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 1.25, 0, Math.PI * 2);
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
      <div ref={stageRef} className="relative w-[clamp(280px,38vmin,560px)] aspect-square">
        <div
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{
            background:
              "radial-gradient(circle at center, rgba(0,212,255,0.08) 0%, rgba(14,165,233,0.03) 42%, transparent 70%)",
            filter: "blur(12px)",
            opacity: 0.55,
          }}
        />
        <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" aria-hidden />
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
