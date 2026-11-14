# Repository checks

> 日本語版: [../ja/repository-checks.md](../ja/repository-checks.md)

What the repository's checks and test tiers hold, and why each is shaped the way it is. The
commands, and the rules a change has to follow, are in `AGENTS.md` "Development" and "Conventions";
this document holds the explanation behind them. Read the section for a check before changing the
check, its pins or its hook.

## `pnpm test` and coverage

`pnpm test` runs vitest over:

- core: routing/constraints/plan/levels/meters/midi
- control: vd/translate/readback/live/follow/fx/insert-fx/firmware etc.
- models
- ui: console/graph/inspector/dyn-*/midi/prefs/dom/fine/history/keys/licenses etc.
- the app entry: main.boot + main.flows in a browser and main.device against a stubbed Tauri shell
  (isTauri() gates half of main.ts, so without that shell it is unreachable rather than untested)
- the contract and pin tests `AGENTS.md` "Reusable assets" lists.

`include` also covers `*.test.mjs` under `scripts/`, which is the tooling's own pins and stays out
of the coverage set.

`pnpm test:coverage` is the same unit suite with V8 coverage for the frontend TypeScript sources,
minus the two message catalogs (why: `vitest.config.ts`, and the same exclusion in
`.github/codecov.yml` + `e2e/coverage-options.ts`); it writes `coverage/lcov.info` for Codecov.

## E2E tiers

- `pnpm typecheck:e2e` (`tsc -p tsconfig.e2e.json`) type-checks `e2e/` + the root config `.ts`
  (playwright/vite/vitest); the src build's tsconfig only includes `"src"`.
- `pnpm test:e2e:app` (`--project=chromium`) runs `e2e/*.spec.ts` only
  (routing/hide/notes/insertfx/midi etc.). The PR tier, in `ci.yml`.
- `pnpm test:e2e:app:webkit` (`--project=app-webkit`) runs the @webkit-tagged app cases in WebKit
  (the engine the macOS build renders in). Its own job in `ci.yml`. The set is one class — a
  constrained window still holds its layout — because that is what the two engines do not implement
  alike; `playwright.config.ts` states what belongs in it, and `scripts/webkit-tier.test.mjs` holds
  the floor, since a case leaves the project by losing a tag.
- `pnpm test:e2e:race:webkit` (`--project=race-webkit`) runs the @webkit-tagged race cases in WebKit
  (the engine the macOS build renders in).

How the `race` project is split into shards, why no `--` goes before `--shard`, and why a bare
`--shard=k/3` is not CI's shard k, are in [live-race-harness.md](live-race-harness.md)
"Implementation and running".

## `pnpm format`

`pnpm format` runs Prettier `--write` on a file list DERIVED from what `check:comments` scans, so
the formatter cannot end up narrower than the checker (`scripts/format.mjs`; config = `package.json`
"prettier", `printWidth` 120).

**`pnpm format` has no file list of its own.** `scripts/format.mjs` takes one from
`check:comments`'s scan set and keeps what Prettier parses — `.ts` / `.mjs` / `.cjs` / `.js` /
`.css` / `.html`.

The JavaScript half is the load-bearing part: the provenance check's one false positive is
unreachable in formatted text, and that argument is only as wide as the formatter's reach, so the
two lists are one list. What it formats is the INVENTORY, not the scan set — this checker excludes
its own two files from what it reads, and that exclusion has no business deciding what Prettier
sees. YAML is deliberately left out although Prettier parses it — the false positive is a JavaScript
shape, and reformatting the workflow and action YAML would be the formatting-only diff the global
rules forbid (`AGENTS.md` "Conventions").

**Measure before quoting a conformance claim**: away from this tree Prettier defaults to
`printWidth` 80 and calls `src/style.css` and `index.html` non-conforming, so a check run outside
the repository's own config answers a different question.

An UNTRACKED file is in the derived list as soon as it is written, unless an ignore rule covers it —
the list is what git reports (`--others --exclude-standard` as well as the index), so a new file is
formatted and checked before it is ever added.

