/**
 * Screencasts of the features of xeus-quickjs in JupyterLab.
 *
 * Each test records a video in screencast-results/<name>.mp4:
 *
 *   npx playwright test --config playwright-screencast.config.js -g <name>
 */
import { expect, test } from '@jupyterlab/galata';
import fs from 'fs';
import path from 'path';
import {
  KERNEL_NAME,
  openNotebook,
  preparePage,
  Screencast,
  uploadFile,
  uploadNotebook,
  waitForKernel
} from './utils';

const NOTEBOOKS = path.resolve(__dirname, '..', '..', 'notebooks');

test.use({
  autoGoto: false,
  // The notebooks are opened from their URL, without the launcher
  waitForApplication: async ({}, use) => {
    await use(async page => {
      await page.locator('#jupyterlab-splash').waitFor({ state: 'detached' });
    });
  }
});

test.beforeEach(async ({ page }) => {
  await preparePage(page);
});

test('execution', async ({ page, request }) => {
  const notebook = await uploadNotebook(request, 'execution', [
    '1 + 2 * 3',
    `
const engine = 'QuickJS';
\`Hello from \${engine}!\`
`,
    `
const person = {
  name: 'Ada Lovelace',
  born: 1815,
  languages: ['English', 'French'],
  works: new Map([['Notes', 1843]])
};
person
`,
    `
class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}
new Point(3, 4)
`,
    `
class Point {
  constructor(x, y, z = 0) {
    Object.assign(this, { x, y, z });
  }
}
new Point(1, 2, 3)
`,
    'Array.from({ length: 30 }, (_, i) => i ** 2)',
    "[2n ** 64n, 0.1 + 0.2, Symbol('id'), /^js$/i, new Date(0), new Set([1, 2, 3])]",
    '_.length'
  ]);
  await openNotebook(page, notebook);
  const screencast = new Screencast(page, 'execution');
  await screencast.begin();
  await screencast.runAll([1500, 1500, 2500, 2000, 2500, 2500, 2500, 1500]);
  await screencast.end();
});

test('console', async ({ page, request }) => {
  const notebook = await uploadNotebook(request, 'console', [
    `
console.log('Hello', 'world', { answer: 42 }, [1, 2, 3]);
console.log('%s was born in %d', 'Ada', 1815);
console.warn('This goes to the standard error');
`,
    `
console.group('A group');
console.info('with an indented message');
console.groupEnd();
console.count('clicks');
console.count('clicks');
`,
    `
console.time('loop');
let sum = 0;
for (let i = 0; i < 1e6; i++) {
  sum += i;
}
console.timeEnd('loop');
sum
`,
    `
console.table([
  { language: 'JavaScript', engine: 'QuickJS', year: 2019 },
  { language: 'Lua', engine: 'PUC-Rio Lua', year: 1993 },
  { language: 'Python', engine: 'CPython', year: 1991 }
]);
`,
    `
import * as std from 'std';
std.printf('%s writes %d bytes\\n', 'std.printf', 42);
`
  ]);
  await openNotebook(page, notebook);
  const screencast = new Screencast(page, 'console');
  await screencast.begin();
  await screencast.runAll([2500, 2500, 2500, 3000, 2000]);
  await screencast.end();
});

test('errors', async ({ page, request }) => {
  const notebook = await uploadNotebook(request, 'errors', [
    `
function parse(text) {
  return JSON.parse(text);
}

function loadConfig() {
  return parse('{ "debug": true, }');
}

loadConfig()
`,
    `
const user = null;
user.name
`,
    'const = 1',
    `
setTimeout(() => {
  throw new RangeError('Thrown in a timer');
}, 500);
`,
    `
async function load() {
  throw new Error('A rejected promise');
}
load();
`,
    "throw { code: 404, message: 'Not found' }"
  ]);
  await openNotebook(page, notebook);
  const screencast = new Screencast(page, 'errors');
  await screencast.begin();
  await screencast.runAll([3500, 2500, 2500, 3000, 2500, 2500]);
  await screencast.end();
});

