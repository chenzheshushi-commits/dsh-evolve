/**
 * Scope-based text ranges for the source-reading gates in this directory.
 *
 * Every gate here answers a question of the form "are these two things in the same
 * place?" by slicing source text. v0.6.x wrote those slices as `slice(i, i + N)`
 * with N a character count, and all ten of them were wrong in the same way: N is a
 * guess about how much source fits between two identifiers, so editing unrelated
 * code changes the answer.
 *
 * Two measured failure modes, neither of which is "the gate did not notice":
 *
 *   - `instance-lock.test.mjs:145` sliced 1200 characters from a function start and
 *     asserted one identifier appeared before another. 126 characters of comment cut
 *     the second one off the end, `indexOf` returned -1, and `740 < -1` is false --
 *     so the gate went RED on a change with no behaviour difference. Written the
 *     other way round it would have been permanently GREEN.
 *   - `ui-api-contract.test.mjs:121` had 273 characters of headroom. Five lines of
 *     ordinary comment turned it red.
 *
 * So the unit is a syntactic scope, not a character budget: a statement ends at its
 * own semicolon, a block at its own closing brace, and neither moves when something
 * else on the page grows.
 *
 * All three functions are text-level on purpose. These gates read sibling source
 * files as data and must keep working when that source does not parse as this
 * module's dialect; a real parser would be a heavier dependency than the job needs.
 */

/**
 * The single statement starting at `from`: text up to the semicolon that closes it,
 * ignoring semicolons nested inside parens, brackets, braces, strings, templates,
 * regexes and comments.
 *
 * Use this when the thing being checked is one call or one assignment -- "this
 * apiPost names this endpoint", "this slice has a numeric second argument".
 */
export function enclosingStatement(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const skipped = skipNonCode(text, i);
    if (skipped > i) { i = skipped - 1; continue; }
    const ch = text[i];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      // A closing bracket at depth 0 ends the enclosing construct: we started
      // inside it, so the statement cannot continue past it.
      if (depth === 0) return text.slice(from, i);
      depth -= 1;
    } else if (ch === ';' && depth === 0) {
      return text.slice(from, i + 1);
    }
  }
  return text.slice(from);
}

/**
 * The block containing `from`: text up to the brace that closes the scope `from`
 * sits in.
 *
 * Use this when the question spans several statements -- "somewhere in this
 * function, is the lock claimed before mutations are allowed?".
 */
export function enclosingBlock(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const skipped = skipNonCode(text, i);
    if (skipped > i) { i = skipped - 1; continue; }
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      if (depth === 0) return text.slice(from, i);
      depth -= 1;
    }
  }
  return text.slice(from);
}

/**
 * The body of the function whose declaration starts at or after `from`, without the
 * outer braces.
 *
 * `enclosingBlock(text, indexOf('function foo'))` does NOT do this: starting before
 * the function's own `{` makes that brace the one that opens depth 1, so the scan
 * runs past the function's closing brace to the end of the file. The first version
 * of the v0.7.0 readme-claims fix had exactly this bug -- it read 17500 characters
 * instead of 580 and swallowed unrelated functions, which made a ban on `cpSync`
 * match a `cpSync` somewhere else entirely.
 *
 * Use this whenever the anchor is a function declaration; use `enclosingBlock` when
 * the anchor is already inside the scope of interest.
 */
export function functionBody(text, from) {
  const brace = text.indexOf('{', from);
  if (brace === -1) return '';
  return enclosingBlock(text, brace + 1);
}

/**
 * Arguments of the call whose opening paren is at `from - 1`, split on top-level
 * commas with bracket balancing, plus the index just past the closing paren.
 *
 * Splitting on `,` with a regex breaks on `foo(bar(a, b), c)` and on any string
 * containing a comma; both shapes occur in this repo's own sources.
 */
export function splitCallArgs(text, from) {
  const args = [];
  let cur = '';
  let depth = 1;
  let i = from;
  while (i < text.length) {
    const skipped = skipNonCode(text, i);
    if (skipped > i) { cur += text.slice(i, skipped); i = skipped; continue; }
    const ch = text[i];
    if ('([{'.includes(ch)) { depth += 1; cur += ch; }
    else if (')]}'.includes(ch)) {
      depth -= 1;
      if (depth === 0) { i += 1; break; }
      cur += ch;
    } else if (ch === ',' && depth === 1) {
      args.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
    i += 1;
  }
  args.push(cur.trim());
  return { args: args.filter((a, n) => a !== '' || n === 0), end: i };
}

/**
 * If a string, template, regex or comment starts at `i`, the index just past it;
 * otherwise `i`.
 *
 * Without this, a brace or semicolon inside a string literal moves the end of a
 * statement -- the class of bug that made v0.6.2's regex-based guard bypassable by
 * an equivalent rewrite.
 */
function skipNonCode(text, i) {
  const ch = text[i];
  if (ch === '/' && text[i + 1] === '/') {
    const nl = text.indexOf('\n', i);
    return nl === -1 ? text.length : nl;
  }
  if (ch === '/' && text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2);
    return end === -1 ? text.length : end + 2;
  }
  if (ch === '\'' || ch === '"' || ch === '`') return skipQuoted(text, i, ch);
  if (ch === '/' && looksLikeRegexStart(text, i)) return skipRegex(text, i);
  return i;
}

function skipQuoted(text, i, quote) {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue; }
    if (text[j] === quote) return j + 1;
    // A template literal's ${...} can contain anything, including the quote we are
    // scanning for, so step over it as a unit.
    if (quote === '`' && text[j] === '$' && text[j + 1] === '{') {
      let depth = 1;
      j += 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') depth -= 1;
        j += 1;
      }
      continue;
    }
    j += 1;
  }
  return text.length;
}

function skipRegex(text, i) {
  let j = i + 1;
  let inClass = false;
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue; }
    if (text[j] === '[') inClass = true;
    else if (text[j] === ']') inClass = false;
    else if (text[j] === '/' && !inClass) {
      j += 1;
      while (j < text.length && /[a-z]/.test(text[j])) j += 1;
      return j;
    } else if (text[j] === '\n') return j;
    j += 1;
  }
  return text.length;
}

/**
 * Distinguish a regex literal from a division operator by what precedes it. Getting
 * this wrong only ever costs precision (a division is skipped as if it opened a
 * regex), so the test bundled with this module pins both directions.
 */
function looksLikeRegexStart(text, i) {
  for (let k = i - 1; k >= 0; k -= 1) {
    const ch = text[k];
    if (/\s/.test(ch)) continue;
    return '(,=:[!&|?{};+-*%~^<>'.includes(ch) || /\breturn$|\btypeof$|\bcase$/.test(text.slice(0, k + 1));
  }
  return true;
}

/** 1-based line number of `idx`, for gate messages that must point somewhere. */
export const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
