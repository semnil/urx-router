#!/usr/bin/env node
// The boundary corpus for the PowerShell reader, and the two answers to each case.
//
// PowerShell decides where a comment begins from a token state a lexer cannot fully see: the
// same `]`, digit, `..`, `--` or `[` opens a comment in expression position and continues a
// bareword in argument position, and only the parser knows which one it is in. Approximated
// with a set of preceding characters, the reader read valid workflows both ways — refusing
// lines PowerShell calls code, and passing comments PowerShell calls comments — so it asks
// the parser instead. `parser` is what PowerShell's own parser answers and `reader` is what
// the reader answers; on a script that parses they are the SAME answer, and the pin requires
// it rather than requiring one to contain the other.
//
// The reader ASKS that parser rather than approximating it, so on a valid script the two
// answers are the same one and the file is a regression fixture over the corpus and over the
// parser's own version. Regenerated where a pwsh is on the PATH — the GitHub runner carries
// one:
//
//   UPDATE_PWSH=1 pnpm test check-comment-provenance
//
// Usage: node scripts/pwsh-boundaries.mjs   (prints the cases, one per line)

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const M = "MARK";
/** Every case: a script, and the words the two readings are asked to place. */
export const PWSH_CASES = [
  // Where a token cannot be in progress, so a comment is certain.
  `# ${M}`,
  `Write-Output x # ${M}`,
  `Write-Output x\n# ${M}`,
  `Write-Output 1;# ${M}`,
  `Write-Output (1)# ${M}`,
  `Write-Output @(1)# ${M}`,
  `if (1) {}# ${M}`,
  `Write-Output @{}# ${M}`,
  `Write-Output 1&# ${M}`,
  `Write-Output "ok"# ${M}`,
  `Write-Output 'ok'# ${M}`,
  `Write-Output @"\nx\n"@# ${M}`,
  `Write-Output 1; <# b #># ${M}`,
  // A block comment, which does NOT nest and opens only where a token may begin.
  `<# ${M} #>`,
  `<# <# note #> Write-Output "${M}" #>`,
  `Foo<# ${M} #>`,
  // Strings, including the quote characters that are not the ASCII pair.
  `Write-Output "$( "x" # ${M}\n)"`,
  `Write-Output @"\n$( "x" # ${M}\n)\n"@`,
  `Write-Output @"\n# ${M}\n"@`,
  `Write-Output @'\n# ${M}\n'@`,
  `Write-Output @'\n$( "x" # ${M}\n)\n'@`,
  `Write-Output '# ${M}'`,
  `“x # ${M}”`,
  `‘x # ${M}’`,
  `Write-Output “a”# ${M}`,
  // The backtick, which escapes rather than substitutes.
  `Write-Output (1)\`# ${M}`,
  `Write-Output "a\`" # ${M}"`,
  `Write-Output \`" # ${M}`,
  // Where a token MAY be in progress: PowerShell answers from a mode this cannot see, so the
  // reader takes the miss. Each of these is a row where `parser` and `reader` differ.
  `Write-Output a#${M}`,
  `Write-Output a]# ${M}`,
  `Write-Output a[# ${M}`,
  `Write-Output 1# ${M}`,
  `Write-Output x1# ${M}`,
  `Write-Output a..b# ${M}`,
  `Write-Output a--b# ${M}`,
  `Write-Output -Name# ${M}`,
  `$x[0]# ${M}`,
  `[int]# ${M}`,
  `1# ${M}`,
  `$x--# ${M}`,
  `$x++# ${M}`,
  `1..3# ${M}`,
  `$a = 1 + 2# ${M}`,
  `$x -is [int]# ${M}`,
  `$x# ${M}`,
  // …the same boundaries as complete scripts, with the operand on the line below. These are
  // valid PowerShell — they run, and they print 1, 1, 3, 2 and True — so what a comment is in
  // one IS a contract, and the reader answers exactly what the parser answers.
  `Write-Output (3 -# ${M}\n2)`,
  `Write-Output (1 -eq# ${M}\n1)`,
  `Write-Output (6 /# ${M}\n2)`,
  `Write-Output (4 *# ${M}\n0.5)`,
  `Write-Output (7 %# ${M}\n2)`,
  `$x = 1\n$x# ${M}`,
];

/**
 * The cases whose value is a workflow TEMPLATE rather than a script.
 *
 * GitHub evaluates a `${{ … }}` BEFORE the shell runs, so what the shell is handed is not what
 * the file says. Where the expression's body is a string literal the value is known exactly
 * and the case is read as expanded — the rules included, since a phrase the expansion
 * completes is not a phrase in the source. Where the body is anything else the value is not in
 * the file, and a phrase the file wrote at or after such an expression is one the expansion
 * decides: it can open a comment, close one, close a quote, end a here-document or add a line.
 * Those are `REFUSED`.
 *
 * A row is the shell the step chose, the value as the file has it, and the comments the check
 * reads in it — or `REFUSED`. They live here rather than in the corpus above because the
 * corpus is asked of `Parser::ParseInput` directly, and a template is a value PowerShell does
 * not parse. `H` is a phrase the rules refuse, so a row says what the check does with the
 * value and not only how it lexed it.
 */
