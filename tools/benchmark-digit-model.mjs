import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";

import { DigitModel } from "../src/digit-model.js";

const bytes = await readFile(new URL("../public/model/digits-cnn.bin", import.meta.url));
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const model = DigitModel.fromBuffer(buffer);
const samples = Array.from({ length: 32 }, (_, sample) => {
  const input = new Float32Array(784);
  for (let pixel = sample; pixel < input.length; pixel += 17 + sample % 7) {
    input[pixel] = ((pixel * 13 + sample * 19) % 255) / 255;
  }
  return input;
});

for (let i = 0; i < 2_000; i += 1) model.predict(samples[i % samples.length]);
const iterations = 20_000;
const startedAt = performance.now();
for (let i = 0; i < iterations; i += 1) model.predict(samples[i % samples.length]);
const elapsed = performance.now() - startedAt;

console.log(`digit model: ${iterations.toLocaleString()} predictions in ${elapsed.toFixed(2)} ms`);
console.log(`${(elapsed * 1_000 / iterations).toFixed(2)} µs/prediction · ${Math.round(iterations / elapsed * 1_000).toLocaleString()} predictions/sec`);
