/***************************************************************************
* Copyright (c) 2026, Jeremy Tuloup                                        *
*                                                                          *
* Distributed under the terms of the BSD 3-Clause License.                 *
*                                                                          *
* The full license is in the file LICENSE, distributed with this software. *
****************************************************************************/

#include <algorithm>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "xeus/xhelper.hpp"
#include "xeus/xinput.hpp"

#include "xeus-quickjs/xinterpreter.hpp"
#include "xeus-quickjs/xeus_quickjs_config.hpp"

#include "quickjs-libc.h"

#include "xjs_sources.hpp"

#ifndef XEUS_QUICKJS_QUICKJS_VERSION
#define XEUS_QUICKJS_QUICKJS_VERSION "unknown"
#endif

namespace xquickjs
{
    namespace
    {
        // Maximum duration of the evaluations done for completion and
        // inspection requests, which must not block the kernel.
        constexpr std::chrono::milliseconds request_timeout(2000);

        // Maximum number of promise jobs run after an interruption, to let
        // the error handlers run without being stuck in an endless chain.
        constexpr std::size_t max_jobs_after_interrupt = 10000;

        // The interpreter of the kernel, once it is configured
        interpreter* p_current_interpreter = nullptr;

        interpreter& get_kernel_interpreter(JSContext* ctx)
        {
            return *static_cast<interpreter*>(JS_GetContextOpaque(ctx));
        }

        std::string to_string(JSContext* ctx, JSValueConst value)
        {
            std::size_t length = 0;
            const char* str = JS_ToCStringLen(ctx, &length, value);
            if (str == nullptr)
            {
                throw std::runtime_error("could not convert value to a string");
            }
            std::string res(str, length);
            JS_FreeCString(ctx, str);
            return res;
        }

        // JSON payloads are serialized by the JavaScript side of the kernel.
        nl::json to_json(JSContext* ctx, JSValueConst value)
        {
            if (JS_IsUndefined(value) || JS_IsNull(value))
            {
                return nl::json::object();
            }
            return nl::json::parse(to_string(ctx, value));
        }

        JSValue new_string(JSContext* ctx, const std::string& str)
        {
            return JS_NewStringLen(ctx, str.data(), str.size());
        }

        // C++ exceptions must not unwind through QuickJS frames: native
        // functions turn them into JavaScript exceptions.
        template <class F>
        JSValue guarded(JSContext* ctx, F&& f)
        {
            try
            {
                return f();
            }
            catch (const std::exception& e)
            {
                return JS_ThrowInternalError(ctx, "%s", e.what());
            }
        }

        /********************
         * Native functions *
         ********************/

        JSValue js_publish_stream(JSContext* ctx, JSValueConst, int, JSValueConst* argv)
        {
            return guarded(ctx, [&]()
            {
                get_kernel_interpreter(ctx).publish_stream(to_string(ctx, argv[0]), to_string(ctx, argv[1]));
                return JS_UNDEFINED;
            });
        }

        JSValue js_publish_execution_result(JSContext* ctx, JSValueConst, int, JSValueConst* argv)
        {
            return guarded(ctx, [&]()
            {
                int execution_count = 0;
                JS_ToInt32(ctx, &execution_count, argv[0]);
                get_kernel_interpreter(ctx).publish_execution_result(execution_count,
                                                                     to_json(ctx, argv[1]),
                                                                     to_json(ctx, argv[2]));
                return JS_UNDEFINED;
            });
        }

        JSValue js_publish_error(JSContext* ctx, JSValueConst, int, JSValueConst* argv)
        {
            return guarded(ctx, [&]()
            {
                std::vector<std::string> traceback = to_json(ctx, argv[2]);
                get_kernel_interpreter(ctx).publish_execution_error(to_string(ctx, argv[0]),
                                                                    to_string(ctx, argv[1]),
                                                                    traceback);
                return JS_UNDEFINED;
            });
        }

        JSValue js_display_data(JSContext* ctx, JSValueConst, int, JSValueConst* argv)
        {
            return guarded(ctx, [&]()
            {
                get_kernel_interpreter(ctx).display_data(to_json(ctx, argv[0]),
                                                         to_json(ctx, argv[1]),
                                                         to_json(ctx, argv[2]));
                return JS_UNDEFINED;
            });
        }

        JSValue js_update_display_data(JSContext* ctx, JSValueConst, int, JSValueConst* argv)
        {
            return guarded(ctx, [&]()
            {
                get_kernel_interpreter(ctx).update_display_data(to_json(ctx, argv[0]),
                                                                to_json(ctx, argv[1]),
                                                                to_json(ctx, argv[2]));
                return JS_UNDEFINED;
            });
        }

