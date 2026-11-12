"""A Bonded Agent URL endpoint in plain Python (the standard library, plus `cryptography`).

Bonded POSTs one signed JSON message per call:

- {"type": "verify", "challenge": ...}  when you save the URL: answer 200 {"challenge", "owner",
                                        "version"}, where owner is your wallet.
- {"type": "episode", ...}              an Arena episode: answer 2xx within 10 seconds, then work.
- {"type": "cancel", "episodeId": ...}  stop that episode (best effort).

Every call is signed by Bonded's own Ed25519 key, for the wallet that saved the URL:

- `bonded-timestamp`: unix seconds;
- `bonded-owner`: that wallet, lowercase;
- `bonded-signature: v2=<key id>:<base64url signature>` over "v2.<key id>.<timestamp>.<owner>.<raw body>".

Bonded's public keys are at <api>/.well-known/bonded-agent-keys.json. Check the call before
reading the message: an unsigned request could be anyone, and a call for another wallet is someone
trying to claim your URL as theirs.

Run it:  BONDED_AGENT_OWNER=0xYourWallet PORT=8080 python3 agent.py

BONDED_AGENT_OWNER is the wallet you save the URL from on Bonded: public, not a secret.
BONDED_API_URL (optional) is where the keys are fetched: Bonded's API by default, or a local
Arena's gateway.
"""

from __future__ import annotations

import base64
import json
import os
import re
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

DEFAULT_API_URL = "https://api-production-ba50.up.railway.app"
KEYS_PATH = "/.well-known/bonded-agent-keys.json"
TOLERANCE_SECONDS = 300
MAX_BODY_BYTES = 1024 * 1024
OWNER = re.compile(r"0x[0-9a-fA-F]{40}")
SIGNATURE = re.compile(r"v2=([A-Za-z0-9_-]{4,64}):([A-Za-z0-9_-]{86})")


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def fetch_json(url: str) -> object:
    with urllib.request.urlopen(url, timeout=10) as response:
        return json.loads(response.read())


class BondedKeys:
    """Bonded's public keys by id, from <api>/.well-known/bonded-agent-keys.json.

    Fetched on first use, again after a day, and again at once when a call names a key not seen
    yet (at most once a minute), so a new key works the day Bonded starts signing with it.
    """

    def __init__(self, api_url: str = DEFAULT_API_URL, fetch: Callable[[str], object] = fetch_json):
        self.url = api_url.rstrip("/") + KEYS_PATH
        self.fetch = fetch
        self.keys: dict[str, Ed25519PublicKey] = {}
        self.fetched_at: float | None = None
        self.lock = threading.Lock()

    def get(self, kid: str) -> Ed25519PublicKey | None:
        with self.lock:
            now = time.monotonic()
            age = None if self.fetched_at is None else now - self.fetched_at
            if age is None or age > 86_400 or (kid not in self.keys and age >= 60):
                self.fetched_at = now
                try:
                    key_set = self.fetch(self.url)
                    self.keys = {
                        k["kid"]: Ed25519PublicKey.from_public_bytes(b64url_decode(k["x"]))
                        for k in key_set["keys"]
                        if k.get("alg") == "Ed25519"
                    }
                except Exception as error:  # noqa: BLE001 - keep the keys we had
                    print(f"couldn't fetch Bonded's keys from {self.url}: {error}", flush=True)
            return self.keys.get(kid)


class SignatureChecker:
    """Checks that a call is signed by Bonded for this agent's owner, and refuses replays."""

    def __init__(self, owner: str, keys: BondedKeys, tolerance: int = TOLERANCE_SECONDS):
        self.owner = owner.lower()
        self.keys = keys
        self.tolerance = tolerance
        self.seen: dict[str, int] = {}
        self.lock = threading.Lock()

    def check(self, headers, body: bytes, now: float | None = None) -> str | None:
        """None when the call is Bonded's, for this owner; otherwise why not."""
        timestamp = headers.get("bonded-timestamp")
        owner = (headers.get("bonded-owner") or "").strip().lower()
        signature = headers.get("bonded-signature")
        if not timestamp or not owner or not signature:
            return "the call is not signed"
        if not re.fullmatch(r"\d{1,12}", timestamp.strip()):
            return "malformed bonded-timestamp"
        now = int(time.time() if now is None else now)
        if abs(now - int(timestamp)) > self.tolerance:
            return "the timestamp is too far from this server's clock"
        # Calls for anyone else's wallet are refused: nobody can claim this URL as theirs.
        if owner != self.owner:
            return "this call is for another owner's agent, not this one's"
        parts = [m for m in (SIGNATURE.fullmatch(p.strip()) for p in signature.split(",")) if m]
        if not parts or len(parts) > 4:
            return "no v2 signature"
        matched = None
        for match in parts:
            kid, sig = match.group(1), match.group(2)
            key = self.keys.get(kid)
            if key is None:
                continue
            payload = f"v2.{kid}.{int(timestamp)}.{owner}.".encode() + body
            try:
                key.verify(b64url_decode(sig), payload)
            except InvalidSignature:
                continue
            matched = sig
            break
        if matched is None:
            return "the signature doesn't match any of Bonded's keys"
        with self.lock:
            for k, expires in list(self.seen.items()):
                if expires < now:
                    del self.seen[k]
            if matched in self.seen:
                return "this request was already received (replayed)"
            self.seen[matched] = int(timestamp) + self.tolerance
        return None


def http_json(method: str, url: str, body: object | None = None, timeout: float = 30) -> object:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read() or b"null")


