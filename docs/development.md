---
title: Development
---

## Architecture

`xeus-quickjs` has two parts:

- **The interpreter** (`src/xinterpreter.cpp`), a [xeus](https://github.com/jupyter-xeus/xeus) interpreter written in C++. It owns the QuickJS runtime, runs the event loop of the cells (promise jobs and timers), handles the interruptions and the comms, and sends the outputs to the frontend.
- **The runtime** (`src/js/runtime.js` and `src/js/widgets.js`), written in JavaScript and embedded in the library at build time. It defines the globals of the notebooks (`console`, `display`, the timers, the widgets...), formats the values, rewrites the cells, and answers the completion and inspection requests.

QuickJS is built from its release tarball, downloaded by CMake. The WebAssembly build links the kernel with xeus-lite instead of xeus-zmq (`src/main_emscripten_kernel.cpp`), and `src/emscripten/pre.js` sends what QuickJS writes on its standard streams to the notebook.

The kernel uses the `xserver_shell_main` server of xeus-zmq: the code runs in the main thread while the control channel has its own thread, so that an interrupt request reaches a busy kernel. The interrupt handler of QuickJS then stops the running code with an uncatchable error. The kernel specification sets `interrupt_mode` to `message`, and `SIGINT` interrupts the code too.

The cells are evaluated as global scripts with the `JS_EVAL_FLAG_ASYNC` flag of QuickJS, for top-level await. Before that, they are parsed with [acorn](https://github.com/acornjs/acorn) (in `thirdparty/acorn`), to turn the top-level `let`, `const` and `class` declarations into `var` declarations, so that the cells can be executed again, and the `import` statements into dynamic imports.

## Building

```bash
pixi run build      # configure and build in build/
pixi run install    # install in the pixi environment
```

## Tests

The tests of the kernel use [jupyter_kernel_test](https://github.com/jupyter/jupyter_kernel_test), and the example notebooks are executed with nbclient:

```bash
pixi run test
```

The cells of the notebooks tagged `interactive` (a prompt, an endless loop to interrupt) are skipped, and the ones tagged `raises-exception` must fail.

### Integration tests

The integration tests run JupyterLab in Chromium with [Playwright](https://playwright.dev) and [Galata](https://github.com/jupyterlab/jupyterlab/tree/main/galata), from the `ui-tests` folder:

```bash
pixi run ui-tests
```

Playwright starts JupyterLab with the configuration of `ui-tests/jupyter_server_test_config.py`.

### JupyterLite

The JupyterLite site is tested with Playwright too, from `ui-tests/lite`:

```bash
pixi run lite-ui-tests
```

### Screencasts

The `ui-tests/screencast` folder records a video of each feature in JupyterLab, in `ui-tests/screencast-results`:

```bash
# All the screencasts
pixi run screencasts

# One screencast
pixi run screencasts -g widgets
```

The scenarios are in `ui-tests/screencast/features.screencast.ts`, and the one of JupyterLite in `ui-tests/lite/jupyterlite.screencast.ts` (`pixi run lite-screencast`). The frames are captured with the screencast API of Chromium, and encoded in H.264 with ffmpeg.

## Documentation

The documentation is built with [MyST](https://mystmd.org), configured in `myst.yml`. The example notebooks are executed with the kernel:

```bash
pixi run docs        # build the HTML in _build/html
pixi run docs-serve  # preview the documentation
```