        JSValue js_clear_output(JSContext* ctx, JSValueConst, int, JSValueConst* argv)
        {
            return guarded(ctx, [&]()
            {
                get_kernel_interpreter(ctx).clear_output(JS_ToBool(ctx, argv[0]));
                return JS_UNDEFINED;
            });
        }

        JSValue js_input_request(JSContext* ctx, JSValueConst, int, JSValueConst* argv)
        {
            return guarded(ctx, [&]()
            {
                if (!get_kernel_interpreter(ctx).allow_stdin())
                {
                    return JS_ThrowTypeError(ctx, "this frontend does not support input requests");
                }
                std::string value = xeus::blocking_input_request(to_string(ctx, argv[0]),
                                                                 JS_ToBool(ctx, argv[1]));
                return new_string(ctx, value);
            });
        }

        // Evaluates a cell as global code. Returns a promise which resolves
        // to an object holding the completion value of the code, so that
        // top-level await is supported.
        JSValue js_eval_script(JSContext* ctx, JSValueConst, int, JSValueConst* argv)
        {
            return guarded(ctx, [&]()
            {
                std::string code = to_string(ctx, argv[0]);
                std::string filename = to_string(ctx, argv[1]);
                return JS_Eval(ctx, code.c_str(), code.size(), filename.c_str(),
                               JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_ASYNC);
            });
        }

        // Returns [state] or [state, result] for promises, [-1] otherwise.
        JSValue js_promise_state(JSContext* ctx, JSValueConst, int, JSValueConst* argv)
        {
            JSValue res = JS_NewArray(ctx);
            int state = JS_PromiseState(ctx, argv[0]);
            JS_SetPropertyUint32(ctx, res, 0, JS_NewInt32(ctx, state));
            if (state == JS_PROMISE_FULFILLED || state == JS_PROMISE_REJECTED)
            {
                JS_SetPropertyUint32(ctx, res, 1, JS_PromiseResult(ctx, argv[0]));
            }
            return res;
        }

        JSValue js_now(JSContext* ctx, JSValueConst, int, JSValueConst*)
        {
            using milliseconds = std::chrono::duration<double, std::milli>;
            auto now = std::chrono::steady_clock::now().time_since_epoch();
            return JS_NewFloat64(ctx, std::chrono::duration_cast<milliseconds>(now).count());
        }

        JSValue js_read_file(JSContext* ctx, JSValueConst, int, JSValueConst* argv)
        {
            return guarded(ctx, [&]()
            {
                std::string path = to_string(ctx, argv[0]);
                std::ifstream file(path, std::ios::binary);
                if (!file)
                {
                    return JS_ThrowReferenceError(ctx, "could not open file '%s'", path.c_str());
                }
                std::vector<char> content((std::istreambuf_iterator<char>(file)),
                                          std::istreambuf_iterator<char>());
                return JS_NewArrayBufferCopy(ctx,
                                             reinterpret_cast<const uint8_t*>(content.data()),
                                             content.size());
            });
        }

#if defined(__GLIBC__) || defined(__APPLE__)
        size_t write_redirected(void* cookie, const char* buffer, size_t size)
        {
            auto* redirection = static_cast<interpreter::stream_redirection*>(cookie);
            // Only the code running in the main thread belongs to the cells
            if (std::this_thread::get_id() != redirection->m_thread_id)
            {
                return std::fwrite(buffer, 1, size, redirection->p_original);
            }
            try
            {
                redirection->p_interpreter->publish_stream(redirection->m_name, std::string(buffer, size));
            }
            catch (const std::exception&)
            {
            }
            return size;
        }

#if defined(__GLIBC__)
        ssize_t write_redirected_stream(void* cookie, const char* buffer, size_t size)
        {
            return static_cast<ssize_t>(write_redirected(cookie, buffer, size));
        }
#else
        int write_redirected_stream(void* cookie, const char* buffer, int size)
        {
            return static_cast<int>(write_redirected(cookie, buffer, static_cast<size_t>(size)));
        }
#endif

        FILE* open_redirected_stream(interpreter::stream_redirection& redirection)
        {
#if defined(__GLIBC__)
            cookie_io_functions_t functions = { nullptr, write_redirected_stream, nullptr, nullptr };
            FILE* stream = fopencookie(&redirection, "w", functions);
#else
            // The BSD counterpart of fopencookie
            FILE* stream = funopen(&redirection, nullptr, write_redirected_stream, nullptr, nullptr);
#endif
            if (stream != nullptr)
            {
                std::setvbuf(stream, nullptr, _IONBF, 0);
            }
            return stream;
        }
#endif

