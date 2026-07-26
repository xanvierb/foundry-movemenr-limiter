import { FLAGS, MODULE_ID, OVERRIDE_MODES } from "./constants.js";
import { Settings } from "./settings.js";

export function registerTokenConfigHook() {
  Hooks.on("renderTokenConfig", renderTokenConfig);
  Hooks.on("renderApplicationV2", (application, html) => {
    const coreTokenConfig = foundry.applications?.sheets?.TokenConfig;
    const isTokenConfig =
      (coreTokenConfig && application instanceof coreTokenConfig) ||
      application.constructor?.name?.includes("TokenConfig");
    if (isTokenConfig) renderTokenConfig(application, html);
  });
}

function renderTokenConfig(application, html) {
  if (game.user.role !== CONST.USER_ROLES.GAMEMASTER) return;

  const tokenDocument = application.document ?? application.object;
  if (tokenDocument?.documentName !== "Token" || !tokenDocument.getFlag) return;

  const root = normalizeRoot(html);
  const form = root?.matches?.("form") ? root : root?.querySelector?.("form");
  if (!form || form.querySelector(".mrl-token-config")) return;

  const override = Settings.tokenOverride(tokenDocument);
  const fieldset = document.createElement("fieldset");
  fieldset.className = "mrl-token-config";
  fieldset.innerHTML = tokenOverrideMarkup(override);

  const footer = form.querySelector("footer, .form-footer");
  if (footer?.parentElement === form) form.insertBefore(fieldset, footer);
  else form.append(fieldset);

  const mode = fieldset.querySelector(
    `[name="flags.${MODULE_ID}.${FLAGS.OVERRIDE_MODE}"]`
  );
  const speed = fieldset.querySelector(
    `[name="flags.${MODULE_ID}.${FLAGS.CUSTOM_SPEED}"]`
  );
  const updateDisabledState = () => {
    speed.disabled = mode.value !== OVERRIDE_MODES.CUSTOM;
    speed.closest(".form-group")?.classList.toggle(
      "mrl-disabled",
      speed.disabled
    );
  };
  mode.addEventListener("change", updateDisabledState);
  updateDisabledState();
}

function normalizeRoot(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return null;
}

function tokenOverrideMarkup(override) {
  const localize = (key) => game.i18n.localize(key);
  const modeName = `flags.${MODULE_ID}.${FLAGS.OVERRIDE_MODE}`;
  const speedName = `flags.${MODULE_ID}.${FLAGS.CUSTOM_SPEED}`;
  const option = (value, key) =>
    `<option value="${value}" ${override.mode === value ? "selected" : ""}>${localize(key)}</option>`;

  return `
    <legend>${localize("MRL.TokenConfig.Legend")}</legend>
    <div class="form-group">
      <label>${localize("MRL.TokenConfig.Override.Name")}</label>
      <div class="form-fields">
        <select name="${modeName}">
          ${option(OVERRIDE_MODES.WORLD, "MRL.TokenConfig.Override.World")}
          ${option(OVERRIDE_MODES.UNLIMITED, "MRL.TokenConfig.Override.Unlimited")}
          ${option(OVERRIDE_MODES.CUSTOM, "MRL.TokenConfig.Override.Custom")}
        </select>
      </div>
      <p class="hint">${localize("MRL.TokenConfig.Override.Hint")}</p>
    </div>
    <div class="form-group">
      <label>${localize("MRL.TokenConfig.CustomSpeed.Name")}</label>
      <div class="form-fields">
        <input
          type="number"
          name="${speedName}"
          value="${override.customSpeed}"
          min="0.1"
          max="20"
          step="0.1"
        >
      </div>
      <p class="hint">${localize("MRL.TokenConfig.CustomSpeed.Hint")}</p>
    </div>
  `;
}
