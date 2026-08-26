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
 * GitHub evaluates a `${{ … }}` BEFORE the shell runs, so what the shell is handed is not
 * what the file says — and what it IS cannot be known here. Each of these is therefore read
 * twice, once where every expression stands for a word and once where every one of them
 * stands for nothing, and the two readings are compared where a comment BEGINS. A row is the
 * shell the step chose, the value as the file has it, and the words the check finds in it —
 * or `REFUSED`, where the two readings disagree and there is no answer to give.
 *
 * They live here rather than in the corpus above because the corpus is asked of
 * `Parser::ParseInput` directly, and a template is a value PowerShell does not parse.
 */
export const REFUSED = "refused";
export const TEMPLATE_CASES = [
  // Expressions in the ordinary places, none of which is a comment.
  ["pwsh", `Write-Output "\${{ github.ref }}"`, []],
  ["pwsh", `Write-Output \${{ github.ref }}`, []],
  ["pwsh", `$x = \${{ inputs.count }}`, []],
  ["pwsh", `if (\${{ inputs.enabled }}) { Write-Output ok }`, []],
  // A hash INSIDE a string is not a comment however the expression expands, which asked of a
  // hash's neighbours alone was a valid workflow this refused.
  ["pwsh", `Write-Output "\${{ 'main' }}#release"`, []],
  ["pwsh", `Write-Output "\${{ 'main' }}# ${M}"`, []],
  ["bash", `echo "\${{ github.ref }} # ${M}"`, []],
  ["bash", `echo "\${{ github.ref }}#${M}"`, []],
  // …and a hash inside the EXPRESSION is not this repository's comment either.
  ["pwsh", `Write-Output "\${{ format('a # ${M}') }}"`, []],
  // A comment beside one is read, and what it reports is the file's own text.
  ["pwsh", `Write-Output \${{ github.ref }} # ${M}`, [` ${M}`]],
  ["pwsh", `Write-Output \${{ format('}}') }} # ${M}`, [` ${M}`]],
  ["bash", `echo \${{ github.ref }} # ${M}`, [` ${M}`]],
  ["pwsh", `Write-Output x # ${M} \${{ github.ref }}`, [` ${M} \${{ github.ref }}`]],
  ["bash", `echo ok # ${M} \${{ github.ref }}`, [` ${M} \${{ github.ref }}`]],
  ["python", `print('ok')#${M} \${{ github.ref }}`, [`${M} \${{ github.ref }}`]],
  ["cmd", `rem ${M} \${{ github.ref }}`, [` ${M} \${{ github.ref }}`]],
  // Where the expansion is what DECIDES: an empty one puts a comment where a word leaves
  // none, and either way round the answer belongs to the expansion and not to the file.
  ["bash", `echo \${{ '' }}# ${M}`, REFUSED],
  ["pwsh", `Write-Output \${{ github.ref }}# ${M}`, REFUSED],
  ["pwsh", `Write-Output \${{ github.ref }}<# ${M} #>`, REFUSED],
  // …and an expression that never closes is no template at all.
  ["pwsh", `Write-Output \${{ github.ref`, REFUSED],
];

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  for (const c of PWSH_CASES) console.log(JSON.stringify(c));
}