        // Buffers are passed as arrays of ArrayBuffer
        xeus::buffer_sequence to_buffers(JSContext* ctx, JSValueConst value)
        {
            xeus::buffer_sequence buffers;
            if (!JS_IsArray(ctx, value))
            {
                return buffers;
            }
            JSValue length_value = JS_GetPropertyStr(ctx, value, "length");
            uint32_t length = 0;
            JS_ToUint32(ctx, &length, length_value);
            JS_FreeValue(ctx, length_value);
            for (uint32_t i = 0; i < length; ++i)
            {
                JSValue item = JS_GetPropertyUint32(ctx, value, i);
                std::size_t size = 0;
                uint8_t* data = JS_GetArrayBuffer(ctx, &size, item);
                JS_FreeValue(ctx, item);
                if (data == nullptr)
                {
                    JS_FreeValue(ctx, JS_GetException(ctx));
                    throw std::runtime_error("comm buffers must be ArrayBuffers");
                }
                buffers.emplace_back(reinterpret_cast<const char*>(data), reinterpret_cast<const char*>(data) + size);
            }
            return buffers;
        }

        JSValue from_buffers(JSContext* ctx, const xeus::buffer_sequence& buffers)
        {
            JSValue res = JS_NewArray(ctx);
            for (std::size_t i = 0; i < buffers.size(); ++i)
            {
                const auto& buffer = buffers[i];
                JS_SetPropertyUint32(ctx, res, static_cast<uint32_t>(i),
                                     JS_NewArrayBufferCopy(ctx,
                                                           reinterpret_cast<const uint8_t*>(buffer.data()),
                                                           buffer.size()));
            }
            return res;
        }

        std::string to_string(const xeus::xguid& id)
        {
            return std::string(id.data(), id.size());
        }

        JSValue js_comm_open(JSContext* ctx, JSValueConst, int, JSValueConst* argv)
        {
            return guarded(ctx, [&]()
            {
                get_kernel_interpreter(ctx).open_comm(to_string(ctx, argv[0]),
                                                      to_string(ctx, argv[1]),
                                                      to_json(ctx, argv[2]),
                                                      to_json(ctx, argv[3]),
                                                      to_buffers(ctx, argv[4]));
                return JS_UNDEFINED;
            });
        }

        JSValue js_comm_send(JSContext* ctx, JSValueConst, int, JSValueConst* argv)
        {
            return guarded(ctx, [&]()
            {
                get_kernel_interpreter(ctx).send_comm(to_string(ctx, argv[0]),
                                                      to_json(ctx, argv[1]),
                                                      to_json(ctx, argv[2]),
                                                      to_buffers(ctx, argv[3]));
                return JS_UNDEFINED;
            });
        }

        JSValue js_comm_close(JSContext* ctx, JSValueConst, int, JSValueConst* argv)
        {
            return guarded(ctx, [&]()
            {
                get_kernel_interpreter(ctx).close_comm(to_string(ctx, argv[0]),
                                                       to_json(ctx, argv[1]),
                                                       to_json(ctx, argv[2]),
                                                       to_buffers(ctx, argv[3]));
                return JS_UNDEFINED;
            });
        }

        JSValue js_comm_register_target(JSContext* ctx, JSValueConst, int, JSValueConst* argv)
        {
            return guarded(ctx, [&]()
            {
                get_kernel_interpreter(ctx).register_comm_target(to_string(ctx, argv[0]));
                return JS_UNDEFINED;
            });
        }

        // The header of the message being handled, e.g. for output widgets
        JSValue js_parent_header(JSContext* ctx, JSValueConst, int, JSValueConst*)
        {
            return guarded(ctx, [&]()
            {
                return new_string(ctx, get_kernel_interpreter(ctx).parent_header().dump());
            });
        }

        void add_function(JSContext* ctx, JSValue object, const char* name, JSCFunction* func, int length)
        {
            JS_SetPropertyStr(ctx, object, name, JS_NewCFunction(ctx, func, name, length));
        }

        JSValue make_native_object(JSContext* ctx)
        {
            JSValue native = JS_NewObject(ctx);
            add_function(ctx, native, "publishStream", js_publish_stream, 2);
            add_function(ctx, native, "publishExecutionResult", js_publish_execution_result, 3);
            add_function(ctx, native, "publishError", js_publish_error, 3);
            add_function(ctx, native, "displayData", js_display_data, 3);
            add_function(ctx, native, "updateDisplayData", js_update_display_data, 3);
            add_function(ctx, native, "clearOutput", js_clear_output, 1);
            add_function(ctx, native, "inputRequest", js_input_request, 2);
            add_function(ctx, native, "evalScript", js_eval_script, 2);
            add_function(ctx, native, "promiseState", js_promise_state, 1);
            add_function(ctx, native, "now", js_now, 0);
            add_function(ctx, native, "readFile", js_read_file, 1);
            add_function(ctx, native, "commOpen", js_comm_open, 5);
            add_function(ctx, native, "commSend", js_comm_send, 4);
            add_function(ctx, native, "commClose", js_comm_close, 4);
            add_function(ctx, native, "commRegisterTarget", js_comm_register_target, 1);
            add_function(ctx, native, "parentHeader", js_parent_header, 0);
            JS_SetPropertyStr(ctx, native, "version", new_string(ctx, XEUS_QUICKJS_VERSION));
            JS_SetPropertyStr(ctx, native, "quickjsVersion", new_string(ctx, XEUS_QUICKJS_QUICKJS_VERSION));
            return native;
        }
    }

