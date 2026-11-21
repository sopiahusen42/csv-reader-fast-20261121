// solve.js — a faster drop-in for csv-reader 1.0.0 (make.fun csv-reader-speed-01, "Read broken CSV files faster, 21 November 2026").
//
// run(input) reads input {text, header} once, left to right, by csv-reader 1.0.0's written broken-row policy, and
// returns the identical JSON value {columns, rows, errors}. Where the reference reads one character at a time and
// grows each field with value += c (a fresh string per character), this reads the text by UTF-16 code-unit index
// with charCodeAt, captures runs by index and slice, and builds each field from a few pieces joined ONCE at the
// field's end. No regex, no per-character calls, nothing allocated per character: the field readers return the
// value string and hand back `ended`/`added` through local state, so the hot loop allocates nothing per character
// and no object per field.
//
// The reference's written policy, point by point, and where each lands here:
//  (1) a U+FEFF at the very start of the text is dropped .............. `pos` starts at 1 when charCodeAt(0) is 0xFEFF
//  (2) a record ends at LF or CRLF; a line left with no characters is no record
//      ................................................................ the line-skip at the top of the record loop
//  (3) outside quotes a CR not followed by LF is dropped (stray_cr, at the record's line/row)
//      ................................................................ readUnquoted records its index, keeps it out of the value
//  (4) a field that opens with a quote runs to the next quote that is not doubled; "" inside it is one quote; each
//     CRLF or lone CR inside it is read as LF (and counts a line); what follows its closing quote, up to the next
//     comma or line break, is appended as it stands (quote_junk when the field ends and anything was appended); a
//     quote that never closes is a literal character, the text after it is read again as an unquoted field starting
//     with that literal quote, the line counter reset to the line the quote opened on (unterminated_quote)
//      ................................................................ readQuoted
//  (5) a quote inside an unquoted field is a literal character; fields stay strings, never trimmed
//      ................................................................ readUnquoted keeps the characters as they stand
//  (6) columns is the first record when header is true, else null (empty text with header true gives columns []);
//     rows holds the records after the header (every record when header is false), each padded with "" (short_row,
//     with fields: the field count) or cut (long_row, with extra: the cut fields) to the first record's width
//      ................................................................ the end of the record loop
//  (7) each error is {code, line, row}: line is the 1-based line the record starts on (every LF, CRLF and lone CR
//     inside a quoted field counts), row is the record's index in rows (null for the header); errors appear in the
//     order met — a field's quote_junk when the field ends, a record's short_row/long_row when the record ends
//      ................................................................ recordLine/recordRow and the push order
//  (8) a line that held only stray CRs is left with no characters: no record (its stray_cr errors stay)
//      ................................................................ the single-empty-unquoted-field check
//  (9) input.header === true selects header mode; input.text is String()-coerced
//      ................................................................ the top of run
// (10) the scan is by UTF-16 code unit (charCodeAt index): a trailing lone CR inside a quoted field becomes an LF
//     even at end of text; a quoted field that reaches EOF right after its closing quote ends the record (END);
//     after a closing comma at EOF an empty final field is produced
//      ................................................................ the scan bounds in both readers

