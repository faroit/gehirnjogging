import assert from "node:assert/strict";

import {
  calculateScore,
  createDailyProblems,
  createTrainingProblems,
  GAME_MODES,
  hashDailySeed,
  localDayKey,
  MISTAKE_PENALTY_SECONDS,
  TOTAL_PROBLEMS,
} from "../src/game-core.js";

function scoringTest() {
  assert.equal(MISTAKE_PENALTY_SECONDS, 5);
  assert.equal(calculateScore(19.8, 0), 19.8);
  assert.equal(calculateScore(19.8, 3), 34.8);
}

function assertRound(problems) {
  assert.equal(problems.length, TOTAL_PROBLEMS);
  assert.equal(new Set(problems.map((problem) => problem.text)).size, TOTAL_PROBLEMS);
  for (const problem of problems) {
    assert.ok(problem.answer >= 0 && problem.answer <= 99, "answers stay compatible with two-digit input");
    if (problem.operation === "−") assert.ok(problem.a >= problem.b);
  }
}

function dailyGenerationTest() {
  const date = "2026-09-06";
  const easy = createDailyProblems(GAME_MODES.DAILY_EASY, date);
  assert.deepEqual(easy, createDailyProblems(GAME_MODES.DAILY_EASY, date), "same local day has the same easy challenge everywhere");
  assert.notEqual(hashDailySeed(`dr-stoeter-daily-v1:${date}:${GAME_MODES.DAILY_EASY}`), hashDailySeed(`dr-stoeter-daily-v1:${date}:${GAME_MODES.DAILY_NORMAL}`));
  assertRound(easy);
  assert.deepEqual(
    Object.fromEntries(["+", "−", "×"].map((operation) => [operation, easy.filter((problem) => problem.operation === operation).length])),
    { "+": 7, "−": 7, "×": 6 },
  );

  const normal = createDailyProblems(GAME_MODES.DAILY_NORMAL, date);
  assertRound(normal);
  assert.ok(normal.every((problem) => problem.operation !== "×"));
  assert.ok(normal.every((problem) => problem.a >= 10 && problem.b >= 10));
  assert.ok(normal.every((problem) => problem.answer <= 99 && problem.answer >= 0));
}

function trainingGenerationTest() {
  const deterministic = () => 0.37;
  for (const mode of [GAME_MODES.TRAINING_SMALL, GAME_MODES.TRAINING_LARGE, GAME_MODES.TRAINING_MIXED]) {
    const problems = createTrainingProblems(mode, deterministic);
    assertRound(problems);
  }
  const small = createTrainingProblems(GAME_MODES.TRAINING_SMALL, deterministic);
  assert.ok(small.every((problem) => problem.a <= 10 && problem.b <= 10 && problem.operation !== "×"));
  const large = createTrainingProblems(GAME_MODES.TRAINING_LARGE, deterministic);
  assert.ok(large.every((problem) => problem.a >= 10 && problem.b >= 10 && problem.operation !== "×"));
}

scoringTest();
dailyGenerationTest();
trainingGenerationTest();
assert.equal(localDayKey(new Date(2026, 8, 6, 23, 59)), "2026-09-06");
console.log("game-core verification: scoring, deterministic daily rounds, and training modes passed");