    bool publish_output(const std::string& name, const std::string& text)
    {
        if (p_current_interpreter == nullptr)
        {
            return false;
        }
        p_current_interpreter->publish_stream(name, text);
        return true;
    }

    /******************************
     * interpreter implementation *
     ******************************/

    interpreter::interpreter()
        : p_runtime(nullptr)
        , p_context(nullptr)
        , m_kernel(JS_UNDEFINED)
        , m_interrupt_requested(false)
        , m_interrupt_observed(false)
        , m_has_deadline(false)
        , m_allow_stdin(false)
        , m_stdout_redirection{this, "stdout", nullptr, std::thread::id()}
        , m_stderr_redirection{this, "stderr", nullptr, std::thread::id()}
        , p_original_stdout(nullptr)
        , p_original_stderr(nullptr)
    {
        xeus::register_interpreter(this);
    }

    interpreter::~interpreter()
    {
        if (p_current_interpreter == this)
        {
            p_current_interpreter = nullptr;
        }
        restore_output();
        // The comm manager may already be gone: the comms are not destroyed
        for (auto& comm : m_comms)
        {
            comm.second.release();
        }
        for (auto& comm : m_closed_comms)
        {
            comm.release();
        }
        if (p_context != nullptr)
        {
            for (auto& rejection : m_unhandled_rejections)
            {
                JS_FreeValue(p_context, rejection.first);
                JS_FreeValue(p_context, rejection.second);
            }
            JS_FreeValue(p_context, m_kernel);
            js_std_free_handlers(p_runtime);
            JS_FreeContext(p_context);
            JS_FreeRuntime(p_runtime);
        }
    }

    void interpreter::request_interrupt() noexcept
    {
        m_interrupt_requested = true;
    }

    bool interpreter::allow_stdin() const noexcept
    {
        return m_allow_stdin;
    }

    void interpreter::configure_impl()
    {
        redirect_output();

        p_runtime = JS_NewRuntime();
        js_std_init_handlers(p_runtime);
        JS_SetModuleLoaderFunc2(p_runtime, nullptr, js_module_loader, js_module_check_attributes, nullptr);
        JS_SetInterruptHandler(p_runtime, interrupt_handler, this);
        JS_SetHostPromiseRejectionTracker(p_runtime, promise_rejection_tracker, this);

        p_context = JS_NewContext(p_runtime);
        JS_SetContextOpaque(p_context, this);
        js_init_module_std(p_context, "std");
        js_init_module_os(p_context, "os");
        js_std_add_helpers(p_context, 0, nullptr);

        // The parser used to rewrite cells, so that they can be re-executed.
        const std::string acorn_source =
            "(function () {\n"
            "const module = { exports: {} };\n"
            "const exports = module.exports;\n"
            + std::string(reinterpret_cast<const char*>(embedded::acorn_js), embedded::acorn_js_size) +
            "\nreturn module.exports;\n"
            "})()";
        JSValue acorn = eval_internal(acorn_source.c_str(), acorn_source.size(), "xeus-quickjs:acorn");
        JSValue widgets = eval_internal(reinterpret_cast<const char*>(embedded::widgets_js),
                                        embedded::widgets_js_size,
                                        "xeus-quickjs:widgets");
        JSValue factory = eval_internal(reinterpret_cast<const char*>(embedded::runtime_js),
                                        embedded::runtime_js_size,
                                        "xeus-quickjs:runtime");

        JSValue args[3] = { make_native_object(p_context), acorn, widgets };
        m_kernel = JS_Call(p_context, factory, JS_UNDEFINED, 3, args);
        for (JSValue& arg : args)
        {
            JS_FreeValue(p_context, arg);
        }
        JS_FreeValue(p_context, factory);
        if (JS_IsException(m_kernel))
        {
            report_pending_exception();
            throw std::runtime_error("could not initialize the xeus-quickjs runtime");
        }
        p_current_interpreter = this;
    }

