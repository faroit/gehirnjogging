export const TOTAL_PROBLEMS = 20;
export const MISTAKE_PENALTY_SECONDS = 5;

export const GAME_MODES = Object.freeze({
  DAILY_EASY: "daily-easy",
  DAILY_NORMAL: "daily-normal",
  TRAINING_SMALL: "training-small",
  TRAINING_LARGE: "training-large",
  TRAINING_MIXED: "training-mixed",
});

const DAILY_MODES = new Set([GAME_MODES.DAILY_EASY, GAME_MODES.DAILY_NORMAL]);

function makeProblem(a, b, operation) {
  const answer = operation === "+" ? a + b : operation === "−" ? a - b : a * b;
  return { a, b, operation, answer, text: `${a} ${operation} ${b}` };
}

function makeBank(operation, minA, maxA, minB, maxB, predicate = () => true) {
  const problems = [];
  for (let a = minA; a <= maxA; a += 1) {
    for (let b = minB; b <= maxB; b += 1) {
      const problem = makeProblem(a, b, operation);
      if (predicate(problem)) problems.push(problem);
    }
  }
  return problems;
}

// This is the fixed exercise database. Selection changes daily, the catalogue does not.
const EXERCISE_DATABASE = Object.freeze({
  smallAdd: makeBank("+", 0, 10, 0, 10),
  smallSubtract: makeBank("−", 0, 10, 0, 10, ({ answer }) => answer >= 0),
  smallMultiply: makeBank("×", 0, 10, 0, 10, ({ answer }) => answer <= 99),
  largeAdd: makeBank("+", 10, 99, 10, 99, ({ answer }) => answer <= 99),
  largeSubtract: makeBank("−", 10, 99, 10, 99, ({ answer }) => answer >= 0),
});

const MODE_BLUEPRINTS = Object.freeze({
  [GAME_MODES.DAILY_EASY]: [["smallAdd", 7], ["smallSubtract", 7], ["smallMultiply", 6]],
  [GAME_MODES.DAILY_NORMAL]: [["largeAdd", 10], ["largeSubtract", 10]],
  [GAME_MODES.TRAINING_SMALL]: [["smallAdd", 10], ["smallSubtract", 10]],
  [GAME_MODES.TRAINING_LARGE]: [["largeAdd", 10], ["largeSubtract", 10]],
  [GAME_MODES.TRAINING_MIXED]: [["smallAdd", 4], ["smallSubtract", 4], ["smallMultiply", 4], ["largeAdd", 4], ["largeSubtract", 4]],
});

function shuffle(items, random) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function pickProblems(mode, random) {
  const blueprint = MODE_BLUEPRINTS[mode];
  if (!blueprint) throw new Error(`Unknown game mode: ${mode}`);
  const selected = blueprint.flatMap(([category, count]) => shuffle([...EXERCISE_DATABASE[category]], random).slice(0, count));
  return shuffle(selected, random);
}

export function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function hashDailySeed(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function isDailyMode(mode) {
  return DAILY_MODES.has(mode);
}

export function createDailyProblems(mode, dayKey = localDayKey()) {
  if (!isDailyMode(mode)) throw new Error(`Daily challenges require a daily mode, received: ${mode}`);
  const seed = hashDailySeed(`dr-stoeter-daily-v1:${dayKey}:${mode}`);
  return pickProblems(mode, seededRandom(seed));
}

export function createTrainingProblems(mode, random = Math.random) {
  if (isDailyMode(mode)) throw new Error(`Training requires a training mode, received: ${mode}`);
  return pickProblems(mode, random);
}

// Kept for the original public API: a random mixed training round.
export function createProblems(random = Math.random) {
  return createTrainingProblems(GAME_MODES.TRAINING_MIXED, random);
}

export function calculateScore(rawSeconds, mistakeCount) {
  return rawSeconds + mistakeCount * MISTAKE_PENALTY_SECONDS;
}

export function paceFor(score) {
  if (score < 12) return { key: "pace.rocket", symbol: "↗" };
  if (score < 20) return { key: "pace.lightning", symbol: "⚡" };
  if (score < 30) return { key: "pace.sharp", symbol: "→" };
  if (score < 45) return { key: "pace.steady", symbol: "↗" };
  return { key: "pace.warmup", symbol: "○" };
}
