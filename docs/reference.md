---
title: Reference
---

The kernel adds these globals to the JavaScript environment of QuickJS.

## Display

| Function | Description |
| --- | --- |
| `display(value, { id?, metadata? })` | Displays a value with its richest representation. With an `id` (`true` for a new one), returns a handle with `update(value)` and `display(value)` methods. |
| `display.html(content, options?)` | Displays HTML. |
| `display.markdown(content, options?)` | Displays Markdown. |
| `display.latex(content, options?)` | Displays LaTeX. |
| `display.svg(content, options?)` | Displays an SVG image from its source. |
| `display.text(content, options?)` | Displays plain text. |
| `display.json(value, options?)` | Displays JSON data as a tree. |
| `display.png(data, { width?, height? })` | Displays a PNG image from its bytes (`Uint8Array`, `ArrayBuffer`) or base64 data. |
| `display.jpeg(data, { width?, height? })` | Displays a JPEG image. |
| `display.image(path, { width?, height?, type? })` | Displays an image file. |
| `display.mime(bundle, options?)` | Displays a MIME bundle, an object mapping MIME types to data. |
| `display.clear(wait?)`, `clearOutput(wait?)` | Clears the outputs of the cell. |

The helpers accept a string, or can be used as tagged templates: ``display.html`<b>${value}</b>` ``.

Objects are displayed with their `_toHtml`, `_toMarkdown`, `_toSvg`, `_toPng`, `_toJpeg`, `_toLatex`, `_toJson` or `_toMime` methods when they have some, or with a `[Symbol.for('Jupyter.display')]()` method returning a MIME bundle. A `[Symbol.for('nodejs.util.inspect.custom')]` method customizes their text representation, like in Node.js.

## Console

`console.log`, `info`, `debug`, `warn`, `error`, `trace`, `dir`, `table`, `group`, `groupCollapsed`, `groupEnd`, `time`, `timeLog`, `timeEnd`, `count`, `countReset`, `assert` and `clear`. `print` is the same as `console.log`.

## Timers and tasks

`setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `setImmediate`, `clearImmediate` and `queueMicrotask`. A cell runs until all its timers have fired.

## Input

| Function | Description |
| --- | --- |
| `prompt(message?, defaultValue?)` | Asks the user for some input, and returns it as a string. |
| `prompt.password(message?)` | Asks for a password, the input is hidden. |

## Web APIs

`TextEncoder`, `TextDecoder` (UTF-8), `btoa`, `atob`, `structuredClone`, `performance.now()` and `DOMException`.

## Widgets

The widgets are available in `Jupyter.widgets`:

| Kind | Widgets |
| --- | --- |
| Numbers | `IntSlider`, `FloatSlider`, `FloatLogSlider`, `IntRangeSlider`, `FloatRangeSlider`, `IntProgress`, `FloatProgress`, `IntText`, `FloatText`, `BoundedIntText`, `BoundedFloatText`, `Play` |
| Booleans | `Checkbox`, `ToggleButton`, `Valid` |
| Selection | `Dropdown`, `RadioButtons`, `Select`, `SelectMultiple`, `ToggleButtons`, `SelectionSlider`, `SelectionRangeSlider` |
| Strings | `Text`, `Textarea`, `Password`, `Combobox`, `Label`, `HTML`, `HTMLMath` |
| Others | `Button`, `ColorPicker`, `Image`, `Output` |
| Containers | `Box`, `HBox`, `VBox`, `GridBox`, `Accordion`, `Tab`, `Stack` |
| Links | `Link`, `DirectionalLink`, `jslink`, `jsdlink` |
| Layout and style | `Layout`, and the style models like `SliderStyle` or `ButtonStyle` |

A widget is created with its state, `new IntSlider({ value: 5, max: 10 })`, and displayed when it is the result of a cell or with `display(widget)`. Its properties can be read and assigned directly (`slider.value = 7`). The `layout` and `style` can be given as plain objects.

| Method | Description |
| --- | --- |
| `widget.observe(callback, names?)` | Calls `callback({ name, new, old, owner, type })` when the properties change. |
| `widget.unobserve(callback, names?)` | Removes a callback. |
| `widget.on(event, callback)` | Listens to `'change:<name>'`, `'change'`, `'close'` and `'custom'` events. |
| `widget.get(name)`, `widget.set(name, value)` | Reads and writes properties. |
| `widget.send(content, buffers?)` | Sends a custom message to the frontend. |
| `widget.close()` | Closes the widget. |
| `button.onClick(callback)` | Calls a function when a `Button` is clicked. |
| `output.capture(callback, { clearOutput? })` | Returns a function showing the outputs of `callback` in an `Output` widget. |
| `output.clear()`, `output.appendStdout(text)`, `output.appendDisplayData(bundle)` | Changes the outputs of an `Output` widget. |

The selection widgets take their `options` as a list of labels, and their `value` is the selected label.

## Comms

`Jupyter.Comm` is the low level communication channel with the frontend, used by the widgets:

```javascript
// A comm opened by the kernel
const comm = new Jupyter.Comm('my-target', { some: 'data' });
comm.onMsg = (data, buffers) => console.log(data);
comm.send({ hello: 'frontend' });
comm.close();

// Comms opened by the frontend
Jupyter.Comm.registerTarget('my-target', (comm, { data, buffers }) => {
  comm.onMsg = data => comm.send({ echo: data });
});
```

## QuickJS modules

The `std` and `os` modules of QuickJS can be imported as `std` and `os` (or `qjs:std` and `qjs:os`), see the [QuickJS documentation](https://bellard.org/quickjs/quickjs.html#Standard-library). The timers of the `os` module do not run in the notebooks: use `setTimeout` instead.