    void interpreter::redirect_output()
    {
#if defined(__GLIBC__) || defined(__APPLE__)
        // The C streams are global variables in the GNU C library and on
        // macOS: the functions of quickjs-libc pick up the redirected
        // streams, while the C++ streams keep the original ones.
        m_stdout_redirection.p_original = stdout;
        m_stdout_redirection.m_thread_id = std::this_thread::get_id();
        m_stderr_redirection.p_original = stderr;
        m_stderr_redirection.m_thread_id = std::this_thread::get_id();
        FILE* redirected_stdout = open_redirected_stream(m_stdout_redirection);
        FILE* redirected_stderr = open_redirected_stream(m_stderr_redirection);
        if (redirected_stdout != nullptr && redirected_stderr != nullptr)
        {
            p_original_stdout = stdout;
            p_original_stderr = stderr;
            stdout = redirected_stdout;
            stderr = redirected_stderr;
        }
#endif
    }

    void interpreter::restore_output()
    {
#if defined(__GLIBC__) || defined(__APPLE__)
        if (p_original_stdout != nullptr)
        {
            std::fflush(stdout);
            std::fflush(stderr);
            FILE* redirected_stdout = stdout;
            FILE* redirected_stderr = stderr;
            stdout = p_original_stdout;
            stderr = p_original_stderr;
            std::fclose(redirected_stdout);
            std::fclose(redirected_stderr);
            p_original_stdout = nullptr;
            p_original_stderr = nullptr;
        }
#endif
    }

    JSValue interpreter::eval_internal(const char* source, std::size_t size, const char* filename)
    {
        // JS_Eval requires a null-terminated buffer
        std::string code(source, size);
        JSValue res = JS_Eval(p_context, code.c_str(), code.size(), filename, JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(res))
        {
            report_pending_exception();
            throw std::runtime_error(std::string("could not evaluate ") + filename);
        }
        return res;
    }

    void interpreter::execute_request_impl(send_reply_callback cb,
                                           int execution_counter,
                                           const std::string& code,
                                           xeus::execute_request_config config,
                                           nl::json user_expressions)
    {
        m_interrupt_requested = false;
        m_interrupt_observed = false;
        m_allow_stdin = config.allow_stdin;
        release_closed_comms();

        JSValue args[3] = {
            new_string(p_context, code),
            JS_NewInt32(p_context, execution_counter),
            JS_NewBool(p_context, config.silent)
        };
        JSValue res = call_kernel("execute", 3, args);
        for (JSValue& arg : args)
        {
            JS_FreeValue(p_context, arg);
        }
        if (JS_IsException(res))
        {
            report_pending_exception();
        }
        JS_FreeValue(p_context, res);

        run_event_loop();

        bool interrupted = is_interrupted();
        m_interrupt_requested = false;
        m_interrupt_observed = false;

        JSValue finish_args[1] = { JS_NewBool(p_context, interrupted) };
        nl::json summary = call_kernel_json("finish", 1, finish_args);

        if (summary.is_object() && summary.value("status", "") == "error")
        {
            cb(xeus::create_error_reply(summary.value("ename", ""),
                                        summary.value("evalue", ""),
                                        summary.value("traceback", nl::json::array())));
        }
        else
        {
            cb(xeus::create_successful_reply(nl::json::array(),
                                             evaluate_user_expressions(user_expressions)));
        }
    }

    nl::json interpreter::complete_request_impl(const std::string& code, int cursor_pos)
    {
        JSValue args[2] = { new_string(p_context, code), JS_NewInt32(p_context, cursor_pos) };
        nl::json res = call_with_deadline("complete", 2, args, nl::json());
        JS_FreeValue(p_context, args[0]);

        if (!res.is_object())
        {
            return xeus::create_complete_reply(nl::json::array(), cursor_pos, cursor_pos);
        }
        return xeus::create_complete_reply(res["matches"],
                                           res["cursor_start"].get<int>(),
                                           res["cursor_end"].get<int>(),
                                           res.value("metadata", nl::json::object()));
    }

    nl::json interpreter::inspect_request_impl(const std::string& code,
                                               int cursor_pos,
                                               int detail_level)
    {
        JSValue args[3] = {
            new_string(p_context, code),
            JS_NewInt32(p_context, cursor_pos),
            JS_NewInt32(p_context, detail_level)
        };
        nl::json res = call_with_deadline("inspect", 3, args, nl::json());
        JS_FreeValue(p_context, args[0]);

        if (!res.is_object() || !res.value("found", false))
        {
            return xeus::create_inspect_reply(false);
        }
        return xeus::create_inspect_reply(true, res["data"], res.value("metadata", nl::json::object()));
    }

