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
  // GitHub evaluates a `${{ … }}` BEFORE the shell runs, so the template is not what
  // PowerShell is given. Each of these is what the substitution has to leave parseable, and
  // the last two are what it has to keep OUT of the answer and IN the reported text.
  `Write-Output "\${{ github.ref }}"`,
  `Write-Output \${{ github.ref }}`,
  `$x = \${{ inputs.count }}`,
  `if (\${{ inputs.enabled }}) { Write-Output ok }`,
  `Write-Output \${{ github.ref }} # ${M}`,
  `Write-Output "\${{ format('a # ${M}') }}"`,
  `Write-Output x # ${M} \${{ github.ref }}`,
  `Write-Output \${{ format('}}') }} # ${M}`,
];

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  for (const c of PWSH_CASES) console.log(JSON.stringify(c));
}
