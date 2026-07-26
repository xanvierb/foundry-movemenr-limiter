import {
  CLIENT_ACTIVE_TIMEOUT_MS,
  CLIENT_REQUEST_TIMEOUT_MS,
  INTERACTIVE_MOVEMENT_METHODS,
  MAX_EXECUTION_WAYPOINTS,
  MAX_SEGMENT_GRID_SPACES,
  MAX_SOCKET_WAYPOINTS,
  MODULE_ID,
  MOVE_SETTLE_GRACE_MS,
  NOTIFICATION_COOLDOWN_MS,
  POSITION_EPSILON_PX,
  RECENT_REQUEST_TTL_MS,
  SOCKET_CHANNEL,
  STATUS_HEARTBEAT_MS
} from "./constants.js";
import { delayUntil, monotonicNow, settleWithin } from "./async-utils.js";
import {
  currentPosition,
  deduplicateWaypoints,
  measuredGridSpaces,
  movementWaypoints,
  sameSpatialPosition,
  sanitizeWaypoint,
  scheduleSegment,
  splitSegmentByCost
} from "./path-utils.js";
import { Settings } from "./settings.js";

export class MovementLimiter {
  #activeMoves = new Map();
  #clientMoves = new Map();
  #lastNotificationAt = 0;
  #recentRequestIds = new Map();
  #socketReady = false;
  #timings;

