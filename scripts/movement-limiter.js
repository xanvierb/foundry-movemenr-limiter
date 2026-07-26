import {
  CLIENT_ACTIVE_TIMEOUT_MS,
  CLIENT_REQUEST_TIMEOUT_MS,
  INTERACTIVE_MOVEMENT_METHODS,
  MAX_EXECUTION_WAYPOINTS,
  MAX_SEGMENT_GRID_SPACES,
  MAX_SOCKET_WAYPOINTS,
  MODULE_ID,
  NOTIFICATION_COOLDOWN_MS,
  POSITION_EPSILON_PX,
  RECENT_REQUEST_TTL_MS,
  SOCKET_CHANNEL,
  STATUS_HEARTBEAT_MS
} from "./constants.js";
import { MovementBucket } from "./movement-bucket.js";
import {
  animationSpeedForDuration,
  currentPosition,
  deduplicateWaypoints,
  movementWaypoints,
  sameSpatialPosition,
  sanitizeWaypoint,
  scheduleSegment,
  splitSegmentByCost
} from "./path-utils.js";
import { Settings } from "./settings.js";

export class MovementLimiter {
  #buckets = new Map();
  #movementDeadlines = new Map();
  #activeMoves = new Map();
  #clientMoves = new Map();
  #lastNotificationAt = 0;
  #recentRequestIds = new Map();
  #socketReady = false;

