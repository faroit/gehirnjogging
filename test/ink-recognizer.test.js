import assert from "node:assert/strict";

import { findDominantBlankSplit, findSplitCandidates, isRecognitionReady } from "../src/ink-recognizer.js";

function columns(values) {
  return Uint16Array.from(values);
}

const separated = columns([
  0, 8, 12, 10, 7, 0, 0, 0, 0, 6, 11, 12, 8, 0,
]);
const separatedCuts = findSplitCandidates(separated, 1, 12);
assert.ok(separatedCuts.some(({ cut }) => cut === 7), "uses the centre of a blank separator");
assert.equal(findDominantBlankSplit(separated, 1, 12), 7, "a clearly largest gap is authoritative");

const touching = columns([
  0, 7, 10, 12, 9, 5, 2, 3, 8, 12, 10, 7, 0,
]);
const touchingCuts = findSplitCandidates(touching, 1, 11);
assert.ok(touchingCuts.some(({ cut }) => cut === 6), "finds a low-density split when digits touch");
assert.equal(findDominantBlankSplit(touching, 1, 11), null, "touching digits use candidate scoring");

const ambiguous = columns([
  0, 8, 9, 0, 0, 7, 9, 0, 0, 8, 10, 0,
]);
assert.equal(findDominantBlankSplit(ambiguous, 1, 10), null, "similar internal gaps remain ambiguous");

const misleadingGap = columns([
  0, 8, 9, 0, 0, 0, 0, 7, 9, 8, 0, 0, 7, 10, 8, 0,
]);
const strokeAware = findSplitCandidates(misleadingGap, 1, 14, [{ cut: 11, bonus: 0.38 }]);
assert.equal(strokeAware[0].cut, 11, "stroke grouping can outrank an internal digit gap");

assert.deepEqual(findSplitCandidates(columns([0, 8, 0]), 1, 1), []);

const confidentDigit = { confidence: 0.91, margin: 0.62 };
assert.equal(isRecognitionReady(confidentDigit, 1), true, "one confident digit enables submit");
assert.equal(isRecognitionReady(confidentDigit, 2, false), false, "one digit cannot enable a two-digit answer");
assert.equal(isRecognitionReady(confidentDigit, 2, true), true, "two distinct confident digits enable submit");
assert.equal(isRecognitionReady({ confidence: 0.3, margin: 0.2 }, 1), false, "uncertain ink stays disabled");
assert.equal(isRecognitionReady({ confidence: 0.9, margin: 0.02 }, 1), false, "ambiguous ink stays disabled");

console.log("ink recognizer verification: blank, touching, and stroke-aware split candidates passed");
