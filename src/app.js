import { DigitModel } from "./digit-model.js";
import {
  calculateScore,
  createDailyProblems,
  createTrainingProblems,
  GAME_MODES,
  isDailyMode,
  localDayKey,
  MISTAKE_PENALTY_SECONDS,
  paceFor,
  TOTAL_PROBLEMS,
} from "./game-core.js";
import { applyDocumentTranslations, formatDecimal, initialLocale, normaliseLocale, rememberLocale, translate } from "./i18n.js";
import { InkRecognizer } from "./ink-recognizer.js";

const elements = Object.fromEntries([
  "home-screen", "game-screen", "results-screen", "start-button", "daily-easy-dock-button", "home-play-dock", "again-button", "home-button", "share-button", "restart-button", "quit-button",
  "daily-normal-button", "daily-tab", "training-tab", "daily-mode-panel", "training-mode-panel", "daily-date", "daily-easy-status", "daily-normal-status",
  "header-best", "progress-text", "timer-text", "equation", "feedback-mark",
  "answer-flash",
  "progress-bar", "recognition-state", "ink-canvas", "canvas-guide", "prediction-preview", "answer-entry",
  "erase-button", "keyboard-button", "submit-answer-button", "keyboard-entry", "number-input", "keypad-backspace", "keypad-submit", "result-rank", "result-burst",
  "final-score-value", "raw-time", "mistake-count", "personal-line", "accuracy-text", "run-list", "toast",
  "language-select", "fullscreen-button",
].map((id) => [id, document.getElementById(id)]));
const appShell = document.querySelector(".app-shell");

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
let predictionSnapshot = { digits: null, complete: false };
let keypadMode = false;
let keypadDigits = "";
let activeMode = GAME_MODES.DAILY_EASY;
const dailyDay = localDayKey();
const SHARE_URL = "https://faroit.com/gehirnjogging/";

const t = (key, parameters) => translate(locale, key, parameters);

function dailyCookieName(mode) {
  return `dr_stoeter_daily_v1_${dailyDay}_${mode}`;
}

function hasCompletedDaily(mode) {
  if (!isDailyMode(mode)) return false;
  const target = `${encodeURIComponent(dailyCookieName(mode))}=1`;
  return document.cookie.split(";").some((cookie) => cookie.trim() === target);
}

function markDailyComplete(mode) {
  if (!isDailyMode(mode)) return;
  document.cookie = `${encodeURIComponent(dailyCookieName(mode))}=1; Max-Age=172800; Path=/; SameSite=Lax`;
}

function modeLabel(mode) {
  return t(`mode.${mode}`);
}

function formatDailyDate() {
  return new Intl.DateTimeFormat(locale, { weekday: "long", month: "short", day: "numeric" }).format(new Date());
}

function setModeTab(tab) {
  const daily = tab === "daily";
  elements["daily-tab"].classList.toggle("is-active", daily);
  elements["training-tab"].classList.toggle("is-active", !daily);
  elements["daily-tab"].setAttribute("aria-selected", String(daily));
  elements["training-tab"].setAttribute("aria-selected", String(!daily));
  elements["daily-mode-panel"].hidden = !daily;
  elements["training-mode-panel"].hidden = daily;
}

function updateHomeModes() {
  const ready = modelState !== "loading";
  const easyComplete = hasCompletedDaily(GAME_MODES.DAILY_EASY);
  const normalComplete = hasCompletedDaily(GAME_MODES.DAILY_NORMAL);
  elements["daily-date"].textContent = t("home.today", { date: formatDailyDate() });
  const easyLabel = !ready
    ? t("home.loading")
    : easyComplete ? t("home.dailyCompleteButton") : t("mode.daily-easy");
  for (const button of [elements["start-button"], elements["daily-easy-dock-button"]]) {
    button.querySelector("span").textContent = easyLabel;
    button.disabled = !ready || easyComplete;
  }
  elements["daily-easy-status"].textContent = easyComplete ? t("home.dailyComplete") : t("home.dailyReady");
  elements["daily-normal-button"].disabled = !ready || normalComplete;
  elements["daily-normal-status"].textContent = normalComplete ? t("home.dailyComplete") : t("home.dailyReady");
  document.querySelectorAll("[data-game-mode]").forEach((button) => {
    button.disabled = !ready;
  });
}

