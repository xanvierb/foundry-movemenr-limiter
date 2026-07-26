import assert from "node:assert/strict";
import test from "node:test";

import { MovementLimiter } from "../scripts/movement-limiter.js";
import { SOCKET_CHANNEL } from "../scripts/constants.js";

const FAST_TIMINGS = Object.freeze({
  clientRequestTimeoutMs: 200,
  clientActiveTimeoutMs: 200,
  moveSettleGraceMs: 20,
  statusHeartbeatMs: 3
});

const GLOBAL_NAMES = ["game", "foundry", "CONST", "ui"];

test("authority completion never adds a second local animation wait", async () => {
  const never = new Promise(() => {});

  await withFoundryMock(
    { currentUser: "player", animationPromise: never },
    async (mock) => {
      const limiter = mock.createLimiter();
      limiter.ready();

      limiter.onPreMoveToken(mock.token, keyboardMovement(100), {});
      const first = mock.moveRequests()[0];
      assert.ok(first);

      mock.deliver(statusFor(first, "accepted"));
      const completedAt = performance.now();
      mock.deliver(statusFor(first, "complete"));

      // A stale local animation promise must not add another wait after the
      // authority has already completed the configured movement window.
      limiter.onPreMoveToken(mock.token, keyboardMovement(200), {});

      await waitFor(
        () => mock.moveRequests().length === 2,
        "authority completion did not release the queued move"
      );
      assert.ok(performance.now() - completedAt < 50);
    }
  );
});

test("a repeated keyboard step is rebased after the first broadcast", async () => {
  await withFoundryMock({ currentUser: "player" }, async (mock) => {
    const limiter = mock.createLimiter();
    limiter.ready();

    limiter.onPreMoveToken(mock.token, keyboardMovement(100), {});
    const first = mock.moveRequests()[0];
    assert.ok(first);

    // Browsers can emit the same 0 -> 100 operation again before the first
    // document broadcast updates _source. It represents another +100 step,
    // not the already-running absolute destination.
    limiter.onPreMoveToken(mock.token, keyboardMovement(100), {});
    assert.equal(mock.moveRequests().length, 1);

    // Rebase the queued request from the position committed by the first move.
    mock.token._source.x = 100;
    mock.deliver(statusFor(first, "complete"));

    await waitFor(
      () => mock.moveRequests().length === 2,
      "the latest queued movement was not dispatched"
    );
    const requests = mock.moveRequests();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].origin.x, 100);
    assert.equal(requests[1].waypoints.at(-1).x, 200);
  });
});

test("authority completion can precede the local document broadcast", async () => {
  await withFoundryMock({ currentUser: "player" }, async (mock) => {
    const limiter = mock.createLimiter();
    limiter.ready();

    limiter.onPreMoveToken(mock.token, keyboardMovement(100), {});
    const first = mock.moveRequests()[0];
    limiter.onPreMoveToken(mock.token, keyboardMovement(100), {});

    // The module status and Foundry document update may use different event
    // routes. The authority-confirmed final position must be sufficient to
    // rebase the queued step even while this client still has x=0.
    mock.deliver({
      ...statusFor(first, "complete"),
      finalPosition: { x: 100, y: 0, elevation: 0 }
    });

    await waitFor(
      () => mock.moveRequests().length === 2,
      "complete-before-broadcast lost the repeated keyboard step"
    );
    assert.equal(mock.token._source.x, 0);
    assert.equal(mock.moveRequests()[1].origin.x, 100);
    assert.equal(mock.moveRequests()[1].waypoints.at(-1).x, 200);
  });
});

test("the latest opposite keyboard step remains relative to the committed position", async () => {
  await withFoundryMock({ currentUser: "player" }, async (mock) => {
    const limiter = mock.createLimiter();
    limiter.ready();

    limiter.onPreMoveToken(mock.token, keyboardMovement(100), {});
    const first = mock.moveRequests()[0];
    limiter.onPreMoveToken(mock.token, keyboardMovement(-100), {});

    mock.token._source.x = 100;
    mock.deliver(statusFor(first, "complete"));

    await waitFor(() => mock.moveRequests().length === 2, "queued reverse step lost");
    assert.equal(mock.moveRequests()[1].origin.x, 100);
    assert.equal(mock.moveRequests()[1].waypoints.at(-1).x, 0);
  });
});

