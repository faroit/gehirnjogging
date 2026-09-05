const MODEL_MAGIC = "DGMLP001";
const HEADER_BYTES = 32;

function validateDimension(value, name) {
  if (!Number.isInteger(value) || value <= 0 || value > 100_000) {
    throw new Error(`Invalid digit model ${name}`);
  }
  return value;
}

function dequantize(packed, scale) {
  const values = new Float32Array(packed.length);
  for (let i = 0; i < packed.length; i += 1) values[i] = packed[i] * scale;
  return values;
}

export class DigitModel {
  static async load(url, { timeoutMs = 8_000, retries = 1 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Digit model failed to load (${response.status})`);
        return DigitModel.fromBuffer(await response.arrayBuffer());
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  static fromBuffer(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < HEADER_BYTES) {
      throw new Error("Invalid digit model file");
    }

    const bytes = new Uint8Array(buffer);
    let magic = "";
    for (let i = 0; i < MODEL_MAGIC.length; i += 1) magic += String.fromCharCode(bytes[i]);
    if (magic !== MODEL_MAGIC) throw new Error("Unsupported digit model");

    const view = new DataView(buffer);
    const input = validateDimension(view.getUint32(8, true), "input size");
    const hidden = validateDimension(view.getUint32(12, true), "hidden size");
    const output = validateDimension(view.getUint32(16, true), "output size");
    const testAccuracy = view.getFloat32(20, true);
    const scale1 = view.getFloat32(24, true);
    const scale2 = view.getFloat32(28, true);
    if (!Number.isFinite(testAccuracy) || testAccuracy < 0 || testAccuracy > 1) {
      throw new Error("Invalid digit model accuracy");
    }
    if (!Number.isFinite(scale1) || scale1 <= 0 || !Number.isFinite(scale2) || scale2 <= 0) {
      throw new Error("Invalid digit model scale");
    }

    const w1Length = input * hidden;
    const b1Length = hidden;
    const w2Length = hidden * output;
    const b2Length = output;
    const w1Offset = HEADER_BYTES;
    const b1Offset = w1Offset + w1Length;
    const w2Offset = b1Offset + b1Length * Float32Array.BYTES_PER_ELEMENT;
    const b2Offset = w2Offset + w2Length;
    const expectedBytes = b2Offset + b2Length * Float32Array.BYTES_PER_ELEMENT;
    if (buffer.byteLength !== expectedBytes || b1Offset % 4 !== 0 || b2Offset % 4 !== 0) {
      throw new Error("Invalid digit model tensor lengths");
    }

    return new DigitModel({
      input,
      hidden,
      output,
      testAccuracy,
      w1: dequantize(new Int8Array(buffer, w1Offset, w1Length), scale1),
      b1: new Float32Array(buffer, b1Offset, b1Length),
      w2: dequantize(new Int8Array(buffer, w2Offset, w2Length), scale2),
      b2: new Float32Array(buffer, b2Offset, b2Length),
    });
  }

  constructor(data) {
    this.inputSize = data.input;
    this.hiddenSize = data.hidden;
    this.outputSize = data.output;
    this.testAccuracy = data.testAccuracy;
    this.w1 = data.w1;
    this.b1 = data.b1;
    this.w2 = data.w2;
    this.b2 = data.b2;
    this.hidden = new Float32Array(this.hiddenSize);
    this.logits = new Float32Array(this.outputSize);
  }

  predict(input) {
    if (input.length !== this.inputSize) {
      throw new Error(`Digit input must contain ${this.inputSize} pixels`);
    }

    this.hidden.set(this.b1);
    for (let pixel = 0; pixel < this.inputSize; pixel += 1) {
      const value = input[pixel];
      if (value < 0.001) continue;
      const offset = pixel * this.hiddenSize;
      for (let node = 0; node < this.hiddenSize; node += 1) {
        this.hidden[node] += value * this.w1[offset + node];
      }
    }
    for (let node = 0; node < this.hiddenSize; node += 1) {
      if (this.hidden[node] < 0) this.hidden[node] = 0;
    }

    this.logits.set(this.b2);
    for (let node = 0; node < this.hiddenSize; node += 1) {
      const value = this.hidden[node];
      if (value === 0) continue;
      const offset = node * this.outputSize;
      for (let digit = 0; digit < this.outputSize; digit += 1) {
        this.logits[digit] += value * this.w2[offset + digit];
      }
    }

    let bestDigit = 0;
    let bestLogit = -Infinity;
    let secondLogit = -Infinity;
    for (let digit = 0; digit < this.outputSize; digit += 1) {
      const logit = this.logits[digit];
      if (!Number.isFinite(logit)) throw new Error("Digit model produced an invalid result");
      if (logit > bestLogit) {
        secondLogit = bestLogit;
        bestLogit = logit;
        bestDigit = digit;
      } else if (logit > secondLogit) {
        secondLogit = logit;
      }
    }

    let total = 0;
    for (let digit = 0; digit < this.outputSize; digit += 1) {
      total += Math.exp(this.logits[digit] - bestLogit);
    }
    const confidence = 1 / total;
    const margin = confidence - Math.exp(secondLogit - bestLogit) / total;
    if (!Number.isFinite(confidence) || !Number.isFinite(margin)) {
      throw new Error("Digit model produced an invalid confidence");
    }
    return { digit: bestDigit, confidence, margin };
  }
}
