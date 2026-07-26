import {
  FLAGS,
  MODULE_ID,
  OVERRIDE_MODES,
  RESTRICTED_ROLE_MODES,
  SETTINGS
} from "./constants.js";

export class Settings {
  static register(onChange) {
    const changed = () => onChange?.();

    game.settings.register(MODULE_ID, SETTINGS.ENABLED, {
      name: "MRL.Settings.Enabled.Name",
      hint: "MRL.Settings.Enabled.Hint",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      onChange: changed
    });

    game.settings.register(MODULE_ID, SETTINGS.MOVEMENT_SPEED, {
      name: "MRL.Settings.MovementSpeed.Name",
      hint: "MRL.Settings.MovementSpeed.Hint",
      scope: "world",
      config: true,
      type: Number,
      default: 2,
      range: {
        min: 0.1,
        max: 20,
        step: 0.1
      },
      onChange: changed
    });

    game.settings.register(MODULE_ID, SETTINGS.MAXIMUM_BURST, {
      name: "MRL.Settings.MaximumBurst.Name",
      hint: "MRL.Settings.MaximumBurst.Hint",
      scope: "world",
      config: true,
      type: Number,
      default: 2,
      range: {
        min: 0.1,
        max: 20,
        step: 0.1
      },
      onChange: changed
    });

    game.settings.register(MODULE_ID, SETTINGS.RESTRICTED_ROLES, {
      name: "MRL.Settings.RestrictedRoles.Name",
      hint: "MRL.Settings.RestrictedRoles.Hint",
      scope: "world",
      config: true,
      type: String,
      default: RESTRICTED_ROLE_MODES.PLAYERS_ONLY,
      choices: {
        [RESTRICTED_ROLE_MODES.PLAYERS_ONLY]:
          "MRL.Settings.RestrictedRoles.Choices.PlayersOnly",
        [RESTRICTED_ROLE_MODES.PLAYERS_AND_TRUSTED]:
          "MRL.Settings.RestrictedRoles.Choices.PlayersAndTrusted",
        [RESTRICTED_ROLE_MODES.EVERYONE_EXCEPT_GM]:
          "MRL.Settings.RestrictedRoles.Choices.EveryoneExceptGM"
      },
      onChange: changed
    });

    game.settings.register(MODULE_ID, SETTINGS.DISABLE_DURING_COMBAT, {
      name: "MRL.Settings.DisableDuringCombat.Name",
      hint: "MRL.Settings.DisableDuringCombat.Hint",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      onChange: changed
    });

    game.settings.register(MODULE_ID, SETTINGS.SHOW_NOTIFICATION, {
      name: "MRL.Settings.ShowNotification.Name",
      hint: "MRL.Settings.ShowNotification.Hint",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, SETTINGS.DEBUG_LOGGING, {
      name: "MRL.Settings.DebugLogging.Name",
      hint: "MRL.Settings.DebugLogging.Hint",
      scope: "world",
      config: true,
      type: Boolean,
      default: false
    });
  }

  static get enabled() {
    return Boolean(game.settings.get(MODULE_ID, SETTINGS.ENABLED));
  }

  static get movementSpeed() {
    return Settings.#positiveNumber(
      game.settings.get(MODULE_ID, SETTINGS.MOVEMENT_SPEED),
      2
    );
  }

  static get maximumBurst() {
    return Settings.#positiveNumber(
      game.settings.get(MODULE_ID, SETTINGS.MAXIMUM_BURST),
      2
    );
  }

  static get restrictedRoles() {
    return game.settings.get(MODULE_ID, SETTINGS.RESTRICTED_ROLES);
  }

  static get disableDuringCombat() {
    return Boolean(
      game.settings.get(MODULE_ID, SETTINGS.DISABLE_DURING_COMBAT)
    );
  }

  static get showNotification() {
    return Boolean(game.settings.get(MODULE_ID, SETTINGS.SHOW_NOTIFICATION));
  }

  static get debugLogging() {
    return Boolean(game.settings.get(MODULE_ID, SETTINGS.DEBUG_LOGGING));
  }

  static tokenOverride(tokenDocument) {
    const rawMode = tokenDocument.getFlag(MODULE_ID, FLAGS.OVERRIDE_MODE);
    const mode = Object.values(OVERRIDE_MODES).includes(rawMode)
      ? rawMode
      : OVERRIDE_MODES.WORLD;
    const customSpeed = Settings.#positiveNumber(
      tokenDocument.getFlag(MODULE_ID, FLAGS.CUSTOM_SPEED),
      Settings.movementSpeed
    );
    return { mode, customSpeed };
  }

  static speedForToken(tokenDocument) {
    const override = Settings.tokenOverride(tokenDocument);
    return override.mode === OVERRIDE_MODES.CUSTOM
      ? override.customSpeed
      : Settings.movementSpeed;
  }

  static isRoleRestricted(user) {
    if (!user) return false;

    const roles = CONST.USER_ROLES;
    switch (Settings.restrictedRoles) {
      case RESTRICTED_ROLE_MODES.PLAYERS_AND_TRUSTED:
        return user.role === roles.PLAYER || user.role === roles.TRUSTED;
      case RESTRICTED_ROLE_MODES.EVERYONE_EXCEPT_GM:
        return user.role !== roles.GAMEMASTER;
      case RESTRICTED_ROLE_MODES.PLAYERS_ONLY:
      default:
        return user.role === roles.PLAYER;
    }
  }

  static isTokenRestricted(tokenDocument, user = game.user) {
    if (!Settings.enabled) return false;
    if (!Settings.isRoleRestricted(user)) return false;
    if (Settings.tokenOverride(tokenDocument).mode === OVERRIDE_MODES.UNLIMITED) {
      return false;
    }
    if (Settings.isCombatBypassed(tokenDocument)) return false;
    return true;
  }

  static isCombatBypassed(tokenDocument) {
    if (!Settings.disableDuringCombat) return false;

    const sceneId = tokenDocument?.parent?.id;
    if (!sceneId) return false;

    for (const combat of game.combats ?? []) {
      if (!combat.started) continue;
      const combatSceneId =
        combat.scene?.id ?? combat.scene ?? combat._source?.scene ?? null;
      if (combatSceneId === sceneId) return true;
    }

    const activeCombat = game.combat;
    if (!activeCombat?.started) return false;
    const activeSceneId =
      activeCombat.scene?.id ??
      activeCombat.scene ??
      activeCombat._source?.scene ??
      null;
    return activeCombat.isActive && (!activeSceneId || activeSceneId === sceneId);
  }

  static #positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }
}
