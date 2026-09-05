import { DigitModel } from "./digit-model.js";
import { calculateScore, createProblems, MISTAKE_PENALTY_SECONDS, paceFor, TOTAL_PROBLEMS } from "./game-core.js";
import { applyDocumentTranslations, formatDecimal, initialLocale, normaliseLocale, rememberLocale, translate } from "./i18n.js";
import { InkRecognizer } from "./ink-recognizer.js";

const elements = Object.fromEntries([
  "home-screen", "game-screen", "results-screen", "start-button", "again-button", "home-button",
  "header-best", "model-note", "progress-text", "timer-text", "equation", "feedback-mark",
  "answer-flash",
  "progress-bar", "recognition-label", "recognition-state", "ink-canvas", "canvas-guide",
  "erase-button", "keyboard-button", "submit-answer-button", "keyboard-entry", "number-input", "result-rank", "result-burst",
  "final-score-value", "raw-time", "mistake-count", "personal-line", "accuracy-text", "run-list", "toast",
  "language-select",
].map((id) => [id, document.getElementById(id)]));

let locale = initialLocale();
let recognizer;
let problems = [];
let results = [];
let problemIndex = 0;
let mistakes = 0;
let runStartedAt = 0;
let timerFrame = 0;
let lastTimerTenth = -1;
let acceptingAnswer = false;
let toastTimer = 0;
let feedbackAnimation;
let feedbackFlashAnimation;
let modelState = "loading";
let modelAccuracy = 0;
let latestSummary = null;
let recognitionSnapshot = { state: "ready", messageKey: "recognition.writeLarge", parameters: {} };

const t = (key, parameters) => translate(locale, key, parameters);

function readBest() {
  try {
    const value = Number(localStorage.getItem("twenty-best-v1"));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeBest(value) {
  try { localStorage.setItem("twenty-best-v1", String(value)); } catch { /* Private mode may block storage. */ }
}

function formatSeconds(seconds, precision = 1) {
  return t("time.seconds", { value: formatDecimal(locale, seconds, precision) });
}

function updateBestLabel() {
  const best = readBest();
  elements["header-best"].textContent = best ? formatSeconds(best) : "—";
}

function showScreen(id) {
  const screens = [elements["home-screen"], elements["game-screen"], elements["results-screen"]];
  for (const screen of screens) {
    screen.classList.remove("is-active");
    if (screen.id !== id) setTimeout(() => { if (!screen.classList.contains("is-active")) screen.hidden = true; }, 230);
  }
  const next = document.getElementById(id);
  next.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => next.classList.add("is-active")));
}

function setRecognitionState(state, messageKey, parameters = {}) {
  recognitionSnapshot = { state, messageKey, parameters };
  const container = elements["recognition-state"];
  container.className = `recognition-state${state === "reading" || state === "writing" ? " is-reading" : state === "unsure" ? " is-unsure" : ""}`;
  container.querySelector("b").textContent = t(`recognition.${state}`);
  const defaults = {
    ready: "recognition.writeLarge",
    writing: "recognition.keepGoing",
    reading: "recognition.readingInk",
    unsure: "recognition.writeFull",
  };
  elements["recognition-label"].textContent = t(messageKey || defaults[state] || defaults.ready, parameters);
}

function updateTimer() {
  if (!runStartedAt) return;
  const elapsedTenth = Math.floor((performance.now() - runStartedAt) / 100);
  if (elapsedTenth !== lastTimerTenth) {
    lastTimerTenth = elapsedTenth;
    elements["timer-text"].textContent = formatDecimal(locale, elapsedTenth / 10, 1);
  }
  timerFrame = requestAnimationFrame(updateTimer);
}

function renderProblem() {
  const problem = problems[problemIndex];
  elements["progress-text"].textContent = `${String(problemIndex + 1).padStart(2, "0")} / ${TOTAL_PROBLEMS}`;
  elements["progress-bar"].style.transform = `scaleX(${problemIndex / TOTAL_PROBLEMS})`;
  elements.equation.textContent = `${problem.text} =`;
  acceptingAnswer = true;
  recognizer?.setExpectedDigits(String(problem.answer).length);
  recognizer?.setEnabled(true);
  recognizer?.clear();
  if (!recognizer) elements["keyboard-entry"].hidden = false;
}

