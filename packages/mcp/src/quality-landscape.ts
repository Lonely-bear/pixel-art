import { PixelBuffer } from '@pixel/core';

/**
 * Small, deterministic composition probes for full-bleed landscape frames.
 *
 * The old rhythm probe only looked at the alpha skyline.  That is exactly the wrong
 * input for a painted environment: a sky can be opaque all the way to the top edge,
 * while the useful ridge, waterline and reflection are internal colour boundaries.
 * These helpers deliberately report evidence (candidate rows, coverage and straightness)
 * rather than pretending that a raster can know the artist's semantic intent.
 */

export interface LandscapeBoundary {
  detected: boolean;
  y: number;
  strength: number;
  coverage: number;
  /** 1 means every column agrees on the row; lower values mean a natural contour. */
  straightness: number;
  regularity: number;
  /** Convenience flag for consumers that want a thresholded judgement. */
  uniform: boolean;
  variation: number;
  confidence: number;
}

export interface LandscapeRhythm {
  peaks: number;
  spacingCV: number;
  heightCV: number;
  uniform: boolean;
  measurable: boolean;
  lowerBandUniform: boolean;
  note: string;
}

export interface LandscapeGuideLines {
  present: boolean;
  detected: boolean;
  vertical: boolean;
  diagonal: boolean;
  verticalPresent: boolean;
  diagonalPresent: boolean;
  orientation: 'none' | 'vertical' | 'diagonal';
  brightPath: boolean;
  coherentStructure: boolean;
  score: number;
  strongest: { x: number; y: number; slope: number; span: number; kind: string } | null;
  candidates: Array<{
    x: number;
    y: number;
    slope: number;
    spanX: number;
    spanY: number;
    coherence: number;
    energy: number;
  }>;
  note: string;
}

export interface LandscapeAnalysis {
  measurable: boolean;
  scene: 'landscape' | 'opaque-field' | 'sparse';
  note: string;
  horizontalBoundaries: LandscapeBoundary[];
  horizon: LandscapeBoundary | null;
  ridge: LandscapeBoundary | null;
  waterline: LandscapeBoundary | null;
  rhythm: LandscapeRhythm;
  guideLines: LandscapeGuideLines;
  /** Spelling alias for clients that use the compositional term "guiding line". */
  guidingLines: LandscapeGuideLines;
  conclusion: string;
}

type Color = { r: number; g: number; b: number; a: number };

function luminance(color: Color): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

function colorDistance(a: Color, b: Color): number {
  return Math.max(
    Math.abs(a.r - b.r),
    Math.abs(a.g - b.g),
    Math.abs(a.b - b.b),
    Math.abs(luminance(a) - luminance(b)),
  );
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function coefficientOfVariation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

function smooth(values: ArrayLike<number>, radius: number): number[] {
  const result = Array.from(values);
  for (let index = 0; index < values.length; index++) {
    let sum = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const at = index + offset;
      if (at < 0 || at >= values.length) continue;
      sum += values[at];
      count++;
    }
    result[index] = sum / Math.max(1, count);
  }
  return result;
}

function localMaxima(values: readonly number[], threshold: number, minimumDistance: number): number[] {
  const peaks: number[] = [];
  for (let index = 1; index < values.length - 1; index++) {
    if (values[index] < threshold) continue;
    if (values[index] < values[index - 1] || values[index] < values[index + 1]) continue;
    const previous = peaks[peaks.length - 1];
    if (previous !== undefined && index - previous < minimumDistance) {
      if (values[index] > values[previous]) peaks[peaks.length - 1] = index;
      continue;
    }
    peaks.push(index);
  }
  return peaks;
}

function edgeAt(buffer: PixelBuffer, x: number, y: number, alphaThreshold: number): number {
  if (x < 0 || x >= buffer.width || y < 1 || y >= buffer.height) return 0;
  const above = buffer.getColor(x, y - 1);
  const below = buffer.getColor(x, y);
  if (above.a < alphaThreshold || below.a < alphaThreshold) return 0;
  return colorDistance(above, below);
}