test('async', async ({ page, request }) => {
  const notebook = await uploadNotebook(request, 'async', [
    `
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

console.log('Waiting for 1 second...');
await sleep(1000);
'Done!'
`,
    `
async function fetchUser(id) {
  await sleep(300 * id);
  return { id, name: ['Ada', 'Grace', 'Alan'][id - 1] };
}

console.time('3 users');
const users = await Promise.all([1, 2, 3].map(fetchUser));
console.timeEnd('3 users');
users
`,
    `
let ticks = 0;
const timer = setInterval(() => {
  console.log(\`tick \${++ticks}\`);
  if (ticks === 5) {
    clearInterval(timer);
  }
}, 300);
`,
    `
async function* countdown(from) {
  for (let i = from; i > 0; i--) {
    await sleep(300);
    yield i;
  }
}

for await (const n of countdown(5)) {
  console.log(n);
}
`
  ]);
  await openNotebook(page, notebook);
  const screencast = new Screencast(page, 'async');
  await screencast.begin();
  await screencast.runAll([2000, 2500, 2000, 2500]);
  await screencast.end();
});

test.describe(() => {
  // The tracking of the kernels by galata fails on the empty response of the
  // interrupt requests: disable it.
  test.use({ kernels: null, sessions: null });

  test('interrupt', async ({ page, request }) => {
    const notebook = await uploadNotebook(request, 'interrupt', [
      `
let iterations = 0;
while (true) {
  iterations++;
}
`,
      'iterations.toLocaleString()',
      `
let count = 0;
setInterval(() => {
  count++;
  clearOutput(true);
  console.log(\`\${count} ticks\`);
}, 100);
`
    ]);
    await openNotebook(page, notebook);
    const screencast = new Screencast(page, 'interrupt');
    const stop = page.getByRole('button', { name: 'Interrupt the kernel' });
    await screencast.begin();

    await page.keyboard.press('Shift+Enter');
    await page.waitForTimeout(3000);
    await screencast.pointer.click(stop);
    await expect(screencast.cell(0)).toContainText(
      'InternalError: interrupted'
    );
    await page.waitForTimeout(2500);
    await screencast.select(1);
    await screencast.run(1, 2000);

    await page.keyboard.press('Shift+Enter');
    await page.waitForTimeout(3500);
    await screencast.pointer.click(stop);
    await expect(screencast.cell(2)).toContainText(
      'InternalError: interrupted'
    );
    await screencast.end();

    await page.getByRole('menuitem', { name: 'Kernel' }).click();
    await page.getByRole('menuitem', { name: 'Shut Down Kernel' }).click();
  });
});

test('rich-display', async ({ page, request }) => {
  const notebook = await uploadNotebook(request, 'rich-display', [
    `
display.html('<h3 style="margin: 0">Hello <em>HTML</em></h3>');
display.markdown('**Markdown** with a [link](https://bellard.org/quickjs/)');
display.latex('$$\\\\int_0^1 x^2\\\\,dx = \\\\frac{1}{3}$$');
`,
    `
display.json({ name: 'xeus-quickjs', features: ['completion', 'widgets'], nested: { a: [1, 2, 3] } });
`,
    `
class Color {
  constructor(r, g, b) {
    Object.assign(this, { r, g, b });
  }

  _toHtml() {
    const { r, g, b } = this;
    return \`<div style="width: 80px; height: 40px; border-radius: 6px; background: rgb(\${r}, \${g}, \${b})"></div>\`;
  }
}

new Color(70, 130, 180)
`,
    `
function barChart(data) {
  const max = Math.max(...data.map(d => d.value));
  const bars = data.map((d, i) => {
    const h = (d.value / max) * 140;
    return \`<rect x="\${i * 60 + 10}" y="\${160 - h}" width="44" height="\${h}" fill="#f0a830" rx="3"/>
      <text x="\${i * 60 + 32}" y="178" text-anchor="middle" font-family="sans-serif" font-size="12">\${d.label}</text>\`;
  });
  return display.svg(\`<svg xmlns="http://www.w3.org/2000/svg" width="380" height="185">\${bars.join('')}</svg>\`);
}

barChart([
  { label: 'Mon', value: 12 }, { label: 'Tue', value: 19 }, { label: 'Wed', value: 7 },
  { label: 'Thu', value: 15 }, { label: 'Fri', value: 22 }, { label: 'Sat', value: 9 }
]);
`,
    `
const progressBar = percent => \`<div style="width: 300px; background: #eee; border-radius: 4px">
  <div style="width: \${percent * 3}px; background: #4e79a7; color: white; padding: 2px 6px; border-radius: 4px">\${percent}%</div>
</div>\`;

const progress = display.html(progressBar(0), { id: true });
for (let percent = 5; percent <= 100; percent += 5) {
  await new Promise(resolve => setTimeout(resolve, 120));
  progress.update(progressBar(percent));
}
`
  ]);
  await openNotebook(page, notebook);
  const screencast = new Screencast(page, 'rich-display');
  await screencast.begin();
  await screencast.runAll([3000, 3000, 2000, 3000, 2500]);
  await screencast.end();
});

