---
title: Usage
---

Start JupyterLab, and create a notebook or a console with the **JavaScript (QuickJS)** kernel. The example notebooks of the `notebooks` folder show all the features below.

## Code execution

The value of the last expression of a cell is displayed, formatted like in the Node.js REPL. End the cell with a semicolon to hide it. The last value is also stored in `_`.

```javascript
const person = { name: 'Ada', languages: ['English', 'French'], works: new Map([['Notes', 1843]]) };
person
```

The variables, functions and classes are shared between the cells. A cell can be executed again: its `let`, `const` and `class` declarations replace the previous ones, instead of raising a `SyntaxError`.

:::{note} How cells are executed
The kernel parses the cells with [acorn](https://github.com/acornjs/acorn) and turns their top-level `let`, `const` and `class` declarations into `var` declarations, and their `import` statements into dynamic imports. The cells are then evaluated as global scripts with top-level await by QuickJS. The line numbers of the cells are kept, for the tracebacks.
:::

## Console and output streams

The `console` methods print on the standard output (`log`, `info`, `debug`) and the standard error (`warn`, `error`) of the cells, and support the format specifiers like `%s` and `%d`. `console.table` displays a table, `console.group`, `console.count`, `console.time` and `console.assert` work like in Node.js, and `console.clear` clears the outputs.

What QuickJS itself writes on the standard output, for instance with `std.printf` or `print`, is shown in the notebook too.

```javascript
console.table([
  { language: 'JavaScript', engine: 'QuickJS' },
  { language: 'Lua', engine: 'PUC-Rio Lua' }
]);
```

## Errors

An error shows the line of code which raised it, and the stack of the calls, with the cells named `In[<execution count>]`. Errors in timers and unhandled promise rejections are reported in the cell which created them, and stop its timers like an uncaught error stops a script.

## Asynchronous code

`await` can be used at the top level of the cells. `setTimeout`, `setInterval`, `setImmediate` and `queueMicrotask` are available. A cell runs until its code is done, its promises are settled and its timers have fired: the outputs of the timers are shown in the cell which created them.

```javascript
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
await sleep(1000);
'Done!'
```

A cell waiting for a promise which can never be resolved fails with an `UnsettledTopLevelAwait` error.

## Interrupting the kernel

Interrupt the kernel, with the stop button of the toolbar or `I`, `I` in command mode, to stop an endless loop or a timer which never stops. The cell fails with an `InternalError: interrupted` error showing where the code was running, and the variables keep their values.

## Rich display

`display` shows a value with its richest representation, and helpers show other kinds of content. They accept a string, or can be used as tagged templates, which keep backslashes like `String.raw`:

```javascript
display.html('<b>Hello</b>');
display.markdown`# Title`;
display.latex`$$\int_0^1 x^2\,dx = \frac{1}{3}$$`;
display.svg('<svg>...</svg>');
display.json({ a: [1, 2, 3] });
display.png(bytes);              // a Uint8Array or an ArrayBuffer
display.image('chart.png');      // an image file
```

Objects can define methods returning their representation, used when they are the result of a cell or displayed: `_toHtml`, `_toMarkdown`, `_toSvg`, `_toPng`, `_toJpeg`, `_toLatex` and `_toJson`, `_toMime` returning a MIME bundle, or a `[Symbol.for('Jupyter.display')]` method (like with Deno).

```javascript
class Color {
  constructor(r, g, b) { Object.assign(this, { r, g, b }); }
  _toHtml() { return `<div style="width: 50px; height: 50px; background: rgb(${this.r}, ${this.g}, ${this.b})"></div>`; }
}
new Color(70, 130, 180)
```

With an `id`, `display` returns a handle to update the output later:

```javascript
const progress = display.html('<b>0%</b>', { id: true });
progress.update('<b>100%</b>');
```

`clearOutput()` clears the outputs of the cell, `clearOutput(true)` waits for the next output to do it.

## Code completion and inspection

Press `Tab` to complete the names of the variables and keywords, and the properties of the objects, with their kind (function, class, instance, property). The own properties of an object come first, then the ones of its class and of its prototypes. The calls are never evaluated for the completion.

Press `Shift+Tab`, or open the contextual help, to inspect the value under the cursor. The inspection shows the signature of the functions, their documentation from their JSDoc comment, their source, and a link to the MDN documentation for the built-in objects.

```javascript
/**
 * Computes the distance between two points.
 */
function distance(a, b = { x: 0, y: 0 }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
```

## User input

`prompt(message, defaultValue)` asks for a value in the frontend, and `prompt.password(message)` asks for a hidden value.

```javascript
const name = prompt('What is your name?');
```

## Modules

The cells can import ES modules with the `import` statement or the `import()` function. The paths of the modules are relative to the directory of the notebook. JSON files can be imported with an import attribute.

```javascript
import { area } from './geometry.mjs';
import planets from './planets.json' with { type: 'json' };
```

The [`std` and `os` modules](https://bellard.org/quickjs/quickjs.html#Standard-library) of QuickJS give access to the files, the environment variables and the operating system:

```javascript
import * as std from 'std';
import * as os from 'os';

std.loadFile('notes.txt')
```

The relative paths start from the directory of the notebook. In JupyterLite, the files are the ones of the file browser. The [files](../notebooks/files.ipynb) notebook shows how to read and write text, JSON, CSV and binary files, and how to work with directories.

## Widgets

The [Jupyter widgets](https://ipywidgets.readthedocs.io) are available in `Jupyter.widgets`, with an API close to the one of ipywidgets and the same as the JupyterLite JavaScript kernel. The frontend needs `jupyterlab_widgets`, like for ipywidgets.

```javascript
const { IntSlider, HTML, HBox } = Jupyter.widgets;

const slider = new IntSlider({ value: 5, max: 10, description: 'Value' });
const square = new HTML();
slider.observe(({ new: value }) => {
  square.value = `<b>${value ** 2}</b>`;
}, 'value');

new HBox({ children: [slider, square] })
```

See the [reference](reference.md#widgets) for the list of widgets.

## Code consoles

In a code console, `Shift+Enter` runs the code when it is complete, and adds a new line otherwise, for instance after the first line of a function.