function boundaryStraightness(
  buffer: PixelBuffer,
  y: number,
  edgeField: Float32Array,
  alphaThreshold: number,
): { straightness: number; coverage: number } {
  const positions: number[] = [];
  for (let x = 0; x < buffer.width; x++) {
    let bestY = -1;
    let best = 0;
    for (let candidate = Math.max(1, y - 4); candidate <= Math.min(buffer.height - 1, y + 4); candidate++) {
      const value = edgeField[candidate * buffer.width + x];
      const before = edgeField[(candidate - 1) * buffer.width + x] ?? 0;
      const after = edgeField[(candidate + 1) * buffer.width + x] ?? 0;
      // A row mean can be high because only a textured minority changed. Require a
      // local edge in each column before treating that column as evidence for the line.
      if (value < 10 || value < Math.max(before, after) * 0.82) continue;
      if (value > best) {
        best = value;
        bestY = candidate;
      }
    }
    if (bestY >= 0) positions.push(bestY);
  }
  if (positions.length < Math.max(8, buffer.width * 0.12)) {
    return { straightness: 0, coverage: positions.length / Math.max(1, buffer.width) };
  }
  const variation = coefficientOfVariation(positions);
  return {
    straightness: 1 / (1 + variation),
    coverage: positions.length / Math.max(1, buffer.width),
  };
}

function boundaryMetric(
  buffer: PixelBuffer,
  y: number,
  strength: number,
  edgeField: Float32Array,
  alphaThreshold: number,
): LandscapeBoundary {
  const geometry = boundaryStraightness(buffer, y, edgeField, alphaThreshold);
  const confidence = clamp01(geometry.coverage * 0.7 + Math.min(1, strength / 70) * 0.3);
  return {
    detected: true,
    y,
    strength,
    coverage: geometry.coverage,
    straightness: geometry.straightness,
    // `regularity` is deliberately a different name from `uniform`: it describes
    // this boundary, while `uniform` below describes repeated boundaries.
    regularity: geometry.straightness,
    uniform: geometry.straightness > 0.82,
    variation: 1 - geometry.straightness,
    confidence,
  };
}

function findRhythm(
  peakYs: readonly number[],
  lowerBound: number,
): LandscapeRhythm {
  const lowerPeaks = peakYs.filter((y) => y >= lowerBound);
  const intervals: number[] = [];
  for (let index = 1; index < lowerPeaks.length; index++) {
    intervals.push(lowerPeaks[index] - lowerPeaks[index - 1]);
  }
  const spacingCV = coefficientOfVariation(intervals);
  const heightCV = coefficientOfVariation(lowerPeaks);
  let bestRun = 0;
  let bestRunCV = 1;
  for (let start = 0; start < intervals.length; start++) {
    for (let end = start + 3; end <= intervals.length; end++) {
      const slice = intervals.slice(start, end);
      const cv = coefficientOfVariation(slice);
      if (slice.length > bestRun || (slice.length === bestRun && cv < bestRunCV)) {
        bestRun = slice.length;
        bestRunCV = cv;
      }
    }
  }
  const lowerBandUniform = bestRun >= 3 && bestRunCV < 0.3;
  const allSpacing = [];
  for (let index = 1; index < peakYs.length; index++) allSpacing.push(peakYs[index] - peakYs[index - 1]);
  const allSpacingCV = coefficientOfVariation(allSpacing);
  const uniform = lowerPeaks.length >= 5 && allSpacingCV < 0.32 && heightCV < 0.42 && lowerBandUniform;
  return {
    peaks: peakYs.length,
    spacingCV: allSpacingCV,
    heightCV,
    uniform,
    measurable: peakYs.length >= 3,
    lowerBandUniform,
    note: peakYs.length >= 3
      ? `row-edge peaks measured across ${lowerPeaks.length} lower/upper candidate(s)`
      : 'few reliable horizontal peaks; boundary evidence is weak',
  };
}