test("a queued stale drag route is rebuilt from the latest position", async () => {
  await withFoundryMock({ currentUser: "player" }, async (mock) => {
    const limiter = mock.createLimiter();
    limiter.ready();

    limiter.onPreMoveToken(mock.token, keyboardMovement(100), {});
    const first = mock.moveRequests()[0];
    limiter.onPreMoveToken(mock.token, draggingMovement(), {});

    mock.token._source.x = 100;
    mock.deliver(statusFor(first, "complete"));

    await waitFor(() => mock.moveRequests().length === 2, "queued drag was lost");
    const replay = mock.moveRequests()[1];
    assert.equal(replay.origin.x, 100);
    assert.deepEqual(replay.waypoints.map((waypoint) => waypoint.x), [300]);
  });
});

test("a queued HUD elevation keeps the latest horizontal position", async () => {
  await withFoundryMock({ currentUser: "player" }, async (mock) => {
    const limiter = mock.createLimiter();
    limiter.ready();

    limiter.onPreMoveToken(mock.token, keyboardMovement(100), {});
    const first = mock.moveRequests()[0];
    limiter.onPreMoveToken(mock.token, hudMovement(10), {});

    mock.token._source.x = 100;
    mock.deliver(statusFor(first, "complete"));

    await waitFor(() => mock.moveRequests().length === 2, "queued HUD move was lost");
    const destination = mock.moveRequests()[1].waypoints.at(-1);
    assert.equal(destination.x, 100);
    assert.equal(destination.y, 0);
    assert.equal(destination.elevation, 10);
  });
});

test("a later keyboard step survives an authority timeout", async () => {
  await withFoundryMock({ currentUser: "player" }, async (mock) => {
    const limiter = mock.createLimiter();
    limiter.ready();

    limiter.onPreMoveToken(mock.token, keyboardMovement(100), {});
    const first = mock.moveRequests()[0];
    limiter.onPreMoveToken(mock.token, keyboardMovement(100), {});

    mock.token._source.x = 50;
    mock.deliver({
      ...statusFor(first, "stopped"),
      reason: "timeout"
    });

    await waitFor(
      () => mock.moveRequests().length === 2,
      "queued input was discarded after an authority timeout"
    );
    assert.equal(mock.moveRequests()[1].origin.x, 50);
    assert.equal(mock.moveRequests()[1].waypoints.at(-1).x, 150);
  });
});

test("a missing terminal status cannot leave the client lock behind", async () => {
  await withFoundryMock({ currentUser: "player" }, async (mock) => {
    const limiter = mock.createLimiter();
    limiter.ready();

    limiter.onPreMoveToken(mock.token, keyboardMovement(100), {});
    const first = mock.moveRequests()[0];
    mock.deliver(statusFor(first, "accepted"));
    limiter.onPreMoveToken(mock.token, keyboardMovement(100), {});
    mock.token._source.x = 50;

    await waitFor(
      () => mock.moveRequests().length === 2,
      "client active watchdog did not release and replay queued input",
      500
    );
    assert.equal(mock.moveRequests()[1].origin.x, 50);
    assert.equal(mock.moveRequests()[1].waypoints.at(-1).x, 150);
  });
});

test("a never-settling authority move is stopped and does not block the next request", async () => {
  const never = new Promise(() => {});
  let moveCalls = 0;

  await withFoundryMock(
    {
      currentUser: "gm",
      move: async (token, waypoint) => {
        moveCalls += 1;
        if (moveCalls === 1) return never;
        Object.assign(token._source, waypoint);
        return true;
      }
    },
    async (mock) => {
      const limiter = mock.createLimiter();
      limiter.ready();

      const first = moveRequest("authority-1", 100);
      mock.deliver(first);

      const stopped = await waitFor(
        () =>
          mock.statuses().find(
            (message) =>
              message.requestId === first.requestId &&
              message.status === "stopped"
          ),
        "the timed-out authority move did not emit a terminal status"
      );
      assert.equal(stopped.reason, "timeout");
      assert.equal(mock.token.stopMovementCalls, 1);

      const second = moveRequest("authority-2", 100);
      mock.deliver(second);

      const completed = await waitFor(
        () =>
          mock.statuses().find(
            (message) =>
              message.requestId === second.requestId &&
              message.status === "complete"
          ),
        "the request after a timed-out move was not processed"
      );
      assert.equal(completed.reason, null);
      assert.equal(moveCalls, 2);
    }
  );
});

