// Addressing a channel-tuning screen from an E2E spec. Three specs drive these screens —
// `dyntuning.spec.ts` for GATE / COMP / EQ / DUCKER, `ssmcs.spec.ts` for the morphing bank and
// `insertfx.spec.ts` for the insert effects — and what they share is the plot, which is a
// control rather than only a picture, and the slider rows.

import { expect, type Page } from "@playwright/test";

/** The screen's own box. */
export const screenBox = (page: Page) => page.locator("#dyn-screen-box");

/** The panel's height. Shared across the specs, so two cases asserting that a bank holds
 *  one height cannot end up measuring different boxes and both passing. Read strictly: a
 *  `boundingBox()?.height ?? 0` would compare 0 to 0 — and pass — if the box ever stopped
 *  resolving, which is what these cases exist to catch. */
export const panelHeight = (page: Page) => screenBox(page).evaluate((el) => el.getBoundingClientRect().height);

/** The response plot, where it takes a press. It is one focus stop, so it carries the
 *  arrow keys as well as the click. */
export const pickPlot = (page: Page) => screenBox(page).locator("canvas.gt-pickplot");

/**
 * Select a band by its index in the descriptor's own order.
 *
 * The markers ON the plot are the band control on both EQ screens; there is no bar. The
 * keyboard path is taken rather than a click because a click has to land on a marker, and
 * only the descriptor knows where it drew one — a spec computing that would be a second
 * copy of the layout. `Home` first, so the walk starts from a known band whatever was
 * selected before.
 *
 * The canvas is replaced on every selection (the column rebuilds), but the host puts focus
 * back on the new one carrying the same id, so the presses keep landing.
 */
export const pickBand = async (page: Page, index: number): Promise<void> => {
  await pickPlot(page).focus();
  await page.keyboard.press("Home");
  for (let i = 0; i < index; i++) await page.keyboard.press("ArrowRight");
};

/** One slider row of the open screen, driven over its whole range. */
export interface SweptSliderRow {
  label: string;
  /** How many distinct readings the row printed. */
  readings: number;
  /** Every track width the row showed, one entry per distinct width. */
  tracks: number[];
  /** Each reading wider than the cell it is printed in. */
  overflow: string[];
}

/**
 * Drive every slider row on the open screen through each position it has, one at a time,
 * and report what the track and the readout did at each. The value goes through the row's
 * own `input` event, as a drag delivers it, and each row is put back where it was. A locked
 * row is opened for its sweep and locked again: the unit moves a locked value too, and the
 * question is what the cell does with every reading the row can print.
 */
export const sweepSliderRows = (page: Page): Promise<SweptSliderRow[]> =>
  screenBox(page).evaluate((box) => {
    const rows = () => [...box.querySelectorAll<HTMLElement>(".prefs-row:has(.dev-slider)")];
    const parts = (i: number) => {
      const row = rows()[i];
      return {
        input: row.querySelector<HTMLInputElement>(".dev-slider input[type=range]")!,
        value: row.querySelector<HTMLElement>(".dev-slider .param-val")!,
      };
    };
    const out: SweptSliderRow[] = [];
    for (let i = 0; i < rows().length; i++) {
      const { input } = parts(i);
      const label = rows()[i].querySelector(".lbl")?.textContent ?? "";
      const locked = input.disabled;
      const start = input.value;
      const min = Number(input.min);
      const step = Number(input.step);
      const count = Math.round((Number(input.max) - min) / step);
      const readings = new Set<string>();
      const tracks = new Set<number>();
      const overflow = new Set<string>();
      let p = parts(i);
      // The row is laid out once per reading it has not printed before; the track's length is a
      // function of the text beside it alone.
      const set = (v: string) => {
        if (!p.input.isConnected) p = parts(i);
        p.input.disabled = false;
        p.input.value = v;
        p.input.dispatchEvent(new Event("input", { bubbles: true }));
        const text = p.value.textContent ?? "";
        if (readings.has(text)) return;
        readings.add(text);
        tracks.add(p.input.getBoundingClientRect().width);
        const ink = document.createRange();
        ink.selectNodeContents(p.value);
        if (ink.getBoundingClientRect().width > p.value.getBoundingClientRect().width) overflow.add(text);
      };
      for (let n = 0; n <= count; n++) set(String(min + n * step));
      set(start);
      parts(i).input.disabled = locked;
      out.push({ label, readings: readings.size, tracks: [...tracks], overflow: [...overflow] });
    }
    return out;
  });

/**
 * Sweep the open screen's slider rows and hold each to what a steady track needs: it printed
 * more than one reading — a sweep that moved nothing would hold every other assertion — and
 * none of them wider than its cell. Returns the track widths the rows showed, so a case can
 * hold one width across every screen it opens.
 */
export const steadySliderTracks = async (page: Page, where: string): Promise<number[]> => {
  const rows = await sweepSliderRows(page);
  expect(rows.length, where).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.readings, `${where} ${row.label}`).toBeGreaterThan(1);
    expect(row.overflow, `${where} ${row.label}`).toEqual([]);
  }
  return rows.flatMap((row) => row.tracks);
};