interface TensorNode {
  gx: number;
  gy: number;
  x: number;
  y: number;
  coherence: number;
  energy: number;
  orientation: number;
}

function tangentStats(
  buffer: PixelBuffer,
  alphaThreshold: number,
): { candidates: LandscapeGuideLines['candidates']; strongest: LandscapeGuideLines['strongest'] } {
  const { width, height } = buffer;
  const gx = new Float32Array(width * height);
  const gy = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x > 0 && x < width - 1) {
        const left = buffer.getColor(x - 1, y);
        const right = buffer.getColor(x + 1, y);
        if (left.a >= alphaThreshold && right.a >= alphaThreshold) {
          gx[y * width + x] = colorDistance(left, right);
        }
      }
      if (y > 0 && y < height - 1) {
        const above = buffer.getColor(x, y - 1);
        const below = buffer.getColor(x, y + 1);
        if (above.a >= alphaThreshold && below.a >= alphaThreshold) {
          gy[y * width + x] = colorDistance(above, below);
        }
      }
    }
  }

  const size = Math.max(6, Math.min(16, Math.round(Math.min(width, height) / 16)));
  const step = Math.max(4, Math.floor(size / 2));
  const nodes: TensorNode[] = [];
  for (let y = 0; y + size <= height; y += step) {
    for (let x = 0; x + size <= width; x += step) {
      let xx = 0;
      let yy = 0;
      let xy = 0;
      let energy = 0;
      for (let py = y; py < y + size; py++) {
        for (let px = x; px < x + size; px++) {
          const dx = gx[py * width + px];
          const dy = gy[py * width + px];
          xx += dx * dx;
          yy += dy * dy;
          xy += dx * dy;
          energy += dx + dy;
        }
      }
      const trace = xx + yy;
      const discriminant = Math.sqrt((xx - yy) ** 2 + 4 * xy * xy);
      const coherence = trace > 0 ? discriminant / trace : 0;
      const meanEnergy = energy / (size * size);
      if (coherence < 0.72 || meanEnergy < 25) continue;
      const orientation = 0.5 * Math.atan2(2 * xy, xx - yy);
      nodes.push({ gx: Math.floor(x / step), gy: Math.floor(y / step), x, y, coherence, energy: meanEnergy, orientation });
    }
  }

  const seen = new Set<number>();
  const nodeAt = new Map<string, number>();
  nodes.forEach((node, index) => nodeAt.set(`${node.gx},${node.gy}`, index));
  const candidates: LandscapeGuideLines['candidates'] = [];
  for (let start = 0; start < nodes.length; start++) {
    if (seen.has(start)) continue;
    const queue = [start];
    const component: TensorNode[] = [];
    seen.add(start);
    while (queue.length > 0) {
      const index = queue.pop()!;
      const node = nodes[index];
      component.push(node);
      // Walk the eight neighbouring grid cells rather than scanning every node;
      // quality_report must stay bounded on a 1024/4096px canvas.
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0) continue;
          const other = nodeAt.get(`${node.gx + ox},${node.gy + oy}`);
          if (other === undefined || seen.has(other)) continue;
          if (Math.abs(nodes[other].orientation - node.orientation) > 0.5) continue;
          seen.add(other);
          queue.push(other);
        }
      }
    }
    if (component.length < 3) continue;
    const minX = Math.min(...component.map((node) => node.x));
    const maxX = Math.max(...component.map((node) => node.x));
    const minY = Math.min(...component.map((node) => node.y));
    const maxY = Math.max(...component.map((node) => node.y));
    const orientation = component.reduce(
      (sum, node) => sum + node.orientation,
      0,
    ) / component.length;
    let tangent = orientation + Math.PI / 2;
    while (tangent < 0) tangent += Math.PI;
    while (tangent >= Math.PI) tangent -= Math.PI;
    const slope = Math.tan(tangent);
    const spanX = maxX - minX + size;
    const spanY = maxY - minY + size;
    // A long, coherent structure is useful evidence only when it is not merely a
    // horizontal water band. Bright reflection paths are measured separately below.
    if (spanY < height * 0.25 || spanX < width * 0.12) continue;
    if (Math.abs(slope) < 0.2 && spanY < height * 0.4) continue;
    candidates.push({
      x: minX + spanX / 2,
      y: minY + spanY / 2,
      slope,
      spanX,
      spanY,
      coherence: component.reduce((sum, node) => sum + node.coherence, 0) / component.length,
      energy: component.reduce((sum, node) => sum + node.energy, 0) / component.length,
    });
  }
  candidates.sort((a, b) => b.spanY + b.spanX * 0.25 - (a.spanY + a.spanX * 0.25));
  const strongest = candidates[0]
    ? {
        x: Math.round(candidates[0].x),
        y: Math.round(candidates[0].y),
        slope: candidates[0].slope,
        span: Math.max(candidates[0].spanX, candidates[0].spanY),
        kind: Math.abs(candidates[0].slope) < 0.35 ? 'vertical' : 'diagonal',
      }
    : null;
  return { candidates: candidates.slice(0, 8), strongest };
}