test('completion', async ({ page, request }) => {
  const notebook = await uploadNotebook(request, 'completion', [
    `
const myFavoriteNumber = 42;
const planets = ['Mercury', 'Venus', 'Earth', 'Mars'];

class Spaceship {
  constructor(name) {
    this.name = name;
    this.speed = 0;
  }

  accelerate(delta) {
    this.speed += delta;
    return this;
  }
}

const ship = new Spaceship('Apollo');
`,
    ''
  ]);
  await openNotebook(page, notebook);
  const screencast = new Screencast(page, 'completion');
  const completer = page.locator('.jp-Completer');
  await screencast.begin();
  await screencast.run(0, 1200);
  await page.keyboard.press('Enter');

  await screencast.type('myFa');
  await page.keyboard.press('Tab');
  await completer.waitFor();
  await page.waitForTimeout(1200);
  await page.keyboard.press('Enter');
  await screencast.type(' + Math.');
  await page.keyboard.press('Tab');
  await completer.waitFor();
  await page.waitForTimeout(2000);
  await screencast.type('ma', 250);
  await page.waitForTimeout(1000);
  await page.keyboard.press('Enter');
  await screencast.type('(1, 2, 3);');

  await page.keyboard.press('Enter');
  await screencast.type('ship.');
  await page.keyboard.press('Tab');
  await completer.waitFor();
  await page.waitForTimeout(2500);
  await screencast.type('ac', 250);
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await screencast.type('(10);');

  await page.keyboard.press('Enter');
  await screencast.type('planets.fi');
  await page.keyboard.press('Tab');
  await completer.waitFor();
  await page.waitForTimeout(1500);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  await screencast.type("(planet => planet.startsWith('M'))");
  await page.waitForTimeout(800);
  await screencast.run(1, 3000);
  await screencast.end(1000);
});

test('inspection', async ({ page, request }) => {
  const notebook = await uploadNotebook(request, 'inspection', [
    `
/**
 * Computes the distance between two points.
 *
 * @param a The first point, like { x: 3, y: 4 }
 * @param b The second point, the origin by default
 */
function distance(a, b = { x: 0, y: 0 }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
`,
    ''
  ]);
  await openNotebook(page, notebook);
  const screencast = new Screencast(page, 'inspection');
  const tooltip = page.locator('.jp-Tooltip');
  // Clicking in the editor closes the tooltip, and keeps the edit mode
  const closeTooltip = async () => {
    await screencast.pointer.click(screencast.cell(1).locator('.cm-content'));
    await page.keyboard.press('End');
    await expect(tooltip).toHaveCount(0);
  };
  await screencast.begin();
  await screencast.run(0, 1000);
  await page.keyboard.press('Enter');

  await screencast.type('distance(');
  await page.keyboard.press('Shift+Tab');
  await tooltip.waitFor({ timeout: 15000 });
  await page.waitForTimeout(4500);
  await closeTooltip();
  await screencast.type('{ x: 3, y: 4 }) + Math.hypot(');
  await page.keyboard.press('Shift+Tab');
  await tooltip.waitFor({ timeout: 15000 });
  await page.waitForTimeout(3500);
  await closeTooltip();
  await screencast.type('1, 1)');
  await page.waitForTimeout(500);
  await screencast.run(1, 1500);

  // The contextual help follows the cursor
  await screencast.pointer.click(page.getByRole('menuitem', { name: 'Help' }));
  await screencast.pointer.click(
    page.getByRole('menuitem', { name: 'Show Contextual Help' })
  );
  const inspector = page.locator('.jp-Inspector');
  await inspector.waitFor();
  await page.waitForTimeout(800);
  await screencast.pointer.click(screencast.cell(2).locator('.cm-content'));
  await screencast.type('const data = JSON.parse');
  await expect(inspector).toContainText('JSON/parse');
  await page.waitForTimeout(2500);
  await screencast.type("('[1, 2, 3]');");
  await page.keyboard.press('Enter');
  await screencast.type('distance');
  await expect(inspector).toContainText('Computes the distance');
  await page.waitForTimeout(3500);
  await screencast.end(500);
});