function updateHomeScrollDock() {
  const homeActive = elements["home-screen"].classList.contains("is-active");
  const visible = homeActive && elements["home-screen"].scrollTop > 72;
  appShell.classList.toggle("has-home-scroll", visible);
  elements["home-play-dock"].setAttribute("aria-hidden", String(!visible));
  elements["daily-easy-dock-button"].tabIndex = visible ? 0 : -1;
}

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
  if (id !== "home-screen") updateHomeScrollDock();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    next.classList.add("is-active");
    updateHomeScrollDock();
  }));
}

function setRecognitionState(state, messageKey, parameters = {}) {
  recognitionSnapshot = { state, messageKey, parameters };
  const container = elements["recognition-state"];
  container.className = `recognition-state${state === "reading" || state === "writing" ? " is-reading" : state === "unsure" ? " is-unsure" : ""}`;
  container.querySelector("b").textContent = t(`recognition.${state}`);
}

function setPrediction(digits, { complete = false } = {}) {
  predictionSnapshot = { digits, complete };
  const preview = elements["prediction-preview"];
  const visible = digits !== null && digits !== undefined && String(digits).length > 0;
  preview.hidden = !visible;
  preview.classList.toggle("is-complete", visible && complete);
  preview.textContent = visible ? String(digits) : "";
  if (visible) preview.setAttribute("aria-label", t("aria.prediction", { value: digits }));
  else preview.removeAttribute("aria-label");
}

function renderKeypad() {
  const hasDigits = keypadDigits.length > 0;
  elements["number-input"].textContent = hasDigits ? keypadDigits : "—";
  elements["number-input"].setAttribute(
    "aria-label",
    hasDigits ? t("game.keypadValue", { value: keypadDigits }) : t("game.keypadEmpty"),
  );
  elements["keypad-submit"].disabled = !hasDigits;
  elements["keypad-backspace"].disabled = !hasDigits;
}

function addKeypadDigit(digit) {
  if (!acceptingAnswer || keypadDigits.length >= 2) return;
  keypadDigits = keypadDigits === "0" ? digit : keypadDigits + digit;
  renderKeypad();
}

function deleteKeypadDigit() {
  if (!acceptingAnswer || !keypadDigits) return;
  keypadDigits = keypadDigits.slice(0, -1);
  renderKeypad();
}

function submitKeypadAnswer() {
  if (!acceptingAnswer || !keypadDigits) return;
  const value = Number(keypadDigits);
  keypadDigits = "";
  renderKeypad();
  submitAnswer(value);
}

function updateInputModeCopy() {
  elements["keyboard-button"].querySelector("span").textContent = t(keypadMode ? "game.useHandwriting" : "game.useKeypad");
}

function setKeypadMode(enabled) {
  keypadMode = Boolean(enabled);
  keypadDigits = "";
  elements["answer-entry"].hidden = keypadMode;
  elements["keyboard-entry"].hidden = !keypadMode;
  elements["erase-button"].hidden = keypadMode;
  elements["keyboard-button"].setAttribute("aria-expanded", String(keypadMode));
  recognizer?.clear();
  recognizer?.setEnabled(!keypadMode && acceptingAnswer);
  renderKeypad();
  updateInputModeCopy();
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
  keypadDigits = "";
  renderKeypad();
  recognizer?.setExpectedDigits(String(problem.answer).length);
  recognizer?.setEnabled(!keypadMode);
  recognizer?.clear();
}

