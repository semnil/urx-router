// Drift guard for the urx-routing-planner skill's bundled routing data. The
// skill ships a standalone copy of scripts/models.json and references/model-*.md
// so it runs without this repo; if a device-model change lands without
// regenerating those, plans validate against stale rules. This test fails in CI
// the moment they diverge.
//
// To regenerate after an intentional model change:
//   UPDATE_SKILL=1 pnpm test skill-export
// then commit the updated skill files alongside the model change.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FX_CHANNEL_NODE_INDEX } from "../core/control/fx-effect";
import { MODEL_IDS, getModel } from "./index";
import { renderModelMarkdown, skillModelsJson } from "./skill-export";

const SKILL_DIR = resolve(__dirname, "../../.claude/skills/urx-routing-planner");
const MODELS_JSON = resolve(SKILL_DIR, "scripts/models.json");
const modelMd = (id: string): string => resolve(SKILL_DIR, `references/model-${id.toLowerCase()}.md`);

const UPDATE = process.env.UPDATE_SKILL === "1";

function check(path: string, expected: string, label: string): void {
  if (UPDATE) {
    writeFileSync(path, expected);
    return;
  }
  const actual = readFileSync(path, "utf-8");
  expect(actual, `${label} is stale — run \`UPDATE_SKILL=1 pnpm test skill-export\` and commit`).toBe(expected);
}

describe("urx-routing-planner skill data stays in sync with the device model", () => {
  it("scripts/models.json matches MODELS", () => {
    check(MODELS_JSON, skillModelsJson(), "scripts/models.json");
  });

  for (const id of MODEL_IDS) {
    it(`references/model-${id.toLowerCase()}.md matches ${id}`, () => {
      check(modelMd(id), renderModelMarkdown(getModel(id)), `references/model-${id.toLowerCase()}.md`);
    });
  }

  // The drift guard above compares the committed file against the generator, so what it
  // cannot see is the generator itself getting narrower and the file being regenerated in the
  // same change: both sides move together and the diff is clean. Every entry keyed by node is
  // exposed that way, so each is asked against the index it is derived FROM rather than
  // against a list written here, which would be the same copy twice.
  it("carries every FX channel, not a subset the generator happened to emit", () => {
    const models = JSON.parse(skillModelsJson());
    for (const id of MODEL_IDS) {
      expect(Object.keys(models[id].fxChannels).sort(), `${id} fxChannels`).toEqual(
        Object.keys(FX_CHANNEL_NODE_INDEX).sort(),
      );
      // …and each entry is populated, since a channel present with an empty menu answers no
      // question the validator asks it and would pass the key comparison above.
      for (const [nodeId, fx] of Object.entries(models[id].fxChannels)) {
        expect((fx as { types: number[] }).types.length, `${id} ${nodeId} types`).toBeGreaterThan(0);
        expect(Object.keys((fx as { params: object }).params).length, `${id} ${nodeId} params`).toBeGreaterThan(0);
      }
    }
  });

  // The drift guard above is a pure equality check, so the renderers must be
  // deterministic: rendering the same model twice (the same process, back to back)
  // has to yield byte-identical output. This catches a stray Set/Object iteration
  // order or Date/Math.random creeping into the export before it flaps CI.
  it("renders identical output on repeated calls (no nondeterminism)", () => {
    expect(skillModelsJson()).toBe(skillModelsJson());
    for (const id of MODEL_IDS) {
      expect(renderModelMarkdown(getModel(id))).toBe(renderModelMarkdown(getModel(id)));
    }
  });
});