test('input', async ({ page, request }) => {
  const notebook = await uploadNotebook(request, 'input', [
    `
const name = prompt('What is your name?');
\`Nice to meet you, \${name}!\`
`,
    `
const secret = prompt.password('Choose a password:');
\`Your password has \${secret.length} characters\`
`
  ]);
  await openNotebook(page, notebook);
  const screencast = new Screencast(page, 'input');
  await screencast.begin();

  for (const [index, answer] of [
    [0, 'Ada'],
    [1, 'correct horse battery staple']
  ] as const) {
    await page.keyboard.press('Shift+Enter');
    const input = screencast.cell(index).locator('.jp-Stdin-input');
    await input.waitFor();
    await page.waitForTimeout(800);
    await screencast.pointer.click(input);
    await screencast.type(answer, 90);
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await expect(screencast.cell(index).locator('.jp-InputPrompt')).toHaveText(
      /\[\d+\]:/
    );
    await page.waitForTimeout(2000);
    if (index === 0) {
      await screencast.select(1);
    }
  }
  await screencast.end();
});

test('modules', async ({ page, request }) => {
  await uploadFile(
    request,
    'modules/geometry.mjs',
    fs.readFileSync(path.join(NOTEBOOKS, 'modules', 'geometry.mjs'), 'utf-8')
  );
  await uploadFile(
    request,
    'modules/planets.json',
    fs.readFileSync(path.join(NOTEBOOKS, 'modules', 'planets.json'), 'utf-8')
  );
  const notebook = await uploadNotebook(request, 'modules', [
    `
import { area, Circle } from './modules/geometry.mjs';

[area({ width: 3, height: 4 }), new Circle(2).area()]
`,
    `
import planets from './modules/planets.json' with { type: 'json' };

console.table(planets);
`,
    `
import * as std from 'std';
import * as os from 'os';

const file = std.open('notes.txt', 'w');
file.puts('Written by QuickJS\\n');
file.close();
std.loadFile('notes.txt')
`,
    `
const [files] = os.readdir('.');
files.filter(name => !name.startsWith('.')).sort()
`
  ]);
  await openNotebook(page, notebook, { sidebar: true });
  await page.sidebar.setWidth(260);
  const screencast = new Screencast(page, 'modules');
  await screencast.begin();
  await screencast.runAll([2500, 3000, 3000, 3000]);
  await screencast.end();
});

test('widgets', async ({ page, request }) => {
  const notebook = await uploadNotebook(request, 'widgets', [
    `
const { FloatSlider, IntSlider, Button, Output, HTML, IntProgress, Play, HBox, VBox, jslink } = Jupyter.widgets;
`,
    `
const celsius = new FloatSlider({ value: 20, min: -40, max: 100, description: '°C' });
const fahrenheit = new HTML();
const convert = () => {
  fahrenheit.value = \`<b>\${(celsius.value * 9 / 5 + 32).toFixed(1)} °F</b>\`;
};
celsius.observe(convert, 'value');
convert();

new HBox({ children: [celsius, fahrenheit] })
`,
    `
const button = new Button({ description: 'Roll the dice', button_style: 'primary', icon: 'dice' });
const output = new Output();
button.onClick(output.capture(() => {
  console.log(\`Rolled a \${1 + Math.floor(Math.random() * 6)}\`);
}));

new VBox({ children: [button, output] })
`,
    `
const bar = new IntProgress({ value: 0, max: 100, description: 'Loading' });
display(bar);
for (let value = 0; value <= 100; value += 4) {
  bar.value = value;
  await new Promise(resolve => setTimeout(resolve, 80));
}
bar.bar_style = 'success';
`,
    `
const play = new Play({ max: 100, interval: 40 });
const linked = new IntSlider({ description: 'Linked' });
jslink([play, 'value'], [linked, 'value']);

new HBox({ children: [play, linked] })
`
  ]);
  await openNotebook(page, notebook);
  const screencast = new Screencast(page, 'widgets');
  await screencast.begin();
  await screencast.runAll([800, 1500]);

  const handle = screencast.cell(1).locator('.noUi-handle');
  await screencast.pointer.drag(handle, { x: 90, y: 0 });
  await page.waitForTimeout(800);
  await screencast.pointer.drag(handle, { x: -150, y: 0 });
  await page.waitForTimeout(1200);

  await screencast.select(2);
  await screencast.run(2, 1000);
  const dice = screencast
    .cell(2)
    .getByRole('button', { name: 'Roll the dice' });
  for (let i = 0; i < 3; i++) {
    await screencast.pointer.click(dice);
    await page.waitForTimeout(900);
  }

  await screencast.select(3);
  await screencast.run(3, 1500);
  await screencast.run(4, 1000);
  await screencast.pointer.click(
    screencast.cell(4).locator('.widget-play button').first()
  );
  await page.waitForTimeout(4500);
  await screencast.end(1000);
});