function startGame() {
  window.scrollTo({ top: 0, behavior: "auto" });
  cancelAnimationFrame(timerFrame);
  problems = createProblems();
  results = [];
  problemIndex = 0;
  mistakes = 0;
  runStartedAt = 0;
  lastTimerTenth = -1;
  acceptingAnswer = false;
  latestSummary = null;
  elements["keyboard-entry"].hidden = Boolean(recognizer);
  elements["keyboard-button"].setAttribute("aria-expanded", "false");
  showScreen("game-screen");
  setTimeout(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
    recognizer?.resize();
    renderProblem();
    runStartedAt = performance.now();
    updateTimer();
  }, 270);
}

function flashFeedback(correct, value) {
  const mark = elements["feedback-mark"];
  const flash = elements["answer-flash"];
  mark.textContent = correct ? "✓" : `${value} ×`;
  mark.className = `feedback-mark${correct ? "" : " is-wrong"}`;
  flash.className = `answer-flash ${correct ? "is-correct" : "is-wrong"}`;
  feedbackAnimation?.cancel();
  feedbackFlashAnimation?.cancel();
  feedbackAnimation = mark.animate(
    [
      { opacity: 0, transform: "rotate(-12deg) scale(.5)" },
      { opacity: .94, transform: "rotate(-7deg) scale(1)", offset: .35 },
      { opacity: .94, transform: "rotate(-7deg) scale(1)", offset: .72 },
      { opacity: 0, transform: "rotate(-3deg) scale(1.12)" },
    ],
    { duration: 480, easing: "cubic-bezier(.18,.8,.3,1)" },
  );
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  feedbackFlashAnimation = flash.animate(
    reduceMotion
      ? [{ opacity: .58 }, { opacity: 0 }]
      : [
          { opacity: 0 },
          { opacity: .78, offset: .08 },
          { opacity: .58, offset: .58 },
          { opacity: .2, offset: .8 },
          { opacity: 0 },
        ],
    { duration: reduceMotion ? 180 : 720, easing: "cubic-bezier(.18,.8,.3,1)" },
  );
}

function submitAnswer(value) {
  if (!acceptingAnswer || !Number.isInteger(value) || value < 0 || value > 99) return;
  acceptingAnswer = false;
  recognizer?.setEnabled(false);
  const problem = problems[problemIndex];
  const correct = value === problem.answer;
  if (!correct) mistakes += 1;
  results.push({
    problem,
    value,
    correct,
  });
  flashFeedback(correct, value);
  problemIndex += 1;
  elements["progress-bar"].style.transform = `scaleX(${problemIndex / TOTAL_PROBLEMS})`;

  if (problemIndex >= TOTAL_PROBLEMS) {
    finishGame();
    return;
  }

  elements.equation.classList.add("is-changing");
  setTimeout(() => {
    renderProblem();
    elements.equation.classList.remove("is-changing");
  }, 105);
}

function finishGame() {
  const endedAt = performance.now();
  cancelAnimationFrame(timerFrame);
  const rawSeconds = (endedAt - runStartedAt) / 1000;
  const finalSeconds = calculateScore(rawSeconds, mistakes);
  const previousBest = readBest();
  const isBest = !previousBest || finalSeconds < previousBest;
  if (isBest) writeBest(finalSeconds);
  updateBestLabel();

  const pace = paceFor(finalSeconds);
  latestSummary = { rawSeconds, finalSeconds, previousBest, isBest, pace, mistakes };
  renderResults(latestSummary);
  window.scrollTo({ top: 0, behavior: "auto" });
  showScreen("results-screen");
}

function renderResults({ rawSeconds, finalSeconds, previousBest, isBest, pace, mistakes: mistakeTotal }) {
  elements["result-rank"].textContent = t(pace.key);
  elements["result-burst"].textContent = pace.symbol;
  elements["final-score-value"].textContent = formatDecimal(locale, finalSeconds, 1);
  elements["raw-time"].textContent = formatSeconds(rawSeconds);
  elements["mistake-count"].textContent = `${mistakeTotal} × ${formatSeconds(MISTAKE_PENALTY_SECONDS, 0)}`;
  elements["accuracy-text"].textContent = `${TOTAL_PROBLEMS - mistakeTotal} / ${TOTAL_PROBLEMS}`;

  if (isBest && previousBest) elements["personal-line"].textContent = t("results.newBest", { value: formatDecimal(locale, previousBest - finalSeconds, 1) });
  else if (isBest) elements["personal-line"].textContent = t("results.first");
  else elements["personal-line"].textContent = t("results.fromBest", { value: formatDecimal(locale, finalSeconds - previousBest, 1) });

  elements["run-list"].innerHTML = results.map((result) =>
    `<li class="${result.correct ? "" : "wrong"}">${result.problem.text} = ${result.value}${result.correct ? "" : ` (${t("results.was", { answer: result.problem.answer })})`}</li>`
  ).join("");
}

