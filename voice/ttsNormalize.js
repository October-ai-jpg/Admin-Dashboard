/**
 * TTS Normalize — Currency/number normalization for TTS input
 * Pipeline version: 2.0
 *
 * Ported from October AI production (ESM → CommonJS).
 * Cartesia mispronounces numbers adjacent to currency codes.
 * This rewrites "USD 500" → "500 US dollars" etc. before TTS.
 *
 * Also provides wrapStreamForTTS() which buffers streaming text
 * at word boundaries to catch currency+number pairs.
 */

/* ── Currency name tables ── */

var CURRENCY_NAMES_EN = {
  USD: 'US dollars', EUR: 'euros', GBP: 'British pounds',
  DKK: 'Danish kroner', SEK: 'Swedish kronor', NOK: 'Norwegian kroner',
  ISK: 'Icelandic krona', CHF: 'Swiss francs', JPY: 'yen',
  CAD: 'Canadian dollars', AUD: 'Australian dollars', NZD: 'New Zealand dollars',
  CNY: 'Chinese yuan', INR: 'Indian rupees', KRW: 'Korean won',
  SGD: 'Singapore dollars', HKD: 'Hong Kong dollars', THB: 'Thai baht',
  ZAR: 'South African rand', PLN: 'Polish zloty', CZK: 'Czech koruna',
  HUF: 'Hungarian forint', TRY: 'Turkish lira', RUB: 'Russian rubles',
  BRL: 'Brazilian reais', MXN: 'Mexican pesos', AED: 'UAE dirhams',
  SAR: 'Saudi riyals'
};

var CURRENCY_NAMES_BY_LANG = {
  en: CURRENCY_NAMES_EN,
  da: { USD: 'amerikanske dollars', EUR: 'euro', GBP: 'britiske pund', DKK: 'kroner', SEK: 'svenske kroner', NOK: 'norske kroner', CHF: 'schweiziske franc' },
  de: { USD: 'US-Dollar', EUR: 'Euro', GBP: 'britische Pfund', DKK: 'dänische Kronen', SEK: 'schwedische Kronen', CHF: 'Schweizer Franken' },
  sv: { USD: 'amerikanska dollar', EUR: 'euro', GBP: 'brittiska pund', SEK: 'kronor', NOK: 'norska kronor' },
  no: { USD: 'amerikanske dollar', EUR: 'euro', GBP: 'britiske pund', NOK: 'kroner', DKK: 'danske kroner' },
  fr: { USD: 'dollars américains', EUR: 'euros', GBP: 'livres sterling', CHF: 'francs suisses' },
  es: { USD: 'dólares estadounidenses', EUR: 'euros', GBP: 'libras esterlinas', MXN: 'pesos mexicanos' },
  it: { USD: 'dollari americani', EUR: 'euro', GBP: 'sterline' },
  nl: { USD: 'Amerikaanse dollars', EUR: 'euro', GBP: 'Britse ponden' },
  pt: { USD: 'dólares americanos', EUR: 'euros', GBP: 'libras', BRL: 'reais' }
};

var SYMBOL_NAMES_EN = { '$': 'dollars', '€': 'euros', '£': 'pounds', '¥': 'yen', '₹': 'rupees', '₩': 'won' };
var SYMBOL_NAMES_BY_LANG = {
  en: SYMBOL_NAMES_EN,
  da: { '$': 'dollars', '€': 'euro', '£': 'pund', '¥': 'yen' },
  de: { '$': 'Dollar', '€': 'Euro', '£': 'Pfund', '¥': 'Yen' }
};

var ALL_CODES = Object.keys(CURRENCY_NAMES_EN);
var CODES_ALTERNATION = ALL_CODES.join('|');

function getNames(language) {
  var lang = (language || 'en').toLowerCase();
  var codes = Object.assign({}, CURRENCY_NAMES_EN, CURRENCY_NAMES_BY_LANG[lang] || {});
  var symbols = Object.assign({}, SYMBOL_NAMES_EN, SYMBOL_NAMES_BY_LANG[lang] || {});
  return { codes: codes, symbols: symbols };
}

/**
 * Normalize currency patterns in text for TTS.
 * "$500" → "500 dollars", "USD 500" → "500 US dollars", etc.
 */
