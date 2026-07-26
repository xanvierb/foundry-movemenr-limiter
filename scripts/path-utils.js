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
  const position = {
    x: Number(tokenDocument.x),
    y: Number(tokenDocument.y),
    elevation: Number(tokenDocument.elevation ?? 0)
  };
  if (tokenDocument.level !== undefined) position.level = tokenDocument.level;
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

  return Number.isFinite(clean.x) || Number.isFinite(clean.y) ? clean : null;
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

export function splitSegmentByCost(from, to, cost, maximumCost) {
  const normalizedCost = Math.max(0, Number(cost) || 0);
  const parts = Math.max(1, Math.ceil(normalizedCost / maximumCost));
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

export function animationSpeedForDuration(cost, durationMs, fallbackSpeed) {
  const normalizedCost = Math.max(0, Number(cost) || 0);
  const normalizedDuration = Math.max(0, Number(durationMs) || 0);
  const normalizedFallback = Math.max(0.01, Number(fallbackSpeed) || 0.01);
  if (normalizedCost === 0 || normalizedDuration === 0) {
    return normalizedFallback;
  }
  return normalizedCost / (normalizedDuration / 1000);
}

/**
 * Schedule a segment against a cumulative movement deadline.
 *
 * Using the previous deadline instead of the current time prevents document
 * update and socket overhead from being added once per segment. If an earlier
 * segment finishes late, the next animation is shortened by the same amount.
 * The token bucket remains responsible for deciding when a segment may begin.
 */
export function scheduleSegment(deadlineMs, cost, speed, now) {
  const currentTime = Number.isFinite(Number(now)) ? Number(now) : 0;
  const previousDeadline = Number.isFinite(Number(deadlineMs))
    ? Number(deadlineMs)
    : currentTime;
  const deadline = previousDeadline + minimumSegmentDurationMs(cost, speed);
  return {
    deadline,
    durationMs: Math.max(0, deadline - currentTime)
  };
}

function interpolate(from, to, ratio) {
  return Number(from ?? 0) + (Number(to ?? from ?? 0) - Number(from ?? 0)) * ratio;
}
