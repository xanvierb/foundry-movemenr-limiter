const WAYPOINT_FIELDS = [
  "x",
  "y",
  "elevation",
  "level",
  "action",
  "snapped",
  "explicit",
  "checkpoint"
];

export function currentPosition(tokenDocument) {
  const source = tokenDocument?._source ?? tokenDocument ?? {};
  const position = {
    x: Number(source.x ?? tokenDocument?.x),
    y: Number(source.y ?? tokenDocument?.y),
    elevation: Number(source.elevation ?? tokenDocument?.elevation ?? 0)
  };
  const level = source.level ?? tokenDocument?.level;
  if (level !== undefined) position.level = level;
  return position;
}

export function sanitizeWaypoint(waypoint) {
  if (!waypoint || typeof waypoint !== "object") return null;

  const clean = {};
  for (const field of WAYPOINT_FIELDS) {
    const value = waypoint[field];
    if (value === undefined || value === null) continue;

    if (["x", "y", "elevation"].includes(field)) {
      const number = Number(value);
      if (!Number.isFinite(number)) continue;
      clean[field] = field === "elevation" ? number : Math.round(number);
      continue;
    }

    if (["snapped", "explicit", "checkpoint"].includes(field)) {
      clean[field] = Boolean(value);
      continue;
    }

    if (typeof value === "string" || typeof value === "number") {
      clean[field] = value;
    }
  }

  const hasMovementCoordinate = ["x", "y", "elevation", "level"].some(
    (field) => clean[field] !== undefined
  );
  return hasMovementCoordinate ? clean : null;
}

export function movementWaypoints(movement, maximum) {
  const source = Array.isArray(movement?.pending?.waypoints)
    ? movement.pending.waypoints
    : [];
  const combined = [...source, movement?.destination].filter(Boolean);
  return deduplicateWaypoints(
    combined.slice(0, maximum).map(sanitizeWaypoint).filter(Boolean)
  );
}

export function deduplicateWaypoints(waypoints, epsilon = 0.01) {
  const result = [];
  for (const waypoint of waypoints) {
    const prior = result.at(-1);
    if (prior && sameSpatialPosition(prior, waypoint, epsilon)) {
      result[result.length - 1] = { ...prior, ...waypoint };
    } else {
      result.push(waypoint);
    }
  }
  return result;
}

export function sameSpatialPosition(a, b, epsilon = 1) {
  if (!a || !b) return false;
  const close = (left, right) =>
    Math.abs(Number(left ?? 0) - Number(right ?? 0)) <= epsilon;
  const sameLevel =
    a.level === undefined ||
    b.level === undefined ||
    String(a.level) === String(b.level);
  return (
    close(a.x, b.x) &&
    close(a.y, b.y) &&
    close(a.elevation, b.elevation) &&
    sameLevel
  );
}

export function splitSegmentByCost(
  from,
  to,
  cost,
  maximumCost,
  maximumParts = Number.POSITIVE_INFINITY
) {
  const normalizedCost = Math.max(0, Number(cost) || 0);
  const normalizedMaximum = Math.max(0.001, Number(maximumCost) || 0.001);
  const parts = Math.max(1, Math.ceil(normalizedCost / normalizedMaximum));
  const partLimit = Math.max(0, Math.floor(Number(maximumParts) || 0));
  if (parts > partLimit) return null;
  if (parts === 1) return [{ ...to }];

  const result = [];
  for (let index = 1; index <= parts; index += 1) {
    const ratio = index / parts;
    if (index === parts) {
      result.push({ ...to });
      continue;
    }

    const waypoint = {
      x: Math.round(interpolate(from.x, to.x, ratio)),
      y: Math.round(interpolate(from.y, to.y, ratio)),
      elevation: interpolate(
        Number(from.elevation ?? 0),
        Number(to.elevation ?? from.elevation ?? 0),
        ratio
      ),
      snapped: false,
      explicit: false,
      checkpoint: true
    };
    if (from.level !== undefined) waypoint.level = from.level;
    if (to.action !== undefined) waypoint.action = to.action;
    result.push(waypoint);
  }
  return deduplicateWaypoints(result);
}

export function minimumSegmentDurationMs(cost, speed) {
  const normalizedCost = Math.max(0, Number(cost) || 0);
  const normalizedSpeed = Math.max(0.01, Number(speed) || 0.01);
  return (normalizedCost / normalizedSpeed) * 1000;
}

/**
 * Convert a Foundry movement measurement into physical grid spaces.
 *
 * `cost` is deliberately not used: systems, movement actions, and terrain can
 * multiply it. Distance is normalized by the scene's distance per grid space,
 * with Foundry's physical space count as the fallback.
 */
export function measuredGridSpaces(
  measurement,
  { gridless = false, gridSize = 1, gridDistance = 0 } = {}
) {
  const distance = Number(measurement?.distance);
  const normalizedGridDistance = Math.max(0, Number(gridDistance) || 0);
  if (
    !gridless &&
    Number.isFinite(distance) &&
    distance > 0 &&
    normalizedGridDistance > 0
  ) {
    return distance / normalizedGridDistance;
  }

  const spaces = Number(measurement?.spaces);
  if (!gridless && Number.isFinite(spaces) && spaces > 0) return spaces;

  const euclidean = Number(measurement?.euclidean);
  const normalizedGridSize = Math.max(1, Number(gridSize) || 1);
  if (Number.isFinite(euclidean) && euclidean > 0) {
    return euclidean / normalizedGridSize;
  }
  return null;
}

/**
 * Schedule a segment against a cumulative movement deadline.
 *
 * Using the previous deadline instead of the current time prevents document
 * update and socket overhead from being added once per segment. If an earlier
 * segment finishes late, the next animation is shortened by the same amount.
 * The caller keeps this deadline local to one accepted movement request.
 */
export function scheduleSegment(deadlineMs, cost, speed, now) {
  const currentTime = Number.isFinite(Number(now)) ? Number(now) : 0;
  const previousDeadline = Number.isFinite(Number(deadlineMs))
    ? Number(deadlineMs)
    : currentTime;
  const segmentDurationMs = minimumSegmentDurationMs(cost, speed);
  const accumulatedDeadline = previousDeadline + segmentDurationMs;
  // Never turn processing overhead into extra movement time. When an earlier
  // update finishes late, the next segment uses the remaining portion of its
  // cumulative window (or zero when that window has already elapsed).
  const deadline = Math.max(
    currentTime,
    Math.min(accumulatedDeadline, currentTime + segmentDurationMs)
  );
  return {
    deadline,
    durationMs: Math.max(0, deadline - currentTime)
  };
}

function interpolate(from, to, ratio) {
  return Number(from ?? 0) + (Number(to ?? from ?? 0) - Number(from ?? 0)) * ratio;
}
