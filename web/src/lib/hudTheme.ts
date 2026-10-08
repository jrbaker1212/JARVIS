/**
 * Central palette for the gold / starfield HUD skin.
 * CSS mirrors these in globals.css `:root` as `--hud-*` variables.
 */
export const HUD_PALETTE = {
  goldBase: "#D4AF37",
  goldHighlight: "#FFD27A",
  goldShadow: "#B8860B",
  warnMid: "#E85D04",
  warnHigh: "#DC2626",
  bgNearBlack: "#050508",
  bgVignette: "#07070c",
} as const;

/** Three.js 0xRRGGBB orb particle colors */
export const HUD_GOLD_THREE = {
  base: 0xd4af37,
  highlight: 0xffd27a,
  shadow: 0xb8860b,
  think: 0xffd27a,
  speak: 0xffe8a8,
} as const;

export function ringAccentColor(value: number, normal: string = HUD_PALETTE.goldBase): string {
  if (value > 85) return HUD_PALETTE.warnHigh;
  if (value > 65) return HUD_PALETTE.warnMid;
  return normal;
}