function brightPath(buffer: PixelBuffer, alphaThreshold: number): {
  present: boolean;
  x: number;
  y: number;
  slope: number;
  score: number;
  concentration: number;
  span: number;
} {
  const width = buffer.width;
  const height = buffer.height;
  const start = Math.floor(height * 0.5);
  const lowerHeight = Math.max(1, height - start);
  const values: number[] = [];
  for (let y = start; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = buffer.getColor(x, y);
      if (color.a >= alphaThreshold) values.push(luminance(color));
    }
  }
  values.sort((a, b) => a - b);
  const median = values.length > 0 ? values[Math.floor(values.length / 2)] : 0;
  const threshold = Math.max(105, median + 28);
  const counts = new Int32Array(width);
  for (let y = start; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = buffer.getColor(x, y);
      if (color.a < alphaThreshold || luminance(color) < threshold) continue;
      counts[x]++;
    }
  }
  const window = Math.max(3, Math.min(9, Math.floor(width / 32)));
  let bestX = Math.floor(width / 2);
  let bestCount = 0;
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let offset = -Math.floor(window / 2); offset <= Math.floor(window / 2); offset++) {
      const at = x + offset;
      if (at >= 0 && at < width) count += counts[at];
    }
    if (count > bestCount) {
      bestCount = count;
      bestX = x;
    }
  }
  let totalCount = 0;
  for (const count of counts) totalCount += count;
  const concentration = bestCount / Math.max(1, totalCount);
  const rowHits = new Int32Array(lowerHeight);
  for (let y = start; y < height; y++) {
    for (let x = Math.max(0, bestX - Math.floor(window / 2)); x <= Math.min(width - 1, bestX + Math.floor(window / 2)); x++) {
      const color = buffer.getColor(x, y);
      if (color.a >= alphaThreshold && luminance(color) >= threshold) {
        rowHits[y - start] = 1;
        break;
      }
    }
  }
  const rowSpan = rowHits.reduce((sum, value) => sum + value, 0) / lowerHeight;
  const score = bestCount / (window * lowerHeight);

  // A large painted canvas can have a real reflection path whose bright pixels are
  // spread over several neighbouring columns (and a lot of unrelated water sparkle).
  // Requiring the same 12% concentration at every resolution therefore misses the
  // lighthouse fixtures. Keep the strict concentration test for small, isolated
  // highlights, but allow a diffuse path when it has a sustained local horizontal
  // edge signature. The latter is important: a smooth vertical gradient has a high
  // row score but almost no horizontal texture, so lowering concentration alone
  // would turn every bright wash into a guide line.
  let edgeSum = 0;
  let edgeCount = 0;
  const corridorLeft = Math.max(1, bestX - Math.floor(window / 2));
  const corridorRight = Math.min(width - 2, bestX + Math.floor(window / 2));
  for (let y = start; y < height; y++) {
    for (let x = corridorLeft; x <= corridorRight; x++) {
      edgeSum += colorDistance(buffer.getColor(x - 1, y), buffer.getColor(x + 1, y));
      edgeCount++;
    }
  }
  const edgeScore = edgeSum / Math.max(1, edgeCount);
  const inFrame = bestX >= Math.floor(width * 0.06) && bestX <= Math.floor(width * 0.94);
  const basePath =
    score >= 0.1 &&
    rowSpan >= 0.18 &&
    bestCount >= 12 &&
    inFrame;
  const diffusePath = basePath && concentration >= 0.025 && edgeScore >= 5;
  const present = inFrame && ((basePath && concentration >= 0.12) || diffusePath);
  // Estimate the path's drift from row centroids. A stable centroid is a vertical
  // reflection path; a steadily moving one is a diagonal leading line.
  const centroids: Array<{ y: number; x: number }> = [];
  for (let y = start; y < height; y++) {
    let sumX = 0;
    let count = 0;
    for (let x = Math.max(0, bestX - window); x <= Math.min(width - 1, bestX + window); x++) {
      const color = buffer.getColor(x, y);
      if (color.a >= alphaThreshold && luminance(color) >= threshold) {
        sumX += x;
        count++;
      }
    }
    if (count > 0) centroids.push({ y, x: sumX / count });
  }
  let slope = 0;
  if (centroids.length >= 3) {
    const meanY = centroids.reduce((sum, point) => sum + point.y, 0) / centroids.length;
    const meanX = centroids.reduce((sum, point) => sum + point.x, 0) / centroids.length;
    const numerator = centroids.reduce((sum, point) => sum + (point.y - meanY) * (point.x - meanX), 0);
    const denominator = centroids.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0);
    slope = denominator > 0 ? numerator / denominator : 0;
  }
  return {
    present,
    x: bestX,
    y: start + Math.floor(lowerHeight / 2),
    slope,
    score,
    concentration,
    span: Math.round(lowerHeight * rowSpan),
  };
}

