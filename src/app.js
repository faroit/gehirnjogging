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
  "home-screen", "game-screen", "results-screen", "start-button", "again-button", "home-button", "share-button", "restart-button", "quit-button",
  "daily-normal-button", "daily-date",
  "progress-text", "timer-text", "equation", "feedback-mark", "game-countdown",
  "answer-flash",
  "progress-bar", "recognition-state", "ink-canvas", "canvas-guide", "prediction-preview", "answer-entry",
  "erase-button", "submit-answer-button", "keyboard-entry", "number-input", "keypad-backspace", "keypad-submit", "result-rank", "result-burst", "results-fireworks",
  "final-score-value", "raw-time", "mistake-count", "personal-line", "accuracy-text", "run-list", "toast",
  "share-modal", "share-modal-close", "share-modal-score", "share-modal-text", "share-copy-button", "share-native-button",
  "onboarding-modal", "onboarding-training-button", "onboarding-skip-button", "onboarding-practice-note", "settings-button", "settings-modal", "settings-modal-close",
  "language-select", "fullscreen-button",
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
let shareSummaryActive = null;
let fireworksTimer = 0;
let countdownTimer = 0;
let startSequence = 0;
let recognitionSnapshot = { state: "ready", messageKey: "recognition.writeLarge", parameters: {} };
let predictionSnapshot = { digits: null, complete: false };
let keypadMode = false;
let keypadDigits = "";
let activeMode = GAME_MODES.DAILY_EASY;
const dailyDay = localDayKey();
const INPUT_PREFERENCE_COOKIE = "dr_stoeter_input_preference_v1";
const FIRST_GAME_COOKIE = "dr_stoeter_first_game_v2";
const TRAINING_COMPLETE_COOKIE = "dr_stoeter_training_complete_v1";
const SHARE_URL = "https://faroit.com/gehirnjogging/";
let inputPreference = "handwriting";
let pendingStartMode = null;

const t = (key, parameters) => translate(locale, key, parameters);

function readCookie(name) {
  const target = `${encodeURIComponent(name)}=`;
  return document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(target))?.slice(target.length) || null;
}