test("a throwing Foundry stop call still releases the module authority lock", async () => {
  let moveCalls = 0;
  await withFoundryMock(
    {
      currentUser: "gm",
      move: (token, waypoint) => {
        moveCalls += 1;
        if (moveCalls === 1) return new Promise(() => {});
        Object.assign(token._source, waypoint);
        return true;
      },
      stopMovement: () => {
        throw new Error("simulated Foundry stop failure");
      }
    },
    async (mock) => {
      const limiter = mock.createLimiter();
      limiter.ready();

      const first = moveRequest("throwing-stop", 100);
      mock.deliver(first);
      await waitFor(
        () =>
          mock.statuses().find(
            (message) =>
              message.requestId === first.requestId &&
              message.status === "stopped"
          ),
        "throwing stopMovement retained the first authority request"
      );

      const second = moveRequest("after-throwing-stop", 100);
      mock.deliver(second);
      await waitFor(
        () =>
          mock.statuses().find(
            (message) =>
              message.requestId === second.requestId &&
              message.status === "complete"
          ),
        "throwing stopMovement retained the module authority lock"
      );
      assert.equal(moveCalls, 2);
    }
  );
});

test("pausing immediately aborts a movement promise that would otherwise hang", async () => {
  let moveCalls = 0;
  await withFoundryMock(
    {
      currentUser: "gm",
      movementSpeed: 100,
      move: (token, waypoint) => {
        moveCalls += 1;
        if (moveCalls === 1) return new Promise(() => {});
        Object.assign(token._source, waypoint);
        return true;
      }
    },
    async (mock) => {
      const limiter = mock.createLimiter();
      limiter.ready();

      const request = moveRequest("pause-hang", 100);
      mock.deliver(request);
      await waitFor(
        () =>
          mock.statuses().find(
            (message) =>
              message.requestId === request.requestId &&
              message.status === "accepted"
          ),
        "movement was not accepted before pausing"
      );

      const pausedAt = performance.now();
      game.paused = true;
      limiter.onPauseChanged(true);
      const stopped = await waitFor(
        () =>
          mock.statuses().find(
            (message) =>
              message.requestId === request.requestId &&
              message.status === "stopped"
          ),
        "pausing did not release a never-settling movement"
      );

      assert.equal(stopped.reason, "paused");
      assert.equal(mock.token.stopMovementCalls, 1);
      assert.ok(performance.now() - pausedAt < 50);

      game.paused = false;
      limiter.onPauseChanged(false);
      const followUp = moveRequest("after-pause", 100);
      mock.deliver(followUp);
      await waitFor(
        () =>
          mock.statuses().find(
            (message) =>
              message.requestId === followUp.requestId &&
              message.status === "complete"
          ),
        "the authority lock survived after unpausing",
        1000
      );
      assert.equal(moveCalls, 2);
    }
  );
});

test("pausing wakes the post-move pacing wait immediately", async () => {
  let moveCalls = 0;
  await withFoundryMock(
    {
      currentUser: "gm",
      movementSpeed: 1,
      move: (token, waypoint) => {
        moveCalls += 1;
        Object.assign(token._source, waypoint);
        return true;
      }
    },
    async (mock) => {
      const limiter = mock.createLimiter();
      limiter.ready();

      const request = moveRequest("pause-pacing", 100);
      mock.deliver(request);
      await waitFor(() => moveCalls === 1, "movement did not reach its pacing wait");
      await sleep(5);

      const pausedAt = performance.now();
      game.paused = true;
      limiter.onPauseChanged(true);
      const stopped = await waitFor(
        () =>
          mock.statuses().find(
            (message) =>
              message.requestId === request.requestId &&
              message.status === "stopped"
          ),
        "post-move pacing wait ignored pause"
      );

      assert.equal(stopped.reason, "paused");
      assert.ok(performance.now() - pausedAt < 50);
    }
  );
});

