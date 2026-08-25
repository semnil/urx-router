#!/usr/bin/env node
// The boundary corpus for the PowerShell reader, and the two answers to each case.
//
// PowerShell decides where a comment begins from a token state a lexer cannot fully see: the
// same `]`, digit, `..`, `--` or `[` opens a comment in expression position and continues a
// bareword in argument position, and only the parser knows which one it is in. So the reader
// takes the MISS on every uncertain boundary rather than the invention, and this file is
// where that set is written down: `parser` is what PowerShell's own parser answers, `reader`
// is what the reader answers, and a row where they differ is an accepted miss, countable
// rather than found one review round at a time.
//
// `parser` is regenerated where a pwsh is on the PATH — the GitHub runner carries one:
//
//   UPDATE_PWSH=1 pnpm test check-comment-provenance
//
// Usage: node scripts/pwsh-boundaries.mjs   (prints the cases, one per line)

import { spawnSync } from "node:child_process";
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
  // …and the shapes that are no script at all: PowerShell's parser reports an error for each
  // of these, so what a comment is in one is not a contract anything can be held to. They are
  // here because they LOOK like the rows above, and the `errors` beside them is what says
  // they are not.
  `3 -# ${M}`,
  `2 *# ${M}`,
  `6 /# ${M}`,
  `7 %# ${M}`,
  `1 -eq# ${M}`,
];

/** What PowerShell's own parser calls a comment, subexpressions included. */
export function parserSpans(cases, pwsh = "pwsh") {
  const script = `
    $ErrorActionPreference = 'Stop'
    $all = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $rows = New-Object System.Collections.ArrayList
    function Walk($ts, $into) {
      foreach ($t in $ts) {
        if ($t.Kind -eq [System.Management.Automation.Language.TokenKind]::Comment) {
          [void]$into.Add(@($t.Extent.StartOffset, $t.Extent.EndOffset))
        }
        if ($t -is [System.Management.Automation.Language.StringExpandableToken] -and $t.NestedTokens) {
          Walk $t.NestedTokens $into
        }
      }
    }
    foreach ($src in $all) {
      $tokens = $null; $errs = $null
      [System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$tokens, [ref]$errs) | Out-Null
      $found = New-Object System.Collections.ArrayList
      Walk $tokens $found
      [void]$rows.Add(@{ errors = @($errs).Count; comments = @($found) })
    }
    ConvertTo-Json -InputObject @($rows) -Depth 6 -Compress
  `;
  const run = spawnSync(pwsh, ["-NoProfile", "-Command", script], {
    input: JSON.stringify(cases),
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  if (run.status !== 0) throw new Error(`${pwsh}: ${run.stderr}`);
  return JSON.parse(run.stdout).map((r) => ({
    errors: r.errors,
    comments: (r.comments ?? []).map((c) => [c[0], c[1]]),
  }));
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  for (const c of PWSH_CASES) console.log(JSON.stringify(c));
}
