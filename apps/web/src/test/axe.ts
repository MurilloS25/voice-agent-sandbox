import axe from "axe-core";
import { expect } from "vitest";

/**
 * Runs axe-core on a rendered container. jsdom has no layout engine, so the checks that need
 * one (colour contrast) are off; the palette's contrast is documented in globals.css.
 */
export async function expectNoA11yViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: {
      "color-contrast": { enabled: false },
      region: { enabled: false },
    },
  });
  expect(
    results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`),
  ).toEqual([]);
}
