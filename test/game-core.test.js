import assert from "node:assert/strict";

import { calculateScore, createProblems, MISTAKE_PENALTY_SECONDS, TOTAL_PROBLEMS } from "../src/game-core.js";

function scoringTest() {
  assert.equal(MISTAKE_PENALTY_SECONDS, 5);
  assert.equal(calculateScore(19.8, 0), 19.8);
  assert.equal(calculateScore(19.8, 3), 34.8);
}

function problemGenerationTest() {
  for (let run = 0; run < 100; run += 1) {
    const problems = createProblems();
    assert.equal(problems.length, TOTAL_PROBLEMS);
    assert.equal(new Set(problems.map((problem) => problem.text)).size, TOTAL_PROBLEMS);
    assert.deepEqual(
      Object.fromEntries(["+", "−", "×"].map((operation) => [operation, problems.filter((problem) => problem.operation === operation).length])),
      { "+": 7, "−": 7, "×": 6 },
    );
    for (const problem of problems) {
      assert.ok(problem.a >= 0 && problem.a <= 9);
      assert.ok(problem.b >= 0 && problem.b <= 9);
      assert.ok(problem.answer >= 0 && problem.answer <= 81);
      if (problem.operation === "−") assert.ok(problem.a >= problem.b);
    }
  }
}

scoringTest();
problemGenerationTest();
console.log("game-core verification: scoring and 100 generated runs passed");
