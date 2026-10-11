// The marks a screen reader reads as something other than what they are: "CH" as a word
// (Japanese voices read it as a country), an a/b pair as a fraction or a date, a slash on its
// own as nothing, and the middle dot as its character name or as nothing. Each is announced
// by a reading of its own (`spoken` in ./glyph) — "CH" spelled letter by letter, a pair as its
// two halves with the slash's word between them, the slash and the dot by their words. A pair
// is one mark, so its reading stays one run of words wherever it is announced. This module
// imports nothing, so the E2E fixture asks the same question the app answers.
export const SPOKEN_MARK = /(?<![A-Za-z0-9])ch(?![A-Za-z0-9])|([A-Za-z0-9.]+)\/([A-Za-z0-9.]+)|\/|·/gi;

/** Whether `text` holds a mark that is announced by a reading of its own. */
export function holdsMark(text: string): boolean {
  SPOKEN_MARK.lastIndex = 0;
  return SPOKEN_MARK.test(text);
}

/** What a screen reader reaches as an element of its own, and reads the title of as a hint;
 *  anything else is a wrapper whose title it does not read. */
export const READ_AS_ELEMENT = "button, input, select, textarea, a[href], [role]";
