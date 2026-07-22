/**
 * Bilingual output guards — ported unchanged in behaviour from the original
 * src/lib/ai-gateway.server.ts.
 *
 * Open-weight models served through Novita intermittently leak foreign-script
 * tokens (Cyrillic in particular) into Arabic output. Prompting alone did not
 * eliminate it, so generated text is also filtered post-hoc. Both layers are
 * required; do not remove one on the assumption the other suffices.
 */

export type AiLocale = "ar" | "en";

const FOREIGN_TO_ARABIC =
  /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const FOREIGN_TO_ARABIC_GLOBAL = new RegExp(FOREIGN_TO_ARABIC.source, "gu");

const FOREIGN_TO_ENGLISH =
  /[\p{Script=Arabic}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const FOREIGN_TO_ENGLISH_GLOBAL = new RegExp(FOREIGN_TO_ENGLISH.source, "gu");

const ARABIC_LETTERS = /[\p{Script=Arabic}]/gu;
const LATIN_LETTERS = /[\p{Script=Latin}]/gu;

function normalizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([،؛,.!?;:])/g, "$1")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sanitizeLanguageText(text: string, locale: AiLocale): string {
  const disallowed = locale === "ar" ? FOREIGN_TO_ARABIC : FOREIGN_TO_ENGLISH;
  const strip =
    locale === "ar" ? FOREIGN_TO_ARABIC_GLOBAL : FOREIGN_TO_ENGLISH_GLOBAL;
  const preferred = locale === "ar" ? ARABIC_LETTERS : LATIN_LETTERS;

  const cleaned = text.replace(/\S+/gu, (token) => {
    if (!disallowed.test(token)) return token;

    const stripped = token.replace(strip, "");
    const preferredCount = stripped.match(preferred)?.length ?? 0;

    // Mixed-script fragments like "والработодатель" leave only a prefix after
    // stripping. Drop those short remnants rather than show a broken word.
    if (preferredCount <= 3) return "";
    return stripped;
  });

  return normalizeWhitespace(cleaned);
}

export function sanitizeLanguageOutput<T>(value: T, locale: AiLocale): T {
  if (typeof value === "string") return sanitizeLanguageText(value, locale) as T;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLanguageOutput(item, locale)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        sanitizeLanguageOutput(nested, locale),
      ]),
    ) as T;
  }
  return value;
}

export function strictLanguageDirective(locale: AiLocale): string {
  if (locale === "ar") {
    return `LANGUAGE LOCK — ABSOLUTE RULE:
- Reply EXCLUSIVELY in Modern Standard Arabic (اللغة العربية الفصحى).
- Every single word, character and token in your output MUST use the Arabic script (U+0600–U+06FF) or standard punctuation/digits.
- DO NOT emit any Cyrillic (Russian), Latin (English/French/German), Chinese, Hindi/Devanagari, Hebrew, or any other non-Arabic script anywhere in the response — not even a single word, name or phrase.
- The ONLY allowed non-Arabic content is: internationally recognized proper nouns already written in Arabic transliteration, digits 0-9, and standard punctuation (. , ; : ! ? " ' - ( ) [ ]).
- If you feel tempted to use an English or foreign word, translate it into Arabic instead.
- If any source, uploaded file, or retrieved legal context contains English or another language, translate it fully into Arabic; never quote foreign-script text verbatim.
- Names of laws, articles, and case citations MUST be written in Arabic (e.g. "المادة 25 من قانون العمل" — never "Article 25 of Labour Law" or any transliteration in Latin/Cyrillic letters).
- Before returning, silently re-read your output and replace any non-Arabic word with its Arabic equivalent.`;
  }

  return `LANGUAGE LOCK — ABSOLUTE RULE:
- Reply EXCLUSIVELY in English.
- Every single word, character and token in your output MUST use the Latin alphabet (A-Z, a-z) with standard punctuation and digits.
- DO NOT emit any Arabic, Cyrillic (Russian), Chinese, Hindi/Devanagari, Hebrew, or any other non-Latin script anywhere in the response — not even a single word, name or phrase.
- If a legal term or law name is originally in Arabic, either translate it to English or transliterate it in Latin letters (e.g. "Jordanian Civil Code (al-Qanun al-Madani)"), never in the original script.
- If any source, uploaded file, or retrieved legal context contains Arabic or another non-Latin script, translate or transliterate it fully into English; never quote non-Latin-script text verbatim.
- Before returning, silently re-read your output and replace any non-Latin-script word with its English equivalent or Latin transliteration.`;
}