## `pnpm check:comments`

`pnpm check:comments` checks that no source comment records where a fact CAME FROM rather than what
the code does — a `(measured)` appositive, a sentence naming the method, a capture date.

The word itself is not the target (`the level meters are measured` describes the data); the shapes
are, and the set is deliberately narrow because a rule wide enough to catch every phrasing teaches
rewording instead. It lexes comments rather than grepping lines, so `Object.entries(measured)` is an
identifier and not a finding, a comment inside a template interpolation is still a comment, and a
JavaScript file is read ONCE, by the lexical goal — never also under a forced division or a forced
pattern. A forced reading has no grammar, so where it differs from the goal what it produces is a
recovery or an invention with nothing to tell the two apart, and it refuses valid, Prettier-stable
files (`[/\//, "…"]`, `[/[//]/, "…"]`, `[a / "x///y", "…"]`). The goal lets a pattern follow
`export default` and `break`, leaves a value behind a postfix `!`, and walks a modifier run from the
keyword itself. The trade is a miss class this reading can have for a false-positive class it
cannot, and a defect here is a grammar bug with one correct answer.

**`pnpm format` takes its JavaScript file list from this scan** (`scripts/format.mjs`), so neither
can be narrowed alone.

It also reads **YAML, TOML, shell, Python and HTML**, each with its own reader rather than a shared
`#` scan: a YAML block scalar's body and a quoted scalar that spans lines are text, TOML's `"""…"""`
spans lines and its `#` needs no space in front of it while YAML's does, a here-document's body is
text while the rest of its DECLARATION line is code, and a `$( … )` inside a double quote is code
again.

One scalar is not data: a workflow's **`run:`** holds shell — block, QUOTED or an alias to either,
since GitHub runs the value rather than the way it was written, and a FLOW mapping puts several
entries on one line — and its body goes to the shell reader with its offsets carried over. What
makes a value that scalar is the PATH to it rather than the NAME of its key: GitHub runs
`jobs.<id>.steps[].run` and a composite action's `runs.steps[].run`, and nothing else, so the reader
carries the block keys open above each line — with the column each one starts at, since a key is
unwound by anything written at its column or to the left of it, and with the keys a flow collection
was opened under, since `steps: [{ run: "…" }]` puts a step on the line its own `steps` is on. Taken
from the name alone, an `env:` variable, a `with:` input and anything nested under either would be
lexed against a grammar they are not written in.

The VALUE: for a block, dedented and — where the header is `>` rather than `|` — FOLDED, since that
is the whole difference between the two; since a here-document's `EOF` never equals an indented
delimiter line; escapes decoded and line breaks folded the way YAML folds them for a quoted one —
one break becomes a space, n become n-1 newlines, and a `\` in front of the first escapes it, so an
escaped break carries a comment past it and a blank line ends one there — with `\n`, `\r\n` and `\r`
all breaks, or a CRLF file's escaped break is read as an escaped carriage return and then a fold;
and only under `.github/workflows` or `.github/actions`, since nothing else in this tree runs one.

**What lexes it is the shell the step CHOSE** — `bash`/`sh`, `pwsh`, `cmd` or `python`, with
`powershell` (Windows PowerShell, which GitHub runs on Windows alone) REFUSED by name rather than
read, resolved from the step's own `shell:`, then its job's `defaults.run.shell`, then the
workflow's, then the runner's own (bash everywhere but Windows) — since a step's `shell:` may be
written after its `run:` and a job's `runs-on` after its steps, the values are queued and lexed once
the document is read.

PowerShell's block comment does NOT nest — the first `#>` ends it and what follows is code — its `#`
begins a comment only where a TOKEN may begin, and its strings are not the shell's: `'…'` doubles
the quote, `"…"` escapes with a BACKTICK, a here-string runs to a line beginning `"@`, and the
expandable forms are not opaque, since a `$( … )` in either is a statement list. cmd has `rem`
opening a line, behind an `@` or not, and a `::` label, and no `#` at all. A shell not in that set
is a custom command line, a COMPOSITE action's run step that declares none has no default to fall
back on, and a runner named by an expression takes the non-Windows default, since the two defaults
agree about `#` and neither is cmd — each of those is left unread rather than lexed against a
grammar it was not written in.

