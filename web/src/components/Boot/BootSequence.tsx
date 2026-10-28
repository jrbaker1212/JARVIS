import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useStore } from "../../lib/store";

const LINES = [
  "INITIALISING NEXEY KERNEL ...",
  "LINKING NATURAL-LANGUAGE CORE ...",
  "TUNING COLLECTIVE VOICE ...",
  "ESTABLISHING SECURE LOCAL UPLINK ...",
  "MOUNTING MEMORY AND MISSION CONTEXT ...",
  "DISCOVERING TOOLS AND AGENT PROTOCOLS ...",
  "ALIGNING HOLOGRAPHIC TELEMETRY ...",
  "RUNNING PRE-FLIGHT DIAGNOSTICS ...",
  "READY.",
];

export default function BootSequence() {
  const booted = useStore((s) => s.booted);
  const setBooted = useStore((s) => s.setBooted);
  const [i, setI] = useState(0);

  useEffect(() => {
    if (booted) return;
    if (i < LINES.length) {
      const t = setTimeout(() => setI(i + 1), 240 + Math.random() * 130);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setBooted(true), 450);
    return () => clearTimeout(t);
  }, [i, booted, setBooted]);

  return (
    <AnimatePresence>
      {!booted && (
        <motion.div
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.6 }}
          className="fixed inset-0 z-[1000] bg-jarvis-ink flex items-center justify-center vignette"
        >
          <div className="text-center space-y-6">
            <div className="relative w-40 h-40 mx-auto">
              <motion.div
                className="absolute inset-0 rounded-full"
                style={{
                  background: "radial-gradient(circle, rgba(255,255,255,0.5) 0%, rgba(47,140,255,0.25) 35%, transparent 65%)",
                  filter: "blur(6px)",
                }}
                animate={{ scale: [1, 1.12, 1], opacity: [0.7, 1, 0.7] }}
                transition={{ duration: 1.6, repeat: Infinity }}
              />
              <motion.div
                className="absolute inset-2 rounded-full border border-jarvis-cyan/40"
                animate={{ rotate: 360 }}
                transition={{ duration: 2.4, repeat: Infinity, ease: "linear" }}
              />
              <motion.div
                className="absolute inset-6 rounded-full border border-jarvis-teal/50 border-dashed"
                animate={{ rotate: -360 }}
                transition={{ duration: 3.2, repeat: Infinity, ease: "linear" }}
              />
              <motion.div
                className="absolute inset-[2.75rem] rounded-full bg-white/90 shadow-[0_0_24px_rgba(108,198,255,0.75)]"
                animate={{ scale: [1, 1.15, 1], opacity: [0.85, 1, 0.85] }}
                transition={{ duration: 1.4, repeat: Infinity }}
              />
            </div>

            <div className="text-mono text-xs text-jarvis-cyan/70 space-y-1 text-left min-w-[380px]">
              {LINES.slice(0, i).map((line, idx) => (
                <motion.div
                  key={idx}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="flex items-center gap-2"
                >
                  <span className="text-jarvis-ok">&gt;</span>
                  <span>{line}</span>
                </motion.div>
              ))}
              {i < LINES.length && (
                <div className="flex items-center gap-2 animate-pulse">
                  <span className="text-jarvis-cyan">&gt;</span>
                  <span className="text-jarvis-aqua">{LINES[i]}</span>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
