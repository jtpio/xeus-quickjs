---
title: Installation
---

`xeus-quickjs` is built from source, on Linux and macOS. Its dependencies come from [conda-forge](https://conda-forge.org): the C and C++ compilers and CMake, [xeus](https://github.com/jupyter-xeus/xeus), [xeus-zmq](https://github.com/jupyter-xeus/xeus-zmq) and the latest release of [QuickJS](https://bellard.org/quickjs/), 2026-06-04.

## With pixi

[pixi](https://pixi.sh) creates an environment with all the dependencies in the `.pixi` folder of the repository, and runs the tasks of the project:

```bash
# Build the kernel and install it in the environment
pixi run install

# Start JupyterLab with the kernel
pixi run lab
```

The kernel is installed in the environment, in `.pixi/envs/default/share/jupyter/kernels/xquickjs`, and only the Jupyter of the environment sees it.

## With conda or mamba

Create an environment with the dependencies:

```bash
mamba create -n xeus-quickjs -c conda-forge cmake ninja c-compiler cxx-compiler "xeus>=6.0.6,<7" "xeus-zmq>=4,<5" nlohmann_json "quickjs>=2026.06.04" jupyterlab jupyterlab_widgets
mamba activate xeus-quickjs
```

Then build and install the kernel in it:

```bash
cmake -S . -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH=$CONDA_PREFIX \
  -DCMAKE_INSTALL_PREFIX=$CONDA_PREFIX \
  -DCMAKE_INSTALL_LIBDIR=lib
cmake --build build
cmake --install build
```

## In JupyterLite

The kernel can be built for WebAssembly with [emscripten](https://emscripten.org), and run in the browser by [JupyterLite](https://jupyterlite.readthedocs.io), without server. Two pixi environments hold the dependencies of this build: `wasm-host` has the libraries of the kernel built for WebAssembly, from [emscripten-forge](https://emscripten-forge.org) (xeus and xeus-lite; QuickJS is not packaged there, so CMake downloads and builds it), and `wasm-build` has the emscripten toolchain, JupyterLite and [jupyterlite-xeus](https://github.com/jupyterlite/xeus).

```bash
# Build the kernel for WebAssembly, in the wasm-host environment
pixi run -e wasm-build wasm-build

# Build a JupyterLite site with the kernel and the example notebooks, in _output
pixi run -e wasm-build lite-build

# Serve the site on http://localhost:8000
pixi run -e wasm-build lite-serve
```

In JupyterLite, the kernel runs in a web worker. It has the same features as the native kernel, with these differences:

- The kernel can not be interrupted: a web worker does not receive messages while it runs some code.
- While a cell waits for its timers, the kernel keeps the worker busy.
- The files of the `std` and `os` modules are the ones of JupyterLite, `os.platform` is `"js"`, and `os.exec` and `os.Worker` are not available.

## Build options

| Option | Default | Description |
| --- | --- | --- |
| `XEUS_QUICKJS_BUILD_SHARED` | `ON` | Build the `xeus-quickjs` shared library |
| `XEUS_QUICKJS_BUILD_STATIC` | `ON` | Build the `xeus-quickjs-static` static library |
| `XEUS_QUICKJS_BUILD_EXECUTABLE` | `ON` | Build the `xquickjs` kernel |
| `XEUS_QUICKJS_USE_SHARED_XEUS` | `ON` | Link with the shared library of xeus |
| `XEUS_QUICKJS_USE_SHARED_XEUS_QUICKJS` | `ON` | Link the kernel with the shared library of xeus-quickjs |
| `XEUS_QUICKJS_USE_SYSTEM_QUICKJS` | `ON` (`OFF` for WebAssembly) | Use an installed QuickJS, like the `quickjs` package of conda-forge, instead of downloading and building it |
| `XEUS_QUICKJS_KERNELSPEC_PATH` | `<prefix>/bin/` | Directory of the kernel in the kernel specification |

The WebAssembly build only builds the static library and the kernel.
