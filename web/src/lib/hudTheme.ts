/**
 * Kort red / gold / neon-blue HUD skin.
 * CSS mirrors these in globals.css `:root` as `--hud-*` variables.
 */
export const HUD_PALETTE = {
  goldBase: "#D4AF37",
  goldHighlight: "#FFD27A",
  goldShadow: "#B8860B",
  red: "#FF2E4D",
  redDeep: "#B3122E",
  blue: "#2F8CFF",
  blueHi: "#6CC6FF",
  ice: "#EAF3FF",
  warnMid: "#E85D04",
  warnHigh: "#DC2626",
  bgNearBlack: "#050508",
  bgVignette: "#07070c",
} as const;

export const KORT_GRADIENT_STOPS = ["#FF2E4D", "#D4AF37", "#2F8CFF"] as const;

/** Three.js 0xRRGGBB orb particle colors */
export const HUD_GOLD_THREE = {
  base: 0xd4af37,
  highlight: 0xffd27a,
  shadow: 0xb8860b,
  think: 0x2f8cff,
  speak: 0xff2e4d,
} as const;

export const HUD_KORT_THREE = HUD_GOLD_THREE;

export function ringAccentColor(value: number, normal: string = HUD_PALETTE.goldBase): string {
  if (value > 85) return HUD_PALETTE.warnHigh;
  if (value > 65) return HUD_PALETTE.warnMid;
  return normal;
}
