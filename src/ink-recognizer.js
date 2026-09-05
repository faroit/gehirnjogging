export class InkRecognizer {
  constructor({ canvas, guide, model, translate, onRead, onState }) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { willReadFrequently: true });
    this.guide = guide;
    this.model = model;
    this.translate = translate;
    this.onRead = onRead;
    this.onState = onState;
    this.strokes = [];
    this.activeStroke = null;
    this.enabled = true;
    this.expectedDigits = 1;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
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
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2.5);
    const width = Math.max(1, Math.round(rect.width * pixelRatio));
    const height = Math.max(1, Math.round(rect.height * pixelRatio));
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.redraw();
  }

  pointFromEvent(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
      pressure: event.pressure || 0.5,
    };
  }

  pointerDown(event) {
    if (!this.enabled || event.button > 0) return;
    event.preventDefault();
    this.canvas.setPointerCapture?.(event.pointerId);
    this.activeStroke = [this.pointFromEvent(event)];
    this.strokes.push(this.activeStroke);
    this.guide.classList.add("has-ink");
    this.onState("writing");
    this.redraw();
  }

  pointerMove(event) {
    if (!this.activeStroke || !this.enabled) return;
    event.preventDefault();
    const coalesced = event.getCoalescedEvents?.();
    const events = coalesced?.length ? coalesced : [event];
    for (const sample of events) this.activeStroke.push(this.pointFromEvent(sample));
    this.redraw();
  }

  pointerUp(event) {
    if (!this.activeStroke) return;
    event.preventDefault();
    this.activeStroke.push(this.pointFromEvent(event));
    this.activeStroke = null;
    this.redraw();
    this.onState("ready", "recognition.tapSubmit");
  }

  redraw() {
    const { context, canvas } = this;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "#14305c";
    context.fillStyle = "#14305c";
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = Math.max(9, Math.min(canvas.width, canvas.height) * 0.045);

    for (const stroke of this.strokes) {
      if (stroke.length < 2) continue;
      context.beginPath();
      context.moveTo(stroke[0].x * canvas.width, stroke[0].y * canvas.height);
      for (let i = 1; i < stroke.length; i += 1) {
        const previous = stroke[i - 1];
        const point = stroke[i];
        const midX = (previous.x + point.x) * canvas.width * 0.5;
        const midY = (previous.y + point.y) * canvas.height * 0.5;
        context.quadraticCurveTo(previous.x * canvas.width, previous.y * canvas.height, midX, midY);
      }
      const last = stroke[stroke.length - 1];
      context.lineTo(last.x * canvas.width, last.y * canvas.height);
      context.stroke();
    }
  }

  clear({ silent = false } = {}) {
    this.strokes = [];
    this.activeStroke = null;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.guide.classList.remove("has-ink");
    if (!silent) this.onState("ready", "recognition.writeFull");
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
    this.read();
  }

  read() {
    if (!this.enabled || this.strokes.length === 0) return;
    const segments = this.findExpectedSegments();
    if (segments.length < this.expectedDigits) {
      this.onState("unsure", this.expectedDigits === 2 ? "recognition.onlyOne" : "recognition.keepWriting");
      return;
    }

    const predictions = segments.map((bounds) => this.model.predict(this.normalise(bounds)));
    const value = Number(predictions.map((result) => result.digit).join(""));
    const confidence = Math.min(...predictions.map((result) => result.confidence));
    const margin = Math.min(...predictions.map((result) => result.margin));

    // A low-confidence scribble should never cost the player five seconds.
    if (confidence < 0.44 || margin < 0.08) {
      this.onState(
        "unsure",
        Number.isFinite(value) ? "recognition.notSureValue" : "recognition.notSure",
        { value },
      );
      return;
    }

    this.onRead(value, { confidence, predictions });
  }

  findExpectedSegments() {
    if (this.expectedDigits === 1) {
      const bounds = this.boundsFromStrokes(this.strokes);
      return bounds ? [bounds] : [];
    }

    return this.findTwoDigitSegments();
  }

  boundsFromStrokes(strokes) {
    const { width, height } = this.canvas;
    const points = strokes.flat();
    if (!points.length) return null;
    const halfStroke = Math.max(9, Math.min(width, height) * 0.045) / 2;
    const xs = points.map((point) => point.x * width);
    const ys = points.map((point) => point.y * height);
    const left = Math.max(0, Math.min(...xs) - halfStroke);
    const right = Math.min(width, Math.max(...xs) + halfStroke);
    const top = Math.max(0, Math.min(...ys) - halfStroke);
    const bottom = Math.min(height, Math.max(...ys) + halfStroke);
    if (right - left < 3 || bottom - top < 3) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  findTwoDigitSegments() {
    const { width, height } = this.canvas;
    const pixels = this.context.getImageData(0, 0, width, height).data;
    const columns = new Uint32Array(width);
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (pixels[(y * width + x) * 4 + 3] < 24) continue;
        columns[x] += 1;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    if (maxX < minX) return [];

    const runs = [];
    let runStart = null;
    for (let x = minX; x <= maxX + 1; x += 1) {
      const occupied = x <= maxX && columns[x] > 0;
      if (occupied && runStart === null) runStart = x;
      if (!occupied && runStart !== null) {
        runs.push({ start: runStart, end: x - 1 });
        runStart = null;
      }
    }
    if (runs.length < 2) return [];

    const gaps = runs.slice(0, -1).map((run, index) => ({
      index,
      size: runs[index + 1].start - run.end - 1,
    })).sort((a, b) => b.size - a.size);
    const split = gaps[0].index;
    const horizontalSegments = [
      { start: runs[0].start, end: runs[split].end },
      { start: runs[split + 1].start, end: runs[runs.length - 1].end },
    ];

    return horizontalSegments.map((segment) => {
      let top = height;
      let bottom = -1;
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = segment.start; x <= segment.end; x += 1) {
          if (pixels[(y * width + x) * 4 + 3] >= 24) {
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      }
      return { x: segment.start, y: top, width: segment.end - segment.start + 1, height: bottom - top + 1 };
    }).filter((bounds) => bounds.width > 2 && bounds.height > 2);
  }

  normalise(bounds) {
    const size = 28;
    const inkSize = 20;
    const staging = document.createElement("canvas");
    staging.width = size;
    staging.height = size;
    const context = staging.getContext("2d", { willReadFrequently: true });
    const scale = inkSize / Math.max(bounds.width, bounds.height);
    const drawWidth = bounds.width * scale;
    const drawHeight = bounds.height * scale;
    context.drawImage(
      this.canvas,
      bounds.x, bounds.y, bounds.width, bounds.height,
      (size - drawWidth) / 2, (size - drawHeight) / 2, drawWidth, drawHeight,
    );

    const firstPass = context.getImageData(0, 0, size, size).data;
    let mass = 0;
    let massX = 0;
    let massY = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const alpha = firstPass[(y * size + x) * 4 + 3] / 255;
        mass += alpha;
        massX += x * alpha;
        massY += y * alpha;
      }
    }

    if (mass > 0) {
      const shiftX = Math.round(13.5 - massX / mass);
      const shiftY = Math.round(13.5 - massY / mass);
      if (shiftX || shiftY) {
        const copy = document.createElement("canvas");
        copy.width = size;
        copy.height = size;
        copy.getContext("2d").drawImage(staging, shiftX, shiftY);
        context.clearRect(0, 0, size, size);
        context.drawImage(copy, 0, 0);
      }
    }

    const pixels = context.getImageData(0, 0, size, size).data;
    const input = new Float32Array(size * size);
    for (let i = 0; i < input.length; i += 1) input[i] = pixels[i * 4 + 3] / 255;
    return input;
  }
}