    nl::json interpreter::is_complete_request_impl(const std::string& code)
    {
        JSValue args[1] = { new_string(p_context, code) };
        nl::json res = call_kernel_json("isComplete", 1, args);
        JS_FreeValue(p_context, args[0]);

        if (!res.is_object())
        {
            return xeus::create_is_complete_reply("unknown");
        }
        return xeus::create_is_complete_reply(res.value("status", "unknown"), res.value("indent", ""));
    }

    nl::json interpreter::kernel_info_request_impl()
    {
        const std::string banner =
            "xeus-quickjs " XEUS_QUICKJS_VERSION ", a Jupyter kernel for JavaScript\n"
            "QuickJS version " XEUS_QUICKJS_QUICKJS_VERSION;

        const nl::json help_links = nl::json::array({
            {{"text", "JavaScript Reference (MDN)"}, {"url", "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference"}},
            {{"text", "QuickJS"}, {"url", "https://bellard.org/quickjs/"}},
            {{"text", "QuickJS std and os modules"}, {"url", "https://bellard.org/quickjs/quickjs.html#Standard-library"}}
        });

        return xeus::create_info_reply("xeus-quickjs",
                                       XEUS_QUICKJS_VERSION,
                                       "javascript",
                                       XEUS_QUICKJS_QUICKJS_VERSION,
                                       "text/javascript",
                                       ".js",
                                       "javascript",
                                       std::string("javascript"),
                                       "",
                                       banner,
                                       help_links);
    }

    nl::json interpreter::shutdown_request_impl(bool restart)
    {
        m_comms.clear();
        m_closed_comms.clear();
        return xeus::create_shutdown_reply(restart);
    }

    nl::json interpreter::interrupt_request_impl()
    {
        request_interrupt();
        return xeus::create_interrupt_reply();
    }

    void interpreter::set_request_context(xeus::xrequest_context context)
    {
        m_request_context = std::move(context);
    }

    const xeus::xrequest_context& interpreter::get_request_context() const noexcept
    {
        return m_request_context;
    }

    void interpreter::open_comm(const std::string& target_name,
                                const std::string& comm_id,
                                nl::json data,
                                nl::json metadata,
                                xeus::buffer_sequence buffers)
    {
        register_comm_target(target_name);
        const xeus::xtarget* target = comm_manager().target(target_name);
        auto comm = std::make_unique<xeus::xcomm>(target, xeus::xguid(comm_id));
        comm->open(std::move(metadata), std::move(data), std::move(buffers));
        add_comm(std::move(comm));
    }

    void interpreter::send_comm(const std::string& comm_id,
                                nl::json data,
                                nl::json metadata,
                                xeus::buffer_sequence buffers)
    {
        auto it = m_comms.find(comm_id);
        if (it == m_comms.end())
        {
            throw std::runtime_error("the comm " + comm_id + " is not open");
        }
        it->second->send(std::move(metadata), std::move(data), std::move(buffers));
    }

    void interpreter::close_comm(const std::string& comm_id,
                                 nl::json data,
                                 nl::json metadata,
                                 xeus::buffer_sequence buffers)
    {
        auto it = m_comms.find(comm_id);
        if (it == m_comms.end())
        {
            return;
        }
        it->second->close(std::move(metadata), std::move(data), std::move(buffers));
        m_closed_comms.push_back(std::move(it->second));
        m_comms.erase(it);
    }

    void interpreter::register_comm_target(const std::string& target_name)
    {
        if (comm_manager().target(target_name) != nullptr)
        {
            return;
        }
        // Comms opened by the frontend are handled by the JavaScript side
        comm_manager().register_comm_target(target_name,
            [this, target_name](xeus::xcomm&& comm, xeus::xmessage request)
            {
                const std::string comm_id = to_string(comm.id());
                add_comm(std::make_unique<xeus::xcomm>(std::move(comm)));
                set_request_context(xeus::xrequest_context(request.header(), request.identities()));

                m_interrupt_requested = false;
                m_interrupt_observed = false;
                const nl::json& content = request.content();
                JSValue args[5] = {
                    new_string(p_context, target_name),
                    new_string(p_context, comm_id),
                    new_string(p_context, content.value("data", nl::json::object()).dump()),
                    new_string(p_context, request.metadata().dump()),
                    from_buffers(p_context, request.buffers())
                };
                JSValue res = call_kernel("commOpened", 5, args);
                for (JSValue& arg : args)
                {
                    JS_FreeValue(p_context, arg);
                }
                if (JS_IsException(res))
                {
                    report_pending_exception();
                }
                JS_FreeValue(p_context, res);
                run_event_loop();
                JSValue finish_args[1] = { JS_NewBool(p_context, is_interrupted()) };
                JS_FreeValue(p_context, call_kernel("finish", 1, finish_args));
            });
    }