Shell's own three: a backtick substitution is code even inside a double quote, a case PATTERN's `)`
has no opener and closes nothing, and `case` is a keyword only where a command could start — a
position WHITESPACE carries rather than ends, and one that a reserved word opening a compound list,
a `!`, and `time`'s own options (`time -p case …`) all carry on the same line — `time`'s only, since
a `-word` transparent everywhere makes the next word a keyword and the `)` that closed a
substitution read as a pattern's, and only until the next boundary, since `time` measures ONE
command. The command position, that option state and the open `case` runs all belong to the
substitution FRAME they were read in, or an inner `;` leaves the outer position open and the `)`
that closes the substitution is read as a pattern's.

A `[` or a `{` written against a key opens a flow collection as much as one standing on its own, or
that entry reads at flow depth zero and its value runs to the end of the line — and only where a
node may BEGIN, since block context lets a plain scalar hold either character (`echo a[0`) and taken
as an opener one of those would leave a collection open for every line after it. A flow collection
is ONE node however many lines it is written across, so the scope it opens and the key still waiting
inside it are carried across the line break, the lines inside it open no block key and unwind none,
and what carries a key to its value there is the ORDER rather than the indentation. Read as though
every line began outside one, an action's `with:` input would read at the path of a step's `run` and
a `run:` whose value sits on the next line at no path at all.

A quoted mapping key is the same key, escapes decoded: `"run": |` is the block GitHub runs, an
anchor or a tag may sit between the key and its value, quoted or block — and where the key's line
ends after that, the value is the next node indented further, in any of its three spellings, with
the anchor in front of the key belonging to it. What such a header's indentation indicator counts
from is then the KEY's column, on the line above, and what the block ends at is that column too,
since a header written on its own line may sit at its body's own indentation.

A PLAIN scalar is that value too — `run: echo ok` is the shell GitHub runs, the same as the other
spellings; YAML ends a plain scalar at a ` #`, so what survives into the value is a `#` behind a
`;`, which is where a shell comment begins, and the scalar runs to the end of the line in block
context, to the `,`, `]` or `}` that closes the entry inside a flow collection, and across the lines
it continues onto in EITHER — one break folding to a space and a blank line to a newline, with what
a flow continuation must be indented past being the block node the flow was opened on rather than
the column of a key written inside it. Nothing a line BEGINS with ends a scalar already started:
`- b`, `-b` and `?b` are the words they look like, and so is `x:y`, since a mapping key's colon has
to be followed by whitespace or by the end of the line and one that is not is part of the key.

An ALIAS is that value — `run: *script` is the shell its anchor holds, with the name ended by `,`,
`]` or `}` where a flow mapping ends it rather than by the line, and the finding points at the line
the text is on, counted ONCE however many aliases read it, and an EXPLICIT entry writes the key on
its own line (`? run`) with the `: |` that carries its value on the next — across the blank and
comment-only lines that are not nodes, and at the key's own column, where the ordinary spelling
takes a deeper one, so a SIBLING sequence entry is not mistaken for a value the key never had. A
sequence entry may be written with nothing after its dash, and unwound at the dash's own column an
INDENTATIONLESS sequence — whose dash sits at the column of the key that owns it — unwound that key
and put its entries at the path of the mapping above.

TOML closes a multi-line string on the LAST three quotes of a run, not the first. Python's f-string
replacement field is code since PEP 701, comments included, while its format spec is text again — a
`#` there is a fill character, and a `!s` conversion ends the expression rather than opening the
spec. PEP 750's template strings carry the same fields, so a `t` prefix is read like an `f`.

