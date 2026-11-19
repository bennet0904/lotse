/**
 * The colour tokens in styles.css meet WCAG 2.2 AA contrast, in the light and
 * the dark theme. Every pair a component puts text, a control border or the
 * focus ring on is listed here; add new pairs together with new tokens.
 */
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

/** The custom properties of the first block that starts after `marker`. */
function tokens(marker: string): Map<string, string> {
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`${marker} not found in styles.css`);
  const open = css.indexOf("{", css.indexOf(":root", start));
  const close = css.indexOf("}", open);
  const found = new Map<string, string>();
  for (const [, name, value] of css.slice(open + 1, close).matchAll(/(--color-[a-z-]+):\s*([^;]+);/g)) {
    found.set(name as string, (value as string).trim());
  }
  return found;
}

const light = tokens(":root {");
const dark = new Map([...light, ...tokens("@media (prefers-color-scheme: dark)")]);

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Not a six-digit hex colour: ${hex}`);
  const value = Number.parseInt(match[1] as string, 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ["bg", "surface", "sunken"];
const PAIRS: [foreground: string, backgrounds: string[], minimum: number][] = [
  // Body text: 7:1, more than AA asks for.
  ["text", [...SURFACES, "primary-soft", "danger-soft", "ok-soft", "warn-soft"], 7],
  // Secondary text, links and the selected navigation item or tab.
  ["text-muted", [...SURFACES, "primary-soft"], 4.5],
  ["link", [...SURFACES, "danger-soft", "ok-soft", "warn-soft"], 4.5],
  ["primary", ["surface", "primary-soft"], 4.5],
  ["on-primary", ["primary", "primary-hover"], 4.5],
  // Status text in notes, badges and danger buttons.
  ["danger", ["surface", "danger-soft"], 4.5],
  ["ok", ["surface", "ok-soft"], 4.5],
  ["warn", ["surface", "warn-soft"], 4.5],
  // Non-text contrast: control borders and the focus ring.
  ["control", SURFACES, 3],
  ["focus", SURFACES, 3],
];

describe.each([
  ["light", light],
  ["dark", dark],
])("%s theme", (_theme, colors) => {
  const color = (name: string) => {
    const value = colors.get(`--color-${name}`);
    if (!value) throw new Error(`--color-${name} is not defined`);
    return value;
  };
  const cases = PAIRS.flatMap(([fg, bgs, min]) => bgs.map((bg) => [fg, bg, min] as const));

  test.each(cases)("%s on %s reaches %d:1", (fg, bg, min) => {
    expect(contrast(color(fg), color(bg))).toBeGreaterThanOrEqual(min);
  });
});