  constructor(timings = {}) {
    this.#timings = {
      clientRequestTimeoutMs: CLIENT_REQUEST_TIMEOUT_MS,
      clientActiveTimeoutMs: CLIENT_ACTIVE_TIMEOUT_MS,
      moveSettleGraceMs: MOVE_SETTLE_GRACE_MS,
      statusHeartbeatMs: STATUS_HEARTBEAT_MS,
      ...timings
    };
  }

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

  onPauseChanged(paused) {
    if (!paused) return;
    for (const state of this.#activeMoves.values()) {
      this.#abort(state, "paused");
    }
  }

  onCanvasReady() {
    this.#pruneRuntimeState();
  }

  onDeleteToken(tokenDocument) {
    const key = this.#tokenKey(tokenDocument.parent?.id, tokenDocument.id);
    globalThis.clearTimeout(this.#clientMoves.get(key)?.timeout);
    this.#clientMoves.delete(key);
    const active = this.#activeMoves.get(key);
    if (active) this.#abort(active, "unavailable");
  }

  onDeleteScene(sceneDocument) {
    const prefix = `${sceneDocument.id}.`;
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

  onMoveToken(tokenDocument, movement, operation, user) {
    const key = this.#tokenKey(tokenDocument.parent?.id, tokenDocument.id);
    const active = this.#activeMoves.get(key);
    if (!active?.currentDestination || movement?.method !== "api") return;

    const initiatingUserId =
      user?.id ?? movement?.user?.id ?? movement?.user ?? operation?.userId;
    if (initiatingUserId && initiatingUserId !== game.user.id) return;

    // v13 can generate its own movement ID even if one is supplied to move().
    // Capture its real ID and constrained destination from the authoritative
    // hook so timeout cleanup still owns the correct operation.
    active.currentMovementId = movement.id ?? tokenDocument.movement?.id ?? null;
    active.currentDestination =
      this.#materializePosition(
        movement.destination,
        active.currentDestination
      ) ?? active.currentDestination;
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

      const intent = this.#captureClientIntent(
        tokenDocument,
        movement,
        waypoints
      );
      if (!intent) return false;

      const pending = this.#clientMoves.get(key);
      if (pending) {
        // Keep at most the latest intent. Repeated keyboard input no longer
        // disappears silently and, importantly, never changes the active
        // request's deadline.
        pending.queuedIntent = intent;
        this.#debugRejected(
          tokenDocument,
          movement,
          "client movement queued behind active request"
        );
        return false;
      }

      this.#dispatchClientIntent(tokenDocument, intent);
      return false;
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to intercept movement`, error);
      this.#notify("MRL.Notifications.Denied");
      return false;
    }
  }

  #dispatchClientIntent(tokenDocument, intent, authoritativeOrigin = null) {
    const resolved = this.#resolveClientIntent(
      tokenDocument,
      intent,
      authoritativeOrigin
    );
    if (!resolved.waypoints.length) return;

    const authority = game.users.activeGM;
    if (!authority) {
      this.#notify("MRL.Notifications.NoActiveGM");
      this.#debug("movement request rejected on requesting client", {
        token: tokenDocument.name,
        reason: "no active GM"
      });
      return;
    }

    const requestId = foundry.utils.randomID();
    const key = this.#tokenKey(intent.sceneId, intent.tokenId);
    const request = {
      type: "move-request",
      requestId,
      userId: game.user.id,
      sceneId: intent.sceneId,
      tokenId: intent.tokenId,
      // The movement operation's origin may refer to an earlier history chain.
      // The source document position is the only safe concurrency anchor.
      origin: resolved.origin,
      waypoints: resolved.waypoints,
      autoRotate: Boolean(intent.autoRotate),
      requestedMethod: intent.requestedMethod
    };

    const timeout = globalThis.setTimeout(() => {
      const pending = this.#clientMoves.get(key);
      if (pending?.requestId !== requestId) return;
      this.#finishClientMove(request, key, true);
      this.#notify("MRL.Notifications.Denied");
    }, this.#timings.clientRequestTimeoutMs);
    this.#clientMoves.set(key, {
      requestId,
      timeout,
      status: "pending",
      queuedIntent: null
    });

    if (authority.id === game.user.id) {
      queueMicrotask(() => void this.#handleMoveRequest(request));
    } else {
      game.socket.emit(SOCKET_CHANNEL, request);
    }

    this.#debug("movement request intercepted", {
      token: tokenDocument.name,
      requestedDistance: this.#measureRequestedGridSpaces(
        tokenDocument,
        request.origin,
        request.waypoints.at(-1)
      ),
      method: intent.requestedMethod,
      authority: authority.name,
      effectiveSpeed: Settings.speedForToken(tokenDocument)
    });
  }

  #captureClientIntent(tokenDocument, movement, waypoints) {
    const sceneId = tokenDocument.parent?.id;
    const tokenId = tokenDocument.id;
    const documentOrigin = currentPosition(tokenDocument);
    const movementOrigin = this.#materializePosition(
      movement?.origin,
      documentOrigin
    );
    const destinationSource = sanitizeWaypoint(waypoints.at(-1));
    const destination = this.#materializePosition(
      destinationSource,
      movementOrigin
    );
    if (!sceneId || !tokenId || !movementOrigin || !destination) return null;

    const common = {
      sceneId,
      tokenId,
      autoRotate: Boolean(movement.autoRotate),
      requestedMethod: movement.method
    };
    const metadata = this.#waypointMetadata(destinationSource);

    if (movement.method === "keyboard") {
      return {
        ...common,
        mode: "relative",
        delta: {
          x: destination.x - movementOrigin.x,
          y: destination.y - movementOrigin.y,
          elevation: destination.elevation - movementOrigin.elevation
        },
        level:
          destinationSource?.level !== undefined
            ? destinationSource.level
            : undefined,
        metadata
      };
    }

    if (movement.method === "hud") {
      return {
        ...common,
        mode: "hud",
        elevation:
          destinationSource?.elevation !== undefined
            ? destination.elevation
            : undefined,
        level:
          destinationSource?.level !== undefined
            ? destinationSource.level
            : undefined,
        metadata
      };
    }

    return {
      ...common,
      mode: "absolute",
      capturedOrigin: movementOrigin,
      waypoints: waypoints.map((waypoint) => ({ ...waypoint })),
      destination,
      metadata
    };
  }

  #resolveClientIntent(tokenDocument, intent, authoritativeOrigin = null) {
    const documentOrigin = currentPosition(tokenDocument);
    const origin =
      (authoritativeOrigin
        ? this.#materializePosition(authoritativeOrigin, documentOrigin)
        : null) ?? documentOrigin;
    let waypoints;

    if (intent.mode === "relative") {
      const destination = {
        ...origin,
        ...intent.metadata,
        x: origin.x + intent.delta.x,
        y: origin.y + intent.delta.y,
        elevation: origin.elevation + intent.delta.elevation
      };
      if (intent.level !== undefined) destination.level = intent.level;
      waypoints = [destination];
    } else if (intent.mode === "hud") {
      const destination = { ...origin, ...intent.metadata };
      if (intent.elevation !== undefined) {
        destination.elevation = intent.elevation;
      }
      if (intent.level !== undefined) destination.level = intent.level;
      waypoints = [destination];
    } else {
      const originUnchanged = sameSpatialPosition(
        origin,
        intent.capturedOrigin,
        POSITION_EPSILON_PX
      );
      // Old drag-ruler intermediates are unsafe after another move. Foundry
      // will constrain a fresh direct path from the new origin to the same
      // absolute destination on the authority.
      waypoints = originUnchanged
        ? intent.waypoints
        : [{ ...intent.destination, ...intent.metadata }];
    }

    const materialized = [];
    let from = origin;
    for (const waypoint of waypoints ?? []) {
      const resolved = this.#materializePosition(waypoint, from);
      if (!resolved) continue;
      if (!sameSpatialPosition(from, resolved, 0.01)) {
        materialized.push(resolved);
      }
      from = resolved;
    }
    return { origin, waypoints: deduplicateWaypoints(materialized) };
  }

  #materializePosition(waypoint, fallback) {
    const clean = sanitizeWaypoint(waypoint) ?? {};
    const position = {
      ...fallback,
      ...clean,
      x: Number(clean.x ?? fallback?.x),
      y: Number(clean.y ?? fallback?.y),
      elevation: Number(clean.elevation ?? fallback?.elevation ?? 0)
    };
    if (
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.elevation)
    ) {
      return null;
    }
    return position;
  }

  #waypointMetadata(waypoint) {
    const metadata = {};
    for (const field of ["action", "snapped", "explicit", "checkpoint"]) {
      if (waypoint?.[field] !== undefined) metadata[field] = waypoint[field];
    }
    return metadata;
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
      heartbeat: null,
      controller: new AbortController(),
      currentMovementId: null,
      currentDestination: null
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
    }, this.#timings.statusHeartbeatMs);

    try {
      const result = await this.#executeMovement(request, state);
      const finalToken = this.#resolveToken(request.sceneId, request.tokenId);
      this.#sendStatus(
        request,
        result.completed ? "complete" : "stopped",
        result.reason,
        {
          movementId: result.movementId ?? null,
          finalPosition: finalToken ? currentPosition(finalToken) : null
        }
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
    const builtPath = this.#buildExecutionPath(token, request.waypoints);
    if (builtPath.truncated) {
      return { completed: false, reason: "path-too-long", movementId: null };
    }
    const path = builtPath.waypoints;
    if (!path.length) {
      return { completed: false, reason: "prevented", movementId: null };
    }
    // The pacing deadline belongs to this accepted request only. Busy/rejected
    // clicks cannot mutate it, and a later request never inherits stale debt.
    let movementDeadline = monotonicNow();
    let finalMovementId = null;

    this.#debug("movement accepted", {
      token: token.name,
      pathWaypoints: path.length,
      speed: Settings.speedForToken(token)
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
      const cost = this.#measureGridSpaces(token, expected, waypoint);

      this.#debug("movement segment evaluated", {
        token: token.name,
        requestedDistance: cost,
        allowedMovement: cost,
        effectiveSpeed: speed
      });

      const startedAt = monotonicNow();
      const timing = scheduleSegment(movementDeadline, cost, speed, startedAt);
      movementDeadline = timing.deadline;
      const durationMs = timing.durationMs;
      const movementId = foundry.utils.randomID();
      const moveOptions = {
        id: movementId,
        method: "api",
        autoRotate: request.autoRotate,
        showRuler: false,
        pan: false,
        animate: durationMs > 0,
        animation: {
          duration: durationMs,
          linkToMovement: true
        }
      };
      const moveResult = await this.#moveSegmentWithinDeadline(
        token,
        waypoint,
        moveOptions,
        timing.deadline,
        state
      );
      if (moveResult.movementId) {
        finalMovementId = moveResult.movementId;
      }

      if (!moveResult.moved) {
        this.#debug("movement segment rejected by Foundry", {
          token: token.name,
          waypoint,
          reason: moveResult.reason
        });
        this.#abort(state, moveResult.reason ?? "prevented");
        break;
      }

      finalMovementId ??= movementId;
      expected = currentPosition(token);
      await delayUntil(movementDeadline, {
        signal: state.controller.signal
      });
    }

    return {
      completed: !state.abort,
      reason: state.abortReason,
      movementId: finalMovementId
    };
  }

  async #moveSegmentWithinDeadline(
    token,
    waypoint,
    moveOptions,
    segmentDeadline,
    state
  ) {
    state.currentDestination = this.#materializePosition(
      waypoint,
      currentPosition(token)
    );
    state.currentMovementId = null;

    let movePromise;
    try {
      movePromise = Promise.resolve(token.move(waypoint, moveOptions));
    } catch (error) {
      state.currentDestination = null;
      throw error;
    }

    this.#captureCurrentMovementId(token, state);
    // Foundry's promise includes document-update bookkeeping in addition to
    // the configured animation. Give that bookkeeping a bounded chance to
    // settle; the cumulative pacing deadline itself is not extended by it.
    const timeoutMs =
      Math.max(0, segmentDeadline - monotonicNow()) +
      this.#timings.moveSettleGraceMs;
    const outcome = await settleWithin(movePromise, timeoutMs, {
      signal: state.controller.signal
    });

    if (outcome.status === "fulfilled") {
      const movementId = state.currentMovementId;
      state.currentDestination = null;
      state.currentMovementId = null;
      return {
        moved: Boolean(outcome.value),
        reason: outcome.value ? null : "prevented",
        movementId
      };
    }
    if (outcome.status === "rejected") {
      state.currentDestination = null;
      state.currentMovementId = null;
      throw outcome.error;
    }

    const current = this.#resolveToken(state.sceneId, state.tokenId);
    this.#captureCurrentMovementId(current, state);
    const movementId = state.currentMovementId;
    const shouldStop = this.#isCurrentMovementOwned(
      current,
      state,
      moveOptions.id
    );
    if (current && shouldStop) {
      try {
        const stopped = current.stopMovement();
        this.#debug("movement deadline cleanup", {
          token: state.tokenId,
          movementId,
          stopped
        });
      } catch (error) {
        this.#debug("failed to stop timed-out movement", {
          token: state.tokenId,
          error
        });
      }
    }

    const reachedDestination =
      outcome.status === "timeout" &&
      shouldStop &&
      state.currentDestination &&
      sameSpatialPosition(
        currentPosition(current),
        state.currentDestination,
        POSITION_EPSILON_PX
      );

    state.currentDestination = null;
    state.currentMovementId = null;

    return {
      moved: Boolean(reachedDestination),
      reason: reachedDestination
        ? null
        : outcome.status === "timeout"
          ? "timeout"
          : state.abortReason,
      movementId
    };
  }

  #captureCurrentMovementId(token, state) {
    const movement = token?.movement;
    if (!movement || movement.method !== "api" || !state.currentDestination) {
      return;
    }
    const initiatingUserId = movement.user?.id ?? movement.user;
    const sameDestination = sameSpatialPosition(
      movement.destination,
      state.currentDestination,
      POSITION_EPSILON_PX
    );
    if (
      !sameDestination &&
      (!initiatingUserId || initiatingUserId !== game.user.id)
    ) {
      return;
    }
    state.currentMovementId = movement.id ?? state.currentMovementId;
    state.currentDestination =
      this.#materializePosition(
        movement.destination,
        state.currentDestination
      ) ?? state.currentDestination;
  }

  #isCurrentMovementOwned(token, state, requestedMovementId) {
    if (!token) return false;
    const movement = token?.movement;
    if (!movement?.id && !movement?.method) return true;
    if (
      state.currentMovementId &&
      movement?.id === state.currentMovementId
    ) {
      return true;
    }
    if (movement?.id === requestedMovementId) return true;
    const initiatingUserId = movement?.user?.id ?? movement?.user;
    if (
      movement?.method === "api" &&
      initiatingUserId === game.user.id
    ) {
      return true;
    }
    return (
      movement?.method === "api" &&
      state.currentDestination &&
      sameSpatialPosition(
        movement.destination,
        state.currentDestination,
        POSITION_EPSILON_PX
      )
    );
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
    const maximumSegmentCost = MAX_SEGMENT_GRID_SPACES;
    for (const to of expanded) {
      const cost = this.#measureGridSpaces(token, from, to);
      const parts = splitSegmentByCost(
        from,
        to,
        cost,
        maximumSegmentCost,
        MAX_EXECUTION_WAYPOINTS - result.length
      );
      if (!parts) return { waypoints: [], truncated: true };
      for (const part of parts) {
        result.push(part);
      }
      from = to;
    }
    return { waypoints: deduplicateWaypoints(result), truncated: false };
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
      const measured = measuredGridSpaces(measurement, {
        gridless,
        gridSize,
        gridDistance
      });
      if (measured !== null) return measured;
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
    const grid = token.parent?.grid;
    return measuredGridSpaces(movement?.pending, {
      gridless:
        Number(grid?.type) === Number(CONST.GRID_TYPES.GRIDLESS),
      gridSize: grid?.size,
      gridDistance: grid?.distance
    });
  }

  #measureRequestedGridSpaces(token, from, to) {
    if (!from || !to) return null;
    return this.#measureGridSpaces(token, from, to);
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
        this.#finishClientMove(message, key, true);
        this.#notify("MRL.Notifications.Denied");
      }, this.#timings.clientActiveTimeoutMs);
      return;
    }

    globalThis.clearTimeout(pending.timeout);
    if (message.status === "complete") {
      // Authority completion already occurs at the configured movement
      // deadline. Never stack a second client-side animation grace period.
      this.#finishClientMove(message, key, true);
      return;
    }

    if (message.status === "rejected" || message.status === "stopped") {
      const replayQueued = [
        "busy",
        "prevented",
        "stale",
        "timeout",
        "error"
      ].includes(message.reason);
      this.#finishClientMove(message, key, replayQueued);
      if (["combat", "state-changed"].includes(message.reason)) return;
      let notificationKey;
      if (message.reason === "stale") {
        notificationKey = "MRL.Notifications.Stale";
      } else if (message.reason === "paused") {
        notificationKey = "MRL.Notifications.Paused";
      } else if (["busy", "prevented"].includes(message.reason)) {
        notificationKey = "MRL.Notifications.Limited";
      } else {
        notificationKey = "MRL.Notifications.Denied";
      }
      this.#notify(notificationKey);
      return;
    }

    this.#finishClientMove(message, key, false);
  }

  #finishClientMove(message, key, runQueuedIntent) {
    const pending = this.#clientMoves.get(key);
    if (!pending || pending.requestId !== message.requestId) return;

    const queuedIntent = runQueuedIntent ? pending.queuedIntent : null;
    globalThis.clearTimeout(pending.timeout);
    this.#clientMoves.delete(key);

    if (!queuedIntent) return;
    queueMicrotask(() => {
      if (this.#clientMoves.has(key)) return;
      const token = this.#resolveToken(
        queuedIntent.sceneId,
        queuedIntent.tokenId
      );
      if (!token || !Settings.isTokenRestricted(token, game.user)) return;
      this.#dispatchClientIntent(token, queuedIntent, message.finalPosition);
    });
  }

  #sendStatus(request, status, reason = null, details = {}) {
    const message = {
      type: "move-status",
      requestId: request.requestId,
      userId: request.userId,
      sceneId: request.sceneId,
      tokenId: request.tokenId,
      status,
      reason,
      ...details
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
    if (localizationKey === "MRL.Notifications.Limited") {
      if (!Settings.showNotification) return;
      const now = Date.now();
      if (now - this.#lastNotificationAt < NOTIFICATION_COOLDOWN_MS) return;
      this.#lastNotificationAt = now;
    }
    ui.notifications.info(game.i18n.localize(localizationKey));
  }

  #validRequestShape(request) {
    const origin = sanitizeWaypoint(request.origin);
    return (
      typeof request.requestId === "string" &&
      typeof request.userId === "string" &&
      typeof request.sceneId === "string" &&
      typeof request.tokenId === "string" &&
      origin &&
      Number.isFinite(origin.x) &&
      Number.isFinite(origin.y) &&
      Array.isArray(request.waypoints) &&
      request.waypoints.length > 0 &&
      request.waypoints.length <= MAX_SOCKET_WAYPOINTS &&
      request.waypoints.every((waypoint) => sanitizeWaypoint(waypoint))
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
    for (const [key, pending] of this.#clientMoves) {
      const separator = key.indexOf(".");
      const sceneId = key.slice(0, separator);
      const tokenId = key.slice(separator + 1);
      if (this.#resolveToken(sceneId, tokenId)) continue;
      globalThis.clearTimeout(pending.timeout);
      this.#clientMoves.delete(key);
    }
    for (const state of this.#activeMoves.values()) {
      if (!this.#resolveToken(state.sceneId, state.tokenId)) {
        this.#abort(state, "unavailable");
      }
    }
    this.#pruneRecentRequests();
  }

  #abort(state, reason) {
    if (state.abort) return;
    state.abort = true;
    state.abortReason ??= reason;
    state.controller?.abort(reason);
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
