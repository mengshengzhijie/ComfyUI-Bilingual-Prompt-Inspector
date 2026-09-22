import asyncio
import sys
import types
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]


def install_stubs():
    """ComfyUI 运行时缺席时也能测：只替身掉节点真正用到的两个模块。"""
    if "bpi_plugin" in sys.modules:
        return sys.modules["bpi_plugin"]

    comfy = types.ModuleType("comfy")
    model_management = types.ModuleType("comfy.model_management")

    class InterruptProcessingException(BaseException):
        pass

    state = {"interrupted": False}
    model_management.InterruptProcessingException = InterruptProcessingException
    model_management.processing_interrupted = lambda: state["interrupted"]
    model_management.set_interrupted = lambda value: state.__setitem__("interrupted", value)
    comfy.model_management = model_management

    server_module = types.ModuleType("server")

    class FakeRoutes:
        """路由注册只被丢掉，测试里不关心 HTTP 装配。"""

        def __getattr__(self, _name):
            def register(_path):
                return lambda handler: handler

            return register

    class FakeServer:
        def __init__(self):
            self.events = []
            self.routes = FakeRoutes()

        def send_sync(self, name, data, sid=None):
            self.events.append((name, data))

    class PromptServer:
        instance = FakeServer()

    server_module.PromptServer = PromptServer

    sys.modules["comfy"] = comfy
    sys.modules["comfy.model_management"] = model_management
    sys.modules["server"] = server_module

    import importlib.util

    spec = importlib.util.spec_from_file_location("bpi_plugin", PLUGIN_DIR / "__init__.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["bpi_plugin"] = module
    spec.loader.exec_module(module)
    return module


plugin = install_stubs()
server = sys.modules["bpi_plugin.server"]
nodes = sys.modules["bpi_plugin.nodes"]
model_management = sys.modules["comfy.model_management"]


class UpstreamGateTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        model_management.set_interrupted(False)
        server.upstream_gate.pending.clear()
        self.node = nodes.BilingualPromptInspector()

    def tearDown(self):
        server.upstream_gate.pending.clear()
        model_management.set_interrupted(False)

    async def test_release_returns_edited_text(self):
        future = server.upstream_gate.open("7", "prompt-1", "from upstream")
        self.assertTrue(server.upstream_gate.ack("7", "prompt-1"))
        self.assertTrue(server.upstream_gate.release("7", "prompt-1", text="edited by hand"))
        self.assertEqual(await future, "edited by hand")

    async def test_release_without_text_falls_back_to_upstream(self):
        future = server.upstream_gate.open("7", "prompt-1", "from upstream")
        self.assertTrue(server.upstream_gate.release("7", "prompt-1"))
        self.assertEqual(await future, "from upstream")

    async def test_unclaimed_wait_times_out(self):
        server.upstream_gate.handoff_timeout = 0.05
        future = server.upstream_gate.open("7", "prompt-1", "from upstream")
        self.assertIsNone(await server.upstream_gate.wait("7", future))
        self.assertEqual(server.upstream_gate.pending, {})

    async def test_ack_extends_the_deadline(self):
        server.upstream_gate.handoff_timeout = 0.05
        server.upstream_gate.wait_timeout = 5
        future = server.upstream_gate.open("7", "prompt-1", "from upstream")
        self.assertTrue(server.upstream_gate.ack("7", "prompt-1"))
        await asyncio.sleep(0.15)
        self.assertFalse(future.done())
        self.assertTrue(server.upstream_gate.release("7", "prompt-1", text="ok"))
        self.assertEqual(await future, "ok")

    async def test_cancel_interrupts_the_run(self):
        future = server.upstream_gate.open("7", "prompt-1", "from upstream")
        self.assertTrue(server.upstream_gate.release("7", "prompt-1", cancelled=True))
        with self.assertRaises(model_management.InterruptProcessingException):
            await future

    async def test_wait_raises_when_processing_interrupted(self):
        future = server.upstream_gate.open("7", "prompt-1", "from upstream")
        model_management.set_interrupted(True)
        with self.assertRaises(model_management.InterruptProcessingException):
            await server.upstream_gate.wait("7", future)
        self.assertEqual(server.upstream_gate.pending, {})

    async def test_node_without_upstream_passes_text_through(self):
        result = await self.node.pass_through("my prompt")
        self.assertEqual(result, ("my prompt",))
        self.assertEqual(server.upstream_gate.pending, {})

    async def test_node_announces_upstream_and_falls_back_to_passthrough(self):
        server.upstream_gate.handoff_timeout = 0.05
        fake_server = sys.modules["server"].PromptServer.instance
        fake_server.events.clear()

        result = await self.node.pass_through("my prompt", prompt="from upstream", unique_id="12")

        self.assertEqual(result, ("from upstream",))
        self.assertEqual(
            fake_server.events,
            [(server.UPSTREAM_ARRIVED_EVENT, {"node_id": "12", "text": "from upstream"})],
        )
        server.upstream_gate.handoff_timeout = server._UPSTREAM_HANDOFF_TIMEOUT

    async def test_node_returns_edited_text_when_released(self):
        async def claim_and_release():
            for _ in range(200):
                if "12" in server.upstream_gate.pending:
                    server.upstream_gate.release("12", text="edited by hand")
                    return True
                await asyncio.sleep(0)
            return False

        task = asyncio.create_task(claim_and_release())
        result = await self.node.pass_through("my prompt", prompt="from upstream", unique_id="12")
        self.assertTrue(await task)
        self.assertEqual(result, ("edited by hand",))


if __name__ == "__main__":
    unittest.main()
