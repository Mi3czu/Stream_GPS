const METERS_PER_DEGREE_LATITUDE = 111320;

const timeOf = (point) => new Date(point.recorded_at).getTime();

const splitOnTimeGaps = (points, gapMilliseconds) => {
  if (!points.length) return [];
  const segments = [];
  let segment = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    const gap = timeOf(points[index]) - timeOf(points[index - 1]);
    if (!Number.isFinite(gap) || gap > gapMilliseconds) {
      segments.push(segment);
      segment = [];
    }
    segment.push(points[index]);
  }
  segments.push(segment);
  return segments;
};

const distanceToSegment = (point, start, end) => {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  if (deltaX === 0 && deltaY === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const factor = Math.max(0, Math.min(1, ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / (deltaX ** 2 + deltaY ** 2)));
  return Math.hypot(point.x - (start.x + factor * deltaX), point.y - (start.y + factor * deltaY));
};

const simplifySegment = (segment, toleranceMeters) => {
  if (segment.length <= 2) return segment;
  const referenceLatitude = segment.reduce((sum, point) => sum + Number(point.latitude), 0) / segment.length;
  const longitudeScale = METERS_PER_DEGREE_LATITUDE * Math.cos(referenceLatitude * Math.PI / 180);
  const projected = segment.map((point) => ({
    x: Number(point.longitude) * longitudeScale,
    y: Number(point.latitude) * METERS_PER_DEGREE_LATITUDE
  }));
  const retained = new Set([0, segment.length - 1]);
  const intervals = [[0, segment.length - 1]];

  while (intervals.length) {
    const [startIndex, endIndex] = intervals.pop();
    let farthestIndex = -1;
    let farthestDistance = toleranceMeters;
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distance = distanceToSegment(projected[index], projected[startIndex], projected[endIndex]);
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthestIndex = index;
      }
    }
    if (farthestIndex !== -1) {
      retained.add(farthestIndex);
      intervals.push([startIndex, farthestIndex], [farthestIndex, endIndex]);
    }
  }
  return [...retained].sort((a, b) => a - b).map((index) => segment[index]);
};

const simplifyRoute = (points, { maxPoints = 2500, toleranceMeters = 3, gapMilliseconds = 60000 } = {}) => {
  const segments = splitOnTimeGaps(points, gapMilliseconds);
  const simplifyAt = (tolerance) => segments.map((segment) => simplifySegment(segment, tolerance));
  let appliedTolerance = toleranceMeters;
  let simplified = simplifyAt(appliedTolerance);
  let count = simplified.reduce((sum, segment) => sum + segment.length, 0);

  if (count > maxPoints) {
    let lower = appliedTolerance;
    let upper = appliedTolerance;
    while (count > maxPoints && upper < 100000) {
      upper *= 2;
      simplified = simplifyAt(upper);
      count = simplified.reduce((sum, segment) => sum + segment.length, 0);
    }
    if (count <= maxPoints) {
      for (let iteration = 0; iteration < 12; iteration += 1) {
        const middle = (lower + upper) / 2;
        const candidate = simplifyAt(middle);
        const candidateCount = candidate.reduce((sum, segment) => sum + segment.length, 0);
        if (candidateCount > maxPoints) lower = middle;
        else { upper = middle; simplified = candidate; count = candidateCount; }
      }
      appliedTolerance = upper;
    } else {
      appliedTolerance = upper;
    }
  }

  const routePoints = simplified.flatMap((segment, segmentIndex) => segment.map((point, pointIndex) => (
    segmentIndex > 0 && pointIndex === 0 ? { ...point, route_break_before: true } : point
  )));
  return {
    points: routePoints,
    sourcePoints: points.length,
    renderedPoints: routePoints.length,
    segments: segments.length,
    toleranceMeters: Math.round(appliedTolerance * 10) / 10
  };
};

module.exports = { simplifyRoute };
