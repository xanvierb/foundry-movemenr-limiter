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
  configured grid/diagonal measurements.
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
| Maximum Burst | 2 squares | Maximum stored allowance per token |
| Restricted Roles | Players only | Which Foundry role constants are restricted |
| Disable During Combat | Enabled | Started combat encounters use normal Foundry movement |
| Show Player Notification | Enabled | Shows throttled rejection feedback |
| Debug Logging | Disabled | Logs path, allowance, elapsed time, waits, and decisions |

Settings are world settings and changes take effect without restarting Foundry.

### Restricted roles

- **Players only** restricts `CONST.USER_ROLES.PLAYER`.
- **Players + Trusted Players** restricts `PLAYER` and `TRUSTED`.
- **Everyone except GM** restricts every role except
  `CONST.USER_ROLES.GAMEMASTER`, including Assistant GM.

The default therefore leaves Trusted Players, Assistant GMs, and GMs
unrestricted.

## How the limiter works

Each scene token has its own in-memory token bucket:

- Allowance regenerates at `Movement Speed` grid spaces per real second.
- Allowance is capped at `Maximum Burst`.
- Waiting for 30 seconds never grants more than the configured burst.
- Token A and Token B never share allowance, even when owned by the same user.
- Runtime allowance resets when the designated GM client reloads or the server
  restarts.

Stored allowance can eliminate a wait before the next small segment, but the
segment itself is still visually paced at the configured speed. The module
therefore favors smooth gradual movement over teleporting the whole burst.
Foundry's per-movement animation options are used to match the visual
interpolation to this pacing. Segment deadlines are cumulative, so normal
socket and document-update overhead shortens later animations instead of being
added to the configured travel time once per segment. The deadline is retained
per token between separate movement requests. Clicking again therefore never
restarts a full movement interval; only the portion that has not elapsed can
still delay the next movement.

Foundry's measured path cost is divided by the scene's configured distance per
grid space. A 5 ft grid and a 1.5 m grid therefore both count one orthogonal
space as one square. Foundry's configured diagonal rule and movement-cost
aggregation are used where available. On gridless scenes, one configured grid
pixel size is treated as one movement space.

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
duplicates its flags, while each placed copy receives a separate runtime bucket.

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
- Before every segment, the GM checks that no GM or other module moved the token.
  If the position changed, the queued path stops instead of correcting or
  rubber-banding it.
- While a path is active, the GM sends a lightweight status heartbeat. If the
  GM tab reloads or disconnects, the player's local busy guard expires within
  about ten seconds instead of becoming stale.
- Token/scene deletion aborts work and removes runtime state.
- A player reconnecting cannot obtain a second bucket while the same GM remains
  authoritative.

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
- With a maximum burst smaller than Foundry's smallest indivisible grid segment,
  that segment may temporarily create bucket debt. The debt must regenerate
  before another segment starts, so the sustained rate is still enforced.
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

The included Node tests cover bucket regeneration/capping, independent token
state, long-segment splitting, pacing bounds, manifest integrity, and matching
English/Dutch localization keys. They can be run without dependencies:

```bash
npm test
```

A real Foundry installation is still required for final system-specific smoke
testing of drag rulers, walls, terrain, and other installed modules.

## License

MIT
