const MODEL_MAGIC = "DGMLP001";
const CNN_MAGIC = "DGCNN001";
const HEADER_BYTES = 32;
const CNN_HEADER_BYTES = 16;

function readMagic(bytes) {
  let magic = "";
  for (let i = 0; i < 8; i += 1) magic += String.fromCharCode(bytes[i]);
  return magic;
}

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

function dequantizeBlocks(packed, scales, blockSize) {
  const values = new Float32Array(packed.length);
  for (let i = 0; i < packed.length; i += 1) values[i] = packed[i] * scales[Math.floor(i / blockSize)];
  return values;
}

function dequantizeStrided(packed, scales) {
  const values = new Float32Array(packed.length);
  for (let i = 0; i < packed.length; i += 1) values[i] = packed[i] * scales[i % scales.length];
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
    const magic = readMagic(bytes);
    if (magic === CNN_MAGIC) return DigitModel.fromCnnBuffer(buffer);
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

  static fromCnnBuffer(buffer) {
    const expectedBytes = 6_248;
    if (buffer.byteLength !== expectedBytes) throw new Error("Invalid CNN model tensor lengths");
    const view = new DataView(buffer);
    const testAccuracy = view.getFloat32(8, true);
    if (!Number.isFinite(testAccuracy) || testAccuracy < 0 || testAccuracy > 1) {
      throw new Error("Invalid CNN model accuracy");
    }

    let offset = CNN_HEADER_BYTES;
    const takeFloats = (length) => {
      const result = new Float32Array(buffer, offset, length);
      offset += length * Float32Array.BYTES_PER_ELEMENT;
      return result;
    };
    const takeInts = (length) => {
      const result = new Int8Array(buffer, offset, length);
      offset += length;
      return result;
    };
    const scale1 = takeFloats(8);
    const scale2 = takeFloats(16);
    const scale3 = takeFloats(10);
    const conv1 = dequantizeBlocks(takeInts(8 * 1 * 5 * 5), scale1, 25);
    const bias1 = takeFloats(8);
    const conv2 = dequantizeBlocks(takeInts(16 * 8 * 5 * 5), scale2, 8 * 25);
    const bias2 = takeFloats(16);
    const dense = dequantizeStrided(takeInts(16 * 4 * 4 * 10), scale3);
    const bias3 = takeFloats(10);
    if (offset !== expectedBytes) throw new Error("Invalid CNN model layout");
    return new DigitModel({ kind: "cnn", input: 784, output: 10, testAccuracy, conv1, bias1, conv2, bias2, dense, bias3 });
  }

  constructor(data) {
    this.kind = data.kind || "mlp";
    this.inputSize = data.input;
    this.hiddenSize = data.hidden;
    this.outputSize = data.output;
    this.testAccuracy = data.testAccuracy;
    this.w1 = data.w1;
    this.b1 = data.b1;
    this.w2 = data.w2;
    this.b2 = data.b2;
    this.hidden = this.kind === "mlp" ? new Float32Array(this.hiddenSize) : null;
    this.logits = new Float32Array(this.outputSize);
    if (this.kind === "cnn") {
      this.conv1 = data.conv1;
      this.bias1 = data.bias1;
      this.conv2 = data.conv2;
      this.bias2 = data.bias2;
      this.dense = data.dense;
      this.bias3 = data.bias3;
      this.conv1Output = new Float32Array(8 * 28 * 28);
      this.pool1Output = new Float32Array(8 * 14 * 14);
      this.conv2Output = new Float32Array(16 * 14 * 14);
      this.pool2Output = new Float32Array(16 * 4 * 4);
    }
  }

  predict(input) {
    if (input.length !== this.inputSize) {
      throw new Error(`Digit input must contain ${this.inputSize} pixels`);
    }

    if (this.kind === "cnn") return this.predictCnn(input);

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

    return this.resultFromLogits();
  }

  predictCnn(input) {
    const conv1 = this.conv1Output;
    for (let output = 0; output < 8; output += 1) {
      const weightBase = output * 25;
      const outputBase = output * 28 * 28;
      for (let y = 0; y < 28; y += 1) {
        for (let x = 0; x < 28; x += 1) {
          let sum = this.bias1[output];
          for (let kernelY = 0; kernelY < 5; kernelY += 1) {
            const inputY = y + kernelY - 2;
            if (inputY < 0 || inputY >= 28) continue;
            for (let kernelX = 0; kernelX < 5; kernelX += 1) {
              const inputX = x + kernelX - 2;
              if (inputX < 0 || inputX >= 28) continue;
              sum += input[inputY * 28 + inputX] * this.conv1[weightBase + kernelY * 5 + kernelX];
            }
          }
          conv1[outputBase + y * 28 + x] = Math.max(0, sum);
        }
      }
    }

    const pool1 = this.pool1Output;
    for (let channel = 0; channel < 8; channel += 1) {
      const inputBase = channel * 28 * 28;
      const outputBase = channel * 14 * 14;
      for (let y = 0; y < 14; y += 1) {
        for (let x = 0; x < 14; x += 1) {
          const index = inputBase + y * 2 * 28 + x * 2;
          pool1[outputBase + y * 14 + x] = Math.max(
            conv1[index], conv1[index + 1], conv1[index + 28], conv1[index + 29],
          );
        }
      }
    }

    const conv2 = this.conv2Output;
    for (let output = 0; output < 16; output += 1) {
      const outputBase = output * 14 * 14;
      const outputWeightBase = output * 8 * 25;
      for (let y = 0; y < 14; y += 1) {
        for (let x = 0; x < 14; x += 1) {
          let sum = this.bias2[output];
          for (let inputChannel = 0; inputChannel < 8; inputChannel += 1) {
            const inputBase = inputChannel * 14 * 14;
            const weightBase = outputWeightBase + inputChannel * 25;
            for (let kernelY = 0; kernelY < 5; kernelY += 1) {
              const inputY = y + kernelY - 2;
              if (inputY < 0 || inputY >= 14) continue;
              for (let kernelX = 0; kernelX < 5; kernelX += 1) {
                const inputX = x + kernelX - 2;
                if (inputX < 0 || inputX >= 14) continue;
                sum += pool1[inputBase + inputY * 14 + inputX] * this.conv2[weightBase + kernelY * 5 + kernelX];
              }
            }
          }
          conv2[outputBase + y * 14 + x] = Math.max(0, sum);
        }
      }
    }

    const pool2 = this.pool2Output;
    for (let channel = 0; channel < 16; channel += 1) {
      const inputBase = channel * 14 * 14;
      const outputBase = channel * 16;
      for (let y = 0; y < 4; y += 1) {
        for (let x = 0; x < 4; x += 1) {
          let maximum = 0;
          for (let poolY = 0; poolY < 3; poolY += 1) {
            const row = inputBase + (y * 3 + poolY) * 14 + x * 3;
            maximum = Math.max(maximum, conv2[row], conv2[row + 1], conv2[row + 2]);
          }
          pool2[outputBase + y * 4 + x] = maximum;
        }
      }
    }

    this.logits.set(this.bias3);
    for (let feature = 0; feature < pool2.length; feature += 1) {
      const value = pool2[feature];
      const weightBase = feature * 10;
      for (let digit = 0; digit < 10; digit += 1) {
        this.logits[digit] += value * this.dense[weightBase + digit];
      }
    }
    return this.resultFromLogits();
  }

  resultFromLogits() {
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