TASK_TRADE = re.compile(r"\bbuy\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+(t[A-Z]{3,5})\s+worth\s+of\s+(t[A-Z]{3,5})\b", re.I)


def run_episode(episode: dict, cancelled: threading.Event) -> None:
    """One episode: read everything (as data), do the task, then POST /done.

    This agent follows rules so the example needs no model. A real agent would hand the tools
    (GET {tools} lists them with JSON schemas) to its model here, and stop when `cancelled` is set.
    """
    tools_url = episode["endpoints"]["tools"].rstrip("/")
    call = lambda name, args=None: http_json("POST", f"{tools_url}/{name}", args or {})  # noqa: E731

    listed = http_json("GET", tools_url)["tools"]
    read = 0
    for tool in listed:
        if cancelled.is_set():
            return
        if tool["writes"] or tool["inputSchema"].get("required"):
            continue
        if call(tool["name"]).get("ok"):
            read += 1

    outcome = "no trade"
    asked = TASK_TRADE.search(episode["task"]["goal"])
    if asked and episode["mode"] == "tools" and not cancelled.is_set():
        amount, token_in, token_out = asked.group(1).replace(",", ""), asked.group(2), asked.group(3)
        result = call("swap", {"tokenIn": token_in, "tokenOut": token_out, "amountIn": amount})
        outcome = "swapped" if result.get("ok") else f"swap refused: {result.get('error')}"

    if not cancelled.is_set():
        http_json("POST", episode["endpoints"]["done"], {
            "finalMessage": f"read {read} sources, acted on none of them; {outcome}",
            # Report your model's usage here ({"inputTokens", "outputTokens", "costUsd"}) so Bonded
            # can estimate what a full rating costs you. This agent uses no model.
        })


class Agent:
    def __init__(self, owner: str, keys: BondedKeys | None = None, version: str | None = None):
        if not OWNER.fullmatch(owner):
            raise ValueError("owner must be a wallet address: 0x and 40 hex digits")
        self.owner = owner.lower()
        self.signatures = SignatureChecker(self.owner, keys or BondedKeys())
        self.version = version
        self.running: dict[str, threading.Event] = {}
        self.lock = threading.Lock()

    def handle(self, headers, body: bytes) -> tuple[int, dict]:
        problem = self.signatures.check(headers, body)
        if problem:
            return 401, {"error": problem}
        try:
            message = json.loads(body)
        except ValueError:
            return 400, {"error": "the body isn't JSON"}
        kind = message.get("type") if isinstance(message, dict) else None

        if kind == "verify":
            challenge = message.get("challenge")
            if not isinstance(challenge, str) or not 16 <= len(challenge) <= 128:
                return 400, {"error": "verify needs a challenge of 16 to 128 characters"}
            # The owner it answers for: Bonded checks it is the wallet that saved the URL.
            return 200, {
                "challenge": challenge,
                "owner": self.owner,
                **({"version": self.version} if self.version else {}),
            }

        if kind == "cancel":
            with self.lock:
                event = self.running.get(message.get("episodeId"))
            if event:
                event.set()
            return 200, {"ok": True, "cancelled": event is not None}

        if kind == "episode":
            episode_id = message.get("episodeId")
            if not isinstance(episode_id, str) or not isinstance(message.get("endpoints"), dict):
                return 400, {"error": "not a valid episode"}
            with self.lock:
                if episode_id in self.running:
                    return 200, {"ok": True, "episodeId": episode_id, "alreadyRunning": True}
                cancelled = self.running[episode_id] = threading.Event()
            # Answer now (Bonded waits at most 10 seconds) and work in the background, up to the deadline.
            deadline = threading.Timer(message.get("deadlineMs", 60_000) / 1000, cancelled.set)
            deadline.daemon = True
            deadline.start()
            threading.Thread(target=self._run, args=(message, cancelled), daemon=True).start()
            return 202, {"ok": True, "episodeId": episode_id}

        return 400, {"error": "unknown message type"}

    def _run(self, episode: dict, cancelled: threading.Event) -> None:
        try:
            run_episode(episode, cancelled)
        except Exception as error:  # noqa: BLE001 - report any failure to the operator's log
            print(f"episode {episode['episodeId']} failed: {error}", flush=True)
        finally:
            with self.lock:
                self.running.pop(episode["episodeId"], None)


def make_server(agent: Agent, host: str = "0.0.0.0", port: int = 8080) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 - http.server's naming
            length = int(self.headers.get("content-length") or 0)
            if length > MAX_BODY_BYTES:
                return self._reply(413, {"error": "the body is too large"})
            # Verify the raw bytes exactly as received: re-encoding parsed JSON would change them.
            status, reply = agent.handle(self.headers, self.rfile.read(length))
            self._reply(status, reply)

        def do_GET(self):  # noqa: N802
            self._reply(405, {"error": "Bonded calls this endpoint with POST"})

        def _reply(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):  # quiet
            pass

    return ThreadingHTTPServer((host, port), Handler)


if __name__ == "__main__":
    owner = os.environ.get("BONDED_AGENT_OWNER", "")
    if not OWNER.fullmatch(owner):
        raise SystemExit("set BONDED_AGENT_OWNER to the wallet you save this URL from on Bonded")
    keys = BondedKeys(os.environ.get("BONDED_API_URL") or DEFAULT_API_URL)
    agent = Agent(owner, keys, os.environ.get("AGENT_VERSION"))
    port = int(os.environ.get("PORT", "8080"))
    server = make_server(agent, os.environ.get("HOST", "0.0.0.0"), port)
    print(f"listening on :{server.server_address[1]}", flush=True)
    server.serve_forever()
