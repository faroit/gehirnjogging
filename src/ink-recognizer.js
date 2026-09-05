const MASK_WIDTH = 128;
const MASK_HEIGHT = 96;
const MODEL_SIZE = 28;
const MODEL_INK_SIZE = 20;
const INK_COLOR = "#14305c";

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
  constructor({ canvas, guide, model, translate, onRead, onState }) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: true, desynchronized: true });
    if (!this.context) throw new Error("Canvas drawing is not available");
    this.guide = guide;
    this.model = model;
    this.translate = translate;
    this.onRead = onRead;
    this.onState = onState;
    this.strokes = [];
    this.activeStroke = null;
    this.inkBounds = null;
    this.enabled = true;
    this.expectedDigits = 1;
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
    this.onState("ready", "recognition.tapSubmit");
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
    this.onState("ready", "recognition.writeFull");
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    this.canvas.style.pointerEvents = enabled ? "auto" : "none";
  }

  setExpectedDigits(count) {
    this.expectedDigits = Math.max(1, Math.min(2, count));
    this.canvas.setAttribute(
      "aria-label",
      this.expectedDigits === 2
        ? this.translate("aria.canvasTwo")
        : this.translate("aria.canvasOne"),
    );
  }

  refreshLocale() {
    this.setExpectedDigits(this.expectedDigits);
  }

  submit() {
    if (!this.enabled) return;
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
    const segments = this.findExpectedSegments();
    if (segments.length < this.expectedDigits) {
      this.onState("unsure", this.expectedDigits === 2 ? "recognition.onlyOne" : "recognition.keepWriting");
      return;
    }

    let digits = "";
    let confidence = 1;
    let margin = 1;
    for (const bounds of segments) {
      const input = this.normalise(bounds);
      const prediction = this.model.predict(input);
      digits += prediction.digit;
      confidence = Math.min(confidence, prediction.confidence);
      margin = Math.min(margin, prediction.margin);
    }
    const value = Number(digits);

    // A low-confidence scribble should never cost the player five seconds.
    if (!Number.isFinite(confidence) || !Number.isFinite(margin) || confidence < 0.44 || margin < 0.08) {
      this.onState(
        "unsure",
        Number.isFinite(value) ? "recognition.notSureValue" : "recognition.notSure",
        { value },
      );
      return;
    }

    this.onRead(value);
  }

  findExpectedSegments() {
    if (this.expectedDigits === 1) {
      const bounds = this.boundsFromInk();
      return bounds ? [bounds] : [];
    }
    return this.findTwoDigitSegments();
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

  findTwoDigitSegments() {
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

    const runs = [];
    let runStart = -1;
    for (let x = minX; x <= maxX + 1; x += 1) {
      const occupied = x <= maxX && columns[x] > 0;
      if (occupied && runStart < 0) runStart = x;
      if (!occupied && runStart >= 0) {
        runs.push({ start: runStart, end: x - 1 });
        runStart = -1;
      }
    }
    if (runs.length < 2) return [];

    let split = 0;
    let largestGap = -1;
    for (let i = 0; i < runs.length - 1; i += 1) {
      const gap = runs[i + 1].start - runs[i].end - 1;
      if (gap > largestGap) {
        largestGap = gap;
        split = i;
      }
    }

    const horizontalSegments = [
      { start: runs[0].start, end: runs[split].end },
      { start: runs[split + 1].start, end: runs[runs.length - 1].end },
    ];
    return horizontalSegments.map((segment) => {
      let top = MASK_HEIGHT;
      let bottom = -1;
      for (let x = segment.start; x <= segment.end; x += 1) {
        if (columns[x] === 0) continue;
        top = Math.min(top, tops[x]);
        bottom = Math.max(bottom, bottoms[x]);
      }
      return {
        x: segment.start / MASK_WIDTH * this.canvas.width,
        y: top / MASK_HEIGHT * this.canvas.height,
        width: (segment.end - segment.start + 1) / MASK_WIDTH * this.canvas.width,
        height: (bottom - top + 1) / MASK_HEIGHT * this.canvas.height,
      };
    }).filter((bounds) => bounds.width > 2 && bounds.height > 2);
  }

  normalise(bounds) {
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

    for (const stroke of this.strokes) {
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
