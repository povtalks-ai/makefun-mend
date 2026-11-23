// mend — one patch tool for every AI edit format.
//
// Applies an edit a model wrote to a tree of text files. The patch comes in
// one of four formats — a unified diff, SEARCH/REPLACE blocks, the V4A patch
// format, or text-editor tool calls as JSON — and every file is changed or
// nothing is. Node 22, standard library only; run as:
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: one line, nothing written. */
class Halt {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece
 *  after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (text.endsWith('\n')) out.pop();
  return out.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \,
 *  and none of its /-separated segments is empty, . or .. . */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const stripTrailing = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** One line of a file: its break, its lines, and whether it ends with one.
 *  An empty file has no lines and does not end with a break. */
interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function readFileLines(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function writeFileLines(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** A fresh file from lines: LF breaks, ending with one when it has lines. */
function freshFile(lines: string[]): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + '\n';
}

/** One line of an old block O or a new block N. `ctx` is the index of the
 *  line in O it is a context line of, or -1 when it is not a context line. */
interface BlockLine {
  text: string;
  ctx: number;
}

/** Compare one old line against one file line at a tier. */
function lineMatches(oldLine: string, fileLine: string, tier: number): boolean {
  if (tier === 0) return oldLine === fileLine;
  if (tier === 1) return stripTrailing(oldLine) === stripTrailing(fileLine);
  return stripBoth(oldLine) === stripBoth(fileLine);
}

/** Every position where O occurs in `lines` at `tier`. */
function occurrencesAt(o: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineMatches(o[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs
 *  at or after `from`, and every occurrence there. */
function firstTier(
  o: string[],
  lines: string[],
  from: number,
  strict: boolean,
): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrencesAt(o, lines, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** The lines N writes when it replaces O matched at `pos`: a context line
 *  is the file's own matched line; at tier 2 every other line is re-indented
 *  from O's first line's leading whitespace to the file's. */
function renderNew(
  n: BlockLine[],
  o: BlockLine[],
  fileLines: string[],
  pos: number,
  tier: number,
): string[] {
  if (tier !== 2) {
    return n.map((l) => (l.ctx >= 0 ? fileLines[pos + l.ctx]! : l.text));
  }
  const p = o.length > 0 ? leadingWs(o[0]!.text) : '';
  const f = fileLines.length > pos ? leadingWs(fileLines[pos]!) : '';
  return n.map((l) => {
    if (l.ctx >= 0) return fileLines[pos + l.ctx]!;
    const t = l.text;
    if (t === '' || t.trim() === '') return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 *  the rest read from disk. */
class Tree {
  private readonly seen = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order: [old path, new path]. */
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.seen.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.seen.set(p, v);
    }
    return this.seen.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function requireSafe(p: string): void {
  if (!isSafePath(p)) throw new EditFail('unsafe', p);
}

function requireExists(tree: Tree, p: string): string {
  requireSafe(p);
  const t = tree.get(p);
  if (t === null) throw new EditFail('missing', p);
  return t;
}

/** Replace O matched at `pos` by N in the file's lines, or insert N at
 *  `pos` when O is empty. Returns the new lines. */
function spliceLines(
  lines: string[],
  pos: number,
  o: BlockLine[],
  n: BlockLine[],
  tier: number,
): string[] {
  const made = renderNew(n, o, lines, pos, tier);
  return [...lines.slice(0, pos), ...made, ...lines.slice(pos + o.length)];
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** Old start, 1-based, from the @@ header. */
  start: number;
  o: BlockLine[];
  n: BlockLine[];
  /** True when the hunk's last context or + line is followed by a \ line. */
  noEol: boolean;
  /** True when the hunk's last body line is a + line. */
  lastIsPlus: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The path after `--- ` or `+++ `: text after four characters, up to the
 *  first tab, surrounding spaces removed, a leading a/ or b/ removed. */
function headerPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!.trim();
  return stripAB(raw);
}

/** A leading a/ or b/ is removed from a path. */
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** A hunk's body: lines after the header starting with space, -, + or \,
 *  or empty (an empty line is a context line whose text is empty). The body
 *  ends at the first other line, at a `diff --git ` line, at a `--- ` line
 *  followed by a `+++ ` line, or at the end of the patch; empty lines at the
 *  end of a body are not part of it. Returns the body lines and the index
 *  just past them. */
function readHunkBody(lines: string[], i: number): { body: string[]; next: number } {
  const body: string[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      j += 1;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0 && body[body.length - 1] === '') {
    body.pop();
    j -= 1;
  }
  return { body, next: j };
}

/** One hunk from its body lines: O is its context and - lines, N its
 *  context and + lines, each in body order. */
function hunkFromBody(start: number, body: string[]): Hunk {
  const o: BlockLine[] = [];
  const n: BlockLine[] = [];
  let lastIsPlus = false;
  for (let k = 0; k < body.length; k += 1) {
    const l = body[k]!;
    if (l.startsWith('\\')) {
      // A \ line refers to the body line before it; it marks that line as
      // having no line break after it.
      continue;
    }
    if (l === '' || l.startsWith(' ')) {
      const text = l === '' ? '' : l.slice(1);
      const idx = o.length;
      o.push({ text, ctx: idx });
      n.push({ text, ctx: idx });
      lastIsPlus = false;
    } else if (l.startsWith('-')) {
      o.push({ text: l.slice(1), ctx: -1 });
      lastIsPlus = false;
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: -1 });
      lastIsPlus = true;
    }
  }
  // noEol is true only when a \ line follows the hunk's last context or +
  // line: a \ after a - line, or after any earlier line, does not count.
  let noEol = false;
  let lastCtxPlus = -1;
  for (let k = 0; k < body.length; k += 1) {
    const l = body[k]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) lastCtxPlus = k;
  }
  if (lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]!.startsWith('\\')) {
    noEol = true;
  }
  return { start, o, n, noEol, lastIsPlus };
}

/** Apply one hunk to a file's lines. `d` is the drift of this section's
 *  hunks applied so far. Returns the new lines, the new final-break flag,
 *  and the new drift. */
function applyHunk(
  file: FileLines,
  hunk: Hunk,
  d: number,
  strict: boolean,
  path: string,
): { lines: string[]; final: boolean; d: number } {
  const oText = hunk.o.map((l) => l.text);
  const nText = hunk.n;
  if (oText.length > 0) {
    const found = firstTier(oText, file.lines, 0, strict);
    if (found === null) throw new EditFail('no-match', path);
    const target = hunk.start - 1 + d;
    let best = found.at[0]!;
    for (const p of found.at) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const lines = spliceLines(file.lines, best, hunk.o, nText, found.tier);
    let fin = file.final;
    if (best + oText.length === file.lines.length) fin = !hunk.noEol;
    return { lines, final: fin, d: d + (nText.length - oText.length) };
  }
  const at = Math.min(hunk.start + d, file.lines.length);
  const lines = [...file.lines.slice(0, at), ...nText.map((l) => l.text), ...file.lines.slice(at)];
  let fin = file.final;
  if (at === file.lines.length) fin = !hunk.noEol;
  return { lines, final: fin, d: d + nText.length };
}

/** Parse a unified diff into its sections' edits. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    // A new section starts at a diff --git line, or at a --- line followed
    // by a +++ line.
    let started = false;
    let sec: Section = { oldPath: null, newPath: null, creation: false, deletion: false, hunks: [] };
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+?)\s*$/.exec(l);
      if (m === null) throw new Halt(`error: parse ${i + 1}`);
      sec.oldPath = stripAB(m[1]!);
      sec.newPath = stripAB(m[2]!);
      started = true;
      i += 1;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec.oldPath = headerPath(l);
      sec.newPath = headerPath(lines[i + 1]!);
      if (sec.oldPath === '/dev/null') sec.oldPath = null;
      if (sec.newPath === '/dev/null') sec.newPath = null;
      started = true;
      i += 2;
    }
    if (!started) {
      // Outside bodies, lines that are not part of a section header are
      // ignored. A hunk header before any section is a parse error.
      if (l.startsWith('@@')) throw new Halt(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    // The section's header: before its first hunk. `hasPair` says whether
    // a ---/+++ pair has already named the paths in this header: a section
    // started by such a pair has one, one started by diff --git does not
    // until its header's pair names them.
    let hasPair = l.startsWith('--- ');
    let firstHunk = true;
    while (i < lines.length) {
      const h = lines[i]!;
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (!firstHunk) break;
        // A second ---/+++ pair starts a new section; the header's own
        // pair names the paths.
        if (hasPair) break;
        sec.oldPath = headerPath(h);
        sec.newPath = headerPath(lines[i + 1]!);
        if (sec.oldPath === '/dev/null') sec.oldPath = null;
        if (sec.newPath === '/dev/null') sec.newPath = null;
        hasPair = true;
        i += 2;
        continue;
      }
      if (h.startsWith('--- ') && firstHunk) {
        throw new Halt(`error: parse ${i + 2}`);
      }
      if (h.startsWith('@@')) {
        const m = HUNK_HEAD.exec(h);
        if (m === null) throw new Halt(`error: parse ${i + 1}`);
        const { body, next } = readHunkBody(lines, i + 1);
        sec.hunks.push(hunkFromBody(Number(m[1]), body));
        i = next;
        firstHunk = false;
        continue;
      }
      if (firstHunk) {
        if (h.startsWith('rename from ')) {
          if (!hasPair) sec.oldPath = h.slice('rename from '.length).trim();
        } else if (h.startsWith('rename to ')) {
          if (!hasPair) sec.newPath = h.slice('rename to '.length).trim();
        } else if (h.startsWith('new file mode')) {
          sec.creation = true;
        } else if (h.startsWith('deleted file mode')) {
          sec.deletion = true;
        }
        // index, old mode, new mode, similarity, dissimilarity, Index: and
        // any other line are ignored.
        i += 1;
        continue;
      }
      // After the first hunk, only hunks and new sections matter.
      break;
    }
    sections.push(sec);
  }
  if (sections.length === 0) throw new Halt('error: parse 1');
  return sections.map((sec) => sectionEdit(sec, strict));
}

/** One section is one edit. */
function sectionEdit(sec: Section, strict: boolean): Edit {
  const isCreation = sec.creation || sec.oldPath === null;
  const isDeletion = !isCreation && (sec.deletion || sec.newPath === null);
  const isMove = !isCreation && !isDeletion && sec.oldPath !== null && sec.newPath !== null && sec.oldPath !== sec.newPath;
  return (tree) => {
    if (isCreation) {
      const to = sec.newPath!;
      requireSafe(to);
      if (tree.get(to) !== null) throw new EditFail('exists', to);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (const l of h.n) {
          if (l.ctx < 0) plus.push(l.text);
        }
        // The last + line overall decides the final break.
        if (h.lastIsPlus) noEol = h.noEol;
      }
      tree.now.set(to, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDeletion) {
      const from = sec.oldPath!;
      const text = requireExists(tree, from);
      void text;
      tree.now.set(from, null);
      return;
    }
    if (isMove) {
      const from = sec.oldPath!;
      const to = sec.newPath!;
      requireSafe(from);
      requireSafe(to);
      const text = tree.get(from);
      if (text === null) throw new EditFail('missing', from);
      if (tree.get(to) !== null) throw new EditFail('exists', to);
      const file = readFileLines(text);
      let d = 0;
      let cur: FileLines = file;
      for (const h of sec.hunks) {
        const r = applyHunk(cur, h, d, strict, from);
        cur = { br: cur.br, lines: r.lines, final: r.final };
        d = r.d;
      }
      tree.now.set(to, writeFileLines(cur));
      tree.now.set(from, null);
      tree.moves.push([from, to]);
      return;
    }
    const p = sec.oldPath!;
    const text = requireExists(tree, p);
    const file = readFileLines(text);
    let d = 0;
    let cur: FileLines = file;
    for (const h of sec.hunks) {
      const r = applyHunk(cur, h, d, strict, p);
      cur = { br: cur.br, lines: r.lines, final: r.final };
      d = r.d;
    }
    tree.now.set(p, writeFileLines(cur));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

/** Parse SEARCH/REPLACE blocks into edits. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    // The path is the nearest line before the SEARCH line, after the
    // previous block's REPLACE line (or the start), that is not blank and
    // does not start with three backticks once trimmed.
    let path: string | null = null;
    for (let k = i - 1; k > prevReplace; k -= 1) {
      const cand = lines[k]!;
      if (isBlank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Halt(`error: parse ${searchLine}`);
    // Old lines run to the ======= line; then new lines to >>>>>>> REPLACE.
    let j = i + 1;
    const oldLines: string[] = [];
    let foundSep = false;
    while (j < lines.length) {
      const m = lines[j]!;
      if (m.trimEnd() === '=======') {
        foundSep = true;
        j += 1;
        break;
      }
      if (m.trimEnd() === '>>>>>>> REPLACE') break;
      oldLines.push(m);
      j += 1;
    }
    if (!foundSep) throw new Halt(`error: parse ${searchLine}`);
    const newLines: string[] = [];
    let foundEnd = false;
    while (j < lines.length) {
      const m = lines[j]!;
      if (m.trimEnd() === '>>>>>>> REPLACE') {
        foundEnd = true;
        j += 1;
        break;
      }
      newLines.push(m);
      j += 1;
    }
    if (!foundEnd) throw new Halt(`error: parse ${searchLine}`);
    prevReplace = j - 1;
    prevPath = path;
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    i = j;
  }
  if (edits.length === 0) throw new Halt('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  const o: BlockLine[] = oldLines.map((t) => ({ text: t, ctx: -1 }));
  const n: BlockLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
  return (tree) => {
    requireSafe(path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFail('exists', path);
      tree.now.set(path, freshFile(newLines));
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new EditFail('missing', path);
    const file = readFileLines(text);
    const found = firstTier(oldLines, file.lines, 0, strict);
    if (found === null) throw new EditFail('no-match', path);
    if (found.at.length > 1) throw new EditFail('ambiguous', path);
    const pos = found.at[0]!;
    const lines = spliceLines(file.lines, pos, o, n, found.tier);
    tree.now.set(path, writeFileLines({ br: file.br, lines, final: file.final }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  /** Null: no anchor. */
  anchor: string | null;
  o: BlockLine[];
  n: BlockLine[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  /** Update only: the new path, or null. */
  moveTo: string | null;
  /** Add only: the file's lines. */
  addLines: string[];
  chunks: V4aChunk[];
  /** The section's header line, 1-based, for parse errors. */
  line: number;
}

const V4A_ADD = '*** Add File: ';
const V4A_DELETE = '*** Delete File: ';
const V4A_UPDATE = '*** Update File: ';

function v4aSectionStart(l: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  if (l.startsWith(V4A_ADD)) return { kind: 'add', path: l.slice(V4A_ADD.length).trim() };
  if (l.startsWith(V4A_DELETE)) return { kind: 'delete', path: l.slice(V4A_DELETE.length).trim() };
  if (l.startsWith(V4A_UPDATE)) return { kind: 'update', path: l.slice(V4A_UPDATE.length).trim() };
  if (l === '*** Add File:' || l === '*** Delete File:' || l === '*** Update File:') {
    return { kind: l.includes('Add') ? 'add' : l.includes('Delete') ? 'delete' : 'update', path: '' };
  }
  return null;
}

/** Parse a V4A patch into its sections' edits. */
function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Halt('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Halt(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Halt(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i += 1;
      continue;
    }
    const start = v4aSectionStart(l);
    if (start === null) throw new Halt(`error: parse ${i + 1}`);
    const sec: V4aSection = { kind: start.kind, path: start.path, moveTo: null, addLines: [], chunks: [], line: i + 1 };
    i += 1;
    if (start.kind === 'add') {
      // Lines start with + or are empty; blank lines at the end of the
      // section are not part of it.
      const collected: string[] = [];
      while (i < last) {
        const m = lines[i]!;
        if (m === '') {
          collected.push('');
          i += 1;
          continue;
        }
        if (m.startsWith('+')) {
          collected.push(m.slice(1));
          i += 1;
          continue;
        }
        break;
      }
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
      sec.addLines = collected;
    } else if (start.kind === 'delete') {
      // No lines.
    } else {
      // Update: an optional *** Move to: as its first line, then chunks.
      while (i < last && isBlank(lines[i]!)) i += 1;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        sec.moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      } else if (i < last && lines[i]! === '*** Move to:') {
        sec.moveTo = '';
        i += 1;
      }
      let firstChunk = true;
      let chunkOpen = false;
      let cur: V4aChunk = { anchor: null, o: [], n: [], eof: false };
      const closeChunk = (): void => {
        if (chunkOpen) {
          sec.chunks.push(cur);
          chunkOpen = false;
        }
      };
      while (i < last) {
        const m = lines[i]!;
        if (m === '*** End of File') {
          if (!chunkOpen) throw new Halt(`error: parse ${i + 1}`);
          cur.eof = true;
          closeChunk();
          i += 1;
          continue;
        }
        if (m.startsWith('@@')) {
          closeChunk();
          cur = { anchor: m.slice(2).trim(), o: [], n: [], eof: false };
          chunkOpen = true;
          firstChunk = false;
          i += 1;
          continue;
        }
        const st = v4aSectionStart(m);
        if (st !== null) break;
        if (isBlank(m)) {
          // A blank line (empty or only whitespace) is an empty context
          // line inside a chunk, but blank lines at the end of a section
          // (before the next section or *** End Patch) are not part of it.
          let k = i;
          while (k < last && isBlank(lines[k]!)) k += 1;
          if (k >= last || v4aSectionStart(lines[k]!) !== null) {
            closeChunk();
            i = k;
            break;
          }
          if (!chunkOpen) {
            if (!firstChunk) throw new Halt(`error: parse ${i + 1}`);
            cur = { anchor: null, o: [], n: [], eof: false };
            chunkOpen = true;
            firstChunk = false;
          }
          const idx = cur.o.length;
          cur.o.push({ text: '', ctx: idx });
          cur.n.push({ text: '', ctx: idx });
          i += 1;
          continue;
        }
        if (m.startsWith(' ') || m.startsWith('-') || m.startsWith('+')) {
          if (!chunkOpen) {
            if (!firstChunk) throw new Halt(`error: parse ${i + 1}`);
            cur = { anchor: null, o: [], n: [], eof: false };
            chunkOpen = true;
            firstChunk = false;
          }
          if (m.startsWith(' ')) {
            const idx = cur.o.length;
            cur.o.push({ text: m.slice(1), ctx: idx });
            cur.n.push({ text: m.slice(1), ctx: idx });
          } else if (m.startsWith('-')) {
            cur.o.push({ text: m.slice(1), ctx: -1 });
          } else {
            cur.n.push({ text: m.slice(1), ctx: -1 });
          }
          i += 1;
          continue;
        }
        throw new Halt(`error: parse ${i + 1}`);
      }
      closeChunk();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Halt(`error: parse ${sec.line}`);
    }
    sections.push(sec);
  }
  if (sections.length === 0) throw new Halt('error: parse 1');
  return sections.map((sec) => v4aSectionEdit(sec));
}

/** Find the first line at or after `from` equal to `anchor` at the first
 *  tier where one is; a single line on both sides. */
function findAnchor(anchor: string, lines: string[], from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = Math.max(0, from); i < lines.length; i += 1) {
      if (lineMatches(anchor, lines[i]!, tier)) return i;
    }
  }
  return null;
}

function v4aSectionEdit(sec: V4aSection): Edit {
  return (tree) => {
    requireSafe(sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new EditFail('exists', sec.path);
      tree.now.set(sec.path, freshFile(sec.addLines));
      return;
    }
    if (sec.kind === 'delete') {
      const text = requireExists(tree, sec.path);
      void text;
      tree.now.set(sec.path, null);
      return;
    }
    // Update.
    if (sec.moveTo !== null) requireSafe(sec.moveTo);
    const text = requireExists(tree, sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new EditFail('exists', sec.moveTo);
    const file = readFileLines(text);
    let lines = file.lines;
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(chunk.anchor, lines, cursor, false);
        if (at === null) throw new EditFail('no-match', sec.path);
        cursor = at + 1;
      }
      const oText = chunk.o.map((l) => l.text);
      if (oText.length === 0) {
        const at = chunk.eof ? lines.length : cursor;
        const made = chunk.n.map((l) => l.text);
        lines = [...lines.slice(0, at), ...made, ...lines.slice(at)];
        cursor = at + made.length;
        continue;
      }
      const found = firstTier(oText, lines, cursor, false);
      if (found === null) throw new EditFail('no-match', sec.path);
      let pos: number | null = null;
      for (const p of found.at) {
        if (chunk.eof && p + oText.length !== lines.length) continue;
        pos = p;
        break;
      }
      if (pos === null) throw new EditFail('no-match', sec.path);
      lines = spliceLines(lines, pos, chunk.o, chunk.n, found.tier);
      cursor = pos + chunk.n.length;
    }
    const out = writeFileLines({ br: file.br, lines, final: file.final });
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(sec.path, null);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one. */
function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      requireSafe(p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = requireExists(tree, p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = requireExists(tree, p);
      const file = readFileLines(before);
      if (line < 0 || line > file.lines.length) throw new EditFail('no-match', p);
      const lines = [...file.lines.slice(0, line), ...add, ...file.lines.slice(line)];
      tree.now.set(p, writeFileLines({ br: file.br, lines, final: file.final }));
    };
  }
  return null;
}

/** The patch is either one JSON array of edit objects, or JSON Lines: one
 *  edit object a line, blank lines ignored. */
function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Halt('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Halt(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Halt(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEditObject(x);
      if (e === null) throw new Halt(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Halt(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Detecting the format (section 4)
// ---------------------------------------------------------------------------

/** With --format=auto the format is the first of these that holds. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// The command line (sections 1, 2 and 10)
// ---------------------------------------------------------------------------

/** Compare two paths in byte order (UTF-8). */
function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines);
    if (edits.length === 0) throw new Halt('error: parse 1');
  } catch (e) {
    if (e instanceof Halt) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  // One line for each path whose state changed, in byte order of the paths.
  // A move replaces that pair's D and A lines and sorts by its new path.
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const movedAway = new Set<string>();
  const movedTo = new Set<string>();
  // Compose move chains: a file moved twice is one move from its first old
  // path to its last new path.
  const chainTo = new Map<string, string>();
  for (const [from, to] of tree.moves) chainTo.set(from, to);
  const chainFrom = new Map<string, string>();
  for (const [from, to] of tree.moves) chainFrom.set(to, from);
  const starts = tree.moves.map(([from]) => from).filter((from) => !chainFrom.has(from));
  for (const from of starts) {
    let to = chainTo.get(from)!;
    while (chainTo.has(to)) to = chainTo.get(to)!;
    const was = tree.original(from);
    const nowFrom = tree.get(from);
    const wasTo = tree.original(to);
    const nowTo = tree.get(to);
    if (was !== null && nowFrom === null && wasTo === null && nowTo !== null) {
      rows.push({ key: to, line: `R ${from} -> ${to}` });
      movedAway.add(from);
      movedTo.add(to);
    }
  }
  for (const p of tree.now.keys()) {
    if (movedAway.has(p) || movedTo.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteOrder)) {
      const now = tree.now.get(p)!;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
