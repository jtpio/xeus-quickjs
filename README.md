# xeus-quickjs

[![CI](https://github.com/jtpio/xeus-quickjs/actions/workflows/ci.yml/badge.svg)](https://github.com/jtpio/xeus-quickjs/actions/workflows/ci.yml)
[![Try it in JupyterLite](https://jupyterlite.rtfd.io/en/latest/_static/badge.svg)](https://jtp.io/xeus-quickjs/lab/index.html)

`xeus-quickjs` is a Jupyter kernel for JavaScript based on [QuickJS](https://bellard.org/quickjs/), the small and
embeddable JavaScript engine by Fabrice Bellard, and on the native implementation of the Jupyter protocol
[xeus](https://github.com/jupyter-xeus/xeus).

QuickJS supports the latest ECMAScript features, like modules, async generators, BigInt and top-level await. The
kernel is a single native executable, with no dependency on Node.js or a web browser. It also runs in the browser with
JupyterLite, compiled to WebAssembly.

## Features

- Code execution, with the values displayed like in the Node.js REPL, cells which can be executed again, and
  top-level `await`
- `console.log` and the other `console` methods, including `console.table`
- Errors with the line of code which raised them
- Promises, timers and async generators
- Rich display of HTML, Markdown, LaTeX, SVG, images and JSON, and objects with their own representation
- Code completion and inspection, with the JSDoc comments and links to MDN
- User input with `prompt`
- Interruption of endless loops and timers
- ES modules, and the `std` and `os` modules of QuickJS
- Jupyter widgets and comms
- JupyterLite, with the kernel compiled to WebAssembly

## Installation

`xeus-quickjs` is built from source, with its dependencies from conda-forge. The latest release of QuickJS, 2026-06-04,
is downloaded and built with the kernel. The simplest way is to use
[pixi](https://pixi.sh), which creates an environment in the `.pixi` folder of the repository:

```bash
# Build the kernel and install it in the environment
pixi run install

# Start JupyterLab with the kernel
pixi run lab
```

To build it in a conda environment instead:

```bash
mamba create -n xeus-quickjs -c conda-forge cmake ninja c-compiler cxx-compiler "xeus>=6.0.6,<7" "xeus-zmq>=4,<5" nlohmann_json jupyterlab jupyterlab_widgets
mamba activate xeus-quickjs

cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH=$CONDA_PREFIX -DCMAKE_INSTALL_PREFIX=$CONDA_PREFIX -DCMAKE_INSTALL_LIBDIR=lib
cmake --build build
cmake --install build
```

### JupyterLite

The kernel can be built for WebAssembly with the emscripten toolchain and the packages of
[emscripten-forge](https://emscripten-forge.org), and run in the browser by JupyterLite:

```bash
# Build the kernel for WebAssembly
pixi run -e wasm-build wasm-build

# Build a JupyterLite site with the kernel and the example notebooks in _output, and serve it
pixi run -e wasm-build lite-serve
```

In JupyterLite, the kernel can not be interrupted, and `os.exec` and `os.Worker` are not available.

## Usage

Launch JupyterLab with `jupyter lab`, and create a notebook with the **JavaScript (QuickJS)** kernel. The
`notebooks` folder has examples of all the features:

- [xeus-quickjs.ipynb](notebooks/xeus-quickjs.ipynb): a tour of the kernel
- [rich-display.ipynb](notebooks/rich-display.ipynb): HTML, Markdown, LaTeX, SVG and images
- [async.ipynb](notebooks/async.ipynb): promises, timers and async generators
- [modules.ipynb](notebooks/modules.ipynb): ES modules and the standard library of QuickJS
- [files.ipynb](notebooks/files.ipynb): reading and writing files with the `std` and `os` modules
- [widgets.ipynb](notebooks/widgets.ipynb): Jupyter widgets
- [mandelbrot.ipynb](notebooks/mandelbrot.ipynb): an interactive explorer of the Mandelbrot set

```javascript
const { IntSlider } = Jupyter.widgets;

const slider = new IntSlider({ value: 5, max: 10, description: 'Value' });
slider.observe(({ new: value }) => console.log(value ** 2), 'value');
slider
```

## Documentation

The documentation, in the `docs` folder, is built with [MyST](https://mystmd.org): `pixi run docs`.

## Tests

```bash
# The tests of the kernel and of the example notebooks
pixi run test

# The integration tests in JupyterLab
pixi run ui-tests

# The integration tests of the JupyterLite site
pixi run lite-ui-tests

# The screencasts of the features, in ui-tests/screencast-results
pixi run screencasts
pixi run lite-screencast
```

## Dependencies

| `xeus-quickjs` | `xeus`        | `xeus-zmq`  | `xeus-lite` | QuickJS      | `nlohmann_json` |
| -------------- | ------------- | ----------- | ----------- | ------------ | --------------- |
| main           | >=6.0.6,<7.0  | >=4.0,<5.0  | >=5.0,<6.0  | 2026-06-04   | >=3.12,<4.0     |

## License

We use a shared copyright model that enables all contributors to maintain the copyright on their contributions.

This software is licensed under the BSD-3-Clause license. See the [LICENSE](LICENSE) file for details.

The parser of the cells, [acorn](https://github.com/acornjs/acorn), is distributed under the MIT license, see
[thirdparty/acorn/LICENSE](thirdparty/acorn/LICENSE).
