import assert from "node:assert/strict";

import {
  detectBrowserLocale,
  formatDecimal,
  missingTranslationKeys,
  normaliseLocale,
  SUPPORTED_LOCALES,
  translate,
} from "../src/i18n.js";

assert.deepEqual(SUPPORTED_LOCALES, ["en", "de", "fr", "es"]);
assert.equal(normaliseLocale("de-DE"), "de");
assert.equal(normaliseLocale("fr-CA"), "fr");
assert.equal(normaliseLocale("unknown"), "en");
assert.equal(detectBrowserLocale(["de-DE"]), "de");
assert.equal(detectBrowserLocale(["fr-CA"]), "fr");
assert.equal(detectBrowserLocale(["es-MX"]), "es");
assert.equal(detectBrowserLocale(["en-GB"]), "en");
assert.equal(detectBrowserLocale(["nl-NL", "de-AT"]), "de");
assert.equal(detectBrowserLocale(["pt-BR"]), "en");
assert.equal(detectBrowserLocale("de_CH"), "de");

for (const locale of SUPPORTED_LOCALES) {
  assert.deepEqual(missingTranslationKeys(locale), [], `${locale} is missing translation keys`);
  assert.notEqual(translate(locale, "home.start"), "home.start");
  assert.match(translate(locale, "recognition.notSureValue", { value: 8 }), /8/);
}

assert.equal(formatDecimal("en", 12.3), "12.3");
assert.equal(formatDecimal("de", 12.3), "12,3");

console.log("i18n verification: 4 complete locales and locale-aware decimals passed");
