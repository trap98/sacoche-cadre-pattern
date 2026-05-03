import { generateFacePieces } from './generateFaces';
import { generateGussetPieces } from './generateGusset';
import type { PatternParameters, PatternPiece, ValidatedBagShape } from './types';

export function generatePattern(
  shape: ValidatedBagShape,
  parameters: PatternParameters,
): PatternPiece[] {
  return [
    ...generateFacePieces('A', shape, parameters.faceA, parameters),
    ...generateFacePieces('B', shape, parameters.faceB, parameters),
    ...generateGussetPieces(shape, parameters.gusset, parameters),
  ];
}