function refreshLocaleCopy() {
  updateBestLabel();
  const startLabel = elements["start-button"].querySelector("span");
  const modelCopy = elements["model-note"].querySelector("[data-model-copy]");

  if (modelState === "ready") {
    startLabel.textContent = t("home.start");
    modelCopy.textContent = t("model.ready", { accuracy: formatDecimal(locale, modelAccuracy * 100, 1) });
  } else if (modelState === "error") {
    startLabel.textContent = t("home.start");
    modelCopy.textContent = t("model.error");
  } else {
    startLabel.textContent = t("home.loading");
    modelCopy.textContent = t("home.modelPreparing");
  }

  setRecognitionState(recognitionSnapshot.state, recognitionSnapshot.messageKey, recognitionSnapshot.parameters);
  recognizer?.refreshLocale();
  if (latestSummary) renderResults(latestSummary);
}

function setLocale(nextLocale, { remember = true } = {}) {
  locale = normaliseLocale(nextLocale);
  if (remember) rememberLocale(locale);
  applyDocumentTranslations(locale);
  elements["language-select"].value = locale;
  refreshLocaleCopy();
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 1800);
}

function bindUi() {
  elements["start-button"].addEventListener("click", startGame);
  elements["again-button"].addEventListener("click", startGame);
  elements["home-button"].addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "auto" });
    showScreen("home-screen");
  });
  document.querySelector(".wordmark").addEventListener("click", (event) => {
    event.preventDefault();
    if (runStartedAt && problemIndex < TOTAL_PROBLEMS && !confirm(t("confirm.leave"))) return;
    cancelAnimationFrame(timerFrame);
    runStartedAt = 0;
    showScreen("home-screen");
  });
  elements["erase-button"].addEventListener("click", () => recognizer?.clear());
  elements["submit-answer-button"].addEventListener("click", () => recognizer?.submit());
  elements["keyboard-button"].addEventListener("click", () => {
    const form = elements["keyboard-entry"];
    const isOpening = form.hidden;
    form.hidden = !isOpening;
    elements["keyboard-button"].setAttribute("aria-expanded", String(isOpening));
    if (isOpening) elements["number-input"].focus();
  });
  elements["keyboard-entry"].addEventListener("submit", (event) => {
    event.preventDefault();
    const value = Number(elements["number-input"].value);
    if (!Number.isInteger(value)) return;
    elements["number-input"].value = "";
    submitAnswer(value);
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && acceptingAnswer) recognizer?.clear();
  });
  elements["language-select"].addEventListener("change", (event) => setLocale(event.target.value));
}

async function initialise() {
  setLocale(locale, { remember: false });
  bindUi();
  updateBestLabel();
  try {
    const model = await DigitModel.load("./public/model/digits-cnn.bin");
    recognizer = new InkRecognizer({
      canvas: elements["ink-canvas"],
      guide: elements["canvas-guide"],
      model,
      translate: t,
      onRead: submitAnswer,
      onState: setRecognitionState,
    });
    elements["start-button"].disabled = false;
    modelState = "ready";
    modelAccuracy = model.testAccuracy;
    elements["model-note"].classList.add("is-ready");
    refreshLocaleCopy();
  } catch (error) {
    console.error(error);
    modelState = "error";
    elements["start-button"].disabled = false;
    elements["erase-button"].disabled = true;
    elements["submit-answer-button"].disabled = true;
    elements["keyboard-button"].disabled = true;
    elements["keyboard-entry"].hidden = false;
    setRecognitionState("unsure", "model.error");
    refreshLocaleCopy();
    showToast(t("model.toastError"));
  }

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Offline mode is unavailable", error);
    });
  }
}

initialise();
