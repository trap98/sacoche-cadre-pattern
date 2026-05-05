import {
  ChangeEvent,
  FormEvent,
  MouseEvent,
  PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlignHorizontalSpaceAround,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CirclePlus,
  Crosshair,
  Droplets,
  FlipHorizontal,
  ImagePlus,
  Move,
  MousePointer2,
  Redo2,
  RotateCcw,
  Ruler,
  Scissors,
  Settings2,
  Trash2,
  Undo2,
  ZoomIn,
} from 'lucide-react';
import {
  angleToHorizontal,
  DEFAULT_MM_PER_UNIT,
  pointsToPolyline,
  rotateImageFrameAround,
  rotatePointsAround,
  scaleImageFrameAround,
  scalePointsAround,
  screenToWorld,
  segmentEndIndex,
  segmentLengthInMm,
  segmentMidpoint,
  segmentScaleFactorForTargetMm,
  zoomAtScreenPoint,
} from './geometry';
import {
  findBladderTemplate,
  HYDRATION_BLADDER_TEMPLATES,
} from './overlays/hydrationBladders';
import { DEFAULT_PATTERN_PARAMETERS } from './pattern/defaults';
import { horizontalLineIntersections } from './pattern/geometry';
import { PatternWorkspace } from './pattern/PatternWorkspace';
import { createValidatedBagShape } from './pattern/shape';
import {
  ensureZipperCount,
  resolveZipperDistanceFromTopMm,
  updateNumber,
  zipperBottomClearanceValue,
} from './pattern/zipperOptions';
import type { FaceOptions, PatternParameters, ValidatedBagShape } from './pattern/types';
import type { Point, SceneImage, SceneOverlay, SegmentSelection, ViewTransform } from './types';

type Interaction =
  | {
      kind: 'pan';
      pointerId: number;
      startScreen: Point;
      startView: ViewTransform;
      addsPointOnClick: boolean;
      moved: boolean;
    }
  | {
      kind: 'point';
      pointerId: number;
      index: number;
      startScreen: Point;
      startScene: SceneSnapshot;
      historyRecorded: boolean;
      moved: boolean;
    }
  | {
      kind: 'overlay';
      pointerId: number;
      id: string;
      startScreen: Point;
      startScene: SceneSnapshot;
      historyRecorded: boolean;
      moved: boolean;
    }
  | {
      kind: 'zip';
      pointerId: number;
      faceKey: FaceKey;
      zipperIndex: number;
      startScreen: Point;
      moved: boolean;
    };

type ContextMenuState =
  | {
      kind: 'point';
      index: number;
      x: number;
      y: number;
    }
  | {
      kind: 'segment';
      startIndex: number;
      worldPoint: Point;
      x: number;
      y: number;
    };

type SceneSnapshot = {
  image: SceneImage | null;
  overlays: SceneOverlay[];
  points: Point[];
  isClosed: boolean;
};

type AppMode = 'trace' | 'zip-setup' | 'pattern';

type FaceKey = 'faceA' | 'faceB';

type ZipPreview = {
  faceKey: FaceKey;
  zipperIndex: number;
  y: number;
  x1: number;
  x2: number;
  label: string;
  valueMm: number;
};

const INITIAL_VIEW: ViewTransform = {
  offsetX: 80,
  offsetY: 80,
  scale: 1,
};

const POINT_NODE_RADIUS_PX = 5;
const PDF_POINT_TO_MM = 25.4 / 72;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function loadImageDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = src;
  });
}

function formatMm(value: number): string {
  return new Intl.NumberFormat('fr-FR', {
    maximumFractionDigits: 1,
  }).format(value);
}

