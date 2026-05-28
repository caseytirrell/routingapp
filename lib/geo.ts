import type { Coordinate } from "./route-types";

export function decodePolyline(encoded: string): Coordinate[] {
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coordinates: Coordinate[] = [];

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;

    while (index < encoded.length) {
      const byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
      if (byte < 0x20) break;
    }

    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    shift = 0;
    result = 0;

    while (index < encoded.length) {
      const byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
      if (byte < 0x20) break;
    }

    const deltaLng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += deltaLng;

    coordinates.push([lng / 1e5, lat / 1e5]);
  }

  return coordinates;
}

export function getDistanceInFeet(coord1: Coordinate, coord2: Coordinate): number {
  const toRad = (value: number) => (value * Math.PI) / 180;

  const [lng1, lat1] = coord1;
  const [lng2, lat2] = coord2;

  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const meters = R * c;

  return meters * 3.28084;
}

export function getClosestPathIndex(point: Coordinate, path: Coordinate[]): number {
  if (path.length === 0) return 0;

  let closestIndex = 0;
  let minDistance = Infinity;

  for (let i = 0; i < path.length; i++) {
    const distance = getDistanceInFeet(point, path[i]);
    if (distance < minDistance) {
      minDistance = distance;
      closestIndex = i;
    }
  }

  return closestIndex;
}

export function distanceFromPointToSegmentFeet(
  point: Coordinate,
  start: Coordinate,
  end: Coordinate
): number {
  const toFeet = (lng: number, lat: number, refLat: number) => {
    const feetPerDegreeLat = 364000;
    const feetPerDegreeLng = 364000 * Math.cos((refLat * Math.PI) / 180);
    return [lng * feetPerDegreeLng, lat * feetPerDegreeLat] as Coordinate;
  };

  const refLat = point[1];
  const [px, py] = toFeet(point[0], point[1], refLat);
  const [x1, y1] = toFeet(start[0], start[1], refLat);
  const [x2, y2] = toFeet(end[0], end[1], refLat);

  const dx = x2 - x1;
  const dy = y2 - y1;

  if (dx === 0 && dy === 0) {
    return Math.hypot(px - x1, py - y1);
  }

  const t = Math.max(
    0,
    Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy))
  );
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;

  return Math.hypot(px - projX, py - projY);
}

export function getDistanceFromPathFeet(point: Coordinate, path: Coordinate[]): number | null {
  if (path.length < 2) return null;

  let minDistance = Infinity;

  for (let i = 0; i < path.length - 1; i++) {
    const distance = distanceFromPointToSegmentFeet(point, path[i], path[i + 1]);
    if (distance < minDistance) minDistance = distance;
  }

  return minDistance;
}

export function getDistanceAlongPathInFeet(
  path: Coordinate[],
  startIndex: number,
  endIndex: number
): number {
  if (path.length < 2) return 0;

  const safeStartIndex = Math.max(0, Math.min(startIndex, path.length - 1));
  const safeEndIndex = Math.max(0, Math.min(endIndex, path.length - 1));

  if (safeEndIndex <= safeStartIndex) return 0;

  let totalFeet = 0;

  for (let i = safeStartIndex; i < safeEndIndex; i++) {
    totalFeet += getDistanceInFeet(path[i], path[i + 1]);
  }

  return totalFeet;
}

export function getBearingBetweenPoints(start: Coordinate, end: Coordinate): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;

  const [lng1, lat1] = start;
  const [lng2, lat2] = end;

  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const lambda1 = toRad(lng1);
  const lambda2 = toRad(lng2);

  const y = Math.sin(lambda2 - lambda1) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(lambda2 - lambda1);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function getUpcomingPathBearing(path: Coordinate[], currentIndex: number): number | null {
  if (path.length < 2) return null;

  const safeIndex = Math.max(0, Math.min(currentIndex, path.length - 2));

  for (let i = safeIndex; i < path.length - 1; i++) {
    const start = path[i];
    const end = path[i + 1];

    if (start[0] !== end[0] || start[1] !== end[1]) {
      return getBearingBetweenPoints(start, end);
    }
  }

  return null;
}

export function getClosestPointOnSegment(
  point: Coordinate,
  start: Coordinate,
  end: Coordinate
): Coordinate {
  const refLat = point[1];
  const feetPerDegreeLat = 364000;
  const feetPerDegreeLng = 364000 * Math.cos((refLat * Math.PI) / 180);

  const toFeet = ([lng, lat]: Coordinate) => [
    lng * feetPerDegreeLng,
    lat * feetPerDegreeLat,
  ];

  const toLngLat = ([x, y]: Coordinate): Coordinate => [
    x / feetPerDegreeLng,
    y / feetPerDegreeLat,
  ];

  const [px, py] = toFeet(point);
  const [x1, y1] = toFeet(start);
  const [x2, y2] = toFeet(end);

  const dx = x2 - x1;
  const dy = y2 - y1;

  if (dx === 0 && dy === 0) {
    return start;
  }

  const t = Math.max(
    0,
    Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy))
  );

  return toLngLat([x1 + t * dx, y1 + t * dy]);
}

export function getClosestPointOnPath(point: Coordinate, path: Coordinate[]): Coordinate | null {
  if (path.length < 2) return null;

  let closestPoint: Coordinate | null = null;
  let minDistance = Infinity;

  for (let i = 0; i < path.length - 1; i++) {
    const projectedPoint = getClosestPointOnSegment(point, path[i], path[i + 1]);
    const distance = getDistanceInFeet(point, projectedPoint);

    if (distance < minDistance) {
      minDistance = distance;
      closestPoint = projectedPoint;
    }
  }

  return closestPoint;
}