test('mandelbrot', async ({ page, request }) => {
  const source = JSON.parse(
    fs.readFileSync(path.join(NOTEBOOKS, 'mandelbrot.ipynb'), 'utf-8')
  );
  const cells = source.cells
    .filter((cell: any) => cell.cell_type === 'code')
    .map((cell: any, index: number) => ({
      source: Array.isArray(cell.source) ? cell.source.join('') : cell.source,
      // Hide the PNG encoder
      hidden: index === 0
    }));
  const notebook = await uploadNotebook(request, 'mandelbrot', cells);
  await openNotebook(page, notebook);
  const screencast = new Screencast(page, 'mandelbrot');
  await screencast.begin();
  await screencast.runAll([500, 2500, 1500]);

  // Zoom on the Seahorse Valley, then add some details
  const sliders = screencast.cell(2).locator('.widget-slider');
  const dragTo = async (index: number, fraction: number) => {
    const slider = sliders.nth(index);
    const track = await slider.locator('.noUi-target').boundingBox();
    const handle = await slider.locator('.noUi-handle').boundingBox();
    const x =
      track!.x + track!.width * fraction - (handle!.x + handle!.width / 2);
    await screencast.pointer.drag(slider.locator('.noUi-handle'), { x, y: 0 });
    await page.waitForTimeout(2500);
  };
  // x from -2 to 1, y from -1.2 to 1.2, zoom from 2^0 to 2^10, iterations from 20 to 300
  await dragTo(0, (-0.745 + 2) / 3);
  await dragTo(1, (0.11 + 1.2) / 2.4);
  await dragTo(2, 0.45);
  await dragTo(3, (220 - 20) / 280);
  await screencast.end(1500);
});

test('code-console', async ({ page }) => {
  await page.goto();
  const card = page.locator('.jp-LauncherCard[data-category="Console"]', {
    hasText: KERNEL_NAME
  });
  await card.waitFor();
  const screencast = new Screencast(page, 'code-console');
  await screencast.begin({ selectFirstCell: false });

  await screencast.pointer.click(card);
  await page.locator('.jp-CodeConsole').waitFor();
  await waitForKernel(page);
  await page.waitForTimeout(800);

  // Run the code with Enter, when it is complete
  await screencast.pointer.click(
    page.getByRole('menuitem', { name: 'Settings' })
  );
  await screencast.pointer.moveTo(
    page.locator('.lm-Menu-item', { hasText: 'Console Run Keystroke' })
  );
  await page.waitForTimeout(500);
  await screencast.pointer.click(
    page
      .locator('.lm-Menu-item')
      .filter({ has: page.getByText('Execute with Enter', { exact: true }) })
  );
  await page.waitForTimeout(600);
  await screencast.pointer.click(
    page.locator('.jp-CodeConsole-promptCell .cm-content')
  );

  // Enter adds a new line while the code is incomplete
  const lines = async (...code: string[]) => {
    for (const line of code) {
      await screencast.type(line);
      await page.waitForTimeout(400);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
    }
  };
  await lines('function greet(name) {', 'return `Hello, ${name}!`;', '}');
  await page.waitForTimeout(1000);
  await lines("greet('QuickJS')");
  await page.waitForTimeout(1200);
  await lines(
    'const fruits = new Map([',
    "['apples', 3],",
    "['pears', 5]",
    ']);'
  );
  await page.waitForTimeout(800);
  await lines('fruits');
  await expect(page.locator('.jp-CodeConsole')).toContainText("'apples' => 3");
  await page.waitForTimeout(800);
  await lines('[...fruits.values()].reduce((a, b) => a + b)');
  await expect(page.locator('.jp-CodeConsole')).toContainText('8');
  await screencast.end();
});
