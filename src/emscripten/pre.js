// Copyright (c) 2026, Jeremy Tuloup
// Distributed under the terms of the BSD 3-Clause License.

// What QuickJS writes on its standard streams, for instance with std.printf,
// is printed by emscripten line by line: the lines are sent to the notebook
// once the kernel runs, and to the console of the worker before.
Module['print'] = text => {
  if (!(Module['xquickjsPublishOutput'] && Module['xquickjsPublishOutput']('stdout', text + '\n'))) {
    console.log(text);
  }
};

Module['printErr'] = text => {
  if (!(Module['xquickjsPublishOutput'] && Module['xquickjsPublishOutput']('stderr', text + '\n'))) {
    console.error(text);
  }
};