export function run(input) {
  const text = String(input.text); // (9)
  const header = input.header === true; // (9)

  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1; // (6) the first record's width, -1 until the first record

  const len = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0; // (1)
  let line = 1; // the 1-based line `pos` is on; LF, CRLF and lone CR inside quotes all count ((4), (7))

  // The record being read: the line it starts on and its index in rows (null: the header) — (7).
  let recordLine = 1;
  let recordRow = null;

  // How the field the readers just read ended: 1 = comma (the record goes on), 2 = line break, 0 = end of text,
  // and the characters the reader kept (for quote_junk). Local state, not a returned object, so the hot loop
  // allocates nothing per field.
  let ended = 1;
  let added = 0;

  // Reads an unquoted field starting at pos, taking `base` (the unterminated-quote re-read of (4) starts with the
  // literal quote). Runs to the next comma (the record goes on), the next line break (the record ends) or the end
  // of the text (10). A CR not followed by LF is dropped with stray_cr (3). The value keeps the kept characters as
  // they stand (5): slices of the text joined once, never one character at a time.
  function readUnquoted(base) {
    const start = pos;
    let end = len;
    let breakAt = -1; // the index where a line break began, when the record ends here
    let strays = null; // the indices of dropped lone CRs (3), in the order met
    let j = pos;
    while (j < len) {
      const c = text.charCodeAt(j);
      if (c === 44) { end = j; break; } // ','
      if (c === 10) { end = j; breakAt = j; break; } // '\n'
      if (c === 13) { // '\r'
        if (text.charCodeAt(j + 1) === 10) { end = j; breakAt = j; break; } // CRLF: the record ends
        if (strays === null) strays = [j]; else strays.push(j); // dropped, counted
      }
      j += 1;
    }
    // The value: the kept run(s) of the text, joined once.
    let value;
    if (strays === null) {
      value = base === '' ? text.slice(start, end) : base + text.slice(start, end);
    } else {
      const parts = [];
      if (base !== '') parts.push(base);
      let last = start;
      for (let k = 0; k < strays.length; k++) {
        const s = strays[k];
        parts.push(text.slice(last, s));
        last = s + 1;
      }
      parts.push(text.slice(last, end));
      value = parts.join('');
    }
    const kept = end - start - (strays === null ? 0 : strays.length); // characters kept, not the dropped CRs
    if (strays !== null) {
      for (let k = 0; k < strays.length; k++) {
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow }); // (3), (7): in the order met
      }
    }
    if (breakAt >= 0) { // (2) the record ends at the line break (CRLF or LF)
      pos = breakAt + (text.charCodeAt(breakAt) === 13 ? 2 : 1);
      line += 1;
      ended = 2;
    } else if (end !== len) { // a comma: the record goes on
      pos = end + 1;
      ended = 1;
    } else { // (10) the end of the text
      pos = len;
      ended = 0;
    }
    added = kept;
    return value;
  }

  // Reads a quoted field whose opening quote is at pos — (4).
  function readQuoted() {
    const open = pos; // the opening quote's index
    const openLine = line; // (4) the line the quote opened on, for the re-read
    let i = pos + 1;
    let closed = -1; // the closing quote's index, -1 when it never closes
    let specials = null; // indices where the value differs from the raw text: a "" escape or a CR/LF
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 34) { // '"'
        if (text.charCodeAt(i + 1) === 34) { // "": one quote
          if (specials === null) specials = [];
          specials.push(i);
          i += 2;
          continue;
        }
        closed = i; // the next quote that is not doubled
        break;
      }
      if (c === 13) { // a CR inside the quotes is read as LF (10: even at end of text)
        if (specials === null) specials = [];
        specials.push(i);
        i += 1;
        if (i < len && text.charCodeAt(i) === 10) i += 1; // the CRLF pair's LF belongs to the CR
        continue;
      }
      if (c === 10) { // a LF inside the quotes
        if (specials === null) specials = [];
        specials.push(i);
      }
      i += 1;
    }
    if (closed < 0) {
      // (4) the quote never closes: a literal character, and the text after it is read again as an unquoted field
      // starting with it, the line counter back to the line the quote opened on.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow }); // (7)
      return readUnquoted('"');
    }
    // The value from [open+1, closed): "" becomes one quote, each CRLF or lone CR one LF (and counts a line: (7)).
    let value;
    if (specials === null) {
      value = text.slice(open + 1, closed);
    } else {
      const parts = [];
      let last = open + 1;
      for (let k = 0; k < specials.length; k++) {
        const s = specials[k];
        const sc = text.charCodeAt(s);
        if (sc === 34) {
          parts.push(text.slice(last, s), '"');
          last = s + 2;
        } else {
          parts.push(text.slice(last, s), '\n');
          line += 1;
          last = s + (sc === 13 && text.charCodeAt(s + 1) === 10 ? 2 : 1);
        }
      }
      parts.push(text.slice(last, closed));
      value = parts.join('');
    }
    pos = closed + 1;
    if (pos >= len) { ended = 0; added = 0; return value; } // (10) EOF right after the closing quote
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; ended = 1; added = 0; return value; }
    if (c === 10) { pos += 1; line += 1; ended = 2; added = 0; return value; }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; ended = 2; added = 0; return value; }
    // (4) what follows the closing quote is appended as it stands, up to the next comma or line break.
    const value2 = readUnquoted(value);
    if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow }); // (7)
    return value2;
  }

  while (true) {
    // (2) a record ends at LF or CRLF, and a line left with no characters is no record:
    // skip the line breaks up to the next record's first character (a lone CR is not one of them).
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line; // (7)
    recordRow = header && columns === null ? null : rows.length; // (7)

    const fields = [];
    let firstQuoted = text.charCodeAt(pos) === 34; // (5), (8): did the record's first (only) field open with a quote
    do {
      const field = text.charCodeAt(pos) === 34 ? readQuoted() : readUnquoted('');
      fields.push(field);
    } while (ended === 1); // COMMA: the record goes on (10)

    // (8) a line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    // A line that held an empty quoted field ("" ) IS a record, so the check only holds for the unquoted case.
    if (fields.length === 1 && fields[0] === '' && !firstQuoted) continue;

    if (width < 0) width = fields.length; // (6)
    if (header && columns === null) {
      columns = fields; // (6) the first record is the header, at its own width
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length }); // (6), (7)
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      const extra = fields.splice(width);
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra }); // (6), (7)
    }
    rows.push(fields);
  }

  // (6) empty text with header true gives columns []; header false gives columns null.
  return { columns: header ? (columns === null ? [] : columns) : null, rows, errors };
}
