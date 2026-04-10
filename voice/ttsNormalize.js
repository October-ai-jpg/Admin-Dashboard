/**
 * voice/ttsNormalize.js — Currency/number normalization for TTS input
 *
 * Ported 1:1 from production (platform/voice/ttsNormalize.js).
 *
 * Cartesia (and most neural TTS) mispronounces numbers when adjacent to
 * currency codes, reading "USD 500" as "you-es-dee five zero zero" instead
 * of "five hundred US dollars". This module rewrites currency+number
 * patterns into natural spoken form before the text reaches TTS.
 *
 * Because GPT streams in small chunks, we wrap the downstream text stream
 * with a lightweight buffering layer that holds back a single "dangling"
 * currency/number word until its pair arrives. All other text flows through
 * without delay.
 */

// ──────────────────────────────────────────────────────────────────────────────
// Language-aware currency names. Fall back to English for unknown languages.
// ──────────────────────────────────────────────────────────────────────────────

const CURRENCY_NAMES_EN = {
  USD: "US dollars",
  EUR: "euros",
  GBP: "British pounds",
  DKK: "Danish kroner",
  SEK: "Swedish kronor",
  NOK: "Norwegian kroner",
  ISK: "Icelandic krona",
  CHF: "Swiss francs",
  JPY: "yen",
  CAD: "Canadian dollars",
  AUD: "Australian dollars",
  NZD: "New Zealand dollars",
  CNY: "Chinese yuan",
  INR: "Indian rupees",
  KRW: "Korean won",
  SGD: "Singapore dollars",
  HKD: "Hong Kong dollars",
  THB: "Thai baht",
  ZAR: "South African rand",
  PLN: "Polish zloty",
  CZK: "Czech koruna",
  HUF: "Hungarian forint",
  TRY: "Turkish lira",
  RUB: "Russian rubles",
  BRL: "Brazilian reais",
  MXN: "Mexican pesos",
  AED: "UAE dirhams",
  SAR: "Saudi riyals",
};

const CURRENCY_NAMES_BY_LANG = {
  en: CURRENCY_NAMES_EN,
  da: {
    USD: "amerikanske dollars",
    EUR: "euro",
    GBP: "britiske pund",
    DKK: "kroner",
    SEK: "svenske kroner",
    NOK: "norske kroner",
    ISK: "islandske kroner",
    CHF: "schweiziske franc",
    JPY: "yen",
    CAD: "canadiske dollars",
    AUD: "australske dollars",
    CNY: "kinesiske yuan",
    INR: "indiske rupees",
  },
  de: {
    USD: "US-Dollar",
    EUR: "Euro",
    GBP: "britische Pfund",
    DKK: "dänische Kronen",
    SEK: "schwedische Kronen",
    NOK: "norwegische Kronen",
    CHF: "Schweizer Franken",
    JPY: "Yen",
    CAD: "kanadische Dollar",
    AUD: "australische Dollar",
  },
  sv: {
    USD: "amerikanska dollar",
    EUR: "euro",
    GBP: "brittiska pund",
    DKK: "danska kronor",
    SEK: "kronor",
    NOK: "norska kronor",
    CHF: "schweiziska franc",
    JPY: "yen",
  },
  no: {
    USD: "amerikanske dollar",
    EUR: "euro",
    GBP: "britiske pund",
    DKK: "danske kroner",
    SEK: "svenske kroner",
    NOK: "kroner",
    CHF: "sveitsiske franc",
    JPY: "yen",
  },
  fr: {
    USD: "dollars américains",
    EUR: "euros",
    GBP: "livres sterling",
    CHF: "francs suisses",
    JPY: "yens",
    CAD: "dollars canadiens",
  },
  es: {
    USD: "dólares estadounidenses",
    EUR: "euros",
    GBP: "libras esterlinas",
    CHF: "francos suizos",
    JPY: "yenes",
    MXN: "pesos mexicanos",
  },
  it: {
    USD: "dollari americani",
    EUR: "euro",
    GBP: "sterline",
    CHF: "franchi svizzeri",
    JPY: "yen",
  },
  nl: {
    USD: "Amerikaanse dollars",
    EUR: "euro",
    GBP: "Britse ponden",
    CHF: "Zwitserse frank",
    JPY: "yen",
  },
  pt: {
    USD: "dólares americanos",
    EUR: "euros",
    GBP: "libras",
    BRL: "reais",
    CHF: "francos suíços",
  },
};

const SYMBOL_NAMES_EN = {
  "$": "dollars",
  "€": "euros",
  "£": "pounds",
  "¥": "yen",
  "₹": "rupees",
  "₩": "won",
};

const SYMBOL_NAMES_BY_LANG = {
  en: SYMBOL_NAMES_EN,
  da: { "$": "dollars", "€": "euro", "£": "pund", "¥": "yen", "₹": "rupees" },
  de: { "$": "Dollar", "€": "Euro", "£": "Pfund", "¥": "Yen", "₹": "Rupien" },
  sv: { "$": "dollar", "€": "euro", "£": "pund", "¥": "yen" },
  no: { "$": "dollar", "€": "euro", "£": "pund", "¥": "yen" },
  fr: { "$": "dollars", "€": "euros", "£": "livres", "¥": "yens" },
  es: { "$": "dólares", "€": "euros", "£": "libras", "¥": "yenes" },
  it: { "$": "dollari", "€": "euro", "£": "sterline", "¥": "yen" },
  nl: { "$": "dollar", "€": "euro", "£": "pond", "¥": "yen" },
  pt: { "$": "dólares", "€": "euros", "£": "libras", "¥": "ienes" },
};

const ALL_CODES = Object.keys(CURRENCY_NAMES_EN);
const CODES_ALTERNATION = ALL_CODES.join("|");

