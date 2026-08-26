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
 * and the case is read as expanded; where it is anything else the value is not in the file,
 * and anything the file writes after such an expression that could open a comment makes the
 * case `REFUSED` — an expansion can close a quote, end a here-document, add a line or open a
 * comment of its own.
 *
 * A row is the shell the step chose, the value as the file has it, and the words the check
 * finds in it — or `REFUSED`. They live here rather than in the corpus above because the
 * corpus is asked of `Parser::ParseInput` directly, and a template is a value PowerShell does
 * not parse.
 */
export const REFUSED = "refused";
export const TEMPLATE_CASES = [
  // A literal body has one value and that value is written in the file, so the case is read as
  // the shell will really get it. Each of these was a MISS while the expansion was stood in
  // for by a word and by nothing: neither of those two is a quote.
  ["pwsh", `Write-Output "\${{ 'main' }}#release"`, []],
  ["pwsh", `Write-Output "\${{ 'main' }}# ${M}"`, []],
  ["pwsh", `Write-Output "\${{ 'a''b' }}# ${M}"`, []],
  ["bash", `echo \${{ '' }}# ${M}`, [` ${M}`]],
  ["bash", `echo "\${{ '" ' }}# ${M}"`, [` ${M}"`]],
  ["pwsh", `Write-Output "\${{ '" ' }}# ${M}"`, [` ${M}"`]],
  ["python", `print("\${{ '" ) ' }}# ${M}")`, [` ${M}")`]],
  ["cmd", `\${{ 'rem ' }}${M} the words`, [`\${{ 'rem ' }}${M} the words`]],
  // …including the two ends of a block comment, where an expansion CLOSES one and the words
  // after it are code rather than the comment they read as in the file.
  ["pwsh", `<# note \${{ '#>' }} ${M} #>`, [" note ", ">"]],
  // …a line break, which puts what follows it at the start of a line.
  ["bash", `echo ok\${{ '\n# ${M}' }}`, [`\${{ '\n# ${M}' }}`]],
  // …and a here-document's delimiter, which ends the body and makes the rest code again.
  ["bash", `cat <<EOF\n\${{ 'EOF' }}\n# ${M}\nEOF`, [` ${M}`]],

  // A body that is not a literal has no value here. Where nothing the FILE wrote after it
  // could open a comment, the reading stands: a comment made of the expansion's own
  // characters is not this repository's.
  ["pwsh", `Write-Output "\${{ github.ref }}"`, []],
  ["pwsh", `Write-Output \${{ github.ref }}`, []],
  ["pwsh", `$x = \${{ inputs.count }}`, []],
  ["pwsh", `if (\${{ inputs.enabled }}) { Write-Output ok }`, []],
  ["pwsh", `Write-Output "\${{ format('a # ${M}') }}"`, []],
  ["pwsh", `Write-Output x # ${M} \${{ github.ref }}`, [` ${M} \${{ github.ref }}`]],
  ["bash", `echo ok # ${M} \${{ github.ref }}`, [` ${M} \${{ github.ref }}`]],
  ["python", `print('ok')#${M} \${{ github.ref }}`, [`${M} \${{ github.ref }}`]],
  ["cmd", `rem ${M} \${{ github.ref }}`, [` ${M} \${{ github.ref }}`]],

  // …and where something did, the answer belongs to the expansion and not to the file.
  ["pwsh", `Write-Output \${{ github.ref }} # ${M}`, REFUSED],
  ["pwsh", `Write-Output \${{ github.ref }}# ${M}`, REFUSED],
  ["pwsh", `Write-Output \${{ github.ref }}<# ${M} #>`, REFUSED],
  ["pwsh", `Write-Output \${{ format('}}') }} # ${M}`, REFUSED],
  ["bash", `echo \${{ github.ref }} # ${M}`, REFUSED],
  ["bash", `echo "\${{ github.ref }} # ${M}"`, REFUSED],
  ["python", `print("\${{ inputs.x }}")#${M}`, REFUSED],
  ["cmd", `echo \${{ github.ref }} rem ${M}`, REFUSED],
  // …and an expression that never closes is no template at all.
  ["pwsh", `Write-Output \${{ github.ref`, REFUSED],
];
