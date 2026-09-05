function decodeBase64(encoded, Type) {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  if (Type === Int8Array) return new Int8Array(bytes.buffer);
  return new Float32Array(bytes.buffer);
}

function dequantize(encoded, scale) {
  const packed = decodeBase64(encoded, Int8Array);
  const values = new Float32Array(packed.length);
  for (let i = 0; i < packed.length; i += 1) values[i] = packed[i] * scale;
  return values;
}

export class DigitModel {
  static async load(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Digit model failed to load (${response.status})`);
    const data = await response.json();
    if (data.format !== "twenty-mlp-int8-v1") throw new Error("Unsupported digit model");
    return new DigitModel(data);
  }

  constructor(data) {
    this.inputSize = data.input;
    this.hiddenSize = data.hidden;
    this.outputSize = data.output;
    this.testAccuracy = data.testAccuracy;
    this.w1 = dequantize(data.layers[0].weights, data.layers[0].scale);
    this.b1 = decodeBase64(data.layers[0].bias, Float32Array);
    this.w2 = dequantize(data.layers[1].weights, data.layers[1].scale);
    this.b2 = decodeBase64(data.layers[1].bias, Float32Array);
    this.hidden = new Float32Array(this.hiddenSize);
    this.logits = new Float32Array(this.outputSize);
  }

  predict(input) {
    if (input.length !== this.inputSize) throw new Error("Digit input must contain 784 pixels");

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

    let maxLogit = -Infinity;
    for (const logit of this.logits) maxLogit = Math.max(maxLogit, logit);
    const probabilities = new Float32Array(this.outputSize);
    let total = 0;
    for (let i = 0; i < this.outputSize; i += 1) {
      probabilities[i] = Math.exp(this.logits[i] - maxLogit);
      total += probabilities[i];
    }
    for (let i = 0; i < probabilities.length; i += 1) probabilities[i] /= total;

    const ranked = Array.from(probabilities, (confidence, digit) => ({ digit, confidence }))
      .sort((a, b) => b.confidence - a.confidence);
    return { ...ranked[0], margin: ranked[0].confidence - ranked[1].confidence, ranked };
  }
}
