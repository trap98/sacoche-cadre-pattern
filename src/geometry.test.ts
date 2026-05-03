import { describe, expect, it } from 'vitest';
import {
  angleToHorizontal,
  distance,
  rotateImageFrameAround,
  rotatePointAround,
  scaleImageFrameAround,
  scalePointsAround,
  segmentLengthInMm,
  segmentScaleFactorForTargetMm,
} from './geometry';

describe('geometry helpers', () => {
  it('measures distance between two points', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('converts segment units to millimeters', () => {
    expect(segmentLengthInMm({ x: 0, y: 0 }, { x: 10, y: 0 }, 2.5)).toBe(25);
  });

  it('computes the global scale factor for a target real length', () => {
    const factor = segmentScaleFactorForTargetMm(
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      1,
      200,
    );

    expect(factor).toBe(4);
  });

  it('scales points around an origin', () => {
    const points = scalePointsAround(
      [
        { x: 10, y: 10 },
        { x: 20, y: 10 },
      ],
      { x: 10, y: 10 },
      3,
    );

    expect(points).toEqual([
      { x: 10, y: 10 },
      { x: 40, y: 10 },
    ]);
  });

  it('scales the image frame with the same global transform as points', () => {
    const frame = scaleImageFrameAround(
      { x: 10, y: 20, width: 100, height: 50 },
      { x: 0, y: 0 },
      2,
    );

    expect(frame).toEqual({ x: 20, y: 40, width: 200, height: 100 });
  });

  it('rotates a point around an origin', () => {
    const point = rotatePointAround({ x: 10, y: 0 }, { x: 0, y: 0 }, Math.PI / 2);

    expect(point.x).toBeCloseTo(0);
    expect(point.y).toBeCloseTo(10);
  });

  it('computes the rotation needed to make a segment horizontal', () => {
    const angle = angleToHorizontal({ x: 0, y: 0 }, { x: 0, y: 10 });
    const rotated = rotatePointAround({ x: 0, y: 10 }, { x: 0, y: 0 }, angle);

    expect(rotated.y).toBeCloseTo(0);
    expect(rotated.x).toBeCloseTo(10);
  });

  it('uses the closest horizontal orientation instead of forcing the segment to point right', () => {
    const angle = angleToHorizontal({ x: 10, y: 1 }, { x: 0, y: 0 });
    const rotated = rotatePointAround({ x: 0, y: 0 }, { x: 10, y: 1 }, angle);

    expect(angle).toBeCloseTo(-Math.atan(0.1));
    expect(rotated.y).toBeCloseTo(1);
    expect(rotated.x).toBeLessThan(10);
  });

  it('rotates the image center and accumulates image rotation', () => {
    const frame = rotateImageFrameAround(
      { x: 5, y: -5, width: 10, height: 10, rotation: 0 },
      { x: 0, y: 0 },
      Math.PI / 2,
    );

    expect(frame.x).toBeCloseTo(-5);
    expect(frame.y).toBeCloseTo(5);
    expect(frame.rotation).toBeCloseTo(Math.PI / 2);
  });
});