Whether a `/` opens a pattern or divides is carried as a lexical GOAL — the last token plus a stack
per bracket kind — because the preceding character cannot decide it (the same state answers the
TypeScript type positions, where a generic constraint puts a brace at the signature's own depth — a
keyword list rather than a type grammar, so a brace inside a type it does not name can still be read
as a block; what settles the known case is that a brace right after `=>` is never a declaration's
body). A type ARGUMENT list closes on a value — after anything that ends one, an index and a call
included — so `f<string> / 2` divides while `a < b > /re/` compares and then matches; one grammar
cannot separate those, and what does in formatted text is the space BEFORE any trivia, since
Prettier writes every comparison spaced (`a /* c */ < b`) and every type argument list tight against
its name (`f/* c */ <string>`).

A DECLARATION's type parameters close on its BODY instead, or `class C<T> {}` leaves an object
literal behind and the pattern on the next line is read as a division into it — with the modifier
run walked past first, since `abstract` and `declare` are part of it, and the DECORATORS in front of
it too. A run is two phases — reading its own expression, then waiting for its target — because
`@sealed` ends on a name, `@a.b` on a dotted one and `@dec(…)` on a `)`, and what decides the
declaration is the token recorded when the run opened. Its ARGUMENTS are out of that, by a bracket
depth that counts type arguments as well — a `{` in one is an object literal, a `class` in one is an
expression, and `@dec<string>()` puts a run between the name and the call, and a member's own
decorator ends at the member rather than at whatever class expression its initialiser holds. Inside
a type there is no comparison for a `<` to be, so a nested generic signature opens whatever sits in
front of it, and the `;` that ends an unclosed run is the one at the run's own bracket depth rather
than the one separating a type literal's properties: `)` ends a value after a call and starts an
expression after `if (…)`, `}` ends one after an object literal and starts one after a block, and
`+` is an operator in `a + /re/` and half of a postfix `++` in `x++ / 2`.

It reads **Rust too**, where block comments NEST, a raw string carries any number of hashes, and a
leading `'` is a lifetime far more often than a character literal (consumed as a quote it runs to
the next apostrophe and takes every comment between).

**The scan set is what git reports** (`ls-files --cached --others --exclude-standard`), not a list
of directories: **a source the scan never opens is a source it does not check**, however well it
lexes, and a list of roots answers which directories were thought of rather than what the repository
carries. A file written but not yet added is in scope; what the ignore rules cover never is. Asking
git also fails LOUDLY when it cannot answer, rather than walking what it can reach.

The two files this check does not read are excluded by their PATH: matched by NAME, a file called
the same thing under any other directory would be exempt from a check it is source for like any
other. **The inventory and the scan set are separate**: `pnpm format` takes the first and this check
the second, and folding the self-exclusion into the inventory would make the formatter skip this
checker and its own pins. `.tsx` is deliberately out of scope: JSX text is neither code nor a
comment, a URL in it opens a line comment at the `//`, and this tree carries no JSX to write that
state machine against. Importing the module runs none of the command line — every pin imports it,
and an import that ran it would scan the tree with vitest's argv.

**`scripts/comment-provenance-baseline.json` is a per-file CEILING**, not a target of zero: the tree
already carries the idiom, and removing it in one sweep would be a comment-only diff across a large
part of the tree. A file may carry what it carried and no more, so a NEW one is red while the
backlog stays countable; a cleaned file prints its lower count in the ledger's own shape, so
lowering the ceiling is a paste. **`--update` only ever LOWERS** — taking the counts as found would
let a run add a comment, be refused, update, and come back green with the violation inside; a rule
change that legitimately grows the corpus is `--reseed`, a separate decision that shows in the diff
as one.

**The edit-time hook asks the same ceiling** — refusing on any finding at all would refuse every
edit to each of the files the ledger names — keyed from the checkout the edited file belongs to, so
a file in a worktree nested inside this checkout is held to that worktree's own ledger — with this
checker and its pins excluded by their path within that worktree, as they are within this checkout —
and a file in a different repository checked out inside it to none; and a run given explicit paths
compares only those, since a row it never opened is not a row that emptied; a partial `--update`
merges rather than rewriting the file from the subset it read.

