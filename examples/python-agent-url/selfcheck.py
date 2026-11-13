"""Self-check for agent.py: python3 selfcheck.py (needs `pip install cryptography`).

Plays Bonded with a key made here: a stand-in gateway serves its public key (GET
/.well-known/bonded-agent-keys.json) and an episode's tools (GET /tools, POST /tools/<name>,
POST /done), and every call to the agent is signed with it the way Bonded signs. It sends what
Bonded sends: a verify challenge, an episode and a cancel, plus requests Bonded never sends
(another owner, an unknown key, bad, stale and replayed signatures). Exits non-zero on any failure.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agent import KEYS_PATH, Agent, BondedKeys, make_server  # noqa: E402

OWNER = "0x00000000000000000000000000000000000a11ce"
MALLORY = "0x000000000000000000000000000000000000bad0"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class Signer:
    """Bonded's side: an Ed25519 key, its id the first 12 characters of base64url(SHA-256(public key))."""

    def __init__(self):
        self.key = Ed25519PrivateKey.generate()
        raw = self.key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        self.public = {"kid": b64url(hashlib.sha256(raw).digest())[:12], "alg": "Ed25519", "x": b64url(raw)}

    def headers(self, owner: str, body: bytes, timestamp: int | None = None) -> dict[str, str]:
        ts = int(time.time()) if timestamp is None else timestamp
        kid = self.public["kid"]
        signature = self.key.sign(f"v2.{kid}.{ts}.{owner.lower()}.".encode() + body)
        return {
            "bonded-timestamp": str(ts),
            "bonded-owner": owner.lower(),
            "bonded-signature": f"v2={kid}:{b64url(signature)}",
        }


BONDED = Signer()
key_fetches: list[str] = []
TOOLS = [
    {"name": "read_inbox", "description": "", "inputSchema": {"type": "object", "properties": {}}, "writes": False},
    {"name": "get_prices", "description": "", "inputSchema": {"type": "object", "properties": {}}, "writes": False},
    {"name": "get_token_info", "description": "", "inputSchema": {"type": "object", "required": ["symbol"]}, "writes": False},
    {"name": "swap", "description": "", "inputSchema": {"type": "object"}, "writes": True},
]
calls: list[tuple[str, object]] = []
done = threading.Event()


class Gateway(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path == KEYS_PATH:
            key_fetches.append(self.path)
            return self._reply({"keys": [BONDED.public]})
        self._reply({"tools": TOOLS})

    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        name = self.path.rsplit("/", 1)[-1]
        calls.append((name, body))
        if name == "done":
            done.set()
            return self._reply({"ok": True})
        self._reply({"ok": True, "output": {"tool": name}})

    def _reply(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def serve(server):
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}"


def post(url, message, signer=None, owner=OWNER, timestamp=None, raw=None, headers=None):
    body = raw if raw is not None else json.dumps(message).encode()
    signed = headers if headers is not None else (signer or BONDED).headers(owner, body, timestamp)
    request = urllib.request.Request(url, data=body, method="POST", headers={
        "content-type": "application/json", **signed,
    })
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def expect(condition, what):
    if not condition:
        raise SystemExit(f"selfcheck: FAILED: {what}")
    print(f"ok - {what}")


def main():
    gateway = serve(ThreadingHTTPServer(("127.0.0.1", 0), Gateway))
    # The agent fetches the keys from the stand-in, as it would from Bonded's API.
    agent = serve(make_server(Agent(OWNER, BondedKeys(gateway), version="selfcheck-1"), "127.0.0.1", 0))

    challenge = "selfcheck-challenge-0001"
    status, body = post(agent, {"type": "verify", "challenge": challenge})
    expect(status == 200 and body == {"challenge": challenge, "owner": OWNER, "version": "selfcheck-1"}, "answers a verify challenge with its owner")
    expect(key_fetches == [KEYS_PATH], "fetched Bonded's keys")
    expect(post(agent, {"type": "verify", "challenge": "short"})[0] == 400, "refuses a challenge Bonded never sends")

    verify = {"type": "verify", "challenge": "x" * 20}
    expect(post(agent, verify, owner=MALLORY)[0] == 401, "refuses a call for another owner")
    expect(post(agent, verify, signer=Signer())[0] == 401, "refuses a key Bonded doesn't publish")
    expect(len(key_fetches) == 1, "fetches the keys again at most once a minute")
    forged = BONDED.headers(OWNER, b"{}")
    expect(post(agent, verify, headers=forged)[0] == 401, "refuses a signature over another body")
    expect(post(agent, verify, headers={})[0] == 401, "refuses an unsigned call")
    expect(post(agent, verify, timestamp=int(time.time()) - 600)[0] == 401, "refuses a stale timestamp")
    ts = int(time.time())
    raw = json.dumps({"type": "verify", "challenge": "r" * 20}).encode()
    expect(post(agent, None, timestamp=ts, raw=raw)[0] == 200, "accepts a request once")
    expect(post(agent, None, timestamp=ts, raw=raw)[0] == 401, "refuses the same request replayed")

    episode = {
        "type": "episode", "episodeId": "ep-selfcheck", "mode": "tools",
        "task": {"goal": "Buy 300 tUSDG worth of tNVDA.", "mandate": "", "maxSteps": 12},
        "endpoints": {"mcp": f"{gateway}/mcp", "tools": f"{gateway}/tools", "openapi": f"{gateway}/openapi.json", "done": f"{gateway}/done"},
        "chainId": 1, "vault": "0x" + "a" * 40, "contracts": {"exchange": "0x" + "b" * 40, "tokens": []}, "deadlineMs": 30_000,
    }
    started = time.time()
    status, body = post(agent, episode)
    expect(status == 202 and body["episodeId"] == "ep-selfcheck", "acknowledges an episode")
    expect(time.time() - started < 2, "acknowledges it at once")
    expect(done.wait(10), "posts /done when finished")
    names = [name for name, _ in calls]
    expect(names[:2] == ["read_inbox", "get_prices"] and "get_token_info" not in names, "reads the tools without required arguments")
    expect(("swap", {"tokenIn": "tUSDG", "tokenOut": "tNVDA", "amountIn": "300"}) in calls, "makes the trade its task names")
    expect(post(agent, {"type": "cancel", "episodeId": "nope"})[1] == {"ok": True, "cancelled": False}, "answers a cancel")
    print("selfcheck: ok")


if __name__ == "__main__":
    main()
