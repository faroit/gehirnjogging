const MASK_WIDTH = 128;
const MASK_HEIGHT = 96;
const MODEL_SIZE = 28;
const MODEL_INK_SIZE = 20;
const INK_COLOR = "#14305c";
const MAX_SPLIT_CANDIDATES = 10;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function findDominantBlankSplit(columns, minX, maxX) {
  if (maxX - minX < 6) return null;
  const span = maxX - minX;
  const safeStart = minX + Math.max(2, Math.floor(span * 0.18));
  const safeEnd = maxX - Math.max(2, Math.floor(span * 0.18));
  const gaps = [];
  let gapStart = -1;

  for (let x = safeStart; x <= safeEnd + 1; x += 1) {
    const blank = x <= safeEnd && columns[x] === 0;
    if (blank && gapStart < 0) gapStart = x;
    if (!blank && gapStart >= 0) {
      const gapEnd = x - 1;
      gaps.push({
        cut: Math.round((gapStart + gapEnd + 1) / 2),
        width: gapEnd - gapStart + 1,
      });
      gapStart = -1;
    }
  }
  gaps.sort((a, b) => b.width - a.width);
  const widest = gaps[0];
  if (!widest || widest.width < Math.max(2, Math.round(span * 0.04))) return null;
  const runnerUp = gaps[1];
  if (runnerUp && widest.width < runnerUp.width * 1.5) return null;
  return widest.cut;
}

export function findSplitCandidates(columns, minX, maxX, strokeCuts = []) {
  if (maxX - minX < 4) return [];

  const start = minX + Math.max(1, Math.floor((maxX - minX) * 0.12));
  const end = maxX - Math.max(1, Math.floor((maxX - minX) * 0.12));
  const peak = Math.max(1, ...columns.slice(minX, maxX + 1));
  const candidates = new Map();

  const add = (cut, bonus = 0, evidence = "valley") => {
    const x = clamp(Math.round(cut), start, end);
    const density = (
      (columns[x - 1] || 0) + columns[x] * 2 + (columns[x + 1] || 0)
    ) / (peak * 4);
    const centreDistance = Math.abs(x - (minX + maxX) / 2) / (maxX - minX);
    const prior = bonus - density * 0.8 - centreDistance * 0.08;
    const previous = candidates.get(x);
    if (!previous || prior > previous.prior) candidates.set(x, { prior, evidence });
  };

  // Blank runs are ideal, but use their centre rather than an arbitrary edge.
  let blankStart = -1;
  for (let x = start; x <= end + 1; x += 1) {
    const blank = x <= end && columns[x] === 0;
    if (blank && blankStart < 0) blankStart = x;
    if (!blank && blankStart >= 0) {
      const blankEnd = x - 1;
      add((blankStart + blankEnd) / 2, Math.min(0.28, (blankEnd - blankStart + 1) * 0.025), "gap");
      blankStart = -1;
    }
  }

  // Stroke order supplies boundaries even when adjacent digits touch.
  for (const strokeCut of strokeCuts) {
    const cut = typeof strokeCut === "number" ? strokeCut : strokeCut.cut;
    const bonus = typeof strokeCut === "number" ? 0.32 : strokeCut.bonus;
    add(cut, bonus, "stroke");
  }

  // Low-ink valleys cover touching digits whose separator is not fully blank.
  for (let x = start; x <= end; x += 1) {
    const density = (columns[x - 1] || 0) + columns[x] * 2 + (columns[x + 1] || 0);
    const before = (columns[x - 2] || 0) + (columns[x - 1] || 0) * 2 + columns[x];
    const after = columns[x] + (columns[x + 1] || 0) * 2 + (columns[x + 2] || 0);
    if (density <= before && density <= after) add(x);
  }
  add((minX + maxX) / 2, -0.08, "fallback");

  const ranked = [...candidates.entries()]
    .map(([cut, { prior, evidence }]) => ({ cut, prior, evidence }))
    .sort((a, b) => b.prior - a.prior);
  const selected = [];
  for (const candidate of ranked) {
    if (selected.some((item) => Math.abs(item.cut - candidate.cut) < 3)) continue;
    selected.push(candidate);
    if (selected.length === MAX_SPLIT_CANDIDATES) break;
  }
  return selected;
}