  ready() {
    if (this.#socketReady) return;
    game.socket.on(SOCKET_CHANNEL, (message) => {
      void this.#onSocketMessage(message);
    });
    this.#socketReady = true;
    this.#pruneRuntimeState();

    const module = game.modules.get(MODULE_ID);
    if (module) {
      module.api = {
        resetBuckets: () => this.resetBuckets(),
        isTokenRestricted: (token, user) =>
          Settings.isTokenRestricted(token, user)
      };
    }
  }

  onSettingsChanged() {
    for (const [key, state] of this.#activeMoves) {
      const token = this.#resolveToken(state.sceneId, state.tokenId);
      const user = game.users.get(state.userId);
      if (!token || !Settings.isTokenRestricted(token, user)) {
        this.#abort(state, "state-changed");
        this.#debug("active movement stopped after settings change", { key });
      }
    }
  }

  onCombatChanged() {
    for (const state of this.#activeMoves.values()) {
      const token = this.#resolveToken(state.sceneId, state.tokenId);
      if (token && Settings.isCombatBypassed(token)) {
        this.#abort(state, "combat");
      }
    }
  }

  resetBuckets() {
    this.#buckets.clear();
  }

  onCanvasReady() {
    this.#pruneRuntimeState();
  }

  onDeleteToken(tokenDocument) {
    const key = this.#tokenKey(tokenDocument.parent?.id, tokenDocument.id);
    this.#buckets.delete(key);
    this.#movementDeadlines.delete(key);
    globalThis.clearTimeout(this.#clientMoves.get(key)?.timeout);
    this.#clientMoves.delete(key);
    const active = this.#activeMoves.get(key);
    if (active) this.#abort(active, "unavailable");
  }

  onDeleteScene(sceneDocument) {
    const prefix = `${sceneDocument.id}.`;
    this.#deleteKeysWithPrefix(this.#buckets, prefix);
    this.#deleteKeysWithPrefix(this.#movementDeadlines, prefix);
    for (const [key, pending] of this.#clientMoves) {
      if (!key.startsWith(prefix)) continue;
      globalThis.clearTimeout(pending.timeout);
      this.#clientMoves.delete(key);
    }
    for (const [key, active] of this.#activeMoves) {
      if (!key.startsWith(prefix)) continue;
      this.#abort(active, "unavailable");
    }
  }

  onPreMoveToken(tokenDocument, movement, operation) {
    try {
      if (!this.#socketReady) return;
      if (game.paused) return;
      if (!INTERACTIVE_MOVEMENT_METHODS.has(movement?.method)) return;
      if (!Settings.isTokenRestricted(tokenDocument, game.user)) return;

      const waypoints = movementWaypoints(movement, MAX_SOCKET_WAYPOINTS);
      if (!waypoints.length) return;

      const sceneId = tokenDocument.parent?.id;
      const tokenId = tokenDocument.id;
      const key = this.#tokenKey(sceneId, tokenId);
      if (!sceneId || !tokenId) return false;

      if (this.#clientMoves.has(key)) {
        this.#notify("MRL.Notifications.Limited");
        this.#debugRejected(tokenDocument, movement, "client movement already pending");
        return false;
      }

      const authority = game.users.activeGM;
      if (!authority) {
        this.#notify("MRL.Notifications.NoActiveGM");
        this.#debugRejected(tokenDocument, movement, "no active GM");
        return false;
      }

      const requestId = foundry.utils.randomID();
      const request = {
        type: "move-request",
        requestId,
        userId: game.user.id,
        sceneId,
        tokenId,
        origin: sanitizeWaypoint(movement.origin) ?? currentPosition(tokenDocument),
        waypoints,
        autoRotate: Boolean(movement.autoRotate),
        requestedMethod: movement.method
      };

      const timeout = globalThis.setTimeout(() => {
        const pending = this.#clientMoves.get(key);
        if (pending?.requestId !== requestId) return;
        this.#clientMoves.delete(key);
        this.#notify("MRL.Notifications.Denied");
      }, CLIENT_REQUEST_TIMEOUT_MS);
      this.#clientMoves.set(key, { requestId, timeout, status: "pending" });

      if (authority.id === game.user.id) {
        queueMicrotask(() => void this.#handleMoveRequest(request));
      } else {
        game.socket.emit(SOCKET_CHANNEL, request);
      }

      this.#debug("movement request intercepted", {
        token: tokenDocument.name,
        requestedDistance: this.#movementGridSpaces(tokenDocument, movement),
        method: movement.method,
        authority: authority.name
      });
      return false;
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to intercept movement`, error);
      this.#notify("MRL.Notifications.Denied");
      return false;
    }
  }

  async #onSocketMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "move-status") {
      this.#handleMoveStatus(message);
      return;
    }
    if (message.type !== "move-request") return;
    if (!this.#isMovementAuthority()) return;
    await this.#handleMoveRequest(message);
  }

  async #handleMoveRequest(request) {
    if (!this.#isMovementAuthority()) return;
    if (!this.#validRequestShape(request)) return;
    if (this.#hasSeenRequest(request.requestId)) return;
    this.#rememberRequest(request.requestId);

    const key = this.#tokenKey(request.sceneId, request.tokenId);
    const user = game.users.get(request.userId);
    const token = this.#resolveToken(request.sceneId, request.tokenId);

    if (!user?.active || !token) {
      this.#sendStatus(request, "rejected", "unavailable");
      return;
    }
    if (game.paused) {
      this.#sendStatus(request, "rejected", "paused");
      return;
    }
    if (
      !token.testUserPermission(
        user,
        CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
      )
    ) {
      this.#sendStatus(request, "rejected", "permission");
      return;
    }
    if (!Settings.isTokenRestricted(token, user)) {
      this.#sendStatus(request, "rejected", "state-changed");
      return;
    }
    if (this.#activeMoves.has(key)) {
      this.#sendStatus(request, "rejected", "busy");
      return;
    }
    if (
      !sameSpatialPosition(
        currentPosition(token),
        request.origin,
        POSITION_EPSILON_PX
      )
    ) {
      this.#sendStatus(request, "rejected", "stale");
      return;
    }

    const state = {
      requestId: request.requestId,
      sceneId: request.sceneId,
      tokenId: request.tokenId,
      userId: request.userId,
      abort: false,
      abortReason: null,
      heartbeat: null
    };
    this.#activeMoves.set(key, state);
    this.#sendStatus(request, "accepted");
    state.heartbeat = globalThis.setInterval(() => {
      if (state.abort || this.#activeMoves.get(key) !== state) return;
      if (!this.#isMovementAuthority()) {
        this.#abort(state, "authority-changed");
        return;
      }
      this.#sendStatus(request, "active");
    }, STATUS_HEARTBEAT_MS);

    try {
      const result = await this.#executeMovement(request, state);
      this.#sendStatus(
        request,
        result.completed ? "complete" : "stopped",
        result.reason
      );
    } catch (error) {
      console.error(`${MODULE_ID} | Movement execution failed`, error);
      this.#sendStatus(request, "rejected", "error");
    } finally {
      globalThis.clearInterval(state.heartbeat);
      if (this.#activeMoves.get(key) === state) this.#activeMoves.delete(key);
    }
  }

  async #executeMovement(request, state) {
    let token = this.#resolveToken(request.sceneId, request.tokenId);
    const user = game.users.get(request.userId);
    if (!token || !user) {
      return { completed: false, reason: "unavailable" };
    }

    let expected = currentPosition(token);
    const path = this.#buildExecutionPath(token, request.waypoints);
    const key = this.#tokenKey(request.sceneId, request.tokenId);
    let movementDeadline =
      this.#movementDeadlines.get(key) ?? MovementBucket.now();

    this.#debug("movement accepted", {
      token: token.name,
      pathWaypoints: path.length,
      speed: Settings.speedForToken(token),
      burst: Settings.maximumBurst
    });

    for (const waypoint of path) {
      if (state.abort) break;

      token = this.#resolveToken(request.sceneId, request.tokenId);
      if (!token || !Settings.isTokenRestricted(token, user) || game.paused) {
        this.#abort(
          state,
          game.paused
            ? "paused"
            : token
              ? "state-changed"
              : "unavailable"
        );
        break;
      }
      if (
        !sameSpatialPosition(
          currentPosition(token),
          expected,
          POSITION_EPSILON_PX
        )
      ) {
        this.#debug("movement cancelled after an external position change", {
          token: token.name,
          expected,
          actual: currentPosition(token)
        });
        this.#abort(state, "stale");
        break;
      }

      const speed = Settings.speedForToken(token);
      const bucket = this.#bucketFor(key, speed, Settings.maximumBurst);
      const cost = this.#measureGridSpaces(token, expected, waypoint);
      const waitMs = bucket.delayFor(cost);
      const before = bucket.snapshot();

      this.#debug("movement segment evaluated", {
        token: token.name,
        requestedDistance: cost,
        available: before.available,
        elapsed: before.elapsedSeconds,
        waitMs,
        allowedMovement: cost
      });

      if (waitMs > 0) await this.#delay(waitMs, state);
      if (state.abort) break;

      token = this.#resolveToken(request.sceneId, request.tokenId);
      if (
        !token ||
        !Settings.isTokenRestricted(token, user) ||
        game.paused ||
        !sameSpatialPosition(
          currentPosition(token),
          expected,
          POSITION_EPSILON_PX
        )
      ) {
        this.#abort(
          state,
          game.paused
            ? "paused"
            : !token
              ? "unavailable"
              : !Settings.isTokenRestricted(token, user)
                ? "state-changed"
                : "stale"
        );
        break;
      }

      bucket.configure(speed, Settings.maximumBurst);
      const startedAt = MovementBucket.now();
      const timing = scheduleSegment(
        movementDeadline,
        cost,
        speed,
        startedAt
      );
      movementDeadline = timing.deadline;
      const durationMs = timing.durationMs;
      const moveOptions = {
        method: "api",
        autoRotate: request.autoRotate,
        showRuler: false,
        animate: durationMs > 0,
        animation: {
          duration: durationMs,
          linkToMovement: true,
          movementSpeed: animationSpeedForDuration(cost, durationMs, speed)
        }
      };
      const moved = await token.move(waypoint, moveOptions);

      if (!moved) {
        this.#debug("movement segment rejected by Foundry", {
          token: token.name,
          waypoint
        });
        this.#abort(state, "prevented");
        break;
      }

      // Only a movement that Foundry actually accepted advances the persistent
      // schedule or spends allowance. Passing startedAt records the debit at
      // the instant movement began, so animation time still regenerates the
      // bucket normally. Rejected clicks and busy-token retries change neither.
      bucket.consume(cost, startedAt);
      this.#movementDeadlines.set(key, movementDeadline);
      expected = currentPosition(token);
      const remainingMs = movementDeadline - MovementBucket.now();
      if (remainingMs > 0) {
        await this.#delay(remainingMs, state);
      }
    }

    return {
      completed: !state.abort,
      reason: state.abortReason
    };
  }

  #buildExecutionPath(token, requestedWaypoints) {
    const origin = currentPosition(token);
    const requested = requestedWaypoints
      .slice(0, MAX_SOCKET_WAYPOINTS)
      .map(sanitizeWaypoint)
      .filter(Boolean);

    let expanded = requested;
    try {
      const complete = token.getCompleteMovementPath([origin, ...requested]);
      if (Array.isArray(complete) && complete.length) {
        expanded = complete.map(sanitizeWaypoint).filter(Boolean);
      }
    } catch (error) {
      this.#debug("complete path expansion unavailable; using requested path", {
        token: token.name,
        error
      });
    }

    expanded = deduplicateWaypoints(expanded);
    while (
      expanded.length &&
      sameSpatialPosition(expanded[0], origin, 0.01)
    ) {
      expanded.shift();
    }

    const result = [];
    let from = origin;
    // Segment size is an execution/detail concern, not bucket capacity. The
    // bucket explicitly supports an indivisible segment exceeding its burst by
    // creating debt. Tying these together creates tiny fractional updates when
    // burst is low and makes Foundry update overhead dominate movement speed.
    const maximumSegmentCost = MAX_SEGMENT_GRID_SPACES;
    for (const to of expanded) {
      const cost = this.#measureGridSpaces(token, from, to);
      const parts = splitSegmentByCost(
        from,
        to,
        cost,
        maximumSegmentCost
      );
      for (const part of parts) {
        if (result.length >= MAX_EXECUTION_WAYPOINTS) break;
        result.push(part);
      }
      if (result.length >= MAX_EXECUTION_WAYPOINTS) break;
      from = to;
    }
    return deduplicateWaypoints(result);
  }

  #measureGridSpaces(token, from, to) {
    const scene = token.parent;
    const grid = scene?.grid;
    const gridSize = Math.max(1, Number(grid?.size) || 1);
    const gridDistance = Math.max(0, Number(grid?.distance) || 0);

    try {
      const measurement = token.measureMovementPath([from, to]);
      const gridless =
        Number(grid?.type) === Number(CONST.GRID_TYPES.GRIDLESS);

      if (
        !gridless &&
        Number.isFinite(measurement.cost) &&
        measurement.cost > 0 &&
        gridDistance > 0
      ) {
        return measurement.cost / gridDistance;
      }
      if (
        !gridless &&
        Number.isFinite(measurement.distance) &&
        measurement.distance > 0 &&
        gridDistance > 0
      ) {
        return measurement.distance / gridDistance;
      }
      if (Number.isFinite(measurement.spaces) && measurement.spaces > 0) {
        return measurement.spaces;
      }
      if (Number.isFinite(measurement.euclidean) && measurement.euclidean > 0) {
        return measurement.euclidean / gridSize;
      }
    } catch (error) {
      this.#debug("Foundry path measurement failed; using pixel fallback", {
        token: token.name,
        error
      });
    }

    const dx = Number(to.x ?? from.x) - Number(from.x);
    const dy = Number(to.y ?? from.y) - Number(from.y);
    const planar = Math.hypot(dx, dy) / gridSize;
    const elevation =
      Math.abs(Number(to.elevation ?? from.elevation ?? 0) -
        Number(from.elevation ?? 0)) /
      Math.max(gridDistance, 1);
    return Math.max(planar, elevation, 0.001);
  }

  #movementGridSpaces(token, movement) {
    const gridDistance = Math.max(0, Number(token.parent?.grid?.distance) || 0);
    const cost = Number(movement?.pending?.cost);
    if (Number.isFinite(cost) && cost > 0 && gridDistance > 0) {
      return cost / gridDistance;
    }
    const distance = Number(movement?.pending?.distance);
    if (Number.isFinite(distance) && distance > 0 && gridDistance > 0) {
      return distance / gridDistance;
    }
    const spaces = Number(movement?.pending?.spaces);
    return Number.isFinite(spaces) ? spaces : null;
  }

  #bucketFor(key, speed, burst) {
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = new MovementBucket(speed, burst);
      this.#buckets.set(key, bucket);
    } else {
      bucket.configure(speed, burst);
    }
    return bucket;
  }

  #handleMoveStatus(message) {
    if (message.userId !== game.user.id) return;
    const key = this.#tokenKey(message.sceneId, message.tokenId);
    const pending = this.#clientMoves.get(key);
    if (!pending || pending.requestId !== message.requestId) return;

    if (message.status === "accepted" || message.status === "active") {
      pending.status = "active";
      globalThis.clearTimeout(pending.timeout);
      pending.timeout = globalThis.setTimeout(() => {
        const active = this.#clientMoves.get(key);
        if (active?.requestId !== message.requestId) return;
        this.#clientMoves.delete(key);
        this.#notify("MRL.Notifications.Denied");
      }, CLIENT_ACTIVE_TIMEOUT_MS);
      return;
    }

    globalThis.clearTimeout(pending.timeout);
    if (message.status === "complete") {
      pending.status = "finishing";
      void this.#releaseAfterLocalAnimation(message, key);
      return;
    }

    this.#clientMoves.delete(key);
    if (message.status === "rejected" || message.status === "stopped") {
      if (["combat", "state-changed"].includes(message.reason)) return;
      const notificationKey =
        message.reason === "stale"
          ? "MRL.Notifications.Stale"
          : message.reason === "paused"
            ? "MRL.Notifications.Paused"
            : "MRL.Notifications.Limited";
      this.#notify(notificationKey);
    }
  }

  async #releaseAfterLocalAnimation(message, key) {
    const token = this.#resolveToken(message.sceneId, message.tokenId);
    const animation = token?.object?.movementAnimationPromise;
    if (animation && typeof animation.then === "function") {
      try {
        await animation;
      } catch (error) {
        this.#debug("local movement animation ended with an error", {
          token: message.tokenId,
          error
        });
      }
    }

    const pending = this.#clientMoves.get(key);
    if (pending?.requestId === message.requestId) {
      this.#clientMoves.delete(key);
    }
  }

  #sendStatus(request, status, reason = null) {
    const message = {
      type: "move-status",
      requestId: request.requestId,
      userId: request.userId,
      sceneId: request.sceneId,
      tokenId: request.tokenId,
      status,
      reason
    };

    if (request.userId === game.user.id) this.#handleMoveStatus(message);
    else game.socket.emit(SOCKET_CHANNEL, message);

    if (status === "rejected" || status === "stopped") {
      this.#debug(`movement ${status}`, {
        token: request.tokenId,
        user: request.userId,
        reason
      });
    }
  }

  #notify(localizationKey) {
    if (!Settings.showNotification) return;
    const now = Date.now();
    if (now - this.#lastNotificationAt < NOTIFICATION_COOLDOWN_MS) return;
    this.#lastNotificationAt = now;
    ui.notifications.info(game.i18n.localize(localizationKey));
  }

  #validRequestShape(request) {
    return (
      typeof request.requestId === "string" &&
      typeof request.userId === "string" &&
      typeof request.sceneId === "string" &&
      typeof request.tokenId === "string" &&
      request.origin &&
      Array.isArray(request.waypoints) &&
      request.waypoints.length > 0 &&
      request.waypoints.length <= MAX_SOCKET_WAYPOINTS
    );
  }

  #isMovementAuthority() {
    return game.users.activeGM?.id === game.user.id;
  }

  #resolveToken(sceneId, tokenId) {
    return game.scenes.get(sceneId)?.tokens.get(tokenId) ?? null;
  }

  #tokenKey(sceneId, tokenId) {
    return `${sceneId ?? "none"}.${tokenId ?? "none"}`;
  }

  #hasSeenRequest(requestId) {
    this.#pruneRecentRequests();
    return this.#recentRequestIds.has(requestId);
  }

  #rememberRequest(requestId) {
    this.#recentRequestIds.set(requestId, Date.now());
  }

  #pruneRecentRequests() {
    const cutoff = Date.now() - RECENT_REQUEST_TTL_MS;
    for (const [requestId, receivedAt] of this.#recentRequestIds) {
      if (receivedAt < cutoff) this.#recentRequestIds.delete(requestId);
    }
  }

  #pruneRuntimeState() {
    for (const key of this.#buckets.keys()) {
      const separator = key.indexOf(".");
      const sceneId = key.slice(0, separator);
      const tokenId = key.slice(separator + 1);
      if (!this.#resolveToken(sceneId, tokenId)) this.#buckets.delete(key);
    }
    for (const key of this.#movementDeadlines.keys()) {
      const separator = key.indexOf(".");
      const sceneId = key.slice(0, separator);
      const tokenId = key.slice(separator + 1);
      if (!this.#resolveToken(sceneId, tokenId)) {
        this.#movementDeadlines.delete(key);
      }
    }
    this.#pruneRecentRequests();
  }

  #deleteKeysWithPrefix(map, prefix) {
    for (const key of map.keys()) {
      if (key.startsWith(prefix)) map.delete(key);
    }
  }

  #abort(state, reason) {
    state.abort = true;
    state.abortReason ??= reason;
  }

  async #delay(durationMs, state) {
    let remaining = Math.max(0, durationMs);
    while (remaining > 0 && !state.abort) {
      const slice = Math.min(remaining, 250);
      await new Promise((resolve) => globalThis.setTimeout(resolve, slice));
      remaining -= slice;
    }
  }

  #debugRejected(token, movement, reason) {
    this.#debug("movement rejected on requesting client", {
      token: token.name,
      requestedDistance: this.#movementGridSpaces(token, movement),
      reason
    });
  }

  #debug(message, details) {
    if (!Settings.debugLogging) return;
    console.debug(`${MODULE_ID} | ${message}`, details ?? "");
  }
}
