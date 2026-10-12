#############################################################################
# Copyright (c) 2026, Jeremy Tuloup                                         #
#                                                                           #
# Distributed under the terms of the BSD 3-Clause License.                  #
#                                                                           #
# The full license is in the file LICENSE, distributed with this software.  #
#############################################################################

import re
import threading
import time
import unittest
from queue import Empty

import jupyter_kernel_test
from jupyter_kernel_test.msgspec_v5 import validate_message


ANSI = re.compile(r"\x1b\[[0-9;]*m")


def strip_ansi(text):
    return ANSI.sub("", text)


class XQuickJSTests(jupyter_kernel_test.KernelTests):

    kernel_name = "xquickjs"
    language_name = "javascript"
    file_extension = ".js"

    code_hello_world = "console.log('hello, world')"
    code_stderr = "console.error('error')"

    completion_samples = [
        {"text": "Math.ma", "matches": {"max"}},
        {"text": "console.lo", "matches": {"log"}},
        {"text": "retu", "matches": {"return"}},
    ]

    complete_code_samples = ["1 + 1", "function foo() { return 1 }", "const x = [1, 2, 3]"]
    incomplete_code_samples = ["function foo() {", "const x = [1, 2,", "`template", "/* comment"]
    invalid_code_samples = ["const x = )", "1 +* 2"]

    code_generate_error = "throw new Error('boom')"

    code_execute_result = [
        {"code": "1 + 2"},
        {"code": "'hello'"},
        {"code": "[1, 2, 3]"},
    ]

    code_display_data = [
        {"code": "display.html('<b>bold</b>')", "mime": "text/html"},
        {"code": "display.markdown('# Title')", "mime": "text/markdown"},
        {"code": "display.svg('<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>')", "mime": "image/svg+xml"},
        {"code": "display.json({ a: 1 })", "mime": "application/json"},
        {"code": "display.latex('$x^2$')", "mime": "text/latex"},
    ]

    # The in-memory history of xeus does not handle ranges and unique
    # searches like IPython
    supported_history_operations = ("tail",)

    code_inspect_sample = "Math.max"

    code_clear_output = "clearOutput()"

    # Helpers

    def flush_channels(self):
        # xeus publishes an "interrupt" message on iopub when it handles an
        # interrupt request, which is not part of the protocol, and the
        # validator does not know about comm messages
        for channel in (self.kc.shell_channel, self.kc.iopub_channel):
            while True:
                try:
                    msg = channel.get_msg(timeout=0.1)
                except Empty:
                    break
                if msg["msg_type"] not in ("interrupt", "comm_open", "comm_msg", "comm_close"):
                    validate_message(msg)

    def execute(self, code, **kwargs):
        # Unlike execute_helper, supports all the options of execute requests
        self.flush_channels()
        msg_id = self.kc.execute(code, **kwargs)
        reply = self.get_non_kernel_info_reply(timeout=30)
        output_msgs = []
        while True:
            msg = self.kc.get_iopub_msg(timeout=30)
            if msg["parent_header"].get("msg_id") != msg_id:
                continue
            if msg["msg_type"] == "status" and msg["content"]["execution_state"] == "idle":
                break
            if msg["msg_type"] not in ("status", "execute_input"):
                output_msgs.append(msg)
        return reply, output_msgs

    def execute_result(self, code):
        reply, output_msgs = self.execute(code)
        self.assertEqual(reply["content"]["status"], "ok")
        results = [msg for msg in output_msgs if msg["msg_type"] == "execute_result"]
        self.assertEqual(len(results), 1)
        return results[0]["content"]["data"]

    def plain_result(self, code):
        return strip_ansi(self.execute_result(code)["text/plain"])

    def streams(self, output_msgs, name="stdout"):
        return "".join(
            msg["content"]["text"]
            for msg in output_msgs
            if msg["msg_type"] == "stream" and msg["content"]["name"] == name
        )

    def error(self, code):
        reply, output_msgs = self.execute(code)
        self.assertEqual(reply["content"]["status"], "error")
        errors = [msg for msg in output_msgs if msg["msg_type"] == "error"]
        self.assertEqual(len(errors), 1)
        return errors[0]["content"]

    # Execution

    def test_last_expression(self):
        self.assertEqual(self.plain_result("const a = 1;\nconst b = 2;\na + b"), "3")
        self.assertEqual(self.plain_result("'Hello, ' + 'JavaScript!'"), "'Hello, JavaScript!'")

    def test_no_result(self):
        for code in ["const a = 1;", "let b = 2", "function f() {}", "1 + 1;", "// comment", ""]:
            with self.subTest(code=code):
                reply, output_msgs = self.execute(code)
                self.assertEqual(reply["content"]["status"], "ok")
                self.assertFalse([msg for msg in output_msgs if msg["msg_type"] == "execute_result"])

    def test_redeclaration(self):
        for code in ["const x = 1", "let x = 2", "const x = 3", "class X {}", "class X { y() { return x } }"]:
            with self.subTest(code=code):
                reply, _ = self.execute(code)
                self.assertEqual(reply["content"]["status"], "ok")
        self.assertEqual(self.plain_result("new X().y()"), "3")

    def test_object_literal(self):
        self.assertEqual(self.plain_result("{ a: 1, b: 'two' }"), "{ a: 1, b: 'two' }")

    def test_formatting(self):
        samples = {
            "new Map([['a', 1]])": "Map(1) { 'a' => 1 }",
            "new Set([1, 2])": "Set(2) { 1, 2 }",
            "10n ** 20n": "100000000000000000000n",
            "[undefined, null, -0, NaN]": "[ undefined, null, -0, NaN ]",
            "function foo() {}; foo": "[Function: foo]",
            "class A {}; class B extends A {}; B": "[class B extends A]",
            "new Uint8Array([1, 2])": "Uint8Array(2) [ 1, 2 ]",
            "Object.create(null)": "[Object: null prototype] {}",
            "const o = { name: 'o' }; o.self = o; o": "{ name: 'o', self: [Circular] }",
            "({ a: { b: { c: { d: 1 } } } })": "{ a: { b: { c: [Object] } } }",
            "Promise.resolve(42)": "Promise { 42 }",
            "new Date(0)": "1970-01-01T00:00:00.000Z",
            "/ab+c/gi": "/ab+c/gi",
        }
        for code, expected in samples.items():
            with self.subTest(code=code):
                self.assertEqual(self.plain_result(code), expected)

    def test_last_value(self):
        self.execute_result("6 * 7")
        self.assertEqual(self.plain_result("_ + 1"), "43")

    def test_top_level_await(self):
        result = self.plain_result("await new Promise(resolve => setTimeout(() => resolve('done'), 100))")
        self.assertEqual(result, "'done'")

    def test_timers(self):
        # The delays leave room for the sleeps of slow CI runners
        code = "\n".join([
            "setTimeout(() => console.log('second'), 300);",
            "setTimeout(() => console.log('first'), 200);",
            "let ticks = 0;",
            "const id = setInterval(() => { if (++ticks === 3) { clearInterval(id); console.log('ticks', ticks) } }, 10);",
            "'sync'",
        ])
        reply, output_msgs = self.execute(code)
        self.assertEqual(reply["content"]["status"], "ok")
        self.assertEqual(strip_ansi(self.streams(output_msgs)), "ticks 3\nfirst\nsecond\n")

    def test_microtasks(self):
        reply, output_msgs = self.execute(
            "queueMicrotask(() => console.log('microtask')); Promise.resolve().then(() => console.log('then'));"
        )
        self.assertEqual(self.streams(output_msgs), "microtask\nthen\n")

    def test_es_modules(self):
        code = "\n".join([
            "import * as std from 'std';",
            "const path = 'xquickjs_test_module.mjs';",
            "const file = std.open(path, 'w');",
            "file.puts('export const answer = 42; export default function hello(name) { return `Hello ${name}` }');",
            "file.close();",
        ])
        reply, _ = self.execute(code)
        self.assertEqual(reply["content"]["status"], "ok")
        try:
            self.assertEqual(
                self.plain_result("import hello, { answer } from './xquickjs_test_module.mjs';\n[hello('QuickJS'), answer]"),
                "[ 'Hello QuickJS', 42 ]",
            )
        finally:
            self.execute("import * as os from 'os'; os.remove('xquickjs_test_module.mjs');")

    # Streams

    def test_console(self):
        reply, output_msgs = self.execute(
            "console.log('a', 1, { b: [2] }); console.info('%s is %d', 'x', 42); console.warn('warning')"
        )
        self.assertEqual(strip_ansi(self.streams(output_msgs)), "a 1 { b: [ 2 ] }\nx is 42\n")
        self.assertEqual(self.streams(output_msgs, "stderr"), "warning\n")

    def test_console_group_and_count(self):
        reply, output_msgs = self.execute(
            "console.group('group'); console.log('inside'); console.groupEnd(); console.count(); console.count()"
        )
        self.assertEqual(strip_ansi(self.streams(output_msgs)), "group\n  inside\ndefault: 1\ndefault: 2\n")

    def test_console_table(self):
        reply, output_msgs = self.execute("console.table([{ a: 1, b: 'x' }, { a: 2 }])")
        displays = [msg for msg in output_msgs if msg["msg_type"] == "display_data"]
        self.assertEqual(len(displays), 1)
        self.assertIn("<table>", displays[0]["content"]["data"]["text/html"])
        self.assertIn("│ (index) │ a │", displays[0]["content"]["data"]["text/plain"])

    def test_quickjs_std_output(self):
        reply, output_msgs = self.execute(
            "import * as std from 'std'; std.printf('%d-%s\\n', 1, 'two'); std.err.puts('to stderr\\n')"
        )
        self.assertEqual(self.streams(output_msgs), "1-two\n")
        self.assertEqual(self.streams(output_msgs, "stderr"), "to stderr\n")

    # Errors

    def test_error_traceback(self):
        error = self.error("function outer() { inner() }\nfunction inner() { throw new TypeError('bad') }\nouter()")
        self.assertEqual(error["ename"], "TypeError")
        self.assertEqual(error["evalue"], "bad")
        traceback = [strip_ansi(line) for line in error["traceback"]]
        self.assertRegex(traceback[0], r"^In\[\d+\]:2$")
        self.assertEqual(traceback[1], "function inner() { throw new TypeError('bad') }")
        self.assertTrue(traceback[2].strip() == "^")
        self.assertIn("TypeError: bad", traceback)
        self.assertTrue(any(line.startswith("    at inner (In[") for line in traceback))
        self.assertTrue(any(line.startswith("    at outer (In[") for line in traceback))

    def test_syntax_error(self):
        error = self.error("const = 1")
        self.assertEqual(error["ename"], "SyntaxError")

    def test_throw_value(self):
        error = self.error("throw { code: 42 }")
        self.assertEqual(error["ename"], "Uncaught")
        self.assertEqual(error["evalue"], "{ code: 42 }")

    def test_error_in_timer(self):
        error = self.error("setTimeout(() => { throw new RangeError('later') }, 10)")
        self.assertEqual(error["ename"], "RangeError")
        self.assertIn("Uncaught RangeError: later", [strip_ansi(line) for line in error["traceback"]])

    def test_unhandled_rejection(self):
        error = self.error("Promise.reject(new Error('rejected')); 1")
        self.assertEqual(error["evalue"], "rejected")
        self.assertIn("Uncaught (in promise) Error: rejected", [strip_ansi(line) for line in error["traceback"]])

    def test_unsettled_top_level_await(self):
        error = self.error("await new Promise(() => {})")
        self.assertEqual(error["ename"], "UnsettledTopLevelAwait")

    # Rich display

    def test_rich_repr(self):
        data = self.execute_result("({ _toHtml() { return '<b>html</b>' }, _toMarkdown() { return '*md*' } })")
        self.assertEqual(data["text/html"], "<b>html</b>")
        self.assertEqual(data["text/markdown"], "*md*")
        self.assertIn("text/plain", data)

    def test_jupyter_display_symbol(self):
        data = self.execute_result("({ [Symbol.for('Jupyter.display')]() { return { 'text/html': '<i>i</i>' } } })")
        self.assertEqual(data["text/html"], "<i>i</i>")

    def test_display_template(self):
        reply, output_msgs = self.execute("const n = 3; display.html`<b>${n * 2}</b>`")
        self.assertEqual(output_msgs[0]["msg_type"], "display_data")
        self.assertEqual(output_msgs[0]["content"]["data"]["text/html"], "<b>6</b>")

    def test_display_png_bytes(self):
        reply, output_msgs = self.execute("display.png(new Uint8Array([137, 80, 78, 71]), { width: 10 })")
        content = output_msgs[0]["content"]
        self.assertEqual(content["data"]["image/png"], "iVBORw==")
        self.assertEqual(content["metadata"], {"image/png": {"width": 10}})

    def test_update_display(self):
        reply, output_msgs = self.execute(
            "const handle = display.html('<b>0</b>', { id: 'counter' });\nhandle.update('<b>1</b>');"
        )
        self.assertEqual([msg["msg_type"] for msg in output_msgs], ["display_data", "update_display_data"])
        self.assertEqual(output_msgs[0]["content"]["transient"], {"display_id": "counter"})
        self.assertEqual(output_msgs[1]["content"]["transient"], {"display_id": "counter"})
        self.assertEqual(output_msgs[1]["content"]["data"]["text/html"], "<b>1</b>")

    # Introspection

    def test_complete_types(self):
        self.execute("const myValue = 1; function myFunction() {}; class MyClass {}")
        self.flush_channels()
        self.kc.complete("my", 2)
        reply = self.get_non_kernel_info_reply()
        self.assertEqual(reply["content"]["matches"], ["myFunction", "myValue"])
        self.kc.complete("My", 2)
        reply = self.get_non_kernel_info_reply()
        types = reply["content"]["metadata"]["_jupyter_types_experimental"]
        self.assertEqual(types[0]["text"], "MyClass")
        self.assertEqual(types[0]["type"], "class")

    def test_complete_unicode(self):
        self.execute("const café = 1; const caféCrème = 2")
        self.flush_channels()
        code = "'☕'; caf"
        self.kc.complete(code, len(code))
        reply = self.get_non_kernel_info_reply()
        self.assertEqual(reply["content"]["matches"], ["café", "caféCrème"])
        self.assertEqual(reply["content"]["cursor_start"], len(code) - 3)
        self.assertEqual(reply["content"]["cursor_end"], len(code))

    def test_inspect_docstring(self):
        self.execute("/** Adds two numbers. */\nfunction add(a, b = 1) { return a + b }")
        self.flush_channels()
        self.kc.inspect("add(", 4)
        reply = self.get_non_kernel_info_reply()
        self.assertTrue(reply["content"]["found"])
        text = strip_ansi(reply["content"]["data"]["text/plain"])
        self.assertIn("Signature: add(a, b = 1)", text)
        self.assertIn("Docstring: Adds two numbers.", text)

    def test_user_expressions(self):
        reply, _ = self.execute("const ue = 21", user_expressions={"double": "ue * 2", "bad": "nope"})
        expressions = reply["content"]["user_expressions"]
        self.assertEqual(expressions["double"]["status"], "ok")
        self.assertEqual(expressions["double"]["data"]["text/plain"], "42")
        self.assertEqual(expressions["bad"]["status"], "error")

    # Input

    def test_prompt(self):
        def answer():
            msg = self.kc.get_stdin_msg(timeout=10)
            self.assertEqual(msg["content"]["prompt"], "Name? ")
            self.kc.input("Ada")

        thread = threading.Thread(target=answer)
        thread.start()
        reply, output_msgs = self.execute("const name = prompt('Name? '); `Hello ${name}`", allow_stdin=True)
        thread.join()
        results = [msg for msg in output_msgs if msg["msg_type"] == "execute_result"]
        self.assertEqual(strip_ansi(results[0]["content"]["data"]["text/plain"]), "'Hello Ada'")

    # Widgets

    def send_comm_msg(self, comm_id, data):
        msg = self.kc.session.msg("comm_msg", {"comm_id": comm_id, "data": data})
        self.kc.shell_channel.send(msg)
        output_msgs = []
        while True:
            reply = self.kc.get_iopub_msg(timeout=10)
            if reply["parent_header"].get("msg_id") != msg["header"]["msg_id"]:
                continue
            if reply["msg_type"] == "status" and reply["content"]["execution_state"] == "idle":
                break
            if reply["msg_type"] != "status":
                output_msgs.append(reply)
        return output_msgs

    def test_widget(self):
        reply, output_msgs = self.execute(
            "const slider = new Jupyter.widgets.IntSlider({ value: 5, max: 10, description: 'n' });\n"
            "slider.observe(({ old, new: value }) => console.log(old, '->', value), 'value');\n"
            "slider"
        )
        self.assertEqual(reply["content"]["status"], "ok")
        opened = {
            msg["content"]["data"]["state"]["_model_name"]: msg["content"]
            for msg in output_msgs
            if msg["msg_type"] == "comm_open"
        }
        self.assertEqual(set(opened), {"LayoutModel", "SliderStyleModel", "IntSliderModel"})
        state = opened["IntSliderModel"]["data"]["state"]
        self.assertEqual(state["value"], 5)
        self.assertEqual(state["max"], 10)
        self.assertEqual(state["layout"], "IPY_MODEL_" + opened["LayoutModel"]["comm_id"])
        self.assertEqual(opened["IntSliderModel"]["target_name"], "jupyter.widget")

        data = [msg for msg in output_msgs if msg["msg_type"] == "execute_result"][0]["content"]["data"]
        view = data["application/vnd.jupyter.widget-view+json"]
        self.assertEqual(view["model_id"], opened["IntSliderModel"]["comm_id"])

        # The frontend changes the value
        output_msgs = self.send_comm_msg(view["model_id"], {"method": "update", "state": {"value": 7}, "buffer_paths": []})
        self.assertEqual(strip_ansi(self.streams(output_msgs)), "5 -> 7\n")
        self.assertEqual(self.plain_result("slider.value"), "7")

        # The kernel changes the value
        reply, output_msgs = self.execute("slider.value = 9;")
        updates = [msg["content"]["data"] for msg in output_msgs if msg["msg_type"] == "comm_msg"]
        self.assertEqual(updates, [{"method": "update", "state": {"value": 9}, "buffer_paths": []}])

    def test_widget_button_output(self):
        reply, output_msgs = self.execute(
            "const { Button, Output, VBox } = Jupyter.widgets;\n"
            "const button = new Button({ description: 'Click' });\n"
            "const out = new Output();\n"
            "button.onClick(out.capture(() => console.log('clicked')));\n"
            "new VBox({ children: [button, out] })"
        )
        self.assertEqual(reply["content"]["status"], "ok")
        ids = {
            msg["content"]["data"]["state"]["_model_name"]: msg["content"]["comm_id"]
            for msg in output_msgs
            if msg["msg_type"] == "comm_open"
        }
        output_msgs = self.send_comm_msg(ids["ButtonModel"], {"method": "custom", "content": {"event": "click"}})
        types = [msg["msg_type"] for msg in output_msgs]
        self.assertEqual(types, ["comm_msg", "stream", "comm_msg"])
        # The output widget captures the outputs of the click message
        click_id = output_msgs[1]["parent_header"]["msg_id"]
        self.assertEqual(output_msgs[0]["content"]["data"]["state"], {"msg_id": click_id})
        self.assertEqual(output_msgs[1]["content"]["text"], "clicked\n")
        self.assertEqual(output_msgs[2]["content"]["data"]["state"], {"msg_id": ""})

    def test_widget_closed_by_frontend(self):
        reply, output_msgs = self.execute("const closed = new Jupyter.widgets.IntSlider({ value: 1 }); closed")
        model_id = [msg for msg in output_msgs if msg["msg_type"] == "execute_result"][0]["content"]["data"][
            "application/vnd.jupyter.widget-view+json"
        ]["model_id"]
        # A frontend without widget manager closes the comm
        msg = self.kc.session.msg("comm_close", {"comm_id": model_id, "data": {}})
        self.kc.shell_channel.send(msg)
        self.assertEqual(self.plain_result("closed.value = 2; closed.value"), "2")

    def test_comm_target(self):
        self.execute(
            "Jupyter.Comm.registerTarget('echo', (comm, { data }) => {\n"
            "  comm.onMsg = message => comm.send({ echo: message, opened: data });\n"
            "})"
        )
        msg = self.kc.session.msg("comm_open", {"comm_id": "echo-1", "target_name": "echo", "data": {"a": 1}})
        self.kc.shell_channel.send(msg)
        output_msgs = self.send_comm_msg("echo-1", {"b": 2})
        self.assertEqual(output_msgs[-1]["msg_type"], "comm_msg")
        self.assertEqual(output_msgs[-1]["content"]["data"], {"echo": {"b": 2}, "opened": {"a": 1}})

    # Interrupt

    def interrupt_after(self, code, delay=0.5):
        self.flush_channels()
        msg_id = self.kc.execute(code)
        time.sleep(delay)
        self.km.interrupt_kernel()
        reply = self.get_non_kernel_info_reply(timeout=10)
        self.assertEqual(reply["parent_header"]["msg_id"], msg_id)
        return reply

    def test_interrupt_loop(self):
        reply = self.interrupt_after("let spins = 0; while (true) { spins++ }")
        self.assertEqual(reply["content"]["status"], "error")
        self.assertEqual(reply["content"]["ename"], "InternalError")
        self.assertEqual(self.plain_result("spins > 0"), "true")

    def test_interrupt_interval(self):
        reply = self.interrupt_after("setInterval(() => {}, 10)")
        self.assertEqual(reply["content"]["status"], "error")
        self.assertEqual(self.plain_result("'alive'"), "'alive'")


if __name__ == "__main__":
    unittest.main()
