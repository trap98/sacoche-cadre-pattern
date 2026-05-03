import type { Point } from './types';

export type BoundingBox = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
};

const EPSILON = 0.000001;

export function boundingBox(points: Point[]): BoundingBox {
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function segmentLength(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function polygonPerimeter(points: Point[]): number {
  if (points.length < 2) {
    return 0;
  }

  return points.reduce((total, point, index) => {
    const next = points[(index + 1) % points.length];
    return total + segmentLength(point, next);
  }, 0);
}

export function signedPolygonArea(points: Point[]): number {
  if (points.length < 3) {
    return 0;
  }

  return (
    points.reduce((area, point, index) => {
      const next = points[(index + 1) % points.length];
      return area + point.x * next.y - next.x * point.y;
    }, 0) / 2
  );
}

export function rectangle(width: number, height: number, origin: Point = { x: 0, y: 0 }): Point[] {
  return [
    { x: origin.x, y: origin.y },
    { x: origin.x + width, y: origin.y },
    { x: origin.x + width, y: origin.y + height },
    { x: origin.x, y: origin.y + height },
  ];
}

export function translatePath(points: Point[], dx: number, dy: number): Point[] {
  return points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
}

export function normalizePath(points: Point[]): Point[] {
  const bounds = boundingBox(points);
  return translatePath(points, -bounds.minX, -bounds.minY);
}

export function mirrorPathOnYAxis(points: Point[]): Point[] {
  const bounds = boundingBox(points);

  return points.map((point) => ({
    x: bounds.minX + bounds.maxX - point.x,
    y: point.y,
  }));
}

export function horizontalLineIntersections(polygon: Point[], y: number): number[] {
  const intersections: number[] = [];

  polygon.forEach((a, index) => {
    const b = polygon[(index + 1) % polygon.length];

    if (Math.abs(a.y - b.y) < EPSILON) {
      return;
    }

    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);

    if (y < minY || y >= maxY) {
      return;
    }

    const t = (y - a.y) / (b.y - a.y);
    intersections.push(a.x + t * (b.x - a.x));
  });

  return intersections
    .sort((a, b) => a - b)
    .filter((value, index, values) => index === 0 || Math.abs(value - values[index - 1]) > EPSILON);
}

function intersectWithHorizontal(a: Point, b: Point, y: number): Point {
  const t = (y - a.y) / (b.y - a.y);
  return {
    x: a.x + t * (b.x - a.x),
    y,
  };
}

function clipPolygonByHorizontalBoundary(
  polygon: Point[],
  y: number,
  keep: (point: Point) => boolean,
): Point[] {
  if (polygon.length === 0) {
    return [];
  }

  const clipped: Point[] = [];

  polygon.forEach((current, index) => {
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    const currentInside = keep(current);
    const previousInside = keep(previous);

    if (currentInside) {
      if (!previousInside) {
        clipped.push(intersectWithHorizontal(previous, current, y));
      }
      clipped.push(current);
      return;
    }

    if (previousInside) {
      clipped.push(intersectWithHorizontal(previous, current, y));
    }
  });

  return clipped;
}

export function clipPolygonToHorizontalRange(
  polygon: Point[],
  minY: number,
  maxY: number,
): Point[] {
  if (maxY <= minY || polygon.length < 3) {
    return [];
  }

  const belowTop = clipPolygonByHorizontalBoundary(
    polygon,
    minY,
    (point) => point.y >= minY - EPSILON,
  );

  return clipPolygonByHorizontalBoundary(
    belowTop,
    maxY,
    (point) => point.y <= maxY + EPSILON,
  );
}

function edgeOutwardNormal(a: Point, b: Point, orientation: number): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);

  if (length <= EPSILON) {
    return { x: 0, y: 0 };
  }

  if (orientation >= 0) {
    return { x: dy / length, y: -dx / length };
  }

  return { x: -dy / length, y: dx / length };
}

function lineIntersection(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const dax = a2.x - a1.x;
  const day = a2.y - a1.y;
  const dbx = b2.x - b1.x;
  const dby = b2.y - b1.y;
  const denominator = dax * dby - day * dbx;

  if (Math.abs(denominator) <= EPSILON) {
    return null;
  }

  const dx = b1.x - a1.x;
  const dy = b1.y - a1.y;
  const t = (dx * dby - dy * dbx) / denominator;

  return {
    x: a1.x + t * dax,
    y: a1.y + t * day,
  };
}

function fallbackOffsetPoint(point: Point, previousNormal: Point, nextNormal: Point, allowanceMm: number): Point {
  const nx = previousNormal.x + nextNormal.x;
  const ny = previousNormal.y + nextNormal.y;
  const length = Math.hypot(nx, ny);

  if (length <= EPSILON) {
    return {
      x: point.x + nextNormal.x * allowanceMm,
      y: point.y + nextNormal.y * allowanceMm,
    };
  }

  return {
    x: point.x + (nx / length) * allowanceMm,
    y: point.y + (ny / length) * allowanceMm,
  };
}

export function applyApproximateSeamAllowance(path: Point[], allowanceMm: number): Point[] {
  if (allowanceMm <= 0 || path.length === 0) {
    return path.map((point) => ({ ...point }));
  }

  if (path.length < 3) {
    return path.map((point) => ({ ...point }));
  }

  const orientation = signedPolygonArea(path);

  if (Math.abs(orientation) <= EPSILON) {
    return path.map((point) => ({ ...point }));
  }

  const edgeNormals = path.map((point, index) =>
    edgeOutwardNormal(point, path[(index + 1) % path.length], orientation),
  );

  return path.map((point, index) => {
    const previousIndex = (index + path.length - 1) % path.length;
    const previousPoint = path[previousIndex];
    const nextPoint = path[(index + 1) % path.length];
    const previousNormal = edgeNormals[previousIndex];
    const nextNormal = edgeNormals[index];
    const previousLineStart = {
      x: previousPoint.x + previousNormal.x * allowanceMm,
      y: previousPoint.y + previousNormal.y * allowanceMm,
    };
    const previousLineEnd = {
      x: point.x + previousNormal.x * allowanceMm,
      y: point.y + previousNormal.y * allowanceMm,
    };
    const nextLineStart = {
      x: point.x + nextNormal.x * allowanceMm,
      y: point.y + nextNormal.y * allowanceMm,
    };
    const nextLineEnd = {
      x: nextPoint.x + nextNormal.x * allowanceMm,
      y: nextPoint.y + nextNormal.y * allowanceMm,
    };
    const intersection = lineIntersection(
      previousLineStart,
      previousLineEnd,
      nextLineStart,
      nextLineEnd,
    );

    if (!intersection || segmentLength(point, intersection) > allowanceMm * 4) {
      return fallbackOffsetPoint(point, previousNormal, nextNormal, allowanceMm);
    }

    return intersection;
  });
}
