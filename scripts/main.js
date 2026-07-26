import { MODULE_ID } from "./constants.js";
import { MovementLimiter } from "./movement-limiter.js";
import { Settings } from "./settings.js";
import { registerTokenConfigHook } from "./token-config.js";

const limiter = new MovementLimiter();

Hooks.once("init", () => {
  Settings.register(() => limiter.onSettingsChanged());
  registerTokenConfigHook();

  Hooks.on("preMoveToken", (token, movement, operation) =>
    limiter.onPreMoveToken(token, movement, operation)
  );
  Hooks.on("moveToken", (token, movement, operation, user) =>
    limiter.onMoveToken(token, movement, operation, user)
  );
  Hooks.on("deleteToken", (token) => limiter.onDeleteToken(token));
  Hooks.on("deleteScene", (scene) => limiter.onDeleteScene(scene));
  Hooks.on("canvasReady", () => limiter.onCanvasReady());
  Hooks.on("pauseGame", (paused) => limiter.onPauseChanged(paused));
  Hooks.on("createCombat", () => limiter.onCombatChanged());
  Hooks.on("updateCombat", () => limiter.onCombatChanged());
  Hooks.on("deleteCombat", () => limiter.onCombatChanged());

  console.info(`${MODULE_ID} | Initialized`);
});

Hooks.once("ready", () => limiter.ready());