export function isRecognitionReady(result, expectedDigits, hasDistinctDigits = true, strokeCount = Infinity) {
  if (!result || !Number.isFinite(result.confidence) || !Number.isFinite(result.margin)) return false;
  if (expectedDigits === 2 && (!hasDistinctDigits || strokeCount < 2)) return false;
  return result.confidence >= 0.44 && result.margin >= 0.08;
}

function makeCanvas(width, height) {
  const canvas = typeof OffscreenCanvas === "function"
    ? new OffscreenCanvas(width, height)
    : document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function configurePen(context, lineWidth, color) {
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = lineWidth;
}

export class InkRecognizer {
  constructor({ canvas, guide, model, translate, onRead, onState, onPrediction = () => {}, onAvailability = () => {} }) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: true, desynchronized: true });
    if (!this.context) throw new Error("Canvas drawing is not available");
    this.guide = guide;
    this.model = model;
    this.translate = translate;
    this.onRead = onRead;
    this.onState = onState;
    this.onPrediction = onPrediction;
    this.onAvailability = onAvailability;
    this.strokes = [];
    this.activeStroke = null;
    this.inkBounds = null;
    this.enabled = true;
    this.expectedDigits = 1;
    this.submitAvailable = false;
    this.previewResult = null;
    this.canvasRect = { left: 0, top: 0, width: 1, height: 1 };

    this.maskCanvas = makeCanvas(MASK_WIDTH, MASK_HEIGHT);
    this.maskContext = this.maskCanvas.getContext("2d", { willReadFrequently: true });
    this.scratchCanvas = makeCanvas(MODEL_SIZE, MODEL_SIZE);
    this.scratchContext = this.scratchCanvas.getContext("2d", { willReadFrequently: true });
    if (!this.maskContext || !this.scratchContext) throw new Error("Canvas recognition is not available");
    this.modelInput = new Float32Array(MODEL_SIZE * MODEL_SIZE);
    this.maskColumns = new Uint16Array(MASK_WIDTH);
    this.maskTop = new Uint16Array(MASK_WIDTH);
    this.maskBottom = new Uint16Array(MASK_WIDTH);

    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas.parentElement);
    } else {
      window.addEventListener("resize", () => this.resize(), { passive: true });
    }
    this.bindEvents();
    this.resize();
  }

  bindEvents() {
    this.canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
    this.canvas.addEventListener("pointercancel", (event) => this.pointerUp(event));
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * pixelRatio));
    const height = Math.max(1, Math.round(rect.height * pixelRatio));
    const changed = this.canvas.width !== width || this.canvas.height !== height;
    if (changed) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.redraw();
    }
    this.cacheCanvasRect();
  }

  cacheCanvasRect() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvasRect = {
      left: rect.left,
      top: rect.top,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    };
  }

  pointFromEvent(event) {
    const rect = this.canvasRect;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  }

  pointerDown(event) {
    if (!this.enabled || event.button > 0) return;
    this.cacheCanvasRect();
    this.previewResult = null;
    this.setSubmitAvailable(false);
    try { this.canvas.setPointerCapture?.(event.pointerId); } catch { /* Synthetic or legacy pointer events may not be capturable. */ }
    const point = this.pointFromEvent(event);
    this.activeStroke = [point];
    this.strokes.push(this.activeStroke);
    this.extendBounds(point);
    this.drawDot(this.context, this.canvas.width, this.canvas.height, point, this.visibleLineWidth(), INK_COLOR);
    this.drawDot(this.maskContext, MASK_WIDTH, MASK_HEIGHT, point, this.maskLineWidth(), "#fff");
    this.guide.classList.add("has-ink");
    this.onState("writing");
  }

  pointerMove(event) {
    if (!this.activeStroke || !this.enabled) return;
    const coalesced = event.getCoalescedEvents?.();
    const events = coalesced?.length ? coalesced : [event];
    const startIndex = this.activeStroke.length - 1;
    for (const sample of events) this.storePoint(this.pointFromEvent(sample));
    this.drawStrokeTail(startIndex);
  }

  pointerUp(event) {
    if (!this.activeStroke) return;
    const startIndex = this.activeStroke.length - 1;
    this.storePoint(this.pointFromEvent(event), true);
    this.drawStrokeTail(startIndex);
    this.activeStroke = null;
    this.updateReadiness();
  }

  storePoint(point, force = false) {
    const stroke = this.activeStroke;
    const previous = stroke[stroke.length - 1];
    const dx = (point.x - previous.x) * this.canvasRect.width;
    const dy = (point.y - previous.y) * this.canvasRect.height;
    if (!force && dx * dx + dy * dy < 0.25) return;
    if (point.x === previous.x && point.y === previous.y) return;

    stroke.push(point);
    this.extendBounds(point);
  }

  drawStrokeTail(startIndex) {
    const stroke = this.activeStroke;
    if (stroke.length <= startIndex + 1) return;
    this.drawPath(
      this.context,
      this.canvas.width,
      this.canvas.height,
      stroke,
      startIndex,
      this.visibleLineWidth(),
      INK_COLOR,
    );
    this.drawPath(
      this.maskContext,
      MASK_WIDTH,
      MASK_HEIGHT,
      stroke,
      startIndex,
      this.maskLineWidth(),
      "#fff",
    );
  }

  extendBounds(point) {
    if (!this.inkBounds) {
      this.inkBounds = { minX: point.x, maxX: point.x, minY: point.y, maxY: point.y };
      return;
    }
    this.inkBounds.minX = Math.min(this.inkBounds.minX, point.x);
    this.inkBounds.maxX = Math.max(this.inkBounds.maxX, point.x);
    this.inkBounds.minY = Math.min(this.inkBounds.minY, point.y);
    this.inkBounds.maxY = Math.max(this.inkBounds.maxY, point.y);
  }

  visibleLineWidth() {
    return Math.max(9, Math.min(this.canvas.width, this.canvas.height) * 0.045);
  }

  maskLineWidth() {
    const normalisedWidth = this.visibleLineWidth() / Math.min(this.canvas.width, this.canvas.height);
    return Math.max(2, normalisedWidth * Math.min(MASK_WIDTH, MASK_HEIGHT));
  }

  drawDot(context, width, height, point, lineWidth, color) {
    configurePen(context, lineWidth, color);
    context.beginPath();
    context.arc(point.x * width, point.y * height, lineWidth / 2, 0, Math.PI * 2);
    context.fill();
  }

  drawPath(context, width, height, points, startIndex, lineWidth, color) {
    configurePen(context, lineWidth, color);
    context.beginPath();
    context.moveTo(points[startIndex].x * width, points[startIndex].y * height);
    for (let i = startIndex + 1; i < points.length; i += 1) {
      context.lineTo(points[i].x * width, points[i].y * height);
    }
    context.stroke();
  }

  redraw() {
    const { context, canvas } = this;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const lineWidth = this.visibleLineWidth();
    for (const stroke of this.strokes) {
      if (stroke.length === 1) {
        this.drawDot(context, canvas.width, canvas.height, stroke[0], lineWidth, INK_COLOR);
        continue;
      }
      configurePen(context, lineWidth, INK_COLOR);
      context.beginPath();
      context.moveTo(stroke[0].x * canvas.width, stroke[0].y * canvas.height);
      for (let i = 1; i < stroke.length; i += 1) {
        context.lineTo(stroke[i].x * canvas.width, stroke[i].y * canvas.height);
      }
      context.stroke();
    }
  }

  clear() {
    this.strokes = [];
    this.activeStroke = null;
    this.inkBounds = null;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.maskContext.clearRect(0, 0, MASK_WIDTH, MASK_HEIGHT);
    this.guide.classList.remove("has-ink");
    this.previewResult = null;
    this.setSubmitAvailable(false);
    this.onPrediction(null);
    this.onState("ready", "recognition.writeFull");
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.canvas.style.pointerEvents = enabled ? "auto" : "none";
    if (!enabled) {
      this.previewResult = null;
      this.setSubmitAvailable(false);
    }
  }

  setExpectedDigits(count) {
    this.expectedDigits = Math.max(1, Math.min(2, count));
    this.previewResult = null;
    this.setSubmitAvailable(false);
    this.onPrediction(null);
    this.canvas.setAttribute(
      "aria-label",
      this.expectedDigits === 2
        ? this.translate("aria.canvasTwo")
        : this.translate("aria.canvasOne"),
    );
  }

  refreshLocale() {
    this.canvas.setAttribute(
      "aria-label",
      this.expectedDigits === 2
        ? this.translate("aria.canvasTwo")
        : this.translate("aria.canvasOne"),
    );
  }

  setSubmitAvailable(available) {
    if (this.submitAvailable === available) return;
    this.submitAvailable = available;
    this.onAvailability(available);
  }

  updateReadiness() {
    if (!this.enabled || this.activeStroke || this.strokes.length === 0) {
      this.previewResult = null;
      this.setSubmitAvailable(false);
      return;
    }

    let result;
    let prediction;
    let hasDistinctDigits = true;
    if (this.expectedDigits === 2) {
      const candidates = this.findTwoDigitCandidates().filter((candidate) => candidate.distinct);
      hasDistinctDigits = candidates.length > 0;
      result = hasDistinctDigits ? this.recogniseTwoDigits(candidates) : null;
      prediction = result || this.recogniseSegments(this.findExpectedSegments(), 1);
    } else {
      result = this.recogniseSegments(this.findExpectedSegments());
      prediction = result;
    }

    const ready = isRecognitionReady(result, this.expectedDigits, hasDistinctDigits, this.strokes.length);
    this.previewResult = ready ? result : null;
    this.setSubmitAvailable(ready);
    this.onPrediction(prediction?.digits ?? null, { complete: ready });
    this.onState(
      ready ? "ready" : "writing",
      ready
        ? "recognition.tapSubmit"
        : this.expectedDigits === 2 ? "recognition.onlyOne" : "recognition.keepWriting",
    );
  }

  submit() {
    if (!this.enabled || !this.submitAvailable) return;
    if (!this.strokes.length) {
      this.onState("unsure", "recognition.empty");
      return;
    }
    this.onState("reading", "recognition.readingComplete");
    try {
      this.read();
    } catch (error) {
      console.error(error);
      this.onState("unsure", "recognition.notSure");
    }
  }

  read() {
    if (!this.enabled || this.strokes.length === 0) return;
    const result = this.previewResult || (this.expectedDigits === 2
      ? this.recogniseTwoDigits()
      : this.recogniseSegments(this.findExpectedSegments()));
    if (!result) {
      this.onState("unsure", this.expectedDigits === 2 ? "recognition.onlyOne" : "recognition.keepWriting");
      return;
    }
    const { value, confidence, margin } = result;

    // A low-confidence scribble should never cost the player five seconds.
    if (!isRecognitionReady(result, this.expectedDigits)) {
      this.onState(
        "unsure",
        Number.isFinite(value) ? "recognition.notSureValue" : "recognition.notSure",
        { value },
      );
      return;
    }

    this.onRead(value);
  }

  recogniseSegments(segments, requiredDigits = this.expectedDigits) {
    if (segments.length < requiredDigits) return null;
    let digits = "";
    let confidence = 1;
    let margin = 1;
    let score = 0;
    for (const segment of segments) {
      const prediction = this.model.predict(this.normalise(segment));
      digits += prediction.digit;
      confidence = Math.min(confidence, prediction.confidence);
      margin = Math.min(margin, prediction.margin);
      score += Math.log(Math.max(prediction.confidence, 0.0001)) + prediction.margin * 0.65;
    }
    return { value: Number(digits), confidence, margin, score, digits };
  }

  recogniseTwoDigits(candidates = this.findTwoDigitCandidates()) {
    let best = null;
    for (const candidate of candidates) {
      const result = this.recogniseSegments(candidate.segments);
      if (!result) continue;
      // Arithmetic answers never have a leading zero, so reject that otherwise-attractive split.
      const score = result.score + candidate.prior + (result.digits[0] === "0" ? -2 : 0);
      if (!best || score > best.score) best = { ...result, score };
    }
    return best;
  }

  findExpectedSegments() {
    const bounds = this.boundsFromInk();
    return bounds ? [bounds] : [];
  }

  boundsFromInk() {
    if (!this.inkBounds) return null;
    const { width, height } = this.canvas;
    const halfStroke = this.visibleLineWidth() / 2;
    const left = Math.max(0, this.inkBounds.minX * width - halfStroke);
    const right = Math.min(width, this.inkBounds.maxX * width + halfStroke);
    const top = Math.max(0, this.inkBounds.minY * height - halfStroke);
    const bottom = Math.min(height, this.inkBounds.maxY * height + halfStroke);
    if (right - left < 3 || bottom - top < 3) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  findTwoDigitCandidates() {
    // A continuous pen stroke is always one digit. Splitting it at an ink valley
    // turns shapes such as a handwritten "2" into bogus answers like "12".
    // Two-digit answers must therefore be written as separate pen strokes.
    if (this.strokes.length < 2) return [];

    const pixels = this.maskContext.getImageData(0, 0, MASK_WIDTH, MASK_HEIGHT).data;
    const columns = this.maskColumns;
    const tops = this.maskTop;
    const bottoms = this.maskBottom;
    columns.fill(0);
    tops.fill(MASK_HEIGHT);
    bottoms.fill(0);
    let minX = MASK_WIDTH;
    let maxX = -1;

    for (let y = 0; y < MASK_HEIGHT; y += 1) {
      for (let x = 0; x < MASK_WIDTH; x += 1) {
        if (pixels[(y * MASK_WIDTH + x) * 4 + 3] < 24) continue;
        columns[x] += 1;
        tops[x] = Math.min(tops[x], y);
        bottoms[x] = Math.max(bottoms[x], y);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    }
    if (maxX < minX) return [];

    // Preserve the natural writing order: one completed digit, then the next.
    // Pixel-only cuts are deliberately not used here; a valley inside a single
    // digit is not evidence of a second digit.
    return this.findStrokeGroupCandidates().filter((candidate) => candidate.distinct);
  }

  findStrokeGroupCandidates() {
    if (this.strokes.length < 2) return [];
    const candidates = [];
    for (let partition = 1; partition < this.strokes.length; partition += 1) {
      const left = this.boundsFromStrokeRange(0, partition);
      const right = this.boundsFromStrokeRange(partition, this.strokes.length);
      if (!left || !right) continue;
      const leftCentre = left.x + left.width / 2;
      const rightCentre = right.x + right.width / 2;
      if (leftCentre >= rightCentre) continue;
      const separation = (rightCentre - leftCentre) / Math.max(1, this.canvas.width);
      const overlap = Math.max(0, left.x + left.width - right.x) / Math.max(1, Math.min(left.width, right.width));
      candidates.push({
        prior: 0.18 + Math.min(0.32, separation * 0.9) - Math.min(0.18, overlap * 0.15),
        distinct: separation >= 0.12 && overlap <= 0.45,
        segments: [
          { bounds: left, strokeStart: 0, strokeEnd: partition },
          { bounds: right, strokeStart: partition, strokeEnd: this.strokes.length },
        ],
      });
    }
    return candidates;
  }

  boundsFromStrokeRange(start, end) {
    let minX = 1;
    let maxX = 0;
    let minY = 1;
    let maxY = 0;
    for (let index = start; index < end; index += 1) {
      for (const point of this.strokes[index]) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
      }
    }
    if (maxX < minX || maxY < minY) return null;
    const halfStroke = this.visibleLineWidth() / 2;
    const left = Math.max(0, minX * this.canvas.width - halfStroke);
    const right = Math.min(this.canvas.width, maxX * this.canvas.width + halfStroke);
    const top = Math.max(0, minY * this.canvas.height - halfStroke);
    const bottom = Math.min(this.canvas.height, maxY * this.canvas.height + halfStroke);
    if (right - left < 3 || bottom - top < 3) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  findStrokeCuts(minX, maxX) {
    if (this.strokes.length < 2) return [];
    const ranges = this.strokes.map((stroke) => {
      let start = MASK_WIDTH;
      let end = -1;
      for (const point of stroke) {
        const x = clamp(Math.round(point.x * (MASK_WIDTH - 1)), 0, MASK_WIDTH - 1);
        start = Math.min(start, x);
        end = Math.max(end, x);
      }
      return { start, end };
    });
    const cuts = [];
    for (let partition = 1; partition < ranges.length; partition += 1) {
      let leftStart = MASK_WIDTH;
      let leftEnd = -1;
      let rightStart = MASK_WIDTH;
      let rightEnd = -1;
      for (let i = 0; i < partition; i += 1) {
        leftStart = Math.min(leftStart, ranges[i].start);
        leftEnd = Math.max(leftEnd, ranges[i].end);
      }
      for (let i = partition; i < ranges.length; i += 1) {
        rightStart = Math.min(rightStart, ranges[i].start);
        rightEnd = Math.max(rightEnd, ranges[i].end);
      }
      const leftCentre = (leftStart + leftEnd) / 2;
      const rightCentre = (rightStart + rightEnd) / 2;
      if (leftCentre >= rightCentre) continue;
      const cut = leftEnd < rightStart
        ? (leftEnd + rightStart + 1) / 2
        : (leftCentre + rightCentre) / 2;
      const separation = (rightCentre - leftCentre) / Math.max(1, maxX - minX);
      const bonus = leftEnd < rightStart
        ? 0.38
        : clamp(separation * 0.28, 0.08, 0.2);
      if (cut > minX && cut <= maxX) cuts.push({ cut, bonus });
    }
    return cuts;
  }

  boundsForMaskRange(start, end, columns, tops, bottoms) {
    while (start <= end && columns[start] === 0) start += 1;
    while (end >= start && columns[end] === 0) end -= 1;
    if (end < start) return null;
    let top = MASK_HEIGHT;
    let bottom = -1;
    for (let x = start; x <= end; x += 1) {
      if (columns[x] === 0) continue;
      top = Math.min(top, tops[x]);
      bottom = Math.max(bottom, bottoms[x]);
    }
    if (bottom < top) return null;
    const bounds = {
      x: start / MASK_WIDTH * this.canvas.width,
      y: top / MASK_HEIGHT * this.canvas.height,
      width: (end - start + 1) / MASK_WIDTH * this.canvas.width,
      height: (bottom - top + 1) / MASK_HEIGHT * this.canvas.height,
    };
    return bounds.width > 2 && bounds.height > 2 ? bounds : null;
  }

  normalise(segment) {
    const bounds = segment.bounds || segment;
    const strokeStart = segment.strokeStart ?? 0;
    const strokeEnd = segment.strokeEnd ?? this.strokes.length;
    const context = this.scratchContext;
    context.clearRect(0, 0, MODEL_SIZE, MODEL_SIZE);
    const scale = MODEL_INK_SIZE / Math.max(bounds.width, bounds.height);
    const drawWidth = bounds.width * scale;
    const drawHeight = bounds.height * scale;
    const offsetX = (MODEL_SIZE - drawWidth) / 2 - bounds.x * scale;
    const offsetY = (MODEL_SIZE - drawHeight) / 2 - bounds.y * scale;
    const lineWidth = this.visibleLineWidth() * scale;
    configurePen(context, lineWidth, "#fff");
    context.save();
    context.beginPath();
    context.rect((MODEL_SIZE - drawWidth) / 2, (MODEL_SIZE - drawHeight) / 2, drawWidth, drawHeight);
    context.clip();

    for (let strokeIndex = strokeStart; strokeIndex < strokeEnd; strokeIndex += 1) {
      const stroke = this.strokes[strokeIndex];
      if (stroke.length === 1) {
        context.beginPath();
        context.arc(
          stroke[0].x * this.canvas.width * scale + offsetX,
          stroke[0].y * this.canvas.height * scale + offsetY,
          lineWidth / 2,
          0,
          Math.PI * 2,
        );
        context.fill();
        continue;
      }
      context.beginPath();
      context.moveTo(
        stroke[0].x * this.canvas.width * scale + offsetX,
        stroke[0].y * this.canvas.height * scale + offsetY,
      );
      for (let i = 1; i < stroke.length; i += 1) {
        context.lineTo(
          stroke[i].x * this.canvas.width * scale + offsetX,
          stroke[i].y * this.canvas.height * scale + offsetY,
        );
      }
      context.stroke();
    }
    context.restore();

    const pixels = context.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
    let mass = 0;
    let massX = 0;
    let massY = 0;
    for (let y = 0; y < MODEL_SIZE; y += 1) {
      for (let x = 0; x < MODEL_SIZE; x += 1) {
        const alpha = pixels[(y * MODEL_SIZE + x) * 4 + 3] / 255;
        mass += alpha;
        massX += x * alpha;
        massY += y * alpha;
      }
    }

    const shiftX = mass > 0 ? Math.round(13.5 - massX / mass) : 0;
    const shiftY = mass > 0 ? Math.round(13.5 - massY / mass) : 0;
    this.modelInput.fill(0);
    for (let y = 0; y < MODEL_SIZE; y += 1) {
      const targetY = y + shiftY;
      if (targetY < 0 || targetY >= MODEL_SIZE) continue;
      for (let x = 0; x < MODEL_SIZE; x += 1) {
        const targetX = x + shiftX;
        if (targetX < 0 || targetX >= MODEL_SIZE) continue;
        this.modelInput[targetY * MODEL_SIZE + targetX] =
          pixels[(y * MODEL_SIZE + x) * 4 + 3] / 255;
      }
    }
    return this.modelInput;
  }
}