function writeCookie(name, value) {
  document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}; Max-Age=31536000; Path=/; SameSite=Lax`;
}

function readInputPreference() {
  const stored = readCookie(INPUT_PREFERENCE_COOKIE);
  return stored === "keypad" || stored === "handwriting" ? stored : "handwriting";
}

function hasCompletedTraining() {
  return readCookie(TRAINING_COMPLETE_COOKIE) === "1";
}

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

function dailySummaryKey(mode) {
  return `dr_stoeter_daily_score_v1:${dailyDay}:${mode}`;
}

function readDailySummary(mode) {
  if (!isDailyMode(mode)) return null;
  try {
    const summary = JSON.parse(localStorage.getItem(dailySummaryKey(mode)));
    return summary?.mode === mode && summary?.day === dailyDay && Number.isFinite(summary.finalSeconds) ? summary : null;
  } catch {
    return null;
  }
}

function writeDailySummary(summary) {
  if (!isDailyMode(summary.mode)) return;
  try { localStorage.setItem(dailySummaryKey(summary.mode), JSON.stringify(summary)); } catch { /* Private mode may block storage. */ }
}

function modeLabel(mode) {
  return t(`mode.${mode}`);
}

function formatDailyDate() {
  return new Intl.DateTimeFormat(locale, { weekday: "long", month: "short", day: "numeric" }).format(new Date());
}

function updateHomeModes() {
  const ready = modelState !== "loading";
  const easyComplete = hasCompletedDaily(GAME_MODES.DAILY_EASY);
  const normalComplete = hasCompletedDaily(GAME_MODES.DAILY_NORMAL);
  elements["daily-date"].textContent = t("home.today", { date: formatDailyDate() });
  const updateDailyAction = (mode, complete, buttonIds, completeLabel) => {
    const summary = readDailySummary(mode);
    const label = !ready
      ? t("home.loading")
      : summary ? t("home.dailyScore", { mode: modeLabel(mode), score: formatSeconds(summary.finalSeconds) })
        : complete ? t(completeLabel) : modeLabel(mode);
    for (const id of buttonIds) {
      const button = elements[id];
      button.querySelector("span").textContent = label;
      button.disabled = !ready || (complete && !summary);
      button.classList.toggle("is-complete", Boolean(summary));
      button.setAttribute("aria-label", summary ? t("home.dailyScoreShare", { mode: modeLabel(mode), score: formatSeconds(summary.finalSeconds) }) : label);
    }
  };
  updateDailyAction(GAME_MODES.DAILY_EASY, easyComplete, ["start-button"], "home.dailyCompleteButton");
  updateDailyAction(GAME_MODES.DAILY_NORMAL, normalComplete, ["daily-normal-button"], "home.dailyNormalCompleteButton");
  document.querySelectorAll("[data-game-mode]").forEach((button) => {
    button.disabled = !ready;
  });
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

function showScreen(id) {
  const screens = [elements["home-screen"], elements["game-screen"], elements["results-screen"]];
  for (const screen of screens) {
    screen.classList.remove("is-active");
    if (screen.id !== id) setTimeout(() => { if (!screen.classList.contains("is-active")) screen.hidden = true; }, 230);
  }
  const next = document.getElementById(id);
  next.hidden = false;
  if (id === "results-screen") next.scrollTop = 0;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    next.classList.add("is-active");
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

function updateInputPreferenceUi() {
  document.querySelectorAll("[data-input-preference]").forEach((button) => {
    const selected = button.dataset.inputPreference === inputPreference;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function setInputPreference(preference) {
  if (preference !== "handwriting" && preference !== "keypad") return;
  inputPreference = preference;
  writeCookie(INPUT_PREFERENCE_COOKIE, preference);
  updateInputPreferenceUi();
  setKeypadMode(preference === "keypad");
}

function setKeypadMode(enabled) {
  keypadMode = Boolean(enabled);
  keypadDigits = "";
  elements["answer-entry"].hidden = keypadMode;
  elements["keyboard-entry"].hidden = !keypadMode;
  elements["erase-button"].hidden = keypadMode;
  recognizer?.clear();
  recognizer?.setEnabled(!keypadMode && acceptingAnswer);
  renderKeypad();
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

function clearCountdown() {
  clearTimeout(countdownTimer);
  elements["game-countdown"].hidden = true;
  elements["game-countdown"].getAnimations().forEach((animation) => animation.cancel());
}

function startCountdown() {
  const steps = ["3", "2", "1", t("game.go")];
  const countdown = elements["game-countdown"];
  let step = 0;
  const advance = () => {
    countdown.hidden = false;
    countdown.textContent = steps[step];
    countdown.animate(
      [
        { opacity: 0, transform: "scale(.55) rotate(-5deg)" },
        { opacity: 1, transform: "scale(1.06) rotate(0)", offset: .22 },
        { opacity: 1, transform: "scale(1)", offset: .72 },
        { opacity: 0, transform: "scale(1.18) rotate(3deg)" },
      ],
      { duration: step === steps.length - 1 ? 620 : 700, easing: "cubic-bezier(.2,.8,.25,1)" },
    );
    step += 1;
    if (step < steps.length) countdownTimer = setTimeout(advance, 700);
    else countdownTimer = setTimeout(() => {
      countdown.hidden = true;
      renderProblem();
      runStartedAt = performance.now();
      updateTimer();
    }, 620);
  };
  advance();
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
  if (!readCookie(FIRST_GAME_COOKIE)) {
    pendingStartMode = mode;
    const suggestPractice = !hasCompletedTraining();
    elements["onboarding-training-button"].hidden = !suggestPractice;
    elements["onboarding-practice-note"].hidden = !suggestPractice;
    if (!elements["onboarding-modal"].open) elements["onboarding-modal"].showModal();
    return;
  }
  window.scrollTo({ top: 0, behavior: "auto" });
  const sequence = ++startSequence;
  cancelAnimationFrame(timerFrame);
  clearCountdown();
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
  elements["progress-text"].textContent = `— / ${TOTAL_PROBLEMS}`;
  elements["progress-bar"].style.transform = "scaleX(0)";
  elements["timer-text"].textContent = formatDecimal(locale, 0, 1);
  elements.equation.textContent = "";
  elements["restart-button"].hidden = isDailyMode(activeMode);
  setKeypadMode(!recognizer || inputPreference === "keypad");
  showScreen("game-screen");
  setTimeout(() => {
    if (sequence !== startSequence || !elements["game-screen"].classList.contains("is-active")) return;
    window.scrollTo({ top: 0, behavior: "auto" });
    recognizer?.resize();
    startCountdown();
  }, 270);
}

function quitGame() {
  const isActiveRun = runStartedAt && problemIndex < TOTAL_PROBLEMS;
  if (isActiveRun && !confirm(t("confirm.leave"))) return;
  cancelAnimationFrame(timerFrame);
  startSequence += 1;
  clearCountdown();
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

  const pace = paceFor(finalSeconds);
  latestSummary = { rawSeconds, finalSeconds, previousBest, isBest, pace, mistakes, mode: activeMode, day: dailyDay };
  if (isDailyMode(activeMode)) {
    markDailyComplete(activeMode);
    writeDailySummary(latestSummary);
  } else {
    writeCookie(TRAINING_COMPLETE_COOKIE, "1");
  }
  renderResults(latestSummary);
  elements["again-button"].hidden = isDailyMode(activeMode);
  updateHomeModes();
  window.scrollTo({ top: 0, behavior: "auto" });
  showScreen("results-screen");
  clearTimeout(fireworksTimer);
  fireworksTimer = setTimeout(launchResultsFireworks, 280);
}

function launchResultsFireworks() {
  const layer = elements["results-fireworks"];
  layer.replaceChildren();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const symbols = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "+", "−", "×", "="];
  const bursts = [[24, 31], [70, 24], [49, 61]];
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < 42; index += 1) {
    const [x, y] = bursts[index % bursts.length];
    const angle = (Math.PI * 2 * index) / 14 + (Math.random() - .5) * .26;
    const distance = 80 + Math.random() * 150;
    const particle = document.createElement("span");
    particle.className = "results-fireworks__particle";
    particle.textContent = symbols[index % symbols.length];
    particle.style.setProperty("--x", `${x + (Math.random() - .5) * 6}%`);
    particle.style.setProperty("--y", `${y + (Math.random() - .5) * 6}%`);
    particle.style.setProperty("--dx", `${Math.cos(angle) * distance}px`);
    particle.style.setProperty("--dy", `${Math.sin(angle) * distance}px`);
    particle.style.setProperty("--turn", `${Math.round((Math.random() - .5) * 180)}deg`);
    particle.style.setProperty("--delay", `${(index % 3) * 100 + Math.random() * 160}ms`);
    particle.style.setProperty("--duration", `${900 + Math.random() * 450}ms`);
    particle.style.setProperty("--size", `${20 + Math.random() * 19}px`);
    fragment.append(particle);
  }
  layer.append(fragment);
  fireworksTimer = setTimeout(() => layer.replaceChildren(), 1900);
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
  updateHomeModes();

  setRecognitionState(recognitionSnapshot.state, recognitionSnapshot.messageKey, recognitionSnapshot.parameters);
  setPrediction(predictionSnapshot.digits, { complete: predictionSnapshot.complete });
  renderKeypad();
  updateInputPreferenceUi();
  updateFullscreenButton();
  recognizer?.refreshLocale();
  if (latestSummary) renderResults(latestSummary);
  if (elements["share-modal"].open && shareSummaryActive) openShareModal(shareSummaryActive);
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

function shareChallenge(summary) {
  return isDailyMode(summary.mode)
    ? t("share.dailyChallenge", { mode: modeLabel(summary.mode), day: summary.day })
    : t("share.trainingChallenge", { mode: modeLabel(summary.mode) });
}

function createShareText(summary) {
  const correct = TOTAL_PROBLEMS - summary.mistakes;
  const message = t("share.message", {
    challenge: shareChallenge(summary),
    score: formatSeconds(summary.finalSeconds),
    raw: formatSeconds(summary.rawSeconds),
    correct,
    total: TOTAL_PROBLEMS,
    mistakes: summary.mistakes,
  });
  return `${message}\n🔗 ${SHARE_URL}`;
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

function openShareModal(summary) {
  if (!summary) return;
  shareSummaryActive = summary;
  elements["share-modal"].classList.toggle("is-daily", isDailyMode(summary.mode));
  const challenge = shareChallenge(summary);
  elements["share-modal-score"].textContent = `${challenge} · ${formatSeconds(summary.finalSeconds)}`;
  elements["share-modal-text"].value = createShareText(summary);
  if (!elements["share-modal"].open) elements["share-modal"].showModal();
}

function closeShareModal() {
  if (elements["share-modal"].open) elements["share-modal"].close();
}

function closeOnboarding() {
  if (elements["onboarding-modal"].open) elements["onboarding-modal"].close();
}

function closeSettingsModal() {
  if (elements["settings-modal"].open) elements["settings-modal"].close();
}

function finishOnboarding({ training = false } = {}) {
  if (!readCookie(INPUT_PREFERENCE_COOKIE)) setInputPreference("handwriting");
  writeCookie(FIRST_GAME_COOKIE, "1");
  closeOnboarding();
  const nextMode = training ? GAME_MODES.TRAINING_SMALL : pendingStartMode;
  pendingStartMode = null;
  if (nextMode) startGame(nextMode);
}

async function copyShareText() {
  if (!shareSummaryActive) return;
  const copied = await copyText(createShareText(shareSummaryActive));
  showToast(copied ? t("share.copied") : t("share.copyFailed"));
}

async function shareThroughSystem() {
  if (!shareSummaryActive) return;
  const clipboardText = createShareText(shareSummaryActive);
  const copyPromise = copyText(clipboardText);

  if (navigator.share) {
    try {
      await navigator.share({ text: clipboardText });
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

function shareResult() {
  if (latestSummary) openShareModal(latestSummary);
}

function handleDailyAction(mode) {
  const summary = readDailySummary(mode);
  if (summary) return openShareModal(summary);
  return startGame(mode);
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
  elements["start-button"].addEventListener("click", () => handleDailyAction(GAME_MODES.DAILY_EASY));
  elements["again-button"].addEventListener("click", startGame);
  elements["daily-normal-button"].addEventListener("click", () => handleDailyAction(GAME_MODES.DAILY_NORMAL));
  document.querySelectorAll("[data-game-mode]").forEach((button) => {
    button.addEventListener("click", () => startGame(button.dataset.gameMode));
  });
  elements["restart-button"].addEventListener("click", restartGame);
  elements["quit-button"].addEventListener("click", quitGame);
  elements["share-button"].addEventListener("click", shareResult);
  elements["share-modal-close"].addEventListener("click", closeShareModal);
  elements["share-copy-button"].addEventListener("click", copyShareText);
  elements["share-native-button"].addEventListener("click", shareThroughSystem);
  elements["share-modal"].addEventListener("click", (event) => {
    if (event.target === elements["share-modal"]) closeShareModal();
  });
  document.querySelectorAll("[data-input-preference]").forEach((button) => {
    button.addEventListener("click", () => {
      setInputPreference(button.dataset.inputPreference);
      if (button.closest("#settings-modal")) closeSettingsModal();
    });
  });
  elements["onboarding-training-button"].addEventListener("click", () => finishOnboarding({ training: true }));
  elements["onboarding-skip-button"].addEventListener("click", () => finishOnboarding());
  elements["settings-button"].addEventListener("click", () => {
    if (!elements["settings-modal"].open) elements["settings-modal"].showModal();
  });
  elements["settings-modal-close"].addEventListener("click", closeSettingsModal);
  elements["settings-modal"].addEventListener("click", (event) => {
    if (event.target === elements["settings-modal"]) closeSettingsModal();
  });
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
  document.addEventListener("fullscreenchange", updateFullscreenButton);
  document.addEventListener("webkitfullscreenchange", updateFullscreenButton);
}

async function initialise() {
  inputPreference = readInputPreference();
  setLocale(locale, { remember: false });
  bindUi();
  updateInputPreferenceUi();
  updateFullscreenButton();
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
