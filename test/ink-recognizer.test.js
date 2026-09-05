import assert from "node:assert/strict";

import { findSplitCandidates } from "../src/ink-recognizer.js";

function columns(values) {
  return Uint16Array.from(values);
}

const separated = columns([
  0, 8, 12, 10, 7, 0, 0, 0, 0, 6, 11, 12, 8, 0,
]);
const separatedCuts = findSplitCandidates(separated, 1, 12);
assert.ok(separatedCuts.some(({ cut }) => cut === 7), "uses the centre of a blank separator");

const touching = columns([
  0, 7, 10, 12, 9, 5, 2, 3, 8, 12, 10, 7, 0,
]);
const touchingCuts = findSplitCandidates(touching, 1, 11);
assert.ok(touchingCuts.some(({ cut }) => cut === 6), "finds a low-density split when digits touch");

const misleadingGap = columns([
  0, 8, 9, 0, 0, 0, 0, 7, 9, 8, 0, 0, 7, 10, 8, 0,
]);
const strokeAware = findSplitCandidates(misleadingGap, 1, 14, [{ cut: 11, bonus: 0.38 }]);
assert.equal(strokeAware[0].cut, 11, "stroke grouping can outrank an internal digit gap");

assert.deepEqual(findSplitCandidates(columns([0, 8, 0]), 1, 1), []);

console.log("ink recognizer verification: blank, touching, and stroke-aware split candidates passed");
