# Decisions: languages of the UI and the documents

> 日本語版: [../../ja/decisions/localization-and-documents.md](../../ja/decisions/localization-and-documents.md)

Closed decisions about which language a string or a document is written in. The rules themselves
are in `CLAUDE.md` "Conventions" and in [architecture.md](../architecture.md) "Localization (i18n)";
this document holds what was decided around them and what was turned down.

## Cross-links keep two forms

**Decision (2026-10-20).** Each document points at its counterpart in the other language on its
first lines, and the wording of that pointer stays in the two forms already in use. The root
documents use the README form (`> 日本語版は […] を参照してください.` and
`> For the English version, see […].`). The documents under `docs/` use the short form
(`> 日本語版: […]` and `> English version: […]`).

**Turned down.** Rewriting the twelve documents under `docs/` to the README form.

## English as the base language: what was rewritten and what stays

**Decision (2026-10-20).** English is the base language of the repository
([#699](https://github.com/semnil/urx-router/pull/699)). Text that already existed was brought in
line as follows.

- Of the forty existing pull requests that contained Japanese, seven were rewritten (#92,
  #144, #248, #553, #665, #676, #697). The Japanese in the other thirty-three is data and stays as
  written: UI strings that are the subject of the change, headings of Japanese documents, run logs,
  test inputs, and quoted remarks that already carry an English translation.
- A rewritten body keeps the Japanese term and adds the English in parentheses. A Japanese word
  used as ordinary prose inside an English sentence was replaced with the English word.
- One line of the v0.9.0 release notes was matched to the new title of #92.
- The comments in `src/i18n/ja.ts` were rewritten in English
  ([#700](https://github.com/semnil/urx-router/pull/700)).

**Kept bilingual.** `.github/ISSUE_TEMPLATE/config.yml`, the text of the issue chooser, stays in
English and Japanese side by side.

## Rows from the unit's own screens

**Decision (2026-08-13).** Every row under `midi.param` in `src/i18n/en.ts` stays `dev()`, in the
unit's own spelling — thirty-four rows on the day it was decided. `PAN/BAL`, `C.INT`, `GAIN` and
`PRE` among them are the words of this app's own chips, and they stay in that group all the same.

**Why.** The MIDI window lists what the unit lets a controller be assigned to. Rows spelled the
way the unit spells them are easier to read against the unit than rows spelled the way the rest of
the app spells them. `scopedParam.gain`, where the same parameter is translated on a tuning screen,
stays as the one earlier exception.

**Also settled that day.** No FX or insert-FX parameter row is shown in Japanese on the unit, so
the `dev()` declaration of those rows holds. How a row is established as the unit's is in
architecture.md "Localization (i18n)" → Terminology.

**The marks are not complete.** The titles of the two effect screens (`FX Effect`, `Insert Effect`)
and the FX strip's `Mix` are still declared `dev()`, and `Mix` is known not to be on the unit. A row
name can be off as well: one reverb row was spelled differently from the unit until the operator read
it off the LCD (it is `E/R Delay`). A row name in the catalog is a lead to start from. The spelling
that goes on a screen is checked on the unit.

## Surfaces left in English

**Decision (2026-11-12).** Seven surfaces show English whatever the app language is, and they are
recorded here as limitations that are not being fixed.

| Surface | Where | Why it is English |
| --- | --- | --- |
| The body of a generated report (write, compare, self-test) | `src/core/control/` | A diagnostic: a stable code carries more than a translated sentence (architecture.md "Error codes") |
| The label of the view switch for assistive technology (`View`) | `index.html` | Left as it is |
| The spoken value of a level fader (`off (-∞)`, and `PRE, ` in front of a pre-fader send) | `src/ui/console.ts` | Left as it is |
| The status line of a `--prepare-modified` launch | `src/main.ts` | Left as it is |
| The three Pitch Fix MIDI Control modes (`Off`, `Setting`, `Real Time`) | `src/ui/insert-fx-screen.ts` | The words on the unit's own screen |
| The buttons of a confirm dialog on macOS (`OK`, `Cancel`) | the dialog library | The library writes them in English on macOS; on Windows they are the system's buttons and follow the OS language |
| The predefined items of the macOS menu bar | the menu library | The library writes them in English; Windows has no menu bar |

No reason is on record for the three marked "Left as it is"; they are known and were left.

## The audio send is written send

**Decision.** In Japanese text — source comments, UI strings and documents — the audio send is
written `send`, not with the Japanese noun 「送り」 (for example 「OFF send を隠す」). Where "send"
is used as a verb, the Japanese text writes 「Send できる」 and does not translate the verb.

**Not covered.** 「縦送り」 in the sense of a line feed in a layout is a different word and stays.
An existing capitalised `Send` may stay; the two spellings may coexist.

**History.** The rule was applied to source comments and UI strings first. The decision to state
it here and to bring the Japanese documents under it was made on 2026-11-12.

## The README's acknowledgement stays

**Decision (2026-11-12, the operator).** The README's "Acknowledgments" section stays as it is. It
credits, by GitHub handle and link, the author of the pull request that verified the URX22's meter
mapping on hardware. It is the credit for a contribution, so the practice these documents follow
elsewhere — an outside person is named by role — is not applied to it.

## The README's comparison paragraph and store links stay

**Decision (2026-11-12, the operator).** Two more parts of `README.md` and `README.ja.md` stay as
they are, as the description of the product:

- the paragraph near the top that says where URX Router stands beside the other software for the
  URX series — the manufacturer's mixer editor, the official Stream Deck plugin, and the DAW
  integration screens;
- the links to the two store pages that carry the installers beside the GitHub releases page.

These documents otherwise leave comparisons with other products and store pages out. The README is
where a reader finds out what the app is for and where to get it, so both stay there.

**How the comparison is worded.** It states what each of the other tools covers and does not call
URX Router the only tool of its kind: a claim of that shape can stop being true with time, and
"fills this gap" does not depend on it.
