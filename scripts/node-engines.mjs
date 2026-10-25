// The rule over the Node range package.json's `engines` declares: it is where the `engines` ranges
// of the direct dependencies meet, together with the 21.2 the `?plan=` codec's
// CompressionStream("deflate-raw") needs. A dependency update that narrows its own range fails
// scripts/node-engines.test.mjs on the pull request that brings it.
//
// A range is read as a union of half-open intervals over versions taken as integer triples, so
// two ranges are compared exactly rather than at sample points. The grammar is the part of
// node-semver's the dependencies write — `||`, a space between comparators, `^` `~` `>=` `>` `<=`
// `<` `=` and a bare version of one to three parts, with or without a space after the operator.
// Anything else (a hyphen range, an `x`, a prerelease tag) is refused by name, since a range read
// the wrong way would compare the wrong sets.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** What the `?plan=` codec needs on its own: CompressionStream("deflate-raw"). */
export const CODEC_FLOOR = ">=21.2";

const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
const COMPARATOR = /^(>=|<=|>|<|=|\^|~)?(.+)$/;

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const maxVersion = (a, b) => (compare(a, b) >= 0 ? a : b);
const minHigh = (a, b) => (a === null ? b : b === null ? a : compare(a, b) <= 0 ? a : b);

function parseVersion(text, range) {
  const match = VERSION.exec(text);
  if (!match) throw new Error(`unsupported version "${text}" in Node range "${range}"`);
  const parts = match.slice(1, 4).map((part) => (part === undefined ? null : Number(part)));
  return { parts, given: parts.filter((part) => part !== null).length };
}

// One comparator as the interval [low, high) it admits; high === null is unbounded.
function comparator(token, range) {
  const [, operator = "=", rest] = COMPARATOR.exec(token);
  const { parts, given } = parseVersion(rest, range);
  const [major, minor = 0, patch = 0] = parts.map((part) => part ?? 0);
  const base = [major, minor, patch];
  const next = given === 1 ? [major + 1, 0, 0] : given === 2 ? [major, minor + 1, 0] : [major, minor, patch + 1];
  switch (operator) {
    case ">=":
      return { low: base, high: null };
    case ">":
      return { low: next, high: null };
    case "<":
      return { low: [0, 0, 0], high: base };
    case "<=":
      return { low: [0, 0, 0], high: next };
    case "=":
      return { low: base, high: next };
    case "~":
      return { low: base, high: given === 1 ? [major + 1, 0, 0] : [major, minor + 1, 0] };
    case "^":
      if (major > 0 || given === 1) return { low: base, high: [major + 1, 0, 0] };
      if (minor > 0 || given === 2) return { low: base, high: [0, minor + 1, 0] };
      return { low: base, high: [0, 0, patch + 1] };
  }
  throw new Error(`unsupported comparator "${token}" in Node range "${range}"`);
}

const isEmpty = ({ low, high }) => high !== null && compare(low, high) >= 0;

// Sorted, with overlapping and touching intervals merged, so that equal sets have equal forms.
function normalize(intervals) {
  const sorted = intervals.filter((interval) => !isEmpty(interval)).sort((a, b) => compare(a.low, b.low));
  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && (last.high === null || compare(interval.low, last.high) <= 0)) {
      last.high = last.high === null || interval.high === null ? null : maxVersion(last.high, interval.high);
    } else {
      merged.push({ low: interval.low, high: interval.high });
    }
  }
  return merged;
}

const overlap = (a, b) => ({ low: maxVersion(a.low, b.low), high: minHigh(a.high, b.high) });

/** A node-semver range, in the grammar above, as its normalized list of [low, high) intervals. */
export function parseRange(range) {
  if (typeof range !== "string" || range.trim() === "") throw new Error(`empty Node range ${JSON.stringify(range)}`);
  return normalize(
    range.split("||").map((set) => {
      const tokens = set
        .trim()
        .replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1")
        .split(/\s+/);
      if (tokens.length === 1 && tokens[0] === "") throw new Error(`empty comparator set in Node range "${range}"`);
      return tokens.map((token) => comparator(token, range)).reduce(overlap);
    }),
  );
}

/** The intervals every one of the given interval lists admits. */
export function intersect(lists) {
  return lists.reduce((met, list) => normalize(met.flatMap((a) => list.map((b) => overlap(a, b)))));
}

export const sameSet = (a, b) =>
  a.length === b.length &&
  a.every(
    (interval, index) =>
      compare(interval.low, b[index].low) === 0 &&
      (interval.high === null
        ? b[index].high === null
        : b[index].high !== null && compare(interval.high, b[index].high) === 0),
  );

export const contains = (intervals, version) => {
  const parts = parseVersion(version, version).parts.map((part) => part ?? 0);
  return intervals.some(({ low, high }) => compare(parts, low) >= 0 && (high === null || compare(parts, high) < 0));
};

/** Intervals written back in node-semver's syntax, `^` where an interval is one major. */
export function formatRange(intervals) {
  const dotted = (parts) => parts.join(".");
  return intervals
    .map(({ low, high }) => {
      if (high === null) return `>=${dotted(low)}`;
      if (low[0] > 0 && compare(high, [low[0] + 1, 0, 0]) === 0) return `^${dotted(low)}`;
      return `>=${dotted(low)} <${dotted(high)}`;
    })
    .join(" || ");
}

/**
 * The range package.json declares, and the one it should declare: the intersection of the codec's
 * floor with the `engines.node` of every direct dependency installed under node_modules.
 * Throws when node_modules holds no direct dependency at all, since an intersection over nothing
 * read would agree with anything.
 */
export function readEngines(repo) {
  const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  const declaring = [];
  for (const name of names) {
    const dependency = JSON.parse(readFileSync(join(repo, "node_modules", name, "package.json"), "utf8"));
    if (dependency.engines?.node !== undefined) {
      declaring.push({ name, version: dependency.version, range: dependency.engines.node });
    }
  }
  if (declaring.length === 0) throw new Error("no direct dependency under node_modules declares engines.node");
  const required = intersect([parseRange(CODEC_FLOOR), ...declaring.map((entry) => parseRange(entry.range))]);
  return { declared: manifest.engines?.node, required, declaring };
}