function getNames(language) {
  const lang = (language || "en").toLowerCase();
  return {
    codes: { ...CURRENCY_NAMES_EN, ...(CURRENCY_NAMES_BY_LANG[lang] || {}) },
    symbols: { ...SYMBOL_NAMES_EN, ...(SYMBOL_NAMES_BY_LANG[lang] || {}) },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Pure text transformation. Handles:
//   $500, €1,500, £19.99              → "500 dollars" etc.
//   USD 500, EUR 1,500, DKK 2.000      → "500 US dollars" etc.
//   500 USD, 1,500 EUR                 → "500 US dollars" etc.
// Thousands separators (",") are removed inside numbers. "Room 500",
// "chapter 12" etc. are left untouched because no currency token is near.
// ──────────────────────────────────────────────────────────────────────────────

function normalizeCurrencyText(text, language = "en") {
  if (!text || typeof text !== "string") return text;
  const { codes, symbols } = getNames(language);

  // Strip thousands separators inside numbers ("1,500" → "1500")
  let out = text.replace(/(\d),(\d{3}\b)/g, "$1$2");
  out = out.replace(/(\d),(\d{3}\b)/g, "$1$2"); // second pass for 1,500,000

  // 1) Symbol + number:  "$500"  → "500 dollars"
  out = out.replace(/([$€£¥₹₩])\s*(\d+(?:\.\d+)?)/g, (_m, sym, num) => {
    const name = symbols[sym];
    return name ? `${num} ${name}` : `${num} ${sym}`;
  });

  // 2) Code before number:  "USD 500"  → "500 US dollars"
  const codeBeforeRe = new RegExp(`\\b(${CODES_ALTERNATION})\\s+(\\d+(?:\\.\\d+)?)`, "g");
  out = out.replace(codeBeforeRe, (_m, code, num) => {
    const upper = code.toUpperCase();
    return `${num} ${codes[upper] || code}`;
  });

  // 3) Number before code:  "500 USD"  → "500 US dollars"
  const codeAfterRe = new RegExp(`(\\d+(?:\\.\\d+)?)\\s+(${CODES_ALTERNATION})\\b`, "g");
  out = out.replace(codeAfterRe, (_m, num, code) => {
    const upper = code.toUpperCase();
    return `${num} ${codes[upper] || code}`;
  });

  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Streaming wrapper
//
// Wraps an inner text stream (with push/finish/asyncIterator) so that chunks
// are buffered until we can safely commit them. A "dangling" last word
// (standalone number or bare currency code) is held back until the next word
// arrives, in case they form a currency pair. All other text flows immediately
// at word boundaries.
//
// Worst case delay: one extra word. Fast path (no currency context): delay
// identical to unwrapped stream.
// ──────────────────────────────────────────────────────────────────────────────

const BARE_NUMBER_RE = /^\d+(?:\.\d+)?$/;
const SYMBOL_NUMBER_RE = /^[$€£¥₹₩]\d+(?:\.\d+)?$/;
const CODE_RE = new RegExp(`^(${CODES_ALTERNATION})$`, "i");

function isBareNumber(s) { return BARE_NUMBER_RE.test(s); }
function isSymbolNumber(s) { return SYMBOL_NUMBER_RE.test(s); }
function isCurrencyCode(s) { return CODE_RE.test(s); }

function wrapStreamForTTS(inner, language = "en") {
  let buffer = "";

  function flush(final) {
    if (!buffer) return;

    if (final) {
      const text = normalizeCurrencyText(buffer, language);
      if (text) inner.push(text);
      buffer = "";
      return;
    }

    const lastSpace = buffer.lastIndexOf(" ");
    if (lastSpace <= 0) return; // no word boundary yet — keep buffering

    // Determine last completed word and the one before it
    const committed = buffer.substring(0, lastSpace);
    const lastWordStart = committed.lastIndexOf(" ") + 1;
    const lastWord = committed.substring(lastWordStart).replace(/[.,!?;:)\]]+$/, "");
    const secondLastEnd = lastWordStart > 0 ? lastWordStart - 1 : -1;
    const secondLastStart = secondLastEnd > 0 ? committed.lastIndexOf(" ", secondLastEnd - 1) + 1 : 0;
    const secondLast = secondLastEnd > 0
      ? committed.substring(secondLastStart, secondLastEnd).replace(/[.,!?;:)\]]+$/, "")
      : "";

    const lastBare = isBareNumber(lastWord);
    const lastCode = isCurrencyCode(lastWord);
    const secondBare = isBareNumber(secondLast);
    const secondCode = isCurrencyCode(secondLast);

    // Dangling if last word COULD pair with a following word:
    //   - bare number without a preceding code (might be followed by code)
    //   - bare code without a preceding number (might be followed by number)
    // Symbol-prefixed numbers ($500) are complete — don't hold back.
    const dangling = (lastBare && !secondCode) || (lastCode && !secondBare);

    let splitAt;
    if (dangling) {
      splitAt = lastWordStart;
      if (splitAt <= 0) return; // nothing to flush yet
    } else {
      splitAt = lastSpace + 1; // include the space
    }

    const toFlush = buffer.substring(0, splitAt);
    buffer = buffer.substring(splitAt);

    if (toFlush) {
      const text = normalizeCurrencyText(toFlush, language);
      if (text) inner.push(text);
    }
  }

  return {
    push(chunk) {
      if (!chunk) return;
      buffer += chunk;
      flush(false);
    },
    finish() {
      flush(true);
      inner.finish();
    },
    [Symbol.asyncIterator]() {
      return inner[Symbol.asyncIterator]();
    },
  };
}

module.exports = { normalizeCurrencyText, wrapStreamForTTS };