## `pnpm check:pr-assumptions`

`pnpm check:pr-assumptions` checks the pull request body's assumptions field, held to what it is
for: each item must name the external thing its observation needs (`[hardware]` / `[operator]` /
`[other-checkout]`), since an observation needing none of the three is one to take before opening
the pull request rather than one to declare — the body is outside the repository and stops being
visible the moment it merges, so a deferral written there is followed by nothing.

A tagged item also needs an entry under it saying how it was settled — a `Result` entry, or a
`Left open by the operator` entry quoting the instruction to open the pull request with it open —
since a tag describes a deferral rather than ending one. It reads `PR_BODY` (or `--file <path>`,
which is how it is run by hand) and REFUSES a run given neither, since a command that prints a
verdict having read no body is one a contributor takes for an answer about the body they are about
to write — an empty body is a different state, and claims nothing.

It asks what someone WROTE — the items under the field, and an answer a colon separates from the
label — never the tick beside them, which is independent of both: read as the question, the tick
would hide every item under a box nobody ticked, which is exactly the body someone leaves who writes
the answer and forgets the box. "none" is the answer the template offers, an untouched template
lists nothing, a body carrying no such field at all is not its business, and whether a tag is TRUE
is a judgement the same way the message catalog's dev/fixed/tr markers are — this asks that one was
made.

It runs in `docs.yml` on pull requests only, where a push has no body to read — and that workflow
subscribes to the edited event for it, since a body changes with no commit behind it.

**A pull request body follows `.github/PULL_REQUEST_TEMPLATE.md`.** The template states its own
rules in HTML comments; what it cannot say about itself, and what `AGENTS.md` "Conventions" says
instead, is: `gh pr create --body` and `--body-file` **replace** the template rather than prefill
it, so reproduce the sections yourself when opening a PR that way; tick a box only for something
that actually ran, and keep the unticked ones with a short reason beside them; and name the model
and System firmware on the hardware-verification line.

**The assumptions field is answered, never used to defer**: each item opens with the external thing
its observation needs (`[hardware]` / `[operator]` / `[other-checkout]`), and an observation needing
none of the three is one to take before opening the pull request — it has no tag to write, so
leaving it there is a false statement rather than a silence. A tagged item is settled with the
operator before the pull request is opened as well, unless the operator explicitly instructed
opening it with the item open, and its result is written under the item as a `Result` entry, which
`pnpm check:pr-assumptions` requires. `pnpm check:pr-assumptions` refuses an untagged item and
`docs.yml` runs it on every pull request, on the body as it stands rather than as it was opened —
and ticking the box is not what makes the field read: what is written under it is.

## `pnpm check:gates`

`pnpm check:gates` checks that every context `.github/required-checks.json` names is still
reportable on EVERY pull request, and every workflow step that fetches from a host outside GitHub
carries its own `timeout-minutes`, and the Codecov uploads are made from one job after every report
exists, one per report, with `.github/codecov.yml`'s `codecov.notify.after_n_builds` equal to their
number, and a required context Codecov reports has those uploads on every pull request and a status
`.github/codecov.yml` leaves on; `--ruleset` also diffs that list against the live branch ruleset
(needs an admin `gh`; no CI token can read it).

## The edit-time hooks

A note pasted between rows of a Markdown table ends it; **restate the header + separator row** to
resume the table.