test("v13-generated movement IDs are still cleaned up at the hard deadline", async () => {
  let settleOldMove;
  let moveCalls = 0;

  await withFoundryMock(
    {
      currentUser: "gm",
      movementSpeed: 100,
      move: (token, waypoint) => {
        moveCalls += 1;
        if (moveCalls === 1) {
          return new Promise((resolve) => {
            settleOldMove = resolve;
          });
        }
        Object.assign(token._source, waypoint);
        return true;
      },
      stopMovement: () => {
        // Model a v13 stop acknowledgement whose move promise settles later.
        setTimeout(() => settleOldMove(false), 25);
        return true;
      }
    },
    async (mock) => {
      const limiter = mock.createLimiter();
      limiter.ready();

      const first = moveRequest("v13-timeout", 100);
      mock.deliver(first);
      await waitFor(() => moveCalls === 1, "the v13 movement did not start");

      // v13 can publish its generated ID only in the later moveToken hook.
      mock.token.movement = {
        id: "foundry-v13-generated-id",
        method: "api",
        destination: { x: 80, y: 0, elevation: 0 },
        user: game.user
      };
      limiter.onMoveToken(mock.token, {
        id: "foundry-v13-generated-id",
        method: "api",
        destination: { x: 80, y: 0, elevation: 0 }
      }, {}, game.user);

      const stopped = await waitFor(
        () =>
          mock.statuses().find(
            (message) =>
              message.requestId === first.requestId &&
              message.status === "stopped"
          ),
        "v13 movement with a generated ID was not stopped"
      );
      assert.equal(stopped.movementId, "foundry-v13-generated-id");
      assert.equal(mock.token.stopMovementCalls, 1);

      const second = moveRequest("v13-follow-up", 200);
      mock.deliver(second);
      await waitFor(
        () =>
          mock.statuses().find(
            (message) =>
              message.requestId === second.requestId &&
              message.status === "complete"
          ),
        "late settlement of the stopped v13 move blocked its successor"
      );
      assert.equal(mock.token._source.x, 200);
    }
  );
});

test("one physical square ignores multiplied cost and uses an explicit animation duration", async () => {
  let operation;
  let moveCalls = 0;

  await withFoundryMock(
    {
      currentUser: "gm",
      movementSpeed: 100,
      measurement: {
        cost: 25,
        distance: 5,
        spaces: 1,
        euclidean: 100
      },
      move: async (token, waypoint, moveOperation) => {
        moveCalls += 1;
        operation = moveOperation;
        await sleep(moveOperation.animation.duration);
        Object.assign(token._source, waypoint);
        return true;
      }
    },
    async (mock) => {
      const limiter = mock.createLimiter();
      limiter.ready();

      const request = moveRequest("physical-space", 100);
      mock.deliver(request);
      await waitFor(
        () =>
          mock.statuses().find(
            (message) =>
              message.requestId === request.requestId &&
              message.status === "complete"
          ),
        "the physical-space movement did not complete"
      );

      assert.equal(moveCalls, 1);
      assert.ok(operation.animation.duration >= 9);
      assert.ok(operation.animation.duration <= 10.1);
      assert.equal("movementSpeed" in operation.animation, false);
      assert.equal(operation.pan, false);
      assert.equal(mock.token.stopMovementCalls, 0);
    }
  );
});

test("a zero-duration catch-up segment still gets time to commit its document update", async () => {
  const durations = [];
  let moveCalls = 0;

  await withFoundryMock(
    {
      currentUser: "gm",
      movementSpeed: 1000,
      move: async (token, waypoint, operation) => {
        moveCalls += 1;
        durations.push(operation.animation.duration);
        await sleep(5);
        Object.assign(token._source, waypoint);
        return true;
      }
    },
    async (mock) => {
      const limiter = mock.createLimiter();
      limiter.ready();

      const request = moveRequest("zero-duration-catch-up", 200);
      mock.deliver(request);
      await waitFor(
        () =>
          mock.statuses().find(
            (message) =>
              message.requestId === request.requestId &&
              message.status === "complete"
          ),
        "zero-duration document update was mistaken for a hung move"
      );

      assert.equal(moveCalls, 2);
      assert.ok(durations[0] > 0);
      assert.equal(durations[1], 0);
      assert.equal(mock.token._source.x, 200);
    }
  );
});

async function withFoundryMock(options, run) {
  const savedGlobals = GLOBAL_NAMES.map((name) => ({
    name,
    existed: Object.hasOwn(globalThis, name),
    value: globalThis[name]
  }));
  const mock = installFoundryMock(options);

  try {
    await run(mock);
  } finally {
    for (const limiter of mock.limiters) limiter.onDeleteToken(mock.token);
    await sleep(5);
    for (const saved of savedGlobals) {
      if (saved.existed) globalThis[saved.name] = saved.value;
      else delete globalThis[saved.name];
    }
  }
}

