export type Point = {
  x: number;
  y: number;
};

export type ImageFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SceneImage = ImageFrame & {
  src: string;
  opacity: number;
  naturalWidth: number;
  naturalHeight: number;
  rotation: number;
};

export type SceneOverlay = ImageFrame & {
  id: string;
  templateId: string;
  mirrored: boolean;
  opacity: number;
  rotation: number;
};

export type ViewTransform = {
  offsetX: number;
  offsetY: number;
  scale: number;
};

export type SegmentSelection = {
  startIndices: number[];
};
