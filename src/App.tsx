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
  ChevronDown,
  ChevronRight,
  CirclePlus,
  Crosshair,
  Download,
  Droplets,
  Upload,
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
import {
  DEFAULT_CABLE_PASS_DISTANCE_FROM_TOP_MM,
  DEFAULT_PATTERN_PARAMETERS,
} from './pattern/defaults';
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

type AppMode = 'trace' | 'horizontal-tube' | 'zip-select' | 'gusset' | 'cable-pass' | 'pattern';

const STEP_ORDER: AppMode[] = ['trace', 'horizontal-tube', 'zip-select', 'gusset', 'cable-pass', 'pattern'];

type StepHistory = { past: SceneSnapshot[]; future: SceneSnapshot[] };

function isZipCanvasMode(m: AppMode): boolean {
  return m === 'horizontal-tube' || m === 'zip-select' || m === 'gusset' || m === 'cable-pass';
}

function segmentDeviationFromHorizontal(a: Point, b: Point): number {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  // sin(angle) = 0 when perfectly horizontal (0° or ±180°)
  return Math.abs(Math.sin(angle));
}

function isTracePerfectlyHorizontal(pts: Point[], closed: boolean): boolean {
  const n = pts.length;
  if (n < 2) return true;
  let topSegIdx = 0;
  let minAvgY = Infinity;
  const limit = closed ? n : n - 1;
  for (let i = 0; i < limit; i++) {
    const j = (i + 1) % n;
    const avgY = (pts[i].y + pts[j].y) / 2;
    if (avgY < minAvgY) {
      minAvgY = avgY;
      topSegIdx = i;
    }
  }
  const a = pts[topSegIdx];
  const b = pts[(topSegIdx + 1) % n];
  return segmentDeviationFromHorizontal(a, b) < 0.0001;
}

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

export function downloadSvgSnapshotAsPng(svgStr: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgStr, 'image/svg+xml');
  const svgEl = doc.documentElement;
  const vw = parseFloat(svgEl.getAttribute('width') ?? '800');
  const vh = parseFloat(svgEl.getAttribute('height') ?? '600');

  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vw * 2);
    canvas.height = Math.round(vh * 2);
    const ctx = canvas.getContext('2d');
    if (!ctx) { URL.revokeObjectURL(url); return; }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    canvas.toBlob((pngBlob) => {
      if (!pngBlob) return;
      const pngUrl = URL.createObjectURL(pngBlob);
      const link = document.createElement('a');
      link.href = pngUrl;
      link.download = 'cadre-vue-finale.png';
      link.click();
      URL.revokeObjectURL(pngUrl);
    }, 'image/png');
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