/** Analyse internal landscape structure in a composited frame. */
export function analyzeLandscape(buffer: PixelBuffer, alphaThreshold = 1): LandscapeAnalysis {
  const { width, height } = buffer;
  let opaque = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (buffer.getColor(x, y).a >= alphaThreshold) opaque++;
    }
  }
  const opaqueRatio = opaque / Math.max(1, width * height);
  if (opaqueRatio < 0.5) {
    const sparseGuideLines: LandscapeGuideLines = {
      present: false,
      detected: false,
      vertical: false,
      diagonal: false,
      verticalPresent: false,
      diagonalPresent: false,
      orientation: 'none',
      brightPath: false,
      coherentStructure: false,
      score: 0,
      strongest: null,
      candidates: [],
      note: 'not enough solid pixels for a guide-line probe',
    };
    return {
      measurable: false,
      scene: 'sparse',
      note: 'fewer than half the analysed pixels are solid; internal landscape boundaries are not measurable',
      horizontalBoundaries: [],
      horizon: null,
      ridge: null,
      waterline: null,
      rhythm: {
        peaks: 0,
        spacingCV: 0,
        heightCV: 0,
        uniform: false,
        measurable: false,
        lowerBandUniform: false,
        note: 'not enough solid pixels for a landscape profile',
      },
      guideLines: sparseGuideLines,
      guidingLines: sparseGuideLines,
      conclusion: 'Landscape structure is not measurable on this sparse frame.',
    };
  }

  const edgeField = new Float32Array(width * height);
  const rowStrength = new Float32Array(height);
  for (let y = 1; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      const value = edgeAt(buffer, x, y, alphaThreshold);
      edgeField[y * width + x] = value;
      sum += value;
    }
    rowStrength[y] = sum / Math.max(1, width);
  }
  const profile = smooth(rowStrength, 2);
  const maximum = Math.max(...profile);
  const threshold = Math.max(5, maximum * 0.06);
  const peakYs = localMaxima(profile, threshold, 3);
  const candidates = peakYs
    .map((y) => boundaryMetric(buffer, y, profile[y], edgeField, alphaThreshold))
    .filter((candidate) => candidate.coverage >= 0.1)
    .sort((a, b) => b.strength * (0.5 + b.coverage) - a.strength * (0.5 + a.coverage))
    .slice(0, 24)
    .sort((a, b) => a.y - b.y);

  const lower = height * 0.45;
  const waterline = candidates
    .filter((candidate) => candidate.y >= lower)
    .sort((a, b) => b.strength * (0.5 + b.coverage) - a.strength * (0.5 + a.coverage))[0] ?? null;
  const horizon = candidates
    .filter((candidate) => candidate.y <= height * 0.72 && candidate.y !== waterline?.y)
    .sort((a, b) => b.strength * (0.5 + b.coverage) - a.strength * (0.5 + a.coverage))[0] ?? null;
  const ridge = candidates
    .filter((candidate) => candidate.y <= height * 0.72)
    .sort((a, b) => (1 - a.straightness) * (0.5 + a.coverage) - (1 - b.straightness) * (0.5 + b.coverage))[0] ?? horizon;

  const rhythm = findRhythm(peakYs, lower);
  const path = brightPath(buffer, alphaThreshold);
  const coherent = tangentStats(buffer, alphaThreshold);
  const coherentGuide = coherent.strongest;
  const guidePresent = path.present || coherentGuide !== null;
  const vertical = path.present
    ? Math.abs(path.slope) < 0.35
    : coherentGuide !== null && Math.abs(coherentGuide.slope) < 0.35;
  const diagonal = path.present
    ? Math.abs(path.slope) >= 0.35
    : coherentGuide !== null && Math.abs(coherentGuide.slope) >= 0.35;
  const guideNote = path.present
    ? `bright lower-frame path score ${path.score.toFixed(3)}, concentration ${path.concentration.toFixed(3)}, at x≈${path.x}`
    : coherentGuide
      ? `coherent ${Math.abs(coherentGuide.slope) < 0.35 ? 'vertical' : 'diagonal'} structure spanning ${coherentGuide.span}px`
      : 'no long vertical or diagonal structure crossed the lower frame';

  const repeatedBands = rhythm.lowerBandUniform || (waterline?.regularity ?? 0) > 0.82;
  const scene = candidates.length >= 2 || path.present ? 'landscape' : 'opaque-field';
  const conclusion = guidePresent
    ? `Measured ${candidates.length} horizontal boundary candidate(s); a ${vertical ? 'vertical' : 'diagonal'} guide is present (${guideNote}).`
    : repeatedBands
      ? `Measured ${candidates.length} horizontal boundary candidate(s), but no vertical/diagonal guide was found; the lower frame reads as repeated bands.`
      : `Measured ${candidates.length} horizontal boundary candidate(s); no confident vertical/diagonal guide was found, so check the composition manually.`;

  const guideLines: LandscapeGuideLines = {
    present: guidePresent,
    detected: guidePresent,
    vertical,
    diagonal,
    verticalPresent: vertical,
    diagonalPresent: diagonal,
    orientation: vertical ? 'vertical' : diagonal ? 'diagonal' : 'none',
    brightPath: path.present,
    coherentStructure: coherentGuide !== null,
    score: path.present ? path.score : coherentGuide ? Math.min(1, coherentGuide.span / Math.max(1, height)) : 0,
    strongest: path.present
      ? { x: path.x, y: path.y, slope: path.slope, span: path.span, kind: Math.abs(path.slope) < 0.35 ? 'vertical' : 'diagonal' }
      : coherentGuide,
    candidates: coherent.candidates,
    note: guideNote,
  };

  return {
    measurable: true,
    scene,
    note: scene === 'landscape'
      ? 'internal colour boundaries are measurable even when the frame is full bleed'
      : 'the frame is measurable, but no strong internal landscape boundary was found',
    horizontalBoundaries: candidates,
    horizon,
    ridge,
    waterline,
    rhythm,
    guideLines,
    guidingLines: guideLines,
    conclusion,
  };
}