function normalizeCurrencyText(text, language) {
  if (!language) language = 'en';
  if (!text || typeof text !== 'string') return text;
  var names = getNames(language);

  // Strip thousands separators
  var out = text.replace(/(\d),(\d{3}\b)/g, '$1$2');
  out = out.replace(/(\d),(\d{3}\b)/g, '$1$2');

  // 1) Symbol + number: "$500" → "500 dollars"
  out = out.replace(/([$€£¥₹₩])\s*(\d+(?:\.\d+)?)/g, function (_m, sym, num) {
    var name = names.symbols[sym];
    return name ? num + ' ' + name : num + ' ' + sym;
  });

  // 2) Code before number: "USD 500" → "500 US dollars"
  var codeBeforeRe = new RegExp('\\b(' + CODES_ALTERNATION + ')\\s+(\\d+(?:\\.\\d+)?)', 'g');
  out = out.replace(codeBeforeRe, function (_m, code, num) {
    return num + ' ' + (names.codes[code.toUpperCase()] || code);
  });

  // 3) Number before code: "500 USD" → "500 US dollars"
  var codeAfterRe = new RegExp('(\\d+(?:\\.\\d+)?)\\s+(' + CODES_ALTERNATION + ')\\b', 'g');
  out = out.replace(codeAfterRe, function (_m, num, code) {
    return num + ' ' + (names.codes[code.toUpperCase()] || code);
  });

  return out;
}


/* ═══════════════════════════════════════════════════════════════
 * Streaming wrapper — buffers at word boundaries to catch
 * currency+number pairs before they reach TTS.
 * ═══════════════════════════════════════════════════════════════ */

var BARE_NUMBER_RE = /^\d+(?:\.\d+)?$/;
var CODE_RE = new RegExp('^(' + CODES_ALTERNATION + ')$', 'i');

function isBareNumber(s) { return BARE_NUMBER_RE.test(s); }
function isCurrencyCode(s) { return CODE_RE.test(s); }

/**
 * Wrap an inner text stream with currency normalization + word-boundary buffering.
 *
 * @param {{ push: function, finish: function, [Symbol.asyncIterator]: function }} inner
 * @param {string} language
 */
function wrapStreamForTTS(inner, language) {
  if (!language) language = 'en';
  var buffer = '';

  function flush(final) {
    if (!buffer) return;

    if (final) {
      var text = normalizeCurrencyText(buffer, language);
      if (text) inner.push(text);
      buffer = '';
      return;
    }

    var lastSpace = buffer.lastIndexOf(' ');
    if (lastSpace <= 0) return;

    var committed = buffer.substring(0, lastSpace);
    var lastWordStart = committed.lastIndexOf(' ') + 1;
    var lastWord = committed.substring(lastWordStart).replace(/[.,!?;:)\]]+$/, '');
    var secondLastEnd = lastWordStart > 0 ? lastWordStart - 1 : -1;
    var secondLastStart = secondLastEnd > 0 ? committed.lastIndexOf(' ', secondLastEnd - 1) + 1 : 0;
    var secondLast = secondLastEnd > 0
      ? committed.substring(secondLastStart, secondLastEnd).replace(/[.,!?;:)\]]+$/, '')
      : '';

    var lastBare = isBareNumber(lastWord);
    var lastCode = isCurrencyCode(lastWord);
    var secondBare = isBareNumber(secondLast);
    var secondCode = isCurrencyCode(secondLast);

    var dangling = (lastBare && !secondCode) || (lastCode && !secondBare);

    var splitAt;
    if (dangling) {
      splitAt = lastWordStart;
      if (splitAt <= 0) return;
    } else {
      splitAt = lastSpace + 1;
    }

    var toFlush = buffer.substring(0, splitAt);
    buffer = buffer.substring(splitAt);

    if (toFlush) {
      var normalized = normalizeCurrencyText(toFlush, language);
      if (normalized) inner.push(normalized);
    }
  }

  return {
    push: function (chunk) {
      if (!chunk) return;
      buffer += chunk;
      flush(false);
    },
    finish: function () {
      flush(true);
      inner.finish();
    },
    /* Delegate async iteration to inner stream */
    [Symbol.asyncIterator]: function () {
      return inner[Symbol.asyncIterator]();
    }
  };
}

module.exports = { normalizeCurrencyText, wrapStreamForTTS };
