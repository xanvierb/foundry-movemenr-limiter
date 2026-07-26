# Movement Rate Limiter

Movement Rate Limiter prevents a player from racing a controlled token through
many rooms in a few seconds. It limits actual token position updates over real
elapsed time; it does not merely make a long movement animation look slower.

The module targets Foundry Virtual Tabletop v14 and keeps a v13-compatible code
path. At the time of development, the current stable releases used for API
verification were v14.365 and v13.350.

## Technical approach

Modern Foundry provides an official token movement lifecycle:

- [`preMoveToken`](https://foundryvtt.com/api/v14/functions/hookEvents.preMoveToken.html)
  can reject an initiating movement before its update is sent.
- [`TokenDocument.move()`](https://foundryvtt.com/api/v14/classes/foundry.documents.TokenDocument.html#move)
  performs synchronized movement using Foundry's document update workflow.
- `TokenDocument.getCompleteMovementPath()` and
  `TokenDocument.measureMovementPath()` expose the final path and Foundry's
  configured grid measurements.
- [`game.users.activeGM`](https://foundryvtt.com/api/v14/classes/foundry.documents.collections.Users.html#activeGM)
  designates one connected GM client for a single-authority workflow.

For an interactive movement initiated by a restricted user, the module rejects
the original update locally and sends the final constrained path to the
designated active GM. The GM verifies the user, token ownership, scene, starting
position, current settings, and per-token override. It then commits the path as
small `TokenDocument.move()` operations at the configured real-time speed.

Every committed position is a real Foundry document update broadcast to every
client. A 20-square move therefore cannot put the document 20 squares away at
once while only playing a slow animation afterward. At most one small path
segment is ahead of its visual interpolation.

This is the strongest authority model available to a normal client-side Foundry
module without modifying Foundry's server.

## Installation

1. Stop Foundry VTT.
2. Copy the `movement-rate-limiter` folder into:
   `{Foundry user data}/Data/modules/`
3. Start Foundry.
4. Open the world, choose **Manage Modules**, and enable
   **Movement Rate Limiter**.
5. Keep a GM or Assistant GM connected while restricted players are moving.

The directory must contain `module.json` directly:

```text
Data/modules/movement-rate-limiter/module.json
```

## Configuration

Open **Game Settings → Configure Settings → Module Settings**.

| Setting | Default | Meaning |
| --- | ---: | --- |
| Enable Movement Limiter | Enabled | Master switch |
| Movement Speed | 2 squares/sec | Sustained real-time movement rate |
| Restricted Roles | Players only | Which Foundry role constants are restricted |
| Disable During Combat | Enabled | Started combat encounters use normal Foundry movement |
| Show Movement-Limit Warnings | Enabled | Shows non-critical limiter warnings; critical failures remain visible |
| Debug Logging | Disabled | Logs path measurements, effective speed, timings, and decisions |

Settings are world settings and changes take effect without restarting Foundry.

### Restricted roles

- **Players only** restricts `CONST.USER_ROLES.PLAYER`.
- **Players + Trusted Players** restricts `PLAYER` and `TRUSTED`.
- **Everyone except GM** restricts every role except
  `CONST.USER_ROLES.GAMEMASTER`, including Assistant GM.

The default therefore leaves Trusted Players, Assistant GMs, and GMs
unrestricted.

## How the limiter works

Each accepted segment owns exactly one time window: physical grid spaces divided
by `Movement Speed`. The visual animation and the authoritative wait use that
same deadline, so hidden waiting is never added before or after a full
animation. Segment deadlines are request-local and cumulative, allowing normal
socket and document-update overhead to be recovered without carrying stale
delays into the next request. If an update is already late, the following
animation is shortened instead of starting a new full wait. Repeated input
cannot restart the active timer; the latest intent is retained and submitted
after the current animation.

The requesting client is released as soon as the authority reports completion;
there is no second local animation grace period. Foundry's movement promise
also includes document-update bookkeeping, so it receives a small bounded
settling guard after the animation deadline. That guard is never added to the
next pacing deadline, and input during it is retained. An operation that still
does not settle is stopped, so a paused or broken animation cannot lock a token
forever. Pausing the game also aborts brokered movement immediately.

Keyboard input queued before a document broadcast is stored as a relative
step. For example, two rapid right-arrow presses are replayed as `0 → 1` and
then `1 → 2`, rather than accidentally treating both as the stale absolute
destination `1`. HUD elevation changes retain the latest horizontal position,
and stale drag-ruler intermediates are rebuilt from the token's new origin.

Foundry's physical path distance is normalized by the scene's distance per grid
space. Terrain, movement-action, or game-system cost multipliers therefore
cannot turn one physical square into several limiter seconds. A 5 ft grid and a
1.5 m grid both count one orthogonal space as one square, while Foundry's
configured diagonal distance remains intact. On gridless scenes, one configured
grid pixel size is treated as one movement space.

Long path segments are divided into small real document updates. The module
also waits for the configured segment duration before committing the next
position, so repeated clicks cannot refill and spend allowance faster than real
movement occurs.

## Per-token overrides

As a full GM:

1. Open a placed token's configuration.
2. Find the **Movement Limiter** fieldset.
3. Choose:
   - **Use world setting**
   - **Unlimited**
   - **Custom speed**
4. For **Custom speed**, enter that token's squares per second.

The override is stored as flags on that TokenDocument. Duplicating a token also
duplicates its flags, while each placed copy is paced independently.

## Combat and paused games

With **Disable Movement Limiter During Combat** enabled, the module does not
intercept movement in a started combat encounter for that scene. If combat
starts during a brokered exploration move, the remaining brokered path stops at
the last synchronized position; the player can immediately move again using
normal combat behavior.

The module does not replace Foundry's pause permissions. It does not broker
player movement while the game is paused.

## Movement methods

The limiter intercepts Foundry movement marked as:

- dragging / drag-and-drop / drag ruler;
- keyboard movement;
- token HUD movement.

Movement marked `method: "api"` is deliberately left alone. This avoids
breaking GM macros, region behavior, teleports, automation, and other modules
whose programmatic updates happen to originate on a player's client. Direct GM
movement is always unrestricted.

## Multiplayer and race handling

- Only `game.users.activeGM` processes a request, so multiple connected GMs do
  not execute it twice.
- If Foundry designates a different active GM while a path is running, the old
  authority stops before committing another segment.
- The GM marks a token busy before awaiting any movement.
- Duplicate request IDs are ignored.
- Every request includes its starting position; stale requests are rejected.
- Completion statuses include the authority-confirmed final position, so input
  queued before a slower local document broadcast is rebased correctly.
- Before every segment, the GM checks that no GM or other module moved the token.
  If the position changed, the queued path stops instead of correcting or
  rubber-banding it.
- While a path is active, the GM sends a lightweight status heartbeat. If the
  GM tab reloads or disconnects, the player's local busy guard expires within
  about ten seconds instead of becoming stale.
- Token/scene deletion aborts work and removes runtime state.
- A player reconnecting cannot bypass an active movement owned by the same GM
  authority.

## Known limitations

- A connected GM or Assistant GM is required for restricted movement. Without
  one, movement is rejected with a localized notification.
- Foundry modules run in browser clients, not in the Foundry server process.
  The GM-brokered design is authoritative for normal clients and prevents
  desynchronization, but it is not anti-cheat protection against a deliberately
  modified client that disables the module or forges socket traffic.
- Programmatic `method: "api"` movement is intentionally not limited.
- Sequential path segments can produce more movement-history entries or region
  movement events than one unmodified long move. This is the tradeoff required
  to commit real positions over time.
- Foundry v14 multi-level waypoints retain their level value, but unusual
  system/module-specific teleport paths remain programmatic and are not
  intercepted.
- Extremely high configured speeds can still be limited by the time Foundry
  needs to perform each synchronized document update. The cumulative scheduler
  compensates for ordinary overhead, but it cannot make an individual database
  operation complete faster.

## Compatibility and verification

| Foundry version | Status |
| --- | --- |
| v14.365 | Targeted; implementation checked against the official API |
| v13.350 | Compatibility path checked against the official API |

The included Node tests cover physical-space measurement, background-tab timer
clamping, bounded promise cleanup, relative queued input, v13 movement-ID
recovery, authority recovery, long-segment splitting, pacing bounds, manifest
integrity, and matching
English/Dutch localization keys. They can be run without dependencies:

```bash
npm test
```

A real Foundry installation is still required for final system-specific smoke
testing of drag rulers, walls, terrain, and other installed modules.

## License

MIT
