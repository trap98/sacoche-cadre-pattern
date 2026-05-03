import type { ImageFrame, Point, ViewTransform } from './types';

export const DEFAULT_MM_PER_UNIT = 1;
export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 16;

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function segmentLengthInMm(a: Point, b: Point, mmPerUnit: number): number {
  return distance(a, b) * mmPerUnit;
}

export function screenToWorld(point: Point, view: ViewTransform): Point {
  return {
    x: (point.x - view.offsetX) / view.scale,
    y: (point.y - view.offsetY) / view.scale,
  };
}

export function worldToScreen(point: Point, view: ViewTransform): Point {
  return {
    x: point.x * view.scale + view.offsetX,
    y: point.y * view.scale + view.offsetY,
  };
}

export function clampZoom(scale: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

export function zoomAtScreenPoint(
  view: ViewTransform,
  screenPoint: Point,
  nextScale: number,
): ViewTransform {
  const scale = clampZoom(nextScale);
  const worldPoint = screenToWorld(screenPoint, view);

  return {
    scale,
    offsetX: screenPoint.x - worldPoint.x * scale,
    offsetY: screenPoint.y - worldPoint.y * scale,
  };
}

export function scalePointAround(point: Point, origin: Point, scaleFactor: number): Point {
  return {
    x: origin.x + (point.x - origin.x) * scaleFactor,
    y: origin.y + (point.y - origin.y) * scaleFactor,
  };
}

export function scalePointsAround(points: Point[], origin: Point, scaleFactor: number): Point[] {
  return points.map((point) => scalePointAround(point, origin, scaleFactor));
}

export function rotatePointAround(point: Point, origin: Point, angleRadians: number): Point {
  const cos = Math.cos(angleRadians);
  const sin = Math.sin(angleRadians);
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;

  return {
    x: origin.x + dx * cos - dy * sin,
    y: origin.y + dx * sin + dy * cos,
  };
}

export function rotatePointsAround(points: Point[], origin: Point, angleRadians: number): Point[] {
  return points.map((point) => rotatePointAround(point, origin, angleRadians));
}

export function scaleImageFrameAround(
  image: ImageFrame,
  origin: Point,
  scaleFactor: number,
): ImageFrame {
  const topLeft = scalePointAround({ x: image.x, y: image.y }, origin, scaleFactor);

  return {
    x: topLeft.x,
    y: topLeft.y,
    width: image.width * scaleFactor,
    height: image.height * scaleFactor,
  };
}

export function rotateImageFrameAround<T extends ImageFrame & { rotation: number }>(
  image: T,
  origin: Point,
  angleRadians: number,
): T {
  const center = {
    x: image.x + image.width / 2,
    y: image.y + image.height / 2,
  };
  const rotatedCenter = rotatePointAround(center, origin, angleRadians);

  return {
    ...image,
    x: rotatedCenter.x - image.width / 2,
    y: rotatedCenter.y - image.height / 2,
    rotation: image.rotation + angleRadians,
  };
}

export function angleToHorizontal(a: Point, b: Point): number {
  const rotation = -Math.atan2(b.y - a.y, b.x - a.x);

  if (rotation > Math.PI / 2) {
    return rotation - Math.PI;
  }

  if (rotation < -Math.PI / 2) {
    return rotation + Math.PI;
  }

  return rotation;
}

export function segmentScaleFactorForTargetMm(
  a: Point,
  b: Point,
  mmPerUnit: number,
  targetLengthMm: number,
): number {
  const currentLengthMm = segmentLengthInMm(a, b, mmPerUnit);

  if (currentLengthMm <= 0 || targetLengthMm <= 0) {
    throw new Error('Segment and target lengths must be greater than zero.');
  }

  return targetLengthMm / currentLengthMm;
}

export function segmentMidpoint(a: Point, b: Point): Point {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

export function pointsToPolyline(points: Point[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(' ');
}

export function segmentEndIndex(startIndex: number, pointCount: number, closed: boolean): number {
  if (pointCount === 0) {
    return 0;
  }

  const isLastOpenSegment = startIndex === pointCount - 1;

  if (isLastOpenSegment && !closed) {
    return startIndex;
  }

  return (startIndex + 1) % pointCount;
}