function installFoundryMock({
  currentUser,
  animationPromise = null,
  move,
  stopMovement,
  movementSpeed = 1000,
  measurement = null
} = {}) {
  const emitted = [];
  let socketHandler = null;
  let randomId = 0;

  const player = { id: "player", name: "Player", role: 1, active: true };
  const gm = { id: "gm", name: "GM", role: 4, active: true };
  const users = new Map([
    [player.id, player],
    [gm.id, gm]
  ]);
  users.activeGM = gm;

  const scene = {
    id: "scene",
    grid: { type: 1, size: 100, distance: 5 },
    tokens: new Map()
  };
  const token = {
    id: "token",
    name: "Token",
    parent: scene,
    _source: { x: 0, y: 0, elevation: 0 },
    object: animationPromise
      ? { movementAnimationPromise: animationPromise }
      : null,
    movement: { id: null },
    stopMovementCalls: 0,
    getFlag: () => null,
    testUserPermission: () => true,
    getCompleteMovementPath: (waypoints) =>
      waypoints.map((waypoint) => ({ ...waypoint })),
    measureMovementPath: ([from, to]) => {
      if (measurement) return { ...measurement };
      const spaces =
        Math.hypot(
          Number(to.x ?? from.x) - Number(from.x),
          Number(to.y ?? from.y) - Number(from.y)
        ) / scene.grid.size;
      return {
        spaces,
        distance: spaces * scene.grid.distance,
        euclidean: spaces * scene.grid.size
      };
    },
    async move(waypoint, operation) {
      if (move) return move(token, waypoint, operation);
      Object.assign(token._source, waypoint);
      return true;
    },
    stopMovement() {
      token.stopMovementCalls += 1;
      return stopMovement?.(token);
    }
  };
  scene.tokens.set(token.id, token);

  const settingValues = {
    enabled: true,
    movementSpeed,
    restrictedRoles: "playersOnly",
    disableDuringCombat: false,
    showNotification: false,
    debugLogging: false
  };

  globalThis.CONST = {
    USER_ROLES: {
      PLAYER: 1,
      TRUSTED: 2,
      ASSISTANT: 3,
      GAMEMASTER: 4
    },
    DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
    GRID_TYPES: { GRIDLESS: 0 }
  };
  globalThis.foundry = {
    utils: { randomID: () => `generated-${++randomId}` }
  };
  globalThis.ui = { notifications: { info() {} } };
  globalThis.game = {
    user: currentUser === "gm" ? gm : player,
    users,
    paused: false,
    combat: null,
    combats: [],
    settings: { get: (_moduleId, key) => settingValues[key] },
    socket: {
      on(channel, handler) {
        assert.equal(channel, SOCKET_CHANNEL);
        socketHandler = handler;
      },
      emit(channel, message) {
        assert.equal(channel, SOCKET_CHANNEL);
        emitted.push(message);
      }
    },
    modules: new Map([["movement-rate-limiter", {}]]),
    scenes: new Map([[scene.id, scene]]),
    i18n: { localize: (key) => key }
  };

  const mock = {
    token,
    limiters: [],
    createLimiter() {
      const limiter = new MovementLimiter(FAST_TIMINGS);
      mock.limiters.push(limiter);
      return limiter;
    },
    deliver(message) {
      assert.ok(socketHandler, "the socket listener must be registered first");
      socketHandler(message);
    },
    moveRequests: () =>
      emitted.filter((message) => message.type === "move-request"),
    statuses: () =>
      emitted.filter((message) => message.type === "move-status")
  };
  return mock;
}

function keyboardMovement(x) {
  return {
    method: "keyboard",
    origin: { x: 0, y: 0, elevation: 0 },
    destination: { x, y: 0, elevation: 0 },
    pending: { waypoints: [], spaces: 1, distance: 5 },
    autoRotate: false
  };
}

function draggingMovement() {
  return {
    method: "dragging",
    origin: { x: 0, y: 0, elevation: 0 },
    destination: { x: 300, y: 0, elevation: 0 },
    pending: {
      waypoints: [
        { x: 50, y: 50, elevation: 0 },
        { x: 200, y: 50, elevation: 0 }
      ]
    },
    autoRotate: false
  };
}

function hudMovement(elevation) {
  return {
    method: "hud",
    origin: { x: 0, y: 0, elevation: 0 },
    destination: { elevation },
    pending: { waypoints: [] },
    autoRotate: false
  };
}

function moveRequest(requestId, x) {
  return {
    type: "move-request",
    requestId,
    userId: "player",
    sceneId: "scene",
    tokenId: "token",
    origin: { x: 0, y: 0, elevation: 0 },
    waypoints: [{ x, y: 0, elevation: 0 }],
    autoRotate: false,
    requestedMethod: "keyboard"
  };
}

function statusFor(request, status) {
  return {
    type: "move-status",
    requestId: request.requestId,
    userId: request.userId,
    sceneId: request.sceneId,
    tokenId: request.tokenId,
    status,
    reason: null
  };
}

async function waitFor(predicate, failureMessage, timeoutMs = 500) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(2);
  }
  assert.fail(failureMessage);
}

function sleep(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