export default function App() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sessionInputRef = useRef<HTMLInputElement | null>(null);
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
  const [showTraceAngles, setShowTraceAngles] = useState(false);
  const [previewPoint, setPreviewPoint] = useState<Point | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [historyPast, setHistoryPast] = useState<SceneSnapshot[]>([]);
  const [historyFuture, setHistoryFuture] = useState<SceneSnapshot[]>([]);
  const [status, setStatus] = useState('Importez une photo, puis cliquez dans la zone pour tracer.');
  const [traceExpanded, setTraceExpanded] = useState(false);
  const [stepHistories, setStepHistories] = useState<Partial<Record<AppMode, StepHistory>>>({});
  const [canvasSvgSnapshot, setCanvasSvgSnapshot] = useState<string | null>(null);

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
    if (!selectedSegment || selectedSegment.startIndices.length !== 1 || points.length < 2) {
      return null;
    }

    const start = selectedSegment.startIndices[0];
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

  const selectedSegmentsInfo = useMemo(() => {
    if (!selectedSegment || selectedSegment.startIndices.length === 0 || points.length < 2) {
      return null;
    }

    const segments = selectedSegment.startIndices
      .map((startIdx) => {
        const endIdx = segmentEndIndex(startIdx, points.length, isClosed);
        return { startIdx, endIdx, a: points[startIdx], b: points[endIdx] };
      })
      .filter((seg) => seg.startIdx !== seg.endIdx);

    if (segments.length === 0) return null;

    const totalLengthMm = segments.reduce(
      (sum, seg) => sum + segmentLengthInMm(seg.a, seg.b, mmPerUnit),
      0,
    );
    const midpoints = segments.map((seg) => segmentMidpoint(seg.a, seg.b));
    const origin = {
      x: midpoints.reduce((sum, p) => sum + p.x, 0) / midpoints.length,
      y: midpoints.reduce((sum, p) => sum + p.y, 0) / midpoints.length,
    };

    return { segments, totalLengthMm, origin, count: segments.length };
  }, [isClosed, points, selectedSegment, mmPerUnit]);

  const selectedOverlay = useMemo(
    () => overlays.find((overlay) => overlay.id === selectedOverlayId) ?? null,
    [overlays, selectedOverlayId],
  );
  const selectedOverlayTemplate = selectedOverlay
    ? findBladderTemplate(selectedOverlay.templateId)
    : null;
  const pointNodeRadius = POINT_NODE_RADIUS_PX / view.scale;

  const currentSelectedLengthMm = selectedSegmentsInfo?.totalLengthMm ?? null;
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
    mode === 'gusset' && patternParameters.gusset.splitMode === 'manual';
  const cablePassSegmentIndex = patternParameters.gusset.cablePass?.segmentIndex ?? 2;
  const canSelectCablePassSegment =
    mode === 'cable-pass' && (patternParameters.gusset.cablePass?.enabled ?? false);
  const cablePassSegmentLengthMm = useMemo(() => {
    if (points.length < 2 || cablePassSegmentIndex < 0 || cablePassSegmentIndex >= segmentCount) {
      return 0;
    }

    const endIndex = segmentEndIndex(cablePassSegmentIndex, points.length, isClosed);

    return segmentLengthInMm(points[cablePassSegmentIndex], points[endIndex], mmPerUnit);
  }, [cablePassSegmentIndex, isClosed, mmPerUnit, points, segmentCount]);
  const zipPreviews = useMemo(() => {
    if (!isZipCanvasMode(mode) || !isClosed || !traceBounds) {
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

  function exportSession() {
    const state = {
      version: 1,
      image,
      points,
      isClosed,
      overlays,
      validatedShape,
      patternParameters,
      mode,
    };
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const date = new Date().toISOString().slice(0, 10);
    a.download = `traçage-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleSessionImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        if (data.version !== 1) { setStatus('Version de session non supportée.'); return; }
        setImage(data.image ?? null);
        setPoints(data.points ?? []);
        setIsClosed(data.isClosed ?? false);
        setOverlays(data.overlays ?? []);
        setValidatedShape(data.validatedShape ?? null);
        setPatternParameters(data.patternParameters);
        setMode(data.mode ?? 'trace');
        setHistoryPast([]);
        setHistoryFuture([]);
        setStatus('Session restaurée.');
      } catch {
        setStatus('Fichier de session invalide.');
      }
    };
    reader.readAsText(file);
    event.target.value = '';
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

  function updateGusset(patch: Partial<PatternParameters['gusset']>) {
    setPatternParameters((current) => ({
      ...current,
      gusset: {
        ...current.gusset,
        ...patch,
      },
    }));
  }

  function updateCablePass(patch: Partial<NonNullable<PatternParameters['gusset']['cablePass']>>) {
    setPatternParameters((current) => {
      const currentCablePass = current.gusset.cablePass ?? {
        enabled: false,
        segmentIndex: 2,
        distanceFromTopMm: DEFAULT_CABLE_PASS_DISTANCE_FROM_TOP_MM,
        overlapMm: 10,
      };

      return {
        ...current,
        gusset: {
          ...current.gusset,
          cablePass: {
            ...currentCablePass,
            ...patch,
          },
        },
      };
    });
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
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) {
      return;
    }
    if (event.button === 1) {
      event.preventDefault();
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

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      setContextMenu(null);
      const rect = svg!.getBoundingClientRect();
      const screenPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const zoomFactor = event.deltaY < 0 ? 1.12 : 0.88;
      setView((current) => zoomAtScreenPoint(current, screenPoint, current.scale * zoomFactor));
    }

    svg.addEventListener('wheel', handleWheel, { passive: false });
    return () => svg.removeEventListener('wheel', handleWheel);
  }, [mode]);

  function selectSegment(startIndex: number, event: PointerEvent<SVGLineElement>) {
    event.stopPropagation();

    if (event.button !== 0) {
      return;
    }

    setContextMenu(null);
    setSelectedOverlayId(null);

    let nextIndices: number[];

    if (event.shiftKey && selectedSegment) {
      const already = selectedSegment.startIndices.includes(startIndex);
      nextIndices = already
        ? selectedSegment.startIndices.filter((i) => i !== startIndex)
        : [...selectedSegment.startIndices, startIndex].sort((a, b) => a - b);
    } else {
      nextIndices = [startIndex];
    }

    const next: SegmentSelection | null =
      nextIndices.length > 0 ? { startIndices: nextIndices } : null;
    setSelectedSegment(next);

    if (next && points.length >= 2) {
      const totalMm = next.startIndices.reduce((sum, idx) => {
        const endIdx = segmentEndIndex(idx, points.length, isClosed);
        return sum + segmentLengthInMm(points[idx], points[endIdx], mmPerUnit);
      }, 0);
      setLengthInput(String(Math.round(totalMm * 10) / 10));
    } else {
      setLengthInput('');
    }

    const msg =
      nextIndices.length > 1
        ? `${nextIndices.length} segments sélectionnés. Saisissez leur longueur totale en mm.`
        : 'Segment sélectionné. Saisissez sa longueur réelle en millimètres.';
    setStatus(msg);
  }

  function selectCablePassSegment(startIndex: number, event: PointerEvent<SVGLineElement>) {
    event.stopPropagation();

    if (event.button !== 0) {
      return;
    }

    setContextMenu(null);
    setSelectedSegment(null);
    setSelectedOverlayId(null);
    updateCablePass({
      enabled: true,
      segmentIndex: startIndex,
    });
    setStatus(`Segment ${startIndex + 1} sélectionné pour le passe cable.`);
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

    if (!selectedSegmentsInfo) {
      return;
    }

    const targetMm = Number(lengthInput.replace(',', '.'));

    if (!Number.isFinite(targetMm) || targetMm <= 0) {
      setStatus('La longueur doit être un nombre positif.');
      return;
    }

    const { totalLengthMm, origin, count } = selectedSegmentsInfo;

    if (totalLengthMm <= 0) {
      return;
    }

    const scaleFactor = targetMm / totalLengthMm;

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
    const label = count > 1 ? `${count} segments réglés à` : 'segment réglé à';
    setStatus(`Calibration appliquée : ${label} ${formatMm(targetMm)} mm.`);
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

  function transitionStep(targetMode: AppMode, forward: boolean) {
    const currentHistory: StepHistory = { past: historyPast, future: historyFuture };

    setStepHistories((prev) => {
      const next: Partial<Record<AppMode, StepHistory>> = { ...prev, [mode]: currentHistory };
      // Going backward: clear histories of all steps after target (they're potentially invalidated)
      if (!forward) {
        const targetIdx = STEP_ORDER.indexOf(targetMode);
        for (let i = targetIdx + 1; i < STEP_ORDER.length; i++) {
          delete next[STEP_ORDER[i]];
        }
      }
      return next;
    });

    // Restore the target step's saved history (or start fresh)
    const targetHistory = stepHistories[targetMode] ?? { past: [], future: [] };
    setHistoryPast(targetHistory.past);
    setHistoryFuture(targetHistory.future);
    setMode(targetMode);
  }

  function validateTrace() {
    try {
      const shape = createValidatedBagShape(points, isClosed, mmPerUnit);

      setValidatedShape(shape);
      setSelectedSegment(null);
      setLengthInput('');
      setContextMenu(null);
      setPreviewPoint(null);
      setTraceExpanded(false);

      if (isTracePerfectlyHorizontal(points, isClosed)) {
        transitionStep('zip-select', true);
        setStatus('Tracé validé. Positionnez les zips sur les faces.');
      } else {
        transitionStep('horizontal-tube', true);
        setStatus('Sélectionnez le segment du tube horizontal pour redresser le tracé.');
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Impossible de valider le tracé.');
    }
  }

  function returnToTrace() {
    transitionStep('trace', false);
    setStatus('Retour au tracé. Modifiez la forme puis validez à nouveau.');
  }

  function confirmHorizontalTube() {
    if (selectedSegmentPoints) {
      straightenSelectedSegment();
    }
    setSelectedSegment(null);
    transitionStep('zip-select', true);
    setStatus('Positionnez les zips sur les faces.');
  }

  function proceedToGusset() {
    transitionStep('gusset', true);
    setSelectedSegment(null);
    setStatus('Configurez la découpe du soufflet.');
  }

  function returnToHorizontalTube() {
    transitionStep('horizontal-tube', false);
    setStatus('Sélectionnez le segment du tube horizontal.');
  }

  function returnToZipSelect() {
    transitionStep('zip-select', false);
    setStatus('Positionnez les zips sur les faces.');
  }

  function proceedToCablePass() {
    transitionStep('cable-pass', true);
    setStatus('Configurez le passe cable si nécessaire.');
  }

  function returnToGusset() {
    transitionStep('gusset', false);
    setStatus('Configurez la découpe du soufflet.');
  }

  function generatePatternStep() {
    try {
      const shape = createValidatedBagShape(points, isClosed, mmPerUnit);

      setValidatedShape(shape);
      setCanvasSvgSnapshot(buildCanvasSvgSnapshot());
      transitionStep('pattern', true);
      setStatus('Les pièces de patronnage sont générées.');
    } catch (error) {
      setMode('trace');
      setStatus(error instanceof Error ? error.message : 'Impossible de générer le patron.');
    }
  }

  function returnToCablePass() {
    transitionStep('cable-pass', false);
    setStatus('Configurez le passe cable si nécessaire.');
  }

  function buildCanvasSvgSnapshot(): string | null {
    const svg = svgRef.current;
    if (!svg || !traceBounds) return null;

    const W = traceBounds.maxX - traceBounds.minX;
    const padWorld = 30;
    const leftWorld = isClosed
      ? traceBounds.minX - 30 - W - padWorld
      : traceBounds.minX - padWorld;
    const rightWorld = traceBounds.maxX + padWorld;
    const topWorld = traceBounds.minY - padWorld;
    const bottomWorld = traceBounds.maxY + padWorld;

    const vx = leftWorld * view.scale + view.offsetX;
    const vy = topWorld * view.scale + view.offsetY;
    const vw = (rightWorld - leftWorld) * view.scale;
    const vh = (bottomWorld - topWorld) * view.scale;

    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
    clone.setAttribute('width', String(vw));
    clone.setAttribute('height', String(vh));

    const bgRect = clone.querySelector('.workspace-hit-area');
    if (bgRect) {
      bgRect.setAttribute('x', String(vx));
      bgRect.setAttribute('y', String(vy));
      bgRect.setAttribute('width', String(vw));
      bgRect.setAttribute('height', String(vh));
    }

    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `
      .workspace-hit-area { fill: #f4f5f6; }
      .shape-fill { fill: rgba(31,111,91,0.12); stroke: none; }
      .shape-line { fill: none; stroke: #1f6f5b; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
      .shape-fill-a { fill: rgba(37,99,168,0.10); stroke: none; }
      .shape-line-a { fill: none; stroke: #2563a8; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
      .face-canvas-label { display: none; }
      .zip-preview.faceA { color: #2563a8; }
      .zip-preview.faceB { color: #26734d; }
      .zip-preview-cutout { stroke: currentColor; opacity: 0.16; stroke-linecap: round; }
      .zip-preview-axis { stroke: currentColor; stroke-width: 2; stroke-linecap: round; vector-effect: non-scaling-stroke; }
      .zip-preview.faceB .zip-preview-axis { stroke-dasharray: 7 5; }
      .zip-preview-label { fill: currentColor; stroke: #ffffff; paint-order: stroke fill; stroke-width: 3; font-weight: 800; font-family: sans-serif; }
      .zip-preview-hit-area { display: none; }
      .segment-hit-area { display: none; }
      .cable-pass-segment { display: none; }
      .point-node { fill: #ffffff; stroke: #1f6f5b; stroke-width: 2.5; vector-effect: non-scaling-stroke; }
      .point-node.gusset-break { fill: #e85d04; stroke: #e85d04; }
      .cable-pass-marker { fill: none; stroke: #7c3aed; stroke-width: 2.5; vector-effect: non-scaling-stroke; }
      .trace-dimensions { visibility: visible; pointer-events: none; }
      .trace-dimension-line { fill: none; stroke: #4d5964; stroke-width: 1; stroke-dasharray: 4 3; vector-effect: non-scaling-stroke; }
      .trace-dimension-tick { stroke: #4d5964; stroke-width: 1; vector-effect: non-scaling-stroke; }
      .trace-dimension-text { fill: #27313b; stroke: #ffffff; paint-order: stroke fill; font-weight: 700; letter-spacing: 0; font-family: sans-serif; }
      .trace-dimension-text.segment { fill: #4d5964; font-weight: 600; }
      .trace-angles { visibility: visible; pointer-events: none; }
      .trace-angle-text { fill: #7c3aed; stroke: #ffffff; paint-order: stroke fill; font-weight: 700; font-family: sans-serif; }
      .scene-overlay-hit-area { display: none; }
      .scene-overlay-selection { display: none; }
      .bladder-path { fill: none; stroke: #4b535f; stroke-width: 1.1; stroke-linecap: round; stroke-linejoin: round; }
      .bladder-path.outline { fill: rgba(90,102,116,0.08); stroke: #26313d; stroke-width: 1.6; }
      .bladder-path.detail, .bladder-path.hose { stroke: #7a8491; stroke-width: 0.9; }
      .bladder-path.fill-cap { fill: rgba(255,255,255,0.72); stroke: #626a76; stroke-width: 1; }
      .bladder-path.port { stroke: #626a76; stroke-width: 0.95; }
    `;
    clone.insertBefore(style, clone.firstChild);
    return new XMLSerializer().serializeToString(clone);
  }

  function exportCanvasPng() {
    const svgStr = buildCanvasSvgSnapshot();
    if (!svgStr) return;
    downloadSvgSnapshotAsPng(svgStr);
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
        onBackToTrace={returnToCablePass}
        backButtonLabel="Retour au passe cable"
        canvasSvgSnapshot={canvasSvgSnapshot ?? undefined}
      />
    );
  }

  return (
    <main className="app-shell">
      <aside className="tool-panel" aria-label="Outils">
        <div className="brand-block">
          {isZipCanvasMode(mode) ? <Scissors size={22} /> : <Crosshair size={22} />}
          <div>
            <h1>Cadre Pattern</h1>
            <p>{mode === 'trace' ? 'POC tracé sacoche' : 'Configuration patronnage'}</p>
          </div>
          <div className="history-controls">
            <button
              className="icon-button"
              type="button"
              onClick={undo}
              disabled={historyPast.length === 0}
              title="Annuler (Ctrl+Z)"
            >
              <Undo2 size={15} />
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={redo}
              disabled={historyFuture.length === 0}
              title="Rétablir (Ctrl+Shift+Z)"
            >
              <Redo2 size={15} />
            </button>
          </div>
        </div>

        {isZipCanvasMode(mode) ? (
          <div className="step-indicator">
            <span className={`step-dot${mode === 'horizontal-tube' ? ' active' : ' done'}`} />
            <span className={`step-dot${mode === 'zip-select' ? ' active' : mode === 'horizontal-tube' ? '' : ' done'}`} />
            <span className={`step-dot${mode === 'gusset' ? ' active' : mode === 'cable-pass' ? ' done' : ''}`} />
            <span className={`step-dot${mode === 'cable-pass' ? ' active' : ''}`} />
            <span className="step-label">
              {mode === 'horizontal-tube' && 'Tube horizontal'}
              {mode === 'zip-select' && 'Zips'}
              {mode === 'gusset' && 'Soufflet'}
              {mode === 'cable-pass' && 'Passe cable'}
            </span>
          </div>
        ) : null}

        <section className="tool-section">
          <div className="section-title">Session</div>
          <input
            ref={sessionInputRef}
            className="hidden-input"
            type="file"
            accept="application/json,.json"
            onChange={handleSessionImport}
          />
          <button className="primary-button" type="button" onClick={exportSession}>
            <Download size={18} />
            Exporter
          </button>
          <button className="secondary-button" type="button" onClick={() => sessionInputRef.current?.click()}>
            <Upload size={18} />
            Charger
          </button>
        </section>

        {mode === 'trace' ? (
          <>
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
              <div className="section-title">Tracé</div>
              <div className="metric-row">
                <span>Points</span>
                <strong>{points.length}</strong>
              </div>
              <div className="metric-row">
                <span>État</span>
                <strong>{isClosed ? 'Fermé' : 'Ouvert'}</strong>
              </div>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={showTraceDimensions}
                  onChange={(event) => setShowTraceDimensions(event.target.checked)}
                />
                Afficher dimensions
              </label>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={showTraceAngles}
                  onChange={(event) => setShowTraceAngles(event.target.checked)}
                />
                Afficher angles
              </label>
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
            </section>

            <section className="tool-section">
              <div className="section-title">Calibration</div>
              {selectedSegmentsInfo && currentSelectedLengthMm !== null ? (
                <form className="calibration-form" onSubmit={applyCalibration}>
                  <div className="metric-row">
                    <span>{selectedSegmentsInfo.count > 1 ? 'Segments' : 'Segment'}</span>
                    <strong>
                      {selectedSegmentsInfo.count > 1
                        ? `${selectedSegmentsInfo.count} sélectionnés`
                        : `${selectedSegmentsInfo.segments[0].startIdx + 1}–${selectedSegmentsInfo.segments[0].endIdx + 1}`}
                    </strong>
                  </div>
                  <div className="metric-row">
                    <span>{selectedSegmentsInfo.count > 1 ? 'Longueur totale' : 'Longueur'}</span>
                    <strong>{formatMm(currentSelectedLengthMm)} mm</strong>
                  </div>
                  <label className="field">
                    <span>{selectedSegmentsInfo.count > 1 ? 'Longueur totale réelle' : 'Longueur réelle'}</span>
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
                  {selectedSegmentsInfo.count === 1 && (
                    <button className="secondary-button" type="button" onClick={straightenSelectedSegment}>
                      <AlignHorizontalSpaceAround size={18} />
                      Remettre droit
                    </button>
                  )}
                </form>
              ) : (
                <p className="empty-state">Cliquez sur un segment pour le sélectionner. Maj+clic pour en ajouter plusieurs.</p>
              )}
            </section>
          </>
        ) : (
          <>
            <button
              className="accordion-toggle"
              type="button"
              onClick={() => setTraceExpanded((v) => !v)}
            >
              {traceExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              Tracé — {points.length} pts · {formatMm(traceHeightMm)} mm
            </button>
            {traceExpanded ? (
              <div className="accordion-body">
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
                  <div className="section-title">Tracé validé</div>
                  <div className="metric-row">
                    <span>Points</span>
                    <strong>{points.length}</strong>
                  </div>
                  <div className="metric-row">
                    <span>Hauteur</span>
                    <strong>{formatMm(traceHeightMm)} mm</strong>
                  </div>
                  <button className="secondary-button" type="button" onClick={returnToTrace}>
                    <ArrowLeft size={17} />
                    Retour au tracé
                  </button>
                </section>
              </div>
            ) : null}
          </>
        )}

        {mode === 'horizontal-tube' ? (
          <section className="tool-section">
            <div className="section-title">Tube horizontal</div>
            {selectedSegmentPoints ? (
              <>
                <div className="metric-row">
                  <span>Segment</span>
                  <strong>{selectedSegmentPoints.start + 1}–{selectedSegmentPoints.end + 1}</strong>
                </div>
                <div className="metric-row">
                  <span>Déviation</span>
                  <strong>
                    {Math.round(
                      Math.asin(
                        segmentDeviationFromHorizontal(
                          selectedSegmentPoints.a,
                          selectedSegmentPoints.b,
                        ),
                      ) * 180 / Math.PI * 10,
                    ) / 10}°
                  </strong>
                </div>
                <button className="primary-button" type="button" onClick={confirmHorizontalTube}>
                  <AlignHorizontalSpaceAround size={18} />
                  Redresser et continuer
                </button>
              </>
            ) : (
              <p className="empty-state">Cliquez sur le segment du tube supérieur horizontal pour redresser le tracé.</p>
            )}
            <button className="secondary-button" type="button" onClick={confirmHorizontalTube}>
              Passer
            </button>
          </section>
        ) : null}

        {mode === 'zip-select' ? (
          <>
            {renderZipSetupFaceControls('faceA', 'Face A')}
            {renderZipSetupFaceControls('faceB', 'Face B')}
          </>
        ) : null}

        {mode === 'gusset' ? (
          <section className="tool-section">
            <div className="section-title">Soufflet</div>
            <label className="field">
              <span>Découpe</span>
              <select
                value={patternParameters.gusset.splitMode}
                onChange={(event) =>
                  updateGusset({
                    splitMode: event.target.value as PatternParameters['gusset']['splitMode'],
                  })
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
                    updateGusset({ angleBreakThresholdDeg: updateNumber(event.target.value) })
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
                <p className="empty-state">
                  Cliquez sur les points du tracé pour placer les coupes du soufflet.
                </p>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() =>
                    setPatternParameters((current) => ({
                      ...current,
                      gusset: { ...current.gusset, manualBreakSegmentIndices: [] },
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
        ) : null}

        {mode === 'cable-pass' ? (
          <section className="tool-section">
            <div className="section-title">Passe cable</div>
            {(() => {
              const cablePass = patternParameters.gusset.cablePass ?? {
                enabled: false,
                segmentIndex: 2,
                distanceFromTopMm: DEFAULT_CABLE_PASS_DISTANCE_FROM_TOP_MM,
                overlapMm: 10,
              };
              const distanceFromTopMm =
                cablePass.distanceFromTopMm ??
                cablePass.distanceFromSegmentStartMm ??
                DEFAULT_CABLE_PASS_DISTANCE_FROM_TOP_MM;

              return (
                <>
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={cablePass.enabled}
                      onChange={(event) => updateCablePass({ enabled: event.target.checked })}
                    />
                    <span>Passe cable down tube</span>
                  </label>
                  {cablePass.enabled ? (
                    <>
                      <p className="empty-state">
                        Cliquez sur un segment du tracé pour le sélectionner.
                      </p>
                      <div className="metric-row">
                        <span>Segment sélectionné</span>
                        <strong>{cablePass.segmentIndex + 1}</strong>
                      </div>
                      <label className="field">
                        <span>Distance depuis haut du segment</span>
                        <input
                          type="number"
                          min="0"
                          max={Math.max(0, Math.round(cablePassSegmentLengthMm * 10) / 10)}
                          step="1"
                          value={Math.round(distanceFromTopMm * 10) / 10}
                          onChange={(event) =>
                            updateCablePass({ distanceFromTopMm: updateNumber(event.target.value) })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Chevauchement</span>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={cablePass.overlapMm}
                          onChange={(event) =>
                            updateCablePass({ overlapMm: updateNumber(event.target.value) })
                          }
                        />
                      </label>
                    </>
                  ) : null}
                </>
              );
            })()}
          </section>
        ) : null}

        {isZipCanvasMode(mode) ? (
          <div className="step-nav">
            <button
              className="secondary-button"
              type="button"
              onClick={
                mode === 'horizontal-tube' ? returnToTrace :
                mode === 'zip-select' ? (isTracePerfectlyHorizontal(points, isClosed) ? returnToTrace : returnToHorizontalTube) :
                mode === 'gusset' ? returnToZipSelect :
                returnToGusset
              }
            >
              <ArrowLeft size={17} />
              Retour
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={
                mode === 'horizontal-tube' ? confirmHorizontalTube :
                mode === 'zip-select' ? proceedToGusset :
                mode === 'gusset' ? proceedToCablePass :
                generatePatternStep
              }
            >
              {mode === 'cable-pass' ? (
                <>
                  <Download size={17} />
                  Générer patron
                </>
              ) : (
                <>
                  Suivant
                  <ArrowRight size={17} />
                </>
              )}
            </button>
          </div>
        ) : null}

        <div className="status-line">
          {isZipCanvasMode(mode) ? <Settings2 size={15} /> : null}
          {status}
        </div>
      </aside>

      <section className="workspace">
        <svg
          ref={svgRef}
          className={isZipCanvasMode(mode) ? 'editor-svg is-zip-setup' : 'editor-svg'}
          onPointerDown={handleWorkspacePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onContextMenu={handleWorkspaceContextMenu}
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
                {isZipCanvasMode(mode) && isClosed && traceBounds ? (() => {
                  const gap = 30;
                  const base = 2 * traceBounds.minX - gap;
                  const faceAPts = points.map((p) => `${base - p.x},${p.y}`).join(' ');
                  return (
                    <g className="face-a-shape" pointerEvents="none">
                      <polygon className="shape-fill-a" points={faceAPts} />
                      <polygon className="shape-line-a" points={faceAPts} fill="none" />
                    </g>
                  );
                })() : null}
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

            {traceBounds && points.length > 1 ? (
              <g className="trace-dimensions" visibility={showTraceDimensions ? undefined : 'hidden'}>
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

            {isClosed && points.length > 2 ? (
              <g className="trace-angles" visibility={showTraceAngles ? undefined : 'hidden'}>
                {points.map((point, index) => {
                  const prev = points[(index - 1 + points.length) % points.length];
                  const next = points[(index + 1) % points.length];
                  const v1 = { x: prev.x - point.x, y: prev.y - point.y };
                  const v2 = { x: next.x - point.x, y: next.y - point.y };
                  const l1 = Math.hypot(v1.x, v1.y);
                  const l2 = Math.hypot(v2.x, v2.y);
                  if (l1 === 0 || l2 === 0) return null;
                  const cosAngle = Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (l1 * l2)));
                  const angleDeg = Math.round(Math.acos(cosAngle) * 180 / Math.PI);
                  let bx = v1.x / l1 + v2.x / l2;
                  let by = v1.y / l1 + v2.y / l2;
                  const bl = Math.hypot(bx, by);
                  if (bl < 0.001) {
                    bx = -v1.y / l1;
                    by = v1.x / l1;
                  } else {
                    bx /= bl;
                    by /= bl;
                  }
                  if (traceCentroid) {
                    const toCentroid = { x: traceCentroid.x - point.x, y: traceCentroid.y - point.y };
                    if (bx * toCentroid.x + by * toCentroid.y < 0) {
                      bx = -bx;
                      by = -by;
                    }
                  }
                  const offset = 22 / view.scale;
                  return (
                    <text
                      key={`angle-${index}`}
                      className="trace-angle-text"
                      x={point.x + bx * offset}
                      y={point.y + by * offset}
                      fontSize={dimensionFontSize}
                      strokeWidth={dimensionTextStroke}
                      textAnchor="middle"
                      dominantBaseline="middle"
                    >
                      {angleDeg}°
                    </text>
                  );
                })}
              </g>
            ) : null}

            {zipPreviews.length > 0 ? (
              <g className="zip-previews">
                {zipPreviews.map((preview) => {
                  const cutoutHeight = Math.max(
                    patternParameters.zipperCutoutHeightMm / mmPerUnit,
                    1 / view.scale,
                  );
                  const isFaceA = preview.faceKey === 'faceA';
                  // Face A zips are mirrored onto the Face A shape placed to the left
                  let lx1 = preview.x1;
                  let lx2 = preview.x2;
                  if (isFaceA && traceBounds) {
                    const base = 2 * traceBounds.minX - 30;
                    const mx1 = base - preview.x1;
                    const mx2 = base - preview.x2;
                    lx1 = Math.min(mx1, mx2);
                    lx2 = Math.max(mx1, mx2);
                  }
                  const midX = (lx1 + lx2) / 2;
                  const labelOffset = (isFaceA ? -14 : 16) / view.scale;

                  return (
                    <g
                      className={`zip-preview ${preview.faceKey}`}
                      key={`${preview.faceKey}-${preview.zipperIndex}`}
                    >
                      <line
                        className="zip-preview-cutout"
                        x1={lx1}
                        y1={preview.y}
                        x2={lx2}
                        y2={preview.y}
                        strokeWidth={cutoutHeight}
                      />
                      <line
                        className="zip-preview-axis"
                        x1={lx1}
                        y1={preview.y}
                        x2={lx2}
                        y2={preview.y}
                        vectorEffect="non-scaling-stroke"
                      />
                      <text
                        className="zip-preview-label"
                        x={midX}
                        y={preview.y + labelOffset}
                        fontSize={12 / view.scale}
                        strokeWidth={4 / view.scale}
                        textAnchor="middle"
                        dominantBaseline="middle"
                      >
                        {preview.label} - {formatMm(preview.valueMm)} mm
                      </text>
                      {mode === 'zip-select' ? (
                        <line
                          className="zip-preview-hit-area"
                          x1={lx1}
                          y1={preview.y}
                          x2={lx2}
                          y2={preview.y}
                          vectorEffect="non-scaling-stroke"
                          onPointerDown={(event) =>
                            handleZipPointerDown(preview.faceKey, preview.zipperIndex, event)
                          }
                        />
                      ) : null}
                    </g>
                  );
                })}
              </g>
            ) : null}

            {isZipCanvasMode(mode) && isClosed && traceBounds ? (() => {
              const gap = 30;
              const w = traceBounds.maxX - traceBounds.minX;
              const labelY = traceBounds.minY - 10 / view.scale;
              const fs = 13 / view.scale;
              // Face A center = minX - gap - w/2
              const faceACenterX = traceBounds.minX - gap - w / 2;
              // Face B center = (minX + maxX) / 2
              const faceBCenterX = (traceBounds.minX + traceBounds.maxX) / 2;
              return (
                <>
                  <text
                    className="face-canvas-label face-canvas-label--a"
                    x={faceACenterX}
                    y={labelY}
                    fontSize={fs}
                    textAnchor="middle"
                    dominantBaseline="auto"
                    pointerEvents="none"
                  >
                    Face A
                  </text>
                  <text
                    className="face-canvas-label face-canvas-label--b"
                    x={faceBCenterX}
                    y={labelY}
                    fontSize={fs}
                    textAnchor="middle"
                    dominantBaseline="auto"
                    pointerEvents="none"
                  >
                    Face B
                  </text>
                </>
              );
            })() : null}

            {(mode === 'trace' || mode === 'horizontal-tube') ? Array.from({ length: segmentCount }, (_, index) => {
              const endIndex = segmentEndIndex(index, points.length, isClosed);
              const a = points[index];
              const b = points[endIndex];
              const selected = selectedSegment?.startIndices.includes(index) ?? false;

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
                  onDoubleClick={mode === 'trace' ? (event) => insertPointInSegment(index, event) : undefined}
                  onContextMenu={mode === 'trace' ? (event) => openSegmentContextMenu(index, event) : undefined}
                />
              );
            }) : null}

            {canSelectCablePassSegment ? Array.from({ length: segmentCount }, (_, index) => {
              const endIndex = segmentEndIndex(index, points.length, isClosed);
              const a = points[index];
              const b = points[endIndex];
              const selected = cablePassSegmentIndex === index;

              return (
                <line
                  key={`cable-pass-segment-${index}-${endIndex}`}
                  className={[
                    'segment-hit-area',
                    'cable-pass-segment',
                    selected ? 'selected cable-pass-selected' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  vectorEffect="non-scaling-stroke"
                  onPointerDown={(event) => selectCablePassSegment(index, event)}
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
                  isZipCanvasMode(mode) ? 'locked' : '',
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

            {isZipCanvasMode(mode) && patternParameters.gusset.cablePass?.enabled && isClosed ? (() => {
              const cp = patternParameters.gusset.cablePass!;
              const segIdx = cp.segmentIndex;
              if (segIdx >= points.length) return null;
              const a = points[segIdx];
              const b = points[(segIdx + 1) % points.length];
              const [top, bot] = a.y <= b.y ? [a, b] : [b, a];
              const dist = (cp.distanceFromTopMm ?? 0) / mmPerUnit;
              const totalLen = Math.hypot(bot.x - top.x, bot.y - top.y);
              const t = totalLen > 0 ? Math.min(1, dist / totalLen) : 0;
              return (
                <circle
                  className="cable-pass-marker"
                  cx={top.x + (bot.x - top.x) * t}
                  cy={top.y + (bot.y - top.y) * t}
                  r={7 / view.scale}
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="none"
                />
              );
            })() : null}
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

        <div className="workspace-panel workspace-panel--top-right">
          <div className="section-title">Navigation</div>
          <button className="secondary-button" type="button" onClick={resetView}>
            <ZoomIn size={17} />
            Reset vue
          </button>
          {isZipCanvasMode(mode) && isClosed ? (
            <button className="secondary-button" type="button" onClick={exportCanvasPng}>
              <Download size={17} />
              Exporter PNG
            </button>
          ) : null}
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
        </div>

        <div className="workspace-panel workspace-panel--bottom-right">
          <div className="section-title">Formes</div>
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
            <p className="empty-state">Ajoutez une forme, puis glissez-la sur le tracé.</p>
          )}
        </div>
      </section>
    </main>
  );
}
