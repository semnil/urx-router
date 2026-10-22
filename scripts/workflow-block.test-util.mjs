// Takes a workflow step's `run: |` block out of the YAML, so a pin can execute the block the
// way GitHub does instead of reading the workflow for names.

// The `run: |` block that follows an anchor, dedented. Its end is the first line indented no
// further than the `run:` key itself, which is how a YAML block scalar ends.
export function runBlock(text, anchor) {
  const lines = text.split("\n");
  const from = lines.findIndex((line) => line.includes(anchor));
  if (from < 0) throw new Error(`anchor not found: ${anchor}`);
  const at = lines.findIndex((line, i) => i >= from && /^\s*run: \|\s*$/.test(line));
  if (at < 0) throw new Error(`no \`run: |\` after: ${anchor}`);
  const keyIndent = lines[at].search(/\S/);
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && line.search(/\S/) <= keyIndent) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter((line) => line.trim() !== "").map((line) => line.search(/\S/)));
  return body.map((line) => line.slice(indent)).join("\n") + "\n";
}
