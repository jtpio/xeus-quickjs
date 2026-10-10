/***************************************************************************
* Copyright (c) 2026, Jeremy Tuloup                                        *
*                                                                          *
* Distributed under the terms of the BSD 3-Clause License.                 *
*                                                                          *
* The full license is in the file LICENSE, distributed with this software. *
****************************************************************************/

#ifndef XQUICKJS_INTERPRETER_HPP
#define XQUICKJS_INTERPRETER_HPP

#include <atomic>
#include <chrono>
#include <cstdio>
#include <map>
#include <memory>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "nlohmann/json.hpp"

#include "xeus_quickjs_config.hpp"
#include "xeus/xcomm.hpp"
#include "xeus/xinterpreter.hpp"
#include "xeus/xrequest_context.hpp"

#include "quickjs.h"

namespace nl = nlohmann;

namespace xquickjs
{
    // Publishes some output of the C streams on the frontend, when the
    // kernel can not redirect them itself. Returns false when no kernel is
    // running.
    XEUS_QUICKJS_API bool publish_output(const std::string& name, const std::string& text);

    class XEUS_QUICKJS_API interpreter : public xeus::xinterpreter
    {
    public:

        interpreter();
        virtual ~interpreter();

        // Asks the running code to stop. Safe to call from another thread
        // or from a signal handler.
        void request_interrupt() noexcept;

        bool allow_stdin() const noexcept;

        // Comms, used by the JavaScript side of the kernel
        void open_comm(const std::string& target_name,
                       const std::string& comm_id,
                       nl::json data,
                       nl::json metadata,
                       xeus::buffer_sequence buffers);
        void send_comm(const std::string& comm_id,
                       nl::json data,
                       nl::json metadata,
                       xeus::buffer_sequence buffers);
        void close_comm(const std::string& comm_id,
                        nl::json data,
                        nl::json metadata,
                        xeus::buffer_sequence buffers);
        void register_comm_target(const std::string& target_name);

    private:

        void configure_impl() override;

        void execute_request_impl(send_reply_callback cb,
                                  int execution_counter,
                                  const std::string& code,
                                  xeus::execute_request_config config,
                                  nl::json user_expressions) override;

        nl::json complete_request_impl(const std::string& code, int cursor_pos) override;

        nl::json inspect_request_impl(const std::string& code,
                                      int cursor_pos,
                                      int detail_level) override;

        nl::json is_complete_request_impl(const std::string& code) override;

        nl::json kernel_info_request_impl() override;

        nl::json shutdown_request_impl(bool restart) override;

        nl::json interrupt_request_impl() override;

        // xeus only sets the request context for execute requests: the comm
        // messages set it too, so that the outputs of their handlers have the
        // right parent message.
        void set_request_context(xeus::xrequest_context context) override;
        const xeus::xrequest_context& get_request_context() const noexcept override;

        // Evaluates an embedded script and returns its completion value.
        JSValue eval_internal(const char* source, std::size_t size, const char* filename);

        // Calls a method of the JavaScript side of the kernel.
        JSValue call_kernel(const char* method, int argc, JSValue* argv);
        // Same as call_kernel, for methods returning a JSON string.
        nl::json call_kernel_json(const char* method, int argc, JSValue* argv);

        // Runs promise jobs and timers until there is nothing left to do,
        // or until the execution is interrupted.
        void run_event_loop();
        void run_pending_jobs(std::size_t max_jobs);
        void report_unhandled_rejections();
        void report_pending_exception();
        void wait_for(double milliseconds);
        bool is_interrupted() const noexcept;

        // Calls the JavaScript side of the kernel with a deadline, for
        // requests that evaluate user code but must not block the kernel.
        nl::json call_with_deadline(const char* method, int argc, JSValue* argv, const nl::json& fallback);

        nl::json evaluate_user_expressions(const nl::json& user_expressions);

        void add_comm(std::unique_ptr<xeus::xcomm> comm);
        void handle_comm_message(const std::string& comm_id, const xeus::xmessage& message, bool close);
        void release_closed_comms();

        // Sends what is written to the C stdout and stderr streams, for
        // instance by std.printf, to the frontend.
        void redirect_output();
        void restore_output();

        static int interrupt_handler(JSRuntime* runtime, void* opaque);
        static void promise_rejection_tracker(JSContext* ctx,
                                              JSValueConst promise,
                                              JSValueConst reason,
                                              JS_BOOL is_handled,
                                              void* opaque);

        xeus::xrequest_context m_request_context;

        JSRuntime* p_runtime;
        JSContext* p_context;
        JSValue m_kernel;

        // Rejected promises that do not have a handler (yet).
        std::vector<std::pair<JSValue, JSValue>> m_unhandled_rejections;

        std::atomic<bool> m_interrupt_requested;
        bool m_interrupt_observed;
        bool m_has_deadline;
        std::chrono::steady_clock::time_point m_deadline;

        // allow stdin for the current request
        bool m_allow_stdin;

    public:

        struct stream_redirection
        {
            interpreter* p_interpreter;
            const char* m_name;
            FILE* p_original;
            std::thread::id m_thread_id;
        };

    private:

        // The comms of the kernel, by id. Closed comms are released later, as
        // they can be closed by their own message handler.
        std::map<std::string, std::unique_ptr<xeus::xcomm>> m_comms;
        std::vector<std::unique_ptr<xeus::xcomm>> m_closed_comms;

        stream_redirection m_stdout_redirection;
        stream_redirection m_stderr_redirection;
        FILE* p_original_stdout;
        FILE* p_original_stderr;
    };
}

#endif
