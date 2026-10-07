/** Register HUD helpers before @elevenlabs/client loads (Electron proof + console). */
type ConvaiGlobal = typeof globalThis & {
  __jarvisConvaiStart?: () => Promise<boolean>;
  __jarvisConvaiStop?: () => Promise<void>;
  __jarvisForceConvaiStart?: () => Promise<unknown>;
  __jarvisConvaiDiag?: () => Promise<unknown>;
};

const g = globalThis as ConvaiGlobal;

g.__jarvisConvaiStart = () =>
  import("./convaiVoice").then((m) => m.startConvaiVoice({ reason: "global-start" }));
g.__jarvisConvaiStop = () => import("./convaiVoice").then((m) => m.stopConvaiVoice());
g.__jarvisForceConvaiStart = () =>
  import("./convaiVoice").then((m) => m.forceConvaiAndStart({ reason: "global-force" }));
g.__jarvisConvaiDiag = () => import("./convaiVoice").then((m) => m.convaiLiveDiag());