    void interpreter::add_comm(std::unique_ptr<xeus::xcomm> comm)
    {
        const std::string comm_id = to_string(comm->id());
        comm->on_message([this, comm_id](xeus::xmessage message)
        {
            handle_comm_message(comm_id, message, false);
        });
        comm->on_close([this, comm_id](xeus::xmessage message)
        {
            handle_comm_message(comm_id, message, true);
        });
        m_comms[comm_id] = std::move(comm);
    }

    void interpreter::handle_comm_message(const std::string& comm_id, const xeus::xmessage& message, bool close)
    {
        set_request_context(xeus::xrequest_context(message.header(), message.identities()));
        m_interrupt_requested = false;
        m_interrupt_observed = false;

        const nl::json& content = message.content();
        JSValue args[5] = {
            new_string(p_context, comm_id),
            new_string(p_context, content.value("data", nl::json::object()).dump()),
            new_string(p_context, message.metadata().dump()),
            from_buffers(p_context, message.buffers()),
            JS_NewBool(p_context, close)
        };
        JSValue res = call_kernel("commMessage", 5, args);
        for (JSValue& arg : args)
        {
            JS_FreeValue(p_context, arg);
        }
        if (JS_IsException(res))
        {
            report_pending_exception();
        }
        JS_FreeValue(p_context, res);

        // Run the timers and promises of the handlers, like for a cell
        run_event_loop();
        JSValue finish_args[1] = { JS_NewBool(p_context, is_interrupted()) };
        JS_FreeValue(p_context, call_kernel("finish", 1, finish_args));
        m_interrupt_requested = false;
        m_interrupt_observed = false;

        if (close)
        {
            auto it = m_comms.find(comm_id);
            if (it != m_comms.end())
            {
                m_closed_comms.push_back(std::move(it->second));
                m_comms.erase(it);
            }
        }
    }

    void interpreter::release_closed_comms()
    {
        m_closed_comms.clear();
    }

    JSValue interpreter::call_kernel(const char* method, int argc, JSValue* argv)
    {
        JSValue func = JS_GetPropertyStr(p_context, m_kernel, method);
        JSValue res = JS_Call(p_context, func, m_kernel, argc, argv);
        JS_FreeValue(p_context, func);
        return res;
    }

    nl::json interpreter::call_kernel_json(const char* method, int argc, JSValue* argv)
    {
        JSValue res = call_kernel(method, argc, argv);
        if (JS_IsException(res))
        {
            report_pending_exception();
            return nl::json();
        }
        nl::json json;
        try
        {
            json = to_json(p_context, res);
        }
        catch (const std::exception& e)
        {
            publish_stream("stderr", std::string("xeus-quickjs internal error: ") + e.what() + "\n");
        }
        JS_FreeValue(p_context, res);
        return json;
    }

    nl::json interpreter::call_with_deadline(const char* method, int argc, JSValue* argv, const nl::json& fallback)
    {
        m_deadline = std::chrono::steady_clock::now() + request_timeout;
        m_has_deadline = true;
        JSValue res = call_kernel(method, argc, argv);
        m_has_deadline = false;

        nl::json json = fallback;
        if (JS_IsException(res))
        {
            JS_FreeValue(p_context, JS_GetException(p_context));
        }
        else
        {
            try
            {
                json = to_json(p_context, res);
            }
            catch (const std::exception&)
            {
            }
        }
        JS_FreeValue(p_context, res);
        return json;
    }

    nl::json interpreter::evaluate_user_expressions(const nl::json& user_expressions)
    {
        nl::json results = nl::json::object();
        if (!user_expressions.is_object())
        {
            return results;
        }
        for (auto it = user_expressions.begin(); it != user_expressions.end(); ++it)
        {
            if (!it.value().is_string())
            {
                continue;
            }
            JSValue args[1] = { new_string(p_context, it.value().get<std::string>()) };
            results[it.key()] = call_kernel_json("evaluateExpression", 1, args);
            JS_FreeValue(p_context, args[0]);
        }
        return results;
    }

    void interpreter::run_event_loop()
    {
        while (true)
        {
            run_pending_jobs(0);
            report_unhandled_rejections();
            if (is_interrupted())
            {
                break;
            }

            JSValue res = call_kernel("nextTimerDelay", 0, nullptr);
            double delay = -1;
            if (JS_IsException(res))
            {
                report_pending_exception();
            }
            else
            {
                JS_ToFloat64(p_context, &delay, res);
            }
            JS_FreeValue(p_context, res);

            if (delay < 0)
            {
                // Nothing is scheduled anymore
                break;
            }
            else if (delay > 0)
            {
                wait_for(delay);
                continue;
            }

            res = call_kernel("runNextTimer", 0, nullptr);
            if (JS_IsException(res))
            {
                report_pending_exception();
            }
            JS_FreeValue(p_context, res);
        }

        if (is_interrupted())
        {
            // Let the rejection handlers report the interruption
            run_pending_jobs(max_jobs_after_interrupt);
            report_unhandled_rejections();
        }
    }

