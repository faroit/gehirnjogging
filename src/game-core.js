export const TOTAL_PROBLEMS = 20;
export const MISTAKE_PENALTY_SECONDS = 5;

function shuffle(items, random) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export function createProblems(random = Math.random) {
  const operations = shuffle([
    "+", "+", "+", "+", "+", "+", "+",
    "−", "−", "−", "−", "−", "−", "−",
    "×", "×", "×", "×", "×", "×",
  ], random);
  const generated = [];
  const seen = new Set();

  for (const operation of operations) {
    let problem;
    do {
      let a = Math.floor(random() * 10);
      let b = Math.floor(random() * 10);
      if (operation === "−" && b > a) [a, b] = [b, a];
      const answer = operation === "+" ? a + b : operation === "−" ? a - b : a * b;
      problem = { a, b, operation, answer, text: `${a} ${operation} ${b}` };
    } while (seen.has(problem.text));
    seen.add(problem.text);
    generated.push(problem);
  }
  return generated;
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
