---
title: xeus-quickjs
---

`xeus-quickjs` is a [Jupyter](https://jupyter.org) kernel for JavaScript, based on [QuickJS](https://bellard.org/quickjs/), the small and embeddable JavaScript engine by Fabrice Bellard, and on [xeus](https://github.com/jupyter-xeus/xeus), the native implementation of the Jupyter protocol.

QuickJS supports the latest ECMAScript features, like modules, async generators, BigInt and top-level await. The kernel is a single native executable, with no dependency on Node.js or a web browser, and it also runs in the browser with [JupyterLite](installation.md#in-jupyterlite), compiled to WebAssembly.

## Features

- **Code execution**: the value of the last expression of a cell is displayed like in the Node.js REPL, cells can be executed again, and `await` works at the top level.
- **Output streams**: `console.log` and the other `console` methods, including `console.table`, and the output of the `std` module of QuickJS.
- **Errors** with the line of code that raised them and the stack of the calls.
- **Asynchronous code**: promises, timers, async generators. A cell runs until its timers have fired.
- **Rich display**: HTML, Markdown, LaTeX, SVG, images and JSON with `display`, and objects with their own rich representation.
- **Code completion** with `Tab`, and **inspection** with `Shift+Tab`, showing signatures, JSDoc comments and links to MDN.
- **User input** with `prompt`.
- **Interruptions**: endless loops and timers can be stopped without restarting the kernel.
- **ES modules**: local modules, JSON modules, and the `std` and `os` modules of QuickJS.
- **Jupyter widgets**, with an API close to ipywidgets, and **comms**.
- **JupyterLite**: the kernel compiled to WebAssembly runs in the browser, without server.

## Getting started

The kernel can be tried without installing anything, in the browser with [JupyterLite](https://jtp.io/xeus-quickjs/lab/index.html).

To run it in JupyterLab, from a clone of the repository:

```bash
pixi run lab
```

[`pixi run lab`](installation.md) builds the kernel, installs it in a local environment, and starts JupyterLab. Create a notebook with the **JavaScript (xquickjs)** kernel, or open one of the example notebooks of the `notebooks` folder.

```javascript
const greeting = 'Hello';
`${greeting} from QuickJS!`
```

The [usage guide](usage.md) shows the features of the kernel, and the [reference](reference.md) lists the functions it adds to JavaScript.
