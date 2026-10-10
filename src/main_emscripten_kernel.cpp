/***************************************************************************
* Copyright (c) 2026, Jeremy Tuloup                                        *
*                                                                          *
* Distributed under the terms of the BSD 3-Clause License.                 *
*                                                                          *
* The full license is in the file LICENSE, distributed with this software. *
****************************************************************************/

#include <string>

#include <emscripten/bind.h>

#include "xeus/xembind.hpp"

#include "xeus-quickjs/xinterpreter.hpp"

EMSCRIPTEN_BINDINGS(my_module)
{
    xeus::export_core();
    using interpreter_type = xquickjs::interpreter;
    xeus::export_kernel<interpreter_type>("xkernel");

    // Used by pre.js to send what QuickJS writes on its standard streams to
    // the notebook
    emscripten::function("xquickjsPublishOutput", &xquickjs::publish_output);
}