function startGame(mode = activeMode) {
  if (isDailyMode(mode) && hasCompletedDaily(mode)) {
    showToast(t("home.dailyAlreadyComplete"));
    updateHomeModes();
    return;
  }
  window.scrollTo({ top: 0, behavior: "auto" });
  cancelAnimationFrame(timerFrame);
  activeMode = mode;
  problems = isDailyMode(mode)
    ? createDailyProblems(mode, dailyDay)
    : createTrainingProblems(mode);
  results = [];
  problemIndex = 0;
  mistakes = 0;
  runStartedAt = 0;
  lastTimerTenth = -1;
  acceptingAnswer = false;
  latestSummary = null;
  elements["restart-button"].hidden = isDailyMode(activeMode);
  setKeypadMode(!recognizer || keypadMode);
  showScreen("game-screen");
  setTimeout(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
    recognizer?.resize();
    renderProblem();
    runStartedAt = performance.now();
    updateTimer();
  }, 270);
}

function quitGame() {
  const isActiveRun = runStartedAt && problemIndex < TOTAL_PROBLEMS;
  if (isActiveRun && !confirm(t("confirm.leave"))) return;
  cancelAnimationFrame(timerFrame);
  runStartedAt = 0;
  acceptingAnswer = false;
  recognizer?.setEnabled(false);
  window.scrollTo({ top: 0, behavior: "auto" });
  showScreen("home-screen");
}

function restartGame() {
  if (isDailyMode(activeMode)) return;
  const isActiveRun = runStartedAt && problemIndex < TOTAL_PROBLEMS;
  if (isActiveRun && !confirm(t("confirm.restart"))) return;
  startGame();
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
  if (isDailyMode(activeMode)) markDailyComplete(activeMode);
  latestSummary = { rawSeconds, finalSeconds, previousBest, isBest, pace, mistakes, mode: activeMode, day: dailyDay };
  renderResults(latestSummary);
  elements["again-button"].hidden = isDailyMode(activeMode);
  updateHomeModes();
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
  updateHomeModes();

  setRecognitionState(recognitionSnapshot.state, recognitionSnapshot.messageKey, recognitionSnapshot.parameters);
  setPrediction(predictionSnapshot.digits, { complete: predictionSnapshot.complete });
  renderKeypad();
  updateInputModeCopy();
  updateFullscreenButton();
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

function createShareText(summary, { includeUrl = true } = {}) {
  const correct = TOTAL_PROBLEMS - summary.mistakes;
  const challenge = isDailyMode(summary.mode)
    ? t("share.dailyChallenge", { mode: modeLabel(summary.mode), day: summary.day })
    : t("share.trainingChallenge", { mode: modeLabel(summary.mode) });
  const copy = t("share.message", {
    challenge,
    score: formatSeconds(summary.finalSeconds),
    raw: formatSeconds(summary.rawSeconds),
    correct,
    total: TOTAL_PROBLEMS,
    mistakes: summary.mistakes,
  });
  return includeUrl ? `${copy}\n${SHARE_URL}` : copy;
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* Fall through to the legacy copy path. */ }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
  document.body.append(textarea);
  textarea.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch { /* Clipboard access can be blocked. */ }
  textarea.remove();
  return copied;
}

async function shareResult() {
  if (!latestSummary) return;
  const clipboardText = createShareText(latestSummary);
  const copyPromise = copyText(clipboardText);

  if (navigator.share) {
    try {
      await navigator.share({
        title: t("meta.title"),
        text: createShareText(latestSummary, { includeUrl: false }),
        url: SHARE_URL,
      });
      const copied = await copyPromise;
      showToast(copied ? t("share.sharedCopied") : t("share.shared"));
      return;
    } catch (error) {
      if (error?.name !== "AbortError") console.warn("Native sharing is unavailable", error);
    }
  }

  const copied = await copyPromise;
  showToast(copied ? t("share.copied") : t("share.copyFailed"));
}

function currentFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function updateFullscreenButton() {
  const active = Boolean(currentFullscreenElement());
  const label = t(active ? "fullscreen.exit" : "fullscreen.enter");
  elements["fullscreen-button"].classList.toggle("is-active", active);
  elements["fullscreen-button"].setAttribute("aria-label", label);
  elements["fullscreen-button"].setAttribute("aria-pressed", String(active));
  elements["fullscreen-button"].title = label;
  requestAnimationFrame(() => recognizer?.resize());
}

