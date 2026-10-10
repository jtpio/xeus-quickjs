/***************************************************************************
* Copyright (c) 2026, Jeremy Tuloup                                        *
*                                                                          *
* Distributed under the terms of the BSD 3-Clause License.                 *
*                                                                          *
* The full license is in the file LICENSE, distributed with this software. *
****************************************************************************/

#include <cstdlib>
#include <iostream>
#include <memory>
#include <string>
#include <utility>
#include <signal.h>

#ifdef __GNUC__
#include <stdio.h>
#include <execinfo.h>
#include <stdlib.h>
#include <unistd.h>
#endif

#include "xeus/xhelper.hpp"
#include "xeus/xkernel.hpp"
#include "xeus/xkernel_configuration.hpp"

#include "xeus-zmq/xserver_zmq_split.hpp"
#include "xeus-zmq/xzmq_context.hpp"

#include "xeus-quickjs/xinterpreter.hpp"
#include "xeus-quickjs/xeus_quickjs_config.hpp"

namespace
{
    xquickjs::interpreter* p_interpreter = nullptr;
}

#ifdef __GNUC__
void handler(int sig)
{
    void* array[10];

    // get void*'s for all entries on the stack
    size_t size = backtrace(array, 10);

    // print out all the frames to stderr
    fprintf(stderr, "Error: signal %d:\n", sig);
    backtrace_symbols_fd(array, size, STDERR_FILENO);
    exit(1);
}
#endif

// SIGINT interrupts the running code instead of stopping the kernel, like
// an interrupt_request message does.
void interrupt_handler(int /*sig*/)
{
    if (p_interpreter != nullptr)
    {
        p_interpreter->request_interrupt();
    }
}

std::unique_ptr<xeus::xlogger> make_file_logger(xeus::xlogger::level log_level)
{
    auto logfile = std::getenv("JUPYTER_LOGFILE");
    if (logfile == nullptr)
    {
        return nullptr;
    }
    return xeus::make_file_logger(log_level, logfile);
}

int main(int argc, char* argv[])
{
    if (xeus::should_print_version(argc, argv))
    {
        std::clog << "xquickjs " << XEUS_QUICKJS_VERSION << std::endl;
        return 0;
    }

    // If we are called from the Jupyter launcher, silence all logging. This
    // is important for a JupyterHub configured with cleanup_servers = False:
    // Upon restart, spawned single-user servers keep running but without the
    // std* streams. When a user then tries to start a new kernel, xquickjs
    // will get a SIGPIPE and exit.
    if (std::getenv("JPY_PARENT_PID") != NULL)
    {
        std::clog.setstate(std::ios_base::failbit);
    }

    // Registering SIGSEGV handler
#ifdef __GNUC__
    std::clog << "registering handler for SIGSEGV" << std::endl;
    signal(SIGSEGV, handler);
#endif
    signal(SIGINT, interrupt_handler);

    std::unique_ptr<xeus::xcontext> context = xeus::make_zmq_context();

    // Instantiating the xeus xinterpreter
    auto interpreter = std::make_unique<xquickjs::interpreter>();
    p_interpreter = interpreter.get();

    using history_manager_ptr = std::unique_ptr<xeus::xhistory_manager>;
    history_manager_ptr hist = xeus::make_in_memory_history_manager();

    std::string connection_filename = xeus::extract_filename(argc, argv);

    // The shell runs in the main thread while the control channel has its
    // own thread, so that interrupt requests reach a busy kernel.
    if (!connection_filename.empty())
    {
        xeus::xconfiguration config = xeus::load_configuration(connection_filename);

        xeus::xkernel kernel(config,
                             xeus::get_user_name(),
                             std::move(context),
                             std::move(interpreter),
                             xeus::make_xserver_shell_main,
                             std::move(hist),
                             xeus::make_console_logger(xeus::xlogger::msg_type,
                                                       make_file_logger(xeus::xlogger::content)));

        std::clog <<
            "Starting xeus-quickjs kernel...\n\n"
            "If you want to connect to this kernel from an other client, you can use"
            " the " + connection_filename + " file."
            << std::endl;

        kernel.start();
    }
    else
    {
        xeus::xkernel kernel(xeus::get_user_name(),
                             std::move(context),
                             std::move(interpreter),
                             xeus::make_xserver_shell_main,
                             std::move(hist),
                             nullptr);

        const auto& config = kernel.get_config();
        std::clog << xeus::get_start_message(config) << std::endl;

        kernel.start();
    }

    p_interpreter = nullptr;
    return 0;
}
