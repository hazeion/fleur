"""Owned command-protocol fixture for the actual guest verification command.

Load its committed functions without its executable main guard. All external
commands remain disposable in-memory protocol responses; no native tool runs.
"""
import ast
import json
from pathlib import Path
import sys

source = Path(__file__).resolve().parents[3] / "scripts/fresh-linux-guest.py"
tree = ast.parse(source.read_text())
tree.body = [node for node in tree.body if not isinstance(node, ast.Try)]
namespace = {}
exec(compile(tree, str(source), "exec"), namespace)
namespace["snapshot"] = lambda: {}
namespace["os"].urandom = lambda count: bytes.fromhex("b" * 32)
result = {"exitCode": 4, "result": {"formatVersion": 1, "command": "doctor", "ok": False,
          "truncated": False, "error": {"code": "PREREQUISITE_UNAVAILABLE"},
          "data": {"components": {"cli": {"state": "ready"}, "daemon": {"state": "ready"},
                   "compose": {"state": "ready"}, "smoke": {"state": "ready", "cleanup": True},
                   "release": {"state": "unverified"}}}}}
scenario = sys.argv[1]
components = result["result"]["data"]["components"]
if scenario == "failed-smoke":
    components["smoke"] = {"state": "failed", "cleanup": True, "reason": "image-identity"}
elif scenario == "missing-compose":
    components["compose"]["state"] = "missing"
elif scenario == "denied-daemon":
    components["daemon"]["state"] = "denied"
elif scenario == "missing-cli":
    components["cli"]["state"] = "missing"
elif scenario == "wrong-command":
    result["result"]["command"] = "setup"
elif scenario == "wrong-exit":
    result["exitCode"] = 0
elif scenario == "wrong-error":
    result["result"]["error"]["code"] = "READINESS_TIMEOUT"
elif scenario == "wrong-envelope":
    result["result"]["formatVersion"] = 2
elif scenario == "truncated":
    result["result"]["truncated"] = True
elif scenario == "wrong-ok":
    result["result"]["ok"] = True
elif scenario == "wrong-release":
    components["release"]["state"] = "ready"
elif scenario != "ready":
    raise AssertionError("Unknown fixture scenario")
# Fail the second repeat. The first successful result must not mask it.
calls = 0
healthy = json.loads(json.dumps(result))
healthy["exitCode"] = 4
healthy["result"] = {"formatVersion": 1, "command": "doctor", "ok": False, "truncated": False,
                     "error": {"code": "PREREQUISITE_UNAVAILABLE"}, "data": {"components": {
                     "cli": {"state": "ready"}, "daemon": {"state": "ready"}, "compose": {"state": "ready"},
                     "smoke": {"state": "ready", "cleanup": True}, "release": {"state": "unverified"}}}}
def command_json(name):
    global calls
    calls += 1
    return healthy if calls == 1 else result
namespace["command_json"] = command_json
cid = "a" * 64
identity = {"Id": cid, "Name": "/fleur-guest-unrelated-" + "b" * 32,
            "Config": {"Labels": {"dev.fleur.guest-sentinel": "b" * 32}}, "State": {"Running": False}}
restriction_calls = 0
def run(args, **kwargs):
    global restriction_calls
    if args[:3] == ["docker", "context", "show"]:
        return 0, "default", ""
    if args[:3] == ["docker", "context", "inspect"]:
        return 0, json.dumps({"Host": "unix:///var/run/docker.sock"}), ""
    if "ps" in args:
        return 0, "", ""
    if "create" in args or "rm" in args:
        return 0, cid, ""
    if "inspect" in args:
        return 0, json.dumps([identity]), ""
    if args[0] == "python3":
        restriction_calls += 1
        return 0, json.dumps({"bounded_probe_passed": True, "cleanup_complete": True}), ""
    if "-e" in args:
        return 0, "oven/bun@sha256:" + "c" * 64, ""
    raise AssertionError(args)
namespace["run"] = run
try:
    namespace["verify_smoke_and_restrictions"]({})
except RuntimeError as error:
    namespace["REPORT"]["error"] = str(error)
print(json.dumps({"report": namespace["REPORT"], "restrictionCalls": restriction_calls, "doctorCalls": calls}))
