import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { DigitModel } from "../src/digit-model.js";

const bytes = await readFile(new URL("../public/model/digits-cnn.bin", import.meta.url));
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const model = DigitModel.fromBuffer(buffer);

assert.equal(model.inputSize, 784);
assert.equal(model.outputSize, 10);
assert.equal(model.kind, "cnn");
assert.ok(model.testAccuracy > 0.98);

let seed = 20260905;
for (let sample = 0; sample < 32; sample += 1) {
  const input = new Float32Array(784);
  for (let pixel = 0; pixel < input.length; pixel += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    input[pixel] = (seed >>> 27) / 31;
  }
  const result = model.predict(input);
  assert.ok(Number.isInteger(result.digit) && result.digit >= 0 && result.digit <= 9);
  assert.ok(result.confidence > 0 && result.confidence <= 1);
  assert.ok(result.margin >= 0 && result.margin <= 1);
  assert.deepEqual(Object.keys(result), ["digit", "confidence", "margin"]);
}

assert.throws(() => model.predict(new Float32Array(1)), /784 pixels/);
assert.throws(() => DigitModel.fromBuffer(buffer.slice(0, -1)), /tensor lengths/);
const badMagic = buffer.slice(0);
new Uint8Array(badMagic)[0] = 0;
assert.throws(() => DigitModel.fromBuffer(badMagic), /Unsupported/);
const nonFiniteBias = buffer.slice(0);
new DataView(nonFiniteBias).setFloat32(nonFiniteBias.byteLength - 4, Number.NaN, true);
const corruptModel = DigitModel.fromBuffer(nonFiniteBias);
assert.throws(() => corruptModel.predict(new Float32Array(784)), /invalid result/);

console.log("digit model verification: binary schema and 32 inference samples passed");
