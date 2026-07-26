export const MODULE_ID = "movement-rate-limiter";
export const SOCKET_CHANNEL = `module.${MODULE_ID}`;

export const SETTINGS = Object.freeze({
  ENABLED: "enabled",
  MOVEMENT_SPEED: "movementSpeed",
  RESTRICTED_ROLES: "restrictedRoles",
  DISABLE_DURING_COMBAT: "disableDuringCombat",
  SHOW_NOTIFICATION: "showNotification",
  DEBUG_LOGGING: "debugLogging"
});

export const FLAGS = Object.freeze({
  OVERRIDE_MODE: "overrideMode",
  CUSTOM_SPEED: "customSpeed"
});

export const OVERRIDE_MODES = Object.freeze({
  WORLD: "world",
  UNLIMITED: "unlimited",
  CUSTOM: "custom"
});

export const RESTRICTED_ROLE_MODES = Object.freeze({
  PLAYERS_ONLY: "playersOnly",
  PLAYERS_AND_TRUSTED: "playersAndTrusted",
  EVERYONE_EXCEPT_GM: "everyoneExceptGM"
});

export const INTERACTIVE_MOVEMENT_METHODS = new Set([
  "dragging",
  "keyboard",
  "hud"
]);

export const NOTIFICATION_COOLDOWN_MS = 1800;
export const CLIENT_REQUEST_TIMEOUT_MS = 10000;
export const CLIENT_ACTIVE_TIMEOUT_MS = 10000;
export const MOVE_SETTLE_GRACE_MS = 500;
export const STATUS_HEARTBEAT_MS = 2500;
export const RECENT_REQUEST_TTL_MS = 60000;
export const MAX_SOCKET_WAYPOINTS = 4096;
export const MAX_EXECUTION_WAYPOINTS = 8192;
export const MAX_SEGMENT_GRID_SPACES = 1.5;
export const POSITION_EPSILON_PX = 1.1;