    void interpreter::run_pending_jobs(std::size_t max_jobs)
    {
        std::size_t count = 0;
        while (max_jobs == 0 || count < max_jobs)
        {
            JSContext* job_context = nullptr;
            int res = JS_ExecutePendingJob(p_runtime, &job_context);
            if (res == 0)
            {
                break;
            }
            else if (res < 0)
            {
                report_pending_exception();
            }
            ++count;
            if (max_jobs == 0 && m_interrupt_observed)
            {
                break;
            }
        }
    }

    void interpreter::report_unhandled_rejections()
    {
        auto rejections = std::move(m_unhandled_rejections);
        m_unhandled_rejections.clear();
        for (auto& rejection : rejections)
        {
            JSValue args[2] = { rejection.second, JS_TRUE };
            JSValue res = call_kernel("reportUncaught", 2, args);
            if (JS_IsException(res))
            {
                JS_FreeValue(p_context, JS_GetException(p_context));
            }
            JS_FreeValue(p_context, res);
            JS_FreeValue(p_context, rejection.first);
            JS_FreeValue(p_context, rejection.second);
        }
    }

    void interpreter::report_pending_exception()
    {
        JSValue exception = JS_GetException(p_context);
        if (!JS_IsNull(m_kernel) && !JS_IsUndefined(m_kernel) && !JS_IsException(m_kernel))
        {
            JSValue args[2] = { exception, JS_FALSE };
            JSValue res = call_kernel("reportUncaught", 2, args);
            if (!JS_IsException(res))
            {
                JS_FreeValue(p_context, res);
                JS_FreeValue(p_context, exception);
                return;
            }
            JS_FreeValue(p_context, JS_GetException(p_context));
        }
        // The runtime is not available: print what we can
        try
        {
            JSValue stack = JS_GetPropertyStr(p_context, exception, "stack");
            std::string message = to_string(p_context, exception);
            if (!JS_IsUndefined(stack))
            {
                message += "\n" + to_string(p_context, stack);
            }
            JS_FreeValue(p_context, stack);
            std::cerr << "xeus-quickjs: " << message << std::endl;
        }
        catch (const std::exception&)
        {
        }
        JS_FreeValue(p_context, exception);
    }

    void interpreter::wait_for(double milliseconds)
    {
        using clock = std::chrono::steady_clock;
        const auto end = clock::now() + std::chrono::duration_cast<clock::duration>(
            std::chrono::duration<double, std::milli>(milliseconds));
        while (!is_interrupted())
        {
            const auto now = clock::now();
            if (now >= end)
            {
                break;
            }
            std::this_thread::sleep_for(std::min<clock::duration>(end - now, std::chrono::milliseconds(10)));
        }
    }

    bool interpreter::is_interrupted() const noexcept
    {
        return m_interrupt_observed || m_interrupt_requested;
    }

    int interpreter::interrupt_handler(JSRuntime*, void* opaque)
    {
        auto* self = static_cast<interpreter*>(opaque);
        if (self->m_interrupt_requested.exchange(false))
        {
            // QuickJS throws an uncatchable error once: the error handlers
            // of the kernel must be able to run afterwards.
            self->m_interrupt_observed = true;
            return 1;
        }
        if (self->m_has_deadline && std::chrono::steady_clock::now() > self->m_deadline)
        {
            self->m_has_deadline = false;
            return 1;
        }
        return 0;
    }

    void interpreter::promise_rejection_tracker(JSContext* ctx,
                                                JSValueConst promise,
                                                JSValueConst reason,
                                                JS_BOOL is_handled,
                                                void* opaque)
    {
        auto* self = static_cast<interpreter*>(opaque);
        auto& rejections = self->m_unhandled_rejections;
        if (!is_handled)
        {
            rejections.emplace_back(JS_DupValue(ctx, promise), JS_DupValue(ctx, reason));
        }
        else
        {
            auto it = std::find_if(rejections.begin(), rejections.end(), [&](const auto& rejection)
            {
                return JS_VALUE_GET_PTR(rejection.first) == JS_VALUE_GET_PTR(promise);
            });
            if (it != rejections.end())
            {
                JS_FreeValue(ctx, it->first);
                JS_FreeValue(ctx, it->second);
                rejections.erase(it);
            }
        }
    }
}