function pointBounds(points: Point[]) {
  return points.reduce(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxX: Math.max(bounds.maxX, point.x),
      maxY: Math.max(bounds.maxY, point.y),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function widestHorizontalSpan(intersections: number[]): { x1: number; x2: number } | null {
  if (intersections.length < 2) {
    return null;
  }

  let widest = {
    x1: intersections[0],
    x2: intersections[1],
  };

  for (let index = 2; index < intersections.length; index += 2) {
    const x1 = intersections[index];
    const x2 = intersections[index + 1];

    if (x2 === undefined) {
      break;
    }

    if (x2 - x1 > widest.x2 - widest.x1) {
      widest = { x1, x2 };
    }
  }

  return widest;
}

function pointCentroid(points: Point[]): Point {
  const sum = points.reduce(
    (current, point) => ({
      x: current.x + point.x,
      y: current.y + point.y,
    }),
    { x: 0, y: 0 },
  );

  return {
    x: sum.x / points.length,
    y: sum.y / points.length,
  };
}

export default function App() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const interactionRef = useRef<Interaction | null>(null);

  const [image, setImage] = useState<SceneImage | null>(null);
  const [overlays, setOverlays] = useState<SceneOverlay[]>([]);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [overlayTemplateId, setOverlayTemplateId] = useState(HYDRATION_BLADDER_TEMPLATES[0].id);
  const [points, setPoints] = useState<Point[]>([]);
  const [isClosed, setIsClosed] = useState(false);
  const [mode, setMode] = useState<AppMode>('trace');
  const [validatedShape, setValidatedShape] = useState<ValidatedBagShape | null>(null);
  const [patternParameters, setPatternParameters] = useState<PatternParameters>(
    DEFAULT_PATTERN_PARAMETERS,
  );
  const [view, setView] = useState(INITIAL_VIEW);
  const [selectedSegment, setSelectedSegment] = useState<SegmentSelection | null>(null);
  const [lengthInput, setLengthInput] = useState('');
  const [mmPerUnit] = useState(DEFAULT_MM_PER_UNIT);
  const [showTraceDimensions, setShowTraceDimensions] = useState(true);
  const [previewPoint, setPreviewPoint] = useState<Point | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [historyPast, setHistoryPast] = useState<SceneSnapshot[]>([]);
  const [historyFuture, setHistoryFuture] = useState<SceneSnapshot[]>([]);
  const [status, setStatus] = useState('Importez une photo, puis cliquez dans la zone pour tracer.');

  const makeSceneSnapshot = useCallback(
    (): SceneSnapshot => ({
      image: image ? { ...image } : null,
      overlays: overlays.map((overlay) => ({ ...overlay })),
      points: points.map((point) => ({ ...point })),
      isClosed,
    }),
    [image, isClosed, overlays, points],
  );

  const applySceneSnapshot = useCallback((snapshot: SceneSnapshot) => {
    setImage(snapshot.image ? { ...snapshot.image } : null);
    setOverlays(snapshot.overlays.map((overlay) => ({ ...overlay })));
    setSelectedOverlayId(null);
    setPoints(snapshot.points.map((point) => ({ ...point })));
    setIsClosed(snapshot.isClosed);
    setSelectedSegment(null);
    setLengthInput('');
    setContextMenu(null);
    setPreviewPoint(null);
  }, []);

  const pushHistorySnapshot = useCallback((snapshot: SceneSnapshot) => {
    setHistoryPast((current) => [...current.slice(-79), snapshot]);
    setHistoryFuture([]);
  }, []);

  const recordHistory = useCallback(() => {
    pushHistorySnapshot(makeSceneSnapshot());
  }, [makeSceneSnapshot, pushHistorySnapshot]);

  const undo = useCallback(() => {
    if (historyPast.length === 0) {
      return;
    }

    const previous = historyPast[historyPast.length - 1];

    setHistoryPast((past) => past.slice(0, -1));
    setHistoryFuture((future) => [makeSceneSnapshot(), ...future]);
    applySceneSnapshot(previous);
    setStatus('Action annulée.');
  }, [applySceneSnapshot, historyPast, makeSceneSnapshot]);

  const redo = useCallback(() => {
    if (historyFuture.length === 0) {
      return;
    }

    const next = historyFuture[0];

    setHistoryPast((past) => [...past.slice(-79), makeSceneSnapshot()]);
    setHistoryFuture((future) => future.slice(1));
    applySceneSnapshot(next);
    setStatus('Action rejouée.');
  }, [applySceneSnapshot, historyFuture, makeSceneSnapshot]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTextInput =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;

      if (isTextInput || (!event.ctrlKey && !event.metaKey)) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key === 'z' && event.shiftKey) {
        event.preventDefault();
        redo();
        return;
      }

      if (key === 'z') {
        event.preventDefault();
        undo();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [redo, undo]);

  const segmentCount = isClosed ? points.length : Math.max(0, points.length - 1);
  const selectedSegmentPoints = useMemo(() => {
    if (!selectedSegment || points.length < 2) {
      return null;
    }

    const start = selectedSegment.startIndex;
    const end = segmentEndIndex(start, points.length, isClosed);

    if (start === end) {
      return null;
    }

    return {
      start,
      end,
      a: points[start],
      b: points[end],
    };
  }, [isClosed, points, selectedSegment]);
  const selectedOverlay = useMemo(
    () => overlays.find((overlay) => overlay.id === selectedOverlayId) ?? null,
    [overlays, selectedOverlayId],
  );
  const selectedOverlayTemplate = selectedOverlay
    ? findBladderTemplate(selectedOverlay.templateId)
    : null;
  const pointNodeRadius = POINT_NODE_RADIUS_PX / view.scale;

  const currentSelectedLengthMm = selectedSegmentPoints
    ? segmentLengthInMm(selectedSegmentPoints.a, selectedSegmentPoints.b, mmPerUnit)
    : null;
  const traceBounds = useMemo(() => (points.length > 0 ? pointBounds(points) : null), [points]);
  const traceCentroid = useMemo(
    () => (points.length > 0 ? pointCentroid(points) : null),
    [points],
  );
  const dimensionOffset = 34 / view.scale;
  const dimensionTick = 7 / view.scale;
  const dimensionTextOffset = 14 / view.scale;
  const dimensionFontSize = 12 / view.scale;
  const dimensionTextStroke = 4 / view.scale;
  const segmentDimensionOffset = 18 / view.scale;
  const traceHeightMm = traceBounds ? (traceBounds.maxY - traceBounds.minY) * mmPerUnit : 0;
  const manualGussetBreaks = patternParameters.gusset.manualBreakSegmentIndices ?? [];
  const manualGussetBreakSet = useMemo(
    () => new Set(manualGussetBreaks),
    [manualGussetBreaks],
  );
  const isManualGussetSetup =
    mode === 'zip-setup' && patternParameters.gusset.splitMode === 'manual';
  const zipPreviews = useMemo(() => {
    if (mode !== 'zip-setup' || !isClosed || !traceBounds) {
      return [];
    }

    const previews: ZipPreview[] = [];
    const cutoutHeightMm = patternParameters.zipperCutoutHeightMm;

    (['faceA', 'faceB'] as const).forEach((faceKey) => {
      const face = patternParameters[faceKey];

      face.zippers.slice(0, face.zipperCount).forEach((zipper, zipperIndex) => {
        const distanceFromTopMm = resolveZipperDistanceFromTopMm(
          zipper,
          zipperIndex,
          traceHeightMm,
          cutoutHeightMm,
        );
        const y = traceBounds.minY + distanceFromTopMm / mmPerUnit;
        const span = widestHorizontalSpan(horizontalLineIntersections(points, y));

        if (!span) {
          return;
        }

        previews.push({
          faceKey,
          zipperIndex,
          y,
          x1: span.x1,
          x2: span.x2,
          label: `${faceKey === 'faceA' ? 'Face A' : 'Face B'} zip ${zipperIndex + 1}`,
          valueMm:
            zipperIndex === 1
              ? zipperBottomClearanceValue(zipper, traceHeightMm, cutoutHeightMm)
              : distanceFromTopMm,
        });
      });
    });

    return previews;
  }, [
    isClosed,
    mmPerUnit,
    mode,
    patternParameters,
    points,
    traceBounds,
    traceHeightMm,
  ]);

  function getScreenPoint(event: { clientX: number; clientY: number }): Point {
    const rect = svgRef.current?.getBoundingClientRect();

    if (!rect) {
      return { x: 0, y: 0 };
    }

    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function addPoint(point: Point) {
    if (isClosed) {
      return;
    }

    recordHistory();
    setPoints((current) => [...current, point]);
    setPreviewPoint(point);
    setSelectedSegment(null);
    setSelectedOverlayId(null);
    setStatus('Point ajouté. Cliquez sur le premier point pour fermer la forme.');
  }

  function closeShape() {
    if (points.length < 3) {
      return;
    }

    recordHistory();
    setIsClosed(true);
    setSelectedSegment(null);
    setPreviewPoint(null);
    setStatus('Forme fermée. Déplacez les points ou sélectionnez un segment à calibrer.');
  }

  async function handleImageImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const src = await readFileAsDataUrl(file);
    const dimensions = await loadImageDimensions(src);

    setImage({
      src,
      opacity: 0.55,
      naturalWidth: dimensions.width,
      naturalHeight: dimensions.height,
      rotation: 0,
      x: 0,
      y: 0,
      width: dimensions.width,
      height: dimensions.height,
    });
    recordHistory();
    setStatus('Photo importée. Ajustez son opacité et tracez la sacoche.');
  }

  function addOverlay(templateId: string) {
    const template = findBladderTemplate(templateId);

    if (!template) {
      return;
    }

    const rect = svgRef.current?.getBoundingClientRect();
    const center = rect
      ? screenToWorld({ x: rect.width / 2, y: rect.height / 2 }, view)
      : { x: 120, y: 120 };
    const overlay: SceneOverlay = {
      id: `${templateId}-${Date.now()}`,
      templateId,
      x: center.x - template.widthMm / 2,
      y: center.y - template.heightMm / 2,
      width: template.widthMm,
      height: template.heightMm,
      mirrored: false,
      opacity: 0.68,
      rotation: 0,
    };

    recordHistory();
    setOverlays((current) => [...current, overlay]);
    setSelectedOverlayId(overlay.id);
    setStatus(`${template.label} ajouté. Glissez la forme pour la déplacer.`);
  }

  function deleteSelectedOverlay() {
    if (!selectedOverlay) {
      return;
    }

    recordHistory();
    setOverlays((current) => current.filter((overlay) => overlay.id !== selectedOverlay.id));
    setSelectedOverlayId(null);
    setStatus('Forme supprimée.');
  }

  function updateSelectedOverlay(
    updates: Partial<Pick<SceneOverlay, 'x' | 'y' | 'rotation' | 'opacity' | 'mirrored'>>,
  ) {
    if (!selectedOverlay) {
      return;
    }

    setOverlays((current) =>
      current.map((overlay) =>
        overlay.id === selectedOverlay.id
          ? {
              ...overlay,
              ...updates,
            }
          : overlay,
      ),
    );
  }

  function toggleSelectedOverlayMirror() {
    if (!selectedOverlay) {
      return;
    }

    recordHistory();
    updateSelectedOverlay({
      mirrored: !selectedOverlay.mirrored,
    });
    setStatus('Forme retournée en miroir.');
  }

  function updatePatternParameters(patch: Partial<PatternParameters>) {
    setPatternParameters((current) => ({ ...current, ...patch }));
  }

  function updateFace(faceKey: FaceKey, updater: (face: FaceOptions) => FaceOptions) {
    setPatternParameters((current) => ({
      ...current,
      [faceKey]: updater(current[faceKey]),
    }));
  }

  function handleFaceZipCount(faceKey: FaceKey, event: ChangeEvent<HTMLSelectElement>) {
    const zipperCount = Number(event.target.value) as 0 | 1 | 2;
    updateFace(faceKey, (face) => ensureZipperCount(face, zipperCount));
    setStatus('Configuration zip mise à jour.');
  }

  function updateZipperFromWorldY(faceKey: FaceKey, zipperIndex: number, worldY: number) {
    if (!traceBounds) {
      return;
    }

    const halfCutoutMm = patternParameters.zipperCutoutHeightMm / 2;
    const minDistanceMm = halfCutoutMm;
    const maxDistanceMm = Math.max(minDistanceMm, traceHeightMm - halfCutoutMm);
    const distanceFromTopMm = clamp(
      (worldY - traceBounds.minY) * mmPerUnit,
      minDistanceMm,
      maxDistanceMm,
    );

    updateFace(faceKey, (face) => ({
      ...face,
      zippers: face.zippers.map((zipper, index) => {
        if (index !== zipperIndex) {
          return zipper;
        }

        if (zipperIndex === 1) {
          return {
            ...zipper,
            clearanceFromBottomTubeMm: Math.max(
              0,
              traceHeightMm - distanceFromTopMm - halfCutoutMm,
            ),
          };
        }

        return {
          ...zipper,
          distanceFromTopTubeMm: distanceFromTopMm,
        };
      }),
    }));
  }

  function handleWorkspacePointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 && event.button !== 2) {
      return;
    }

    setContextMenu(null);
    const startScreen = getScreenPoint(event);
    interactionRef.current = {
      kind: 'pan',
      pointerId: event.pointerId,
      startScreen,
      startView: view,
      addsPointOnClick: mode === 'trace' && event.button === 0,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointPointerDown(index: number, event: PointerEvent<SVGCircleElement>) {
    event.stopPropagation();

    if (event.button !== 0) {
      return;
    }

    setContextMenu(null);

    if (event.altKey) {
      deletePoint(index);
      return;
    }

    interactionRef.current = {
      kind: 'point',
      pointerId: event.pointerId,
      index,
      startScreen: getScreenPoint(event),
      startScene: makeSceneSnapshot(),
      historyRecorded: false,
      moved: false,
    };
    svgRef.current?.setPointerCapture(event.pointerId);
  }

  function handleGussetBreakPointerDown(index: number, event: PointerEvent<SVGCircleElement>) {
    event.stopPropagation();

    if (event.button !== 0) {
      return;
    }

    setContextMenu(null);
    setSelectedSegment(null);
    setSelectedOverlayId(null);
    setPatternParameters((current) => {
      const currentBreaks = current.gusset.manualBreakSegmentIndices ?? [];
      const hasBreak = currentBreaks.includes(index);
      const nextBreaks = hasBreak
        ? currentBreaks.filter((breakIndex) => breakIndex !== index)
        : [...currentBreaks, index].sort((a, b) => a - b);

      return {
        ...current,
        gusset: {
          ...current.gusset,
          splitMode: 'manual',
          manualBreakSegmentIndices: nextBreaks,
        },
      };
    });
    setStatus('Point de coupe du soufflet mis à jour.');
  }

  function handleOverlayPointerDown(id: string, event: PointerEvent<SVGGElement>) {
    event.stopPropagation();

    if (event.button !== 0) {
      return;
    }

    setContextMenu(null);
    setSelectedSegment(null);
    setSelectedOverlayId(id);

    interactionRef.current = {
      kind: 'overlay',
      pointerId: event.pointerId,
      id,
      startScreen: getScreenPoint(event),
      startScene: makeSceneSnapshot(),
      historyRecorded: false,
      moved: false,
    };
    svgRef.current?.setPointerCapture(event.pointerId);
  }

  function handleZipPointerDown(
    faceKey: FaceKey,
    zipperIndex: number,
    event: PointerEvent<SVGLineElement>,
  ) {
    event.stopPropagation();

    if (event.button !== 0) {
      return;
    }

    setContextMenu(null);
    setSelectedSegment(null);
    setSelectedOverlayId(null);
    interactionRef.current = {
      kind: 'zip',
      pointerId: event.pointerId,
      faceKey,
      zipperIndex,
      startScreen: getScreenPoint(event),
      moved: false,
    };
    svgRef.current?.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    const interaction = interactionRef.current;
    const screenPoint = getScreenPoint(event);

    if (!interaction) {
      if (mode === 'trace' && !isClosed && points.length > 0) {
        setPreviewPoint(screenToWorld(screenPoint, view));
      }

      return;
    }

    if (interaction.pointerId !== event.pointerId) {
      return;
    }

    const moved =
      Math.abs(screenPoint.x - interaction.startScreen.x) > 3 ||
      Math.abs(screenPoint.y - interaction.startScreen.y) > 3;

    if (interaction.kind === 'pan') {
      interactionRef.current = { ...interaction, moved: interaction.moved || moved };
      setView({
        ...interaction.startView,
        offsetX: interaction.startView.offsetX + screenPoint.x - interaction.startScreen.x,
        offsetY: interaction.startView.offsetY + screenPoint.y - interaction.startScreen.y,
      });
      return;
    }

    if (interaction.kind === 'overlay') {
      interactionRef.current = { ...interaction, moved: interaction.moved || moved };
      if (moved && !interaction.historyRecorded) {
        pushHistorySnapshot(interaction.startScene);
        interactionRef.current = {
          ...interaction,
          historyRecorded: true,
          moved: interaction.moved || moved,
        };
      }

      const dx = (screenPoint.x - interaction.startScreen.x) / view.scale;
      const dy = (screenPoint.y - interaction.startScreen.y) / view.scale;
      const startOverlay = interaction.startScene.overlays.find(
        (overlay) => overlay.id === interaction.id,
      );

      if (startOverlay) {
        setOverlays((current) =>
          current.map((overlay) =>
            overlay.id === interaction.id
              ? {
                  ...overlay,
                  x: startOverlay.x + dx,
                  y: startOverlay.y + dy,
                }
              : overlay,
          ),
        );
      }
      return;
    }

    if (interaction.kind === 'zip') {
      interactionRef.current = { ...interaction, moved: interaction.moved || moved };
      updateZipperFromWorldY(interaction.faceKey, interaction.zipperIndex, screenToWorld(screenPoint, view).y);
      return;
    }

    interactionRef.current = { ...interaction, moved: interaction.moved || moved };
    if (moved && !interaction.historyRecorded) {
      pushHistorySnapshot(interaction.startScene);
      interactionRef.current = {
        ...interaction,
        historyRecorded: true,
        moved: interaction.moved || moved,
      };
    }
    const worldPoint = screenToWorld(screenPoint, view);
    setPoints((current) =>
      current.map((point, pointIndex) => (pointIndex === interaction.index ? worldPoint : point)),
    );
  }

  function handlePointerUp(event: PointerEvent<SVGSVGElement>) {
    const interaction = interactionRef.current;

    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    interactionRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);

    if (interaction.kind === 'pan' && !interaction.moved) {
      if (interaction.addsPointOnClick) {
        addPoint(screenToWorld(getScreenPoint(event), view));
      }
    }

    if (interaction.kind === 'point' && !interaction.moved && interaction.index === 0 && !isClosed) {
      closeShape();
    }

    if (interaction.kind === 'zip' && interaction.moved) {
      setStatus('Hauteur de zip ajustée.');
    }
  }

  function handleWheel(event: React.WheelEvent<SVGSVGElement>) {
    event.preventDefault();
    setContextMenu(null);
    const rect = svgRef.current?.getBoundingClientRect();

    if (!rect) {
      return;
    }

    const screenPoint = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    const zoomFactor = event.deltaY < 0 ? 1.12 : 0.88;

    setView((current) => zoomAtScreenPoint(current, screenPoint, current.scale * zoomFactor));
  }

  function selectSegment(startIndex: number, event: PointerEvent<SVGLineElement>) {
    event.stopPropagation();

    if (event.button !== 0) {
      return;
    }

    setContextMenu(null);
    const endIndex = segmentEndIndex(startIndex, points.length, isClosed);
    const lengthMm = segmentLengthInMm(points[startIndex], points[endIndex], mmPerUnit);

    setSelectedSegment({ startIndex });
    setSelectedOverlayId(null);
    setLengthInput(String(Math.round(lengthMm * 10) / 10));
    setStatus('Segment sélectionné. Saisissez sa longueur réelle en millimètres.');
  }

  function insertPointInSegment(startIndex: number, event: MouseEvent<SVGLineElement>) {
    event.stopPropagation();
    const point = screenToWorld(getScreenPoint(event), view);

    insertPointAtSegment(startIndex, point);
  }

  function insertPointAtSegment(startIndex: number, point: Point) {
    const insertIndex = startIndex + 1;

    recordHistory();
    setPoints((current) => [
      ...current.slice(0, insertIndex),
      point,
      ...current.slice(insertIndex),
    ]);
    setSelectedSegment(null);
    setLengthInput('');
    setContextMenu(null);
    setStatus('Point ajouté dans le segment.');
  }

  function deletePoint(index: number) {
    recordHistory();
    setPoints((current) => {
      const next = current.filter((_, pointIndex) => pointIndex !== index);

      if (next.length < 3) {
        setIsClosed(false);
      }

      return next;
    });
    setSelectedSegment(null);
    setLengthInput('');
    setContextMenu(null);
    setStatus('Point supprimé.');
  }

  function openPointContextMenu(index: number, event: MouseEvent<SVGCircleElement>) {
    event.preventDefault();
    event.stopPropagation();
    const screenPoint = getScreenPoint(event);

    setContextMenu({
      kind: 'point',
      index,
      x: screenPoint.x,
      y: screenPoint.y,
    });
  }

  function openSegmentContextMenu(startIndex: number, event: MouseEvent<SVGLineElement>) {
    event.preventDefault();
    event.stopPropagation();
    const screenPoint = getScreenPoint(event);

    setContextMenu({
      kind: 'segment',
      startIndex,
      worldPoint: screenToWorld(screenPoint, view),
      x: screenPoint.x,
      y: screenPoint.y,
    });
  }

  function handleWorkspaceContextMenu(event: MouseEvent<SVGSVGElement>) {
    event.preventDefault();
    setContextMenu(null);
  }

  function runContextMenuAction() {
    if (!contextMenu) {
      return;
    }

    if (contextMenu.kind === 'point') {
      deletePoint(contextMenu.index);
      return;
    }

    insertPointAtSegment(contextMenu.startIndex, contextMenu.worldPoint);
  }

  function applyCalibration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedSegmentPoints) {
      return;
    }

    const targetMm = Number(lengthInput.replace(',', '.'));

    if (!Number.isFinite(targetMm) || targetMm <= 0) {
      setStatus('La longueur doit être un nombre positif.');
      return;
    }

    const scaleFactor = segmentScaleFactorForTargetMm(
      selectedSegmentPoints.a,
      selectedSegmentPoints.b,
      mmPerUnit,
      targetMm,
    );
    const origin = segmentMidpoint(selectedSegmentPoints.a, selectedSegmentPoints.b);

    recordHistory();
    setPoints((current) => scalePointsAround(current, origin, scaleFactor));
    setImage((current) =>
      current
        ? {
            ...current,
            ...scaleImageFrameAround(current, origin, scaleFactor),
          }
        : current,
    );
    setOverlays((current) =>
      current.map((overlay) => ({
        ...overlay,
        ...scaleImageFrameAround(overlay, origin, scaleFactor),
      })),
    );
    setStatus(`Calibration appliquée : segment réglé à ${formatMm(targetMm)} mm.`);
  }

  function straightenSelectedSegment() {
    if (!selectedSegmentPoints) {
      setStatus('Sélectionnez un segment avant de remettre droit.');
      return;
    }

    const rotation = angleToHorizontal(selectedSegmentPoints.a, selectedSegmentPoints.b);

    if (Math.abs(rotation) < 0.0001) {
      setStatus('Le segment sélectionné est déjà horizontal.');
      return;
    }

    const origin = segmentMidpoint(selectedSegmentPoints.a, selectedSegmentPoints.b);

    recordHistory();
    setPoints((current) => rotatePointsAround(current, origin, rotation));
    setImage((current) => (current ? rotateImageFrameAround(current, origin, rotation) : current));
    setOverlays((current) =>
      current.map((overlay) => rotateImageFrameAround(overlay, origin, rotation)),
    );
    setContextMenu(null);
    setStatus('Segment remis horizontal, photo et tracé réorientés.');
  }

  function resetView() {
    setView(INITIAL_VIEW);
  }

  function clearTrace() {
    recordHistory();
    setPoints([]);
    setIsClosed(false);
    setValidatedShape(null);
    setSelectedSegment(null);
    setLengthInput('');
    setPreviewPoint(null);
    setStatus('Tracé réinitialisé. Cliquez dans la zone pour ajouter un point.');
  }

  function validateTrace() {
    try {
      const shape = createValidatedBagShape(points, isClosed, mmPerUnit);

      setValidatedShape(shape);
      setMode('zip-setup');
      setSelectedSegment(null);
      setLengthInput('');
      setContextMenu(null);
      setPreviewPoint(null);
      setStatus('Tracé validé. Configurez les zips sur la photo avant de générer le patron.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Impossible de valider le tracé.');
    }
  }

  function returnToTrace() {
    setMode('trace');
    setStatus('Retour au tracé. Modifiez la forme puis validez à nouveau.');
  }

  function returnToZipSetup() {
    setMode('zip-setup');
    setStatus('Retour à la configuration des zips.');
  }

  function generatePatternStep() {
    try {
      const shape = createValidatedBagShape(points, isClosed, mmPerUnit);

      setValidatedShape(shape);
      setMode('pattern');
      setStatus('Les pièces de patronnage sont générées.');
    } catch (error) {
      setMode('trace');
      setStatus(error instanceof Error ? error.message : 'Impossible de générer le patron.');
    }
  }

  function renderZipSetupFaceControls(faceKey: FaceKey, label: string) {
    const face = patternParameters[faceKey];

    return (
      <section className="tool-section">
        <div className="section-title">{label}</div>
        <label className="field">
          <span>Nombre de zips</span>
          <select value={face.zipperCount} onChange={(event) => handleFaceZipCount(faceKey, event)}>
            <option value={0}>0 zip</option>
            <option value={1}>1 zip</option>
            <option value={2}>2 zips</option>
          </select>
        </label>

        {face.zippers.slice(0, face.zipperCount).map((zipper, index) => {
          const usesBottomReference = index === 1;
          const inputValue = usesBottomReference
            ? zipperBottomClearanceValue(
                zipper,
                traceHeightMm,
                patternParameters.zipperCutoutHeightMm,
              )
            : zipper.distanceFromTopTubeMm;
          const labelText = usesBottomReference
            ? 'Hauteur utile sous zip 2'
            : `Hauteur zip ${index + 1} depuis top tube`;

          return (
            <label className="field" key={zipper.id}>
              <span>{labelText}</span>
              <input
                type="number"
                min="0"
                step="1"
                value={Math.round(inputValue * 10) / 10}
                onChange={(event) =>
                  updateFace(faceKey, (currentFace) => ({
                    ...currentFace,
                    zippers: currentFace.zippers.map((currentZipper, zipperIndex) =>
                      zipperIndex === index
                        ? {
                            ...currentZipper,
                            ...(usesBottomReference
                              ? { clearanceFromBottomTubeMm: updateNumber(event.target.value) }
                              : { distanceFromTopTubeMm: updateNumber(event.target.value) }),
                          }
                        : currentZipper,
                    ),
                  }))
                }
              />
            </label>
          );
        })}
      </section>
    );
  }

  if (mode === 'pattern' && validatedShape) {
    return (
      <PatternWorkspace
        shape={validatedShape}
        parameters={patternParameters}
        onParametersChange={setPatternParameters}
        onBackToTrace={returnToZipSetup}
        backButtonLabel="Retour aux zips"
      />
    );
  }

  return (
    <main className="app-shell">
      <aside className="tool-panel" aria-label="Outils">
        <div className="brand-block">
          {mode === 'zip-setup' ? <Scissors size={22} /> : <Crosshair size={22} />}
          <div>
            <h1>Cadre Pattern</h1>
            <p>{mode === 'zip-setup' ? 'Configuration patronnage' : 'POC tracé sacoche'}</p>
          </div>
        </div>

        <section className="tool-section">
          <div className="section-title">Photo</div>
          <input
            ref={fileInputRef}
            className="hidden-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleImageImport}
          />
          <button className="primary-button" type="button" onClick={() => fileInputRef.current?.click()}>
            <ImagePlus size={18} />
            Importer
          </button>

          <label className="field">
            <span>Opacité</span>
            <input
              type="range"
              min="0.05"
              max="1"
              step="0.05"
              value={image?.opacity ?? 0.55}
              disabled={!image}
              onChange={(event) =>
                setImage((current) =>
                  current ? { ...current, opacity: Number(event.target.value) } : current,
                )
              }
            />
          </label>
        </section>

        <section className="tool-section">
          <div className="section-title">{mode === 'zip-setup' ? 'Tracé validé' : 'Tracé'}</div>
          <div className="metric-row">
            <span>Points</span>
            <strong>{points.length}</strong>
          </div>
          <div className="metric-row">
            <span>État</span>
            <strong>{isClosed ? 'Fermé' : 'Ouvert'}</strong>
          </div>
          {mode === 'zip-setup' ? (
            <>
              <div className="metric-row">
                <span>Hauteur</span>
                <strong>{formatMm(traceHeightMm)} mm</strong>
              </div>
              <button className="secondary-button" type="button" onClick={returnToTrace}>
                <ArrowLeft size={17} />
                Retour au tracé
              </button>
              <button className="primary-button" type="button" onClick={generatePatternStep}>
                <ArrowRight size={18} />
                Générer patron
              </button>
            </>
          ) : (
            <>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={showTraceDimensions}
                  onChange={(event) => setShowTraceDimensions(event.target.checked)}
                />
                Afficher dimensions
              </label>
              <div className="button-row">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={undo}
                  disabled={historyPast.length === 0}
                >
                  <Undo2 size={17} />
                  Retour
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={redo}
                  disabled={historyFuture.length === 0}
                >
                  <Redo2 size={17} />
                  Suivant
                </button>
              </div>
              <button className="secondary-button" type="button" onClick={clearTrace} disabled={points.length === 0}>
                <RotateCcw size={17} />
                Réinitialiser
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={validateTrace}
                disabled={!isClosed || points.length < 3}
              >
                <CheckCircle2 size={18} />
                Valider le tracé
              </button>
            </>
          )}
        </section>

        <section className="tool-section">
          <div className="section-title">Navigation</div>
          <button className="secondary-button" type="button" onClick={resetView}>
            <ZoomIn size={17} />
            Reset vue
          </button>
          <div className="hint-list">
            {mode === 'trace' ? (
              <>
                <span>
                  <MousePointer2 size={15} /> Clic fond : point
                </span>
                <span>
                  <MousePointer2 size={15} /> Alt + clic point : supprimer
                </span>
                <span>
                  <MousePointer2 size={15} /> Clic droit : menu
                </span>
                <span>
                  <MousePointer2 size={15} /> Ctrl+Z / Ctrl+Shift+Z
                </span>
                <span>
                  <MousePointer2 size={15} /> Double-clic segment : insérer
                </span>
              </>
            ) : (
              <>
                <span>
                  <MousePointer2 size={15} /> Glisser une ligne zip : hauteur
                </span>
                {isManualGussetSetup ? (
                  <span>
                    <MousePointer2 size={15} /> Clic point : coupe soufflet
                  </span>
                ) : null}
              </>
            )}
            <span>
              <Move size={15} /> Glisser fond : pan
            </span>
            <span>
              <ZoomIn size={15} /> Molette : zoom
            </span>
          </div>
        </section>

        {mode === 'trace' ? (
          <section className="tool-section">
            <div className="section-title">Calibration</div>
            {selectedSegmentPoints && currentSelectedLengthMm !== null ? (
              <form className="calibration-form" onSubmit={applyCalibration}>
                <div className="metric-row">
                  <span>Segment</span>
                  <strong>
                    {selectedSegmentPoints.start + 1}-{selectedSegmentPoints.end + 1}
                  </strong>
                </div>
                <div className="metric-row">
                  <span>Longueur</span>
                  <strong>{formatMm(currentSelectedLengthMm)} mm</strong>
                </div>
                <label className="field">
                  <span>Longueur réelle</span>
                  <input
                    type="number"
                    min="1"
                    step="0.1"
                    value={lengthInput}
                    onChange={(event) => setLengthInput(event.target.value)}
                  />
                </label>
                <button className="primary-button" type="submit">
                  <Ruler size={18} />
                  Appliquer
                </button>
                <button className="secondary-button" type="button" onClick={straightenSelectedSegment}>
                  <AlignHorizontalSpaceAround size={18} />
                  Remettre droit
                </button>
              </form>
            ) : (
              <p className="empty-state">Sélectionnez un segment du tracé pour saisir sa longueur en mm.</p>
            )}
          </section>
        ) : null}

        {mode === 'zip-setup' ? (
          <>
            <section className="tool-section">
              <div className="section-title">Découpe zip</div>
              <label className="field">
                <span>Hauteur découpe zip</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={patternParameters.zipperCutoutHeightMm}
                  onChange={(event) =>
                    updatePatternParameters({ zipperCutoutHeightMm: updateNumber(event.target.value) })
                  }
                />
              </label>
            </section>
            {renderZipSetupFaceControls('faceA', 'Face A')}
            {renderZipSetupFaceControls('faceB', 'Face B')}
            <section className="tool-section">
              <div className="section-title">Soufflet</div>
              <label className="field">
                <span>Découpe</span>
                <select
                  value={patternParameters.gusset.splitMode}
                  onChange={(event) =>
                    setPatternParameters((current) => ({
                      ...current,
                      gusset: {
                        ...current.gusset,
                        splitMode: event.target.value as PatternParameters['gusset']['splitMode'],
                      },
                    }))
                  }
                >
                  <option value="single-piece">Une pièce</option>
                  <option value="one-piece-per-tube">Une pièce par tube</option>
                  <option value="manual">Manuelle</option>
                </select>
              </label>
              {patternParameters.gusset.splitMode === 'one-piece-per-tube' ? (
                <label className="field">
                  <span>Angle changement pièce</span>
                  <input
                    type="number"
                    min="1"
                    max="180"
                    step="1"
                    value={patternParameters.gusset.angleBreakThresholdDeg}
                    onChange={(event) =>
                      setPatternParameters((current) => ({
                        ...current,
                        gusset: {
                          ...current.gusset,
                          angleBreakThresholdDeg: updateNumber(event.target.value),
                        },
                      }))
                    }
                  />
                </label>
              ) : null}
              {patternParameters.gusset.splitMode === 'manual' ? (
                <>
                  <div className="metric-row">
                    <span>Points de coupe</span>
                    <strong>{manualGussetBreaks.length}</strong>
                  </div>
                  <p className="empty-state">Cliquez sur les points du tracé où le soufflet doit être coupé.</p>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() =>
                      setPatternParameters((current) => ({
                        ...current,
                        gusset: {
                          ...current.gusset,
                          manualBreakSegmentIndices: [],
                        },
                      }))
                    }
                    disabled={manualGussetBreaks.length === 0}
                  >
                    <Trash2 size={17} />
                    Réinitialiser coupes
                  </button>
                </>
              ) : null}
            </section>
          </>
        ) : null}

        <section className="tool-section">
          <div className="section-title">Formes test</div>
          <label className="field">
            <span>Hydration bladder</span>
            <select
              value={overlayTemplateId}
              onChange={(event) => setOverlayTemplateId(event.target.value)}
            >
              {HYDRATION_BLADDER_TEMPLATES.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.label}
                </option>
              ))}
            </select>
          </label>
          <button className="secondary-button" type="button" onClick={() => addOverlay(overlayTemplateId)}>
            <Droplets size={17} />
            Ajouter la forme
          </button>
          {selectedOverlay && selectedOverlayTemplate ? (
            <div className="overlay-controls">
              <div className="metric-row">
                <span>Sélection</span>
                <strong>{selectedOverlayTemplate.label}</strong>
              </div>
              <div className="metric-row">
                <span>Taille</span>
                <strong>
                  {formatMm(selectedOverlay.width)} x {formatMm(selectedOverlay.height)} mm
                </strong>
              </div>
              <label className="field">
                <span>Rotation</span>
                <input
                  type="number"
                  step="5"
                  value={Math.round((selectedOverlay.rotation * 180) / Math.PI)}
                  onFocus={recordHistory}
                  onChange={(event) =>
                    updateSelectedOverlay({
                      rotation: (Number(event.target.value) * Math.PI) / 180,
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Opacité</span>
                <input
                  type="range"
                  min="0.1"
                  max="1"
                  step="0.05"
                  value={selectedOverlay.opacity}
                  onPointerDown={recordHistory}
                  onChange={(event) =>
                    updateSelectedOverlay({
                      opacity: Number(event.target.value),
                    })
                  }
                />
              </label>
              <button className="secondary-button" type="button" onClick={toggleSelectedOverlayMirror}>
                <FlipHorizontal size={17} />
                Miroir
              </button>
              <button className="secondary-button" type="button" onClick={deleteSelectedOverlay}>
                <Trash2 size={17} />
                Supprimer
              </button>
            </div>
          ) : (
            <p className="empty-state">Ajoutez une forme, puis glissez-la directement sur le tracé.</p>
          )}
        </section>

        <div className="status-line">
          {mode === 'zip-setup' ? <Settings2 size={15} /> : null}
          {status}
        </div>
      </aside>

      <section className="workspace">
        <svg
          ref={svgRef}
          className={mode === 'zip-setup' ? 'editor-svg is-zip-setup' : 'editor-svg'}
          onPointerDown={handleWorkspacePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onContextMenu={handleWorkspaceContextMenu}
          onWheel={handleWheel}
        >
          <defs>
            <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
              <path d="M 32 0 L 0 0 0 32" fill="none" stroke="rgba(31, 41, 55, 0.08)" strokeWidth="1" />
            </pattern>
          </defs>
          <rect className="workspace-hit-area" width="100%" height="100%" fill="url(#grid)" />

          <g transform={`translate(${view.offsetX} ${view.offsetY}) scale(${view.scale})`}>
            {image && (
              <image
                href={image.src}
                x={image.x}
                y={image.y}
                width={image.width}
                height={image.height}
                opacity={image.opacity}
                transform={`rotate(${(image.rotation * 180) / Math.PI} ${image.x + image.width / 2} ${
                  image.y + image.height / 2
                })`}
                preserveAspectRatio="none"
              />
            )}

            {overlays.map((overlay) => {
              const template = findBladderTemplate(overlay.templateId);

              if (!template) {
                return null;
              }

              const selected = overlay.id === selectedOverlayId;
              const scaleX = overlay.width / template.widthMm;
              const scaleY = overlay.height / template.heightMm;
              const pdfViewBox = template.viewBoxPt;

              return (
                <g
                  key={overlay.id}
                  className={selected ? 'scene-overlay selected' : 'scene-overlay'}
                  opacity={overlay.opacity}
                  transform={`translate(${overlay.x} ${overlay.y}) rotate(${(overlay.rotation * 180) / Math.PI} ${
                    overlay.width / 2
                  } ${overlay.height / 2})`}
                  onPointerDown={(event) => handleOverlayPointerDown(overlay.id, event)}
                >
                  <rect
                    className="scene-overlay-hit-area"
                    x={-24 * scaleX}
                    y={0}
                    width={overlay.width + 48 * scaleX}
                    height={overlay.height + 12 * scaleY}
                  />
                  {selected ? (
                    <rect
                      className="scene-overlay-selection"
                      x={0}
                      y={0}
                      width={overlay.width}
                      height={overlay.height}
                    />
                  ) : null}
                  <g transform={`scale(${scaleX} ${scaleY})`}>
                    <g transform={overlay.mirrored ? `translate(${template.widthMm} 0) scale(-1 1)` : undefined}>
                    {template.paths
                      .filter((path) => path.space === 'template-mm')
                      .map((path, index) => (
                        <path
                          key={`template-mm-${path.kind}-${index}`}
                          className={`bladder-path ${path.kind}`}
                          d={path.d}
                          vectorEffect="non-scaling-stroke"
                        />
                      ))}
                    <g transform={template.displayTransform}>
                    {pdfViewBox ? (
                      <g
                        transform={`translate(${-pdfViewBox.x * PDF_POINT_TO_MM} ${
                          -pdfViewBox.y * PDF_POINT_TO_MM
                        })`}
                      >
                        <g transform={`scale(${PDF_POINT_TO_MM})`}>
                          {template.paths
                            .filter((path) => path.space !== 'template-mm')
                            .map((path, index) => (
                              <path
                                key={`${path.kind}-${index}`}
                                className={`bladder-path ${path.kind}`}
                                d={path.d}
                                transform={path.transform}
                                vectorEffect="non-scaling-stroke"
                              />
                            ))}
                        </g>
                      </g>
                    ) : (
                      template.paths
                        .filter((path) => path.space !== 'template-mm')
                        .map((path, index) => (
                          <path
                            key={`${path.kind}-${index}`}
                            className={`bladder-path ${path.kind}`}
                            d={path.d}
                            transform={path.transform}
                            vectorEffect="non-scaling-stroke"
                          />
                        ))
                    )}
                    </g>
                    </g>
                  </g>
                </g>
              );
            })}

            {points.length > 1 && (
              <>
                {isClosed ? (
                  <polygon className="shape-fill" points={pointsToPolyline(points)} />
                ) : null}
                <polyline className="shape-line" points={pointsToPolyline(points)} />
                {isClosed && points.length > 2 ? (
                  <line
                    className="shape-line"
                    x1={points[points.length - 1].x}
                    y1={points[points.length - 1].y}
                    x2={points[0].x}
                    y2={points[0].y}
                  />
                ) : null}
              </>
            )}

            {showTraceDimensions && traceBounds && points.length > 1 ? (
              <g className="trace-dimensions">
                <line
                  className="trace-dimension-line"
                  x1={traceBounds.minX}
                  y1={traceBounds.minY - dimensionOffset}
                  x2={traceBounds.maxX}
                  y2={traceBounds.minY - dimensionOffset}
                />
                <line
                  className="trace-dimension-line"
                  x1={traceBounds.minX}
                  y1={traceBounds.minY}
                  x2={traceBounds.minX}
                  y2={traceBounds.minY - dimensionOffset}
                />
                <line
                  className="trace-dimension-line"
                  x1={traceBounds.maxX}
                  y1={traceBounds.minY}
                  x2={traceBounds.maxX}
                  y2={traceBounds.minY - dimensionOffset}
                />
                <line
                  className="trace-dimension-tick"
                  x1={traceBounds.minX}
                  y1={traceBounds.minY - dimensionOffset - dimensionTick}
                  x2={traceBounds.minX}
                  y2={traceBounds.minY - dimensionOffset + dimensionTick}
                />
                <line
                  className="trace-dimension-tick"
                  x1={traceBounds.maxX}
                  y1={traceBounds.minY - dimensionOffset - dimensionTick}
                  x2={traceBounds.maxX}
                  y2={traceBounds.minY - dimensionOffset + dimensionTick}
                />
                <text
                  className="trace-dimension-text"
                  x={(traceBounds.minX + traceBounds.maxX) / 2}
                  y={traceBounds.minY - dimensionOffset - dimensionTextOffset}
                  fontSize={dimensionFontSize}
                  strokeWidth={dimensionTextStroke}
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {formatMm((traceBounds.maxX - traceBounds.minX) * mmPerUnit)} mm
                </text>

                <line
                  className="trace-dimension-line"
                  x1={traceBounds.maxX + dimensionOffset}
                  y1={traceBounds.minY}
                  x2={traceBounds.maxX + dimensionOffset}
                  y2={traceBounds.maxY}
                />
                <line
                  className="trace-dimension-line"
                  x1={traceBounds.maxX}
                  y1={traceBounds.minY}
                  x2={traceBounds.maxX + dimensionOffset}
                  y2={traceBounds.minY}
                />
                <line
                  className="trace-dimension-line"
                  x1={traceBounds.maxX}
                  y1={traceBounds.maxY}
                  x2={traceBounds.maxX + dimensionOffset}
                  y2={traceBounds.maxY}
                />
                <line
                  className="trace-dimension-tick"
                  x1={traceBounds.maxX + dimensionOffset - dimensionTick}
                  y1={traceBounds.minY}
                  x2={traceBounds.maxX + dimensionOffset + dimensionTick}
                  y2={traceBounds.minY}
                />
                <line
                  className="trace-dimension-tick"
                  x1={traceBounds.maxX + dimensionOffset - dimensionTick}
                  y1={traceBounds.maxY}
                  x2={traceBounds.maxX + dimensionOffset + dimensionTick}
                  y2={traceBounds.maxY}
                />
                <text
                  className="trace-dimension-text"
                  x={traceBounds.maxX + dimensionOffset + dimensionTextOffset}
                  y={(traceBounds.minY + traceBounds.maxY) / 2}
                  fontSize={dimensionFontSize}
                  strokeWidth={dimensionTextStroke}
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {formatMm((traceBounds.maxY - traceBounds.minY) * mmPerUnit)} mm
                </text>

                {Array.from({ length: segmentCount }, (_, index) => {
                  const endIndex = segmentEndIndex(index, points.length, isClosed);
                  const a = points[index];
                  const b = points[endIndex];
                  const dx = b.x - a.x;
                  const dy = b.y - a.y;
                  const length = Math.hypot(dx, dy);

                  if (length === 0) {
                    return null;
                  }

                  const midpoint = {
                    x: (a.x + b.x) / 2,
                    y: (a.y + b.y) / 2,
                  };
                  let normal = {
                    x: -dy / length,
                    y: dx / length,
                  };

                  if (traceCentroid) {
                    const awayFromCenter = {
                      x: midpoint.x - traceCentroid.x,
                      y: midpoint.y - traceCentroid.y,
                    };

                    if (normal.x * awayFromCenter.x + normal.y * awayFromCenter.y < 0) {
                      normal = { x: -normal.x, y: -normal.y };
                    }
                  }

                  return (
                    <text
                      key={`segment-dimension-${index}-${endIndex}`}
                      className="trace-dimension-text segment"
                      x={midpoint.x + normal.x * segmentDimensionOffset}
                      y={midpoint.y + normal.y * segmentDimensionOffset}
                      fontSize={dimensionFontSize}
                      strokeWidth={dimensionTextStroke}
                      textAnchor="middle"
                      dominantBaseline="middle"
                    >
                      {formatMm(segmentLengthInMm(a, b, mmPerUnit))} mm
                    </text>
                  );
                })}
              </g>
            ) : null}

            {zipPreviews.length > 0 ? (
              <g className="zip-previews">
                {zipPreviews.map((preview) => {
                  const labelOffset = (preview.faceKey === 'faceA' ? -14 : 16) / view.scale;
                  const cutoutHeight = Math.max(
                    patternParameters.zipperCutoutHeightMm / mmPerUnit,
                    1 / view.scale,
                  );

                  return (
                    <g
                      className={`zip-preview ${preview.faceKey}`}
                      key={`${preview.faceKey}-${preview.zipperIndex}`}
                    >
                      <line
                        className="zip-preview-cutout"
                        x1={preview.x1}
                        y1={preview.y}
                        x2={preview.x2}
                        y2={preview.y}
                        strokeWidth={cutoutHeight}
                      />
                      <line
                        className="zip-preview-axis"
                        x1={preview.x1}
                        y1={preview.y}
                        x2={preview.x2}
                        y2={preview.y}
                        vectorEffect="non-scaling-stroke"
                      />
                      <text
                        className="zip-preview-label"
                        x={(preview.x1 + preview.x2) / 2}
                        y={preview.y + labelOffset}
                        fontSize={12 / view.scale}
                        strokeWidth={4 / view.scale}
                        textAnchor="middle"
                        dominantBaseline="middle"
                      >
                        {preview.label} - {formatMm(preview.valueMm)} mm
                      </text>
                      <line
                        className="zip-preview-hit-area"
                        x1={preview.x1}
                        y1={preview.y}
                        x2={preview.x2}
                        y2={preview.y}
                        vectorEffect="non-scaling-stroke"
                        onPointerDown={(event) =>
                          handleZipPointerDown(preview.faceKey, preview.zipperIndex, event)
                        }
                      />
                    </g>
                  );
                })}
              </g>
            ) : null}

            {mode === 'trace' ? Array.from({ length: segmentCount }, (_, index) => {
              const endIndex = segmentEndIndex(index, points.length, isClosed);
              const a = points[index];
              const b = points[endIndex];
              const selected = selectedSegment?.startIndex === index;

              return (
                <line
                  key={`segment-${index}-${endIndex}`}
                  className={selected ? 'segment-hit-area selected' : 'segment-hit-area'}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  vectorEffect="non-scaling-stroke"
                  onPointerDown={(event) => selectSegment(index, event)}
                  onDoubleClick={(event) => insertPointInSegment(index, event)}
                  onContextMenu={(event) => openSegmentContextMenu(index, event)}
                />
              );
            }) : null}

            {!isClosed && points.length > 0 && previewPoint ? (
              <line
                className="preview-line"
                x1={points[points.length - 1].x}
                y1={points[points.length - 1].y}
                x2={previewPoint.x}
                y2={previewPoint.y}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}

            {points.map((point, index) => (
              <circle
                key={`${point.x}-${point.y}-${index}`}
                className={[
                  index === 0 && !isClosed && points.length >= 3 ? 'point-node close-ready' : 'point-node',
                  mode === 'zip-setup' ? 'locked' : '',
                  isManualGussetSetup ? 'gusset-selectable' : '',
                  manualGussetBreakSet.has(index) ? 'gusset-break' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                cx={point.x}
                cy={point.y}
                r={pointNodeRadius}
                vectorEffect="non-scaling-stroke"
                onPointerDown={
                  mode === 'trace'
                    ? (event) => handlePointPointerDown(index, event)
                    : isManualGussetSetup
                      ? (event) => handleGussetBreakPointerDown(index, event)
                      : undefined
                }
                onContextMenu={mode === 'trace' ? (event) => openPointContextMenu(index, event) : undefined}
              />
            ))}
          </g>
        </svg>

        {contextMenu ? (
          <div
            className="context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
          >
            <button type="button" onClick={runContextMenuAction}>
              {contextMenu.kind === 'point' ? <Trash2 size={16} /> : <CirclePlus size={16} />}
              {contextMenu.kind === 'point' ? 'Supprimer le point' : 'Ajouter un point'}
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