const H = "measured by device";
export const REFUSED = "refused";
export const TEMPLATE_CASES = [
  // A literal body has one value and that value is written in the file, so the case is read as
  // the shell will really get it. Each of these was a MISS while the expansion was stood in
  // for by a word and by nothing: neither of those two is a quote.
  ["pwsh", `Write-Output "\${{ 'main' }}#release"`, []],
  ["pwsh", `Write-Output "\${{ 'main' }}# ${H}"`, []],
  ["pwsh", `Write-Output "\${{ 'a''b' }}# ${H}"`, []],
  ["bash", `echo \${{ '' }}# ${H}`, [` ${H}`]],
  ["bash", `echo "\${{ '" ' }}# ${H}"`, [` ${H}"`]],
  ["pwsh", `Write-Output "\${{ '" ' }}# ${H}"`, [` ${H}"`]],
  ["python", `print("\${{ '" ) ' }}# ${H}")`, [` ${H}")`]],
  ["cmd", `\${{ 'rem ' }}${H} the words`, [` ${H} the words`]],
  // …including the two ends of a block comment, where an expansion CLOSES one and the words
  // after it are code rather than the comment they read as in the file.
  ["pwsh", `<# note \${{ '#>' }} ${H} #>`, [" note ", ">"]],
  // …a line break, which puts what follows it at the start of a line.
  ["bash", `echo ok\${{ '\n# ${H}' }}`, [` ${H}`]],
  // …and a here-document's delimiter, which ends the body and makes the rest code again.
  ["bash", `cat <<EOF\n\${{ 'EOF' }}\n# ${H}\nEOF`, [` ${H}`]],
  // The expansion is the OPENER and the words are the file's, which is what asking about the
  // openers a file wrote could not see.
  ["bash", `\${{ '# measured ' }}by device`, [" measured by device"]],
  ["cmd", `\${{ 'rem measured ' }}by device`, [" measured by device"]],
  // …and the phrase itself is written ACROSS one, which is what reading the rules against the
  // source rather than against the expansion could not see.
  ["bash", `echo # meas\${{ 'ured by dev' }}ice`, [" measured by device"]],

  // A body that is not a literal has no value here. Where no phrase the FILE wrote sits at or
  // after it, the reading stands: a comment made of the expansion's own characters is not this
  // repository's.
  ["pwsh", `Write-Output "\${{ github.ref }}"`, []],
  ["pwsh", `Write-Output \${{ github.ref }}`, []],
  ["pwsh", `$x = \${{ inputs.count }}`, []],
  ["pwsh", `if (\${{ inputs.enabled }}) { Write-Output ok }`, []],
  ["pwsh", `Write-Output "\${{ format('a # ${H}') }}"`, []],
  ["bash", `echo \${{ inputs.x }} plain words`, []],
  // …including cmd's, which asked about the openers was refused for the `rem` inside a word.
  ["cmd", `echo \${{ inputs.x }} premium result`, []],
  // …and a phrase in front of one is a phrase the file wrote, however many follow it.
  ["pwsh", `Write-Output x # ${H} \${{ github.ref }}`, [` ${H} \${{ github.ref }}`]],
  ["bash", `echo ok # ${H} \${{ github.ref }}`, [` ${H} \${{ github.ref }}`]],
  ["python", `print('ok')#${H} \${{ github.ref }}`, [`${H} \${{ github.ref }}`]],
  ["cmd", `rem ${H} \${{ github.ref }}`, [` ${H} \${{ github.ref }}`]],
  ["bash", `echo # ${H} \${{ a.b }} and \${{ c.d }} more`, [` ${H} \${{ a.b }} and \${{ c.d }} more`]],

  // …and where a phrase sits at or after one, the answer belongs to the expansion. The
  // expansion OPENS the comment here, and the words after it are the file's.
  ["bash", `\${{ inputs.prefix }}${H}`, REFUSED],
  ["python", `\${{ inputs.prefix }}${H}`, REFUSED],
  ["pwsh", `\${{ inputs.prefix }}${H}`, REFUSED],
  ["cmd", `\${{ inputs.prefix }}${H}`, REFUSED],
  // …it ENDS one here, and the words after it are code.
  ["bash", `echo x # \${{ inputs.x }} ${H}`, REFUSED],
  ["python", `print(1) # \${{ inputs.x }} ${H}`, REFUSED],
  ["pwsh", `Write-Output x # \${{ inputs.x }} ${H}`, REFUSED],
  ["cmd", `rem \${{ inputs.x }} ${H}`, REFUSED],
  // …and here it decides whether the phrase is one at all.
  ["bash", `echo # meas\${{ inputs.x }}ured by device`, REFUSED],
  // …and a value carrying SEVERAL of them is decided by the first, not by the last.
  ["bash", `echo \${{ a.b }} x \${{ c.d }} ${H}`, REFUSED],
  // …the ordinary shape, where the file writes the comment and the expansion the value.
  ["pwsh", `Write-Output \${{ github.ref }} # ${H}`, REFUSED],
  ["pwsh", `Write-Output \${{ github.ref }}# ${H}`, REFUSED],
  ["pwsh", `Write-Output \${{ github.ref }}<# ${H} #>`, REFUSED],
  ["pwsh", `Write-Output \${{ format('}}') }} # ${H}`, REFUSED],
  ["bash", `echo \${{ github.ref }} # ${H}`, REFUSED],
  ["bash", `echo "\${{ github.ref }} # ${H}"`, REFUSED],
  ["python", `print("\${{ inputs.x }}")#${H}`, REFUSED],
  // …and an expression that never closes is no template at all.
  ["pwsh", `Write-Output \${{ github.ref`, REFUSED],
];