`scripts/check-md-tables.mjs` catches it (`pnpm check:md`, `docs.yml`, and a `PostToolUse` hook —
`.claude/settings.json` is tracked so the hook reaches every clone; `scripts/md-hook.sh` runs
`check-assets-index.mjs --hook` behind the same trigger, so an asset row broken by an AGENTS.md edit
— or a file reference broken by a `docs/{en,ja}` edit — is reported at the edit and not in CI; for
an edit to a file inside the private notes' checkout, the same hook also runs that checkout's own
ledger anchor check — located in the main checkout through git, so a worktree with no such checkout
of its own still reaches it — which is how an edit to one of its ledgers made from this checkout is
held to the ledger's contract).

## The displayed-item inventory

**Every dialog, window, menu and popover shows everything its messages say it does, and that stays
at 100%.** `e2e/inventory.spec.ts` derives the expected set from the message catalog and drives each
surface through its states, so **adding a message obliges some surface to display it** — there is no
way to add one and have nothing check it.

Four escapes exist and each has to be *written down* in that file: another surface shows it
(`elsewhere`, naming that surface); the app never shows it here and the run asserts it stays absent
(`neverShown`); the app deliberately shows it only in a tooltip or other label attribute
(`viaAttribute` — a hover-revealed explanation is **not** a display, which is why the default is
text-only); or it is composed into a larger run (`composed`). **`OUT_OF_SCOPE` is the countable
statement of what a green run does not prove**, and it grows under the exclusion-list rule in the
global rules (`AGENTS.md` "Conventions").

The guard answers **presence, not layout**: a collapsed or clipped element whose text still renders
passes, and that question belongs to `ui-capture`.

## What no check covers: the skill's hand-written half

The skill is `.claude/skills/urx-routing-planner/`; `SKILL.md`, `references/` and `scripts/` below
are its own. The rules for keeping it in step with the app are in `AGENTS.md` "Conventions".

**The skill's hand-written half goes stale in silence, and one of its four files is held.**
`SKILL.md`, `references/plan-schema.md` and `references/device-apply.md` have no test and no lint
and sit outside `pnpm format`; the Markdown is table-checked by `pnpm check:md`, and
`plan_tool.py`'s comments are read by `pnpm check:comments` — neither of which knows anything about
the contract they describe — so the app changes and they keep answering confidently with the old
contract.

`.claude/skills/urx-routing-planner/scripts/plan_tool.py` is the exception: `pnpm test plan-tool`
runs it and the app's own loader over the same documents and fails when they disagree about whether
a document survives a load, which is the tool's whole claim. That covers what the bundled data can
answer; the prose files still carry everything it cannot.

Update them inside the same change as any of these **six**:

- (1) **the plan document's shape** — a field added to `serialize` / `deserializeDocument`, e.g. the
  scene-scoped `scope:"scene"` that drops `sampleRate` and the out-of-scene state, which makes a
  pasted plan read as "no monitor source" — and, for a document of version 5 or earlier, as "no
  output patch";
- (2) **a new `NodeParams` key**, e.g. an output bus master's `pan`;
- (3) **a claim about a parameter's stability** — an insert-FX / FX selector write is
  **irreversible**, it refills the engine array with the type's defaults
  (`control/insert-fx-effect.ts`'s header is canonical);
- (4) **the load-time gates `plan_tool.py` mirrors** — `deserializeDocument`'s format/version check,
  the app's model check, and the **silent-drop** rules (unknown kind, invalid params, non-finite
  leaf, one bad array element dropping the whole collection); a dropped wire is out of scope for the
  routing check rather than a hard problem;
- (5) **the write UX** — the Device-menu confirms (firmware mismatch, the rate three-way) and the
  Preferences device scope, since *Scene only* writes no monitor source and no microSD record
  assign, and a plan centred on one then never reaches the unit;
- (6) **"available in a future release" wording**, which becomes a lie at the next ship.

**Semantic constraints that never appear in the route table (signal-flow ordering = pre/post-fader,
duckers) cannot be generated at all**, so those hand-written feasibility notes are their only
carrier — example: channel → USB/SD direct outs tap at the Rec Point = pre-fader/pre-ducker.

**The skill is also published as a marketplace plugin, and both of its manifests are versioned by
hand.** `.claude-plugin/marketplace.json` and
`.claude/skills/urx-routing-planner/.claude-plugin/plugin.json` each pin `version`. **Nothing reads
either file** — `skill-export.test.ts` diffs the generated half, `pnpm check:assets` reads the
documents and the asset table, and no workflow greps them — so an installed copy is never told an
update exists.

Bump both in the same change that alters `SKILL.md`, `references/` or `scripts/`.