async function toggleFullscreen() {
  const root = document.documentElement;
  try {
    if (currentFullscreenElement()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (!exit) throw new Error("Fullscreen exit is unavailable");
      await exit.call(document);
    } else {
      const enter = root.requestFullscreen || root.webkitRequestFullscreen;
      if (!enter) {
        showToast(t("fullscreen.unavailable"));
        return;
      }
      await enter.call(root);
    }
  } catch (error) {
    console.warn("Fullscreen mode is unavailable", error);
    showToast(t("fullscreen.unavailable"));
  }
  updateFullscreenButton();
}

function bindUi() {
  elements["start-button"].addEventListener("click", () => startGame(GAME_MODES.DAILY_EASY));
  elements["daily-easy-dock-button"].addEventListener("click", () => startGame(GAME_MODES.DAILY_EASY));
  elements["again-button"].addEventListener("click", startGame);
  elements["daily-normal-button"].addEventListener("click", () => startGame(GAME_MODES.DAILY_NORMAL));
  elements["daily-tab"].addEventListener("click", () => setModeTab("daily"));
  elements["training-tab"].addEventListener("click", () => setModeTab("training"));
  document.querySelectorAll("[data-game-mode]").forEach((button) => {
    button.addEventListener("click", () => startGame(button.dataset.gameMode));
  });
  elements["restart-button"].addEventListener("click", restartGame);
  elements["quit-button"].addEventListener("click", quitGame);
  elements["share-button"].addEventListener("click", shareResult);
  elements["home-button"].addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "auto" });
    showScreen("home-screen");
  });
  document.querySelector(".wordmark").addEventListener("click", (event) => {
    event.preventDefault();
    quitGame();
  });
  elements["erase-button"].addEventListener("click", () => recognizer?.clear());
  elements["submit-answer-button"].addEventListener("click", () => recognizer?.submit());
  elements["keyboard-button"].addEventListener("click", () => setKeypadMode(!keypadMode));
  elements["keyboard-entry"].querySelectorAll("[data-digit]").forEach((button) => {
    button.addEventListener("click", () => addKeypadDigit(button.dataset.digit));
  });
  elements["keypad-backspace"].addEventListener("click", deleteKeypadDigit);
  elements["keyboard-entry"].addEventListener("submit", (event) => {
    event.preventDefault();
    submitKeypadAnswer();
  });
  window.addEventListener("keydown", (event) => {
    if (keypadMode && acceptingAnswer && !event.altKey && !event.ctrlKey && !event.metaKey) {
      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        addKeypadDigit(event.key);
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        deleteKeypadDigit();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        submitKeypadAnswer();
        return;
      }
    }
    if (event.key === "Escape" && acceptingAnswer && !currentFullscreenElement()) recognizer?.clear();
  });
  elements["language-select"].addEventListener("change", (event) => setLocale(event.target.value));
  elements["fullscreen-button"].addEventListener("click", toggleFullscreen);
  elements["home-screen"].addEventListener("scroll", updateHomeScrollDock, { passive: true });
  document.addEventListener("fullscreenchange", updateFullscreenButton);
  document.addEventListener("webkitfullscreenchange", updateFullscreenButton);
}

async function initialise() {
  setLocale(locale, { remember: false });
  bindUi();
  setModeTab("daily");
  updateFullscreenButton();
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
      onPrediction: setPrediction,
      onAvailability: (available) => {
        elements["submit-answer-button"].disabled = !available;
      },
    });
    modelState = "ready";
    modelAccuracy = model.testAccuracy;
    refreshLocaleCopy();
  } catch (error) {
    console.error(error);
    modelState = "error";
    elements["erase-button"].disabled = true;
    elements["submit-answer-button"].disabled = true;
    setKeypadMode(true);
    elements["keyboard-button"].hidden = true;
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
