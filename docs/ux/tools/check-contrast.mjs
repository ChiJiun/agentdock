// Computes WCAG 2.x contrast ratios for the light and dark themes in
// docs/ux/tokens/tokens.css and prints a Markdown table.
// Usage: node docs/ux/tools/check-contrast.mjs [path/to/tokens.css]
// Exit code 1 if any pair is below its required ratio.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = process.argv[2] || fileURLToPath(new URL('../tokens/tokens.css', import.meta.url));
const css = readFileSync(file, 'utf8');

function block(selector) {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const out = {};
  for (const m of css.slice(open, close).matchAll(/--ad-([\w-]+):\s*(#[0-9A-Fa-f]{6})/g)) out[m[1]] = m[2];
  return out;
}
const light = block(':root[data-theme="light"]');
const dark = block(':root[data-theme="dark"]');

const channels = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
const linear = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = hex => { const [r, g, b] = channels(hex).map(linear); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [foreground, background, required ratio]; 4.5 for text, 3 for UI boundaries and focus.
const pairs = [
  ['text-primary', 'bg-surface', 4.5], ['text-primary', 'bg-sunken', 4.5], ['text-primary', 'bg-selected', 4.5], ['text-primary', 'bg-raised', 4.5],
  ['text-secondary', 'bg-surface', 4.5], ['text-secondary', 'bg-sunken', 4.5],
  ['text-tertiary', 'bg-surface', 4.5], ['text-tertiary', 'bg-canvas', 4.5], ['text-tertiary', 'bg-sunken', 4.5], ['text-tertiary', 'bg-hover', 4.5], ['text-tertiary', 'bg-selected', 4.5],
  ['text-secondary', 'bg-raised', 4.5], ['text-tertiary', 'bg-raised', 4.5], ['accent', 'bg-selected', 4.5], ['accent', 'bg-raised', 4.5],
  ['accent', 'bg-surface', 4.5], ['accent', 'bg-sunken', 4.5], ['text-on-accent', 'accent', 4.5],
  ['focus-ring', 'bg-surface', 3], ['focus-ring', 'bg-sunken', 3], ['focus-ring', 'bg-selected', 3],
  ['border-strong', 'bg-surface', 3], ['border-strong', 'bg-canvas', 3], ['border-strong', 'bg-sunken', 3],
  ['status-running', 'bg-surface', 4.5], ['status-running', 'bg-sunken', 4.5], ['status-running', 'status-running-soft', 4.5],
  ['status-attention', 'bg-surface', 4.5], ['status-attention', 'bg-sunken', 4.5], ['status-attention', 'status-attention-soft', 4.5],
  ['status-success', 'bg-surface', 4.5], ['status-success', 'bg-sunken', 4.5], ['status-success', 'status-success-soft', 4.5],
  ['status-danger', 'bg-surface', 4.5], ['status-danger', 'bg-sunken', 4.5], ['status-danger', 'status-danger-soft', 4.5],
  ['status-neutral', 'bg-surface', 4.5], ['status-neutral', 'bg-sunken', 4.5],
  ['kind-local', 'bg-sunken', 4.5], ['kind-background', 'bg-sunken', 4.5], ['kind-remote', 'bg-sunken', 4.5],
  ['kind-background', 'bg-surface', 4.5], ['kind-remote', 'bg-surface', 4.5],
  ['diff-add-fg', 'diff-add-bg', 4.5], ['diff-del-fg', 'diff-del-bg', 4.5], ['text-primary', 'diff-add-bg', 4.5], ['text-primary', 'diff-del-bg', 4.5],
  ['text-on-accent', 'status-attention', 4.5], // "needs reply" badge fill
];

let failures = 0;
console.log('| Foreground | Background | Light | Dark | Required |');
console.log('| --- | --- | --- | --- | --- |');
for (const [fg, bg, req] of pairs) {
  for (const [name, theme] of [['light', light], ['dark', dark]]) {
    if (!theme[fg] || !theme[bg]) throw new Error(`missing token ${fg} or ${bg} in ${name}`);
  }
  const l = ratio(light[fg], light[bg]);
  const d = ratio(dark[fg], dark[bg]);
  const cell = v => (v >= req ? v.toFixed(2) : `**${v.toFixed(2)} FAIL**`);
  if (l < req || d < req) failures++;
  console.log(`| \`${fg}\` | \`${bg}\` | ${cell(l)} | ${cell(d)} | ${req}:1 |`);
}
console.log(`\n${pairs.length} pairs, ${failures} failing.`);
process.exitCode = failures ? 1 : 0;
