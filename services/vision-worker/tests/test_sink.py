"""CoreSink against a local fake of core's internal observations endpoint:
batching, auth header, retry with backoff, 400 bad-line handling, and
drop-oldest backpressure that never blocks the producer."""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from zeoatap_vision.sink import CoreSink
from zeoatap_vision.timing import Backoff
from zeoatap_vision.worker import metrics_text

TOKEN = "s3cret-token"


class FakeCore:
    """Records accepted lines. `script` is a list of per-request behaviours:
    an int status; ("bad", n) = old-style 400 with accepted=n and no `line`;
    ("bad_line", line, ignored) = v2 400; ("busy", line) = v2 503 after core
    queued the first `line` lines; ("ignore", k) = 200 with the last k lines
    ignored (unknown camera); or "hang" (sleep)."""

    def __init__(self):
        self.lines: list[dict] = []
        self.requests = 0
        self.auth: list[str] = []
        self.ctypes: list[str] = []
        self.script: list = []
        self.lock = threading.Lock()
        core = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                body = self.rfile.read(int(self.headers["Content-Length"]))
                with core.lock:
                    core.requests += 1
                    core.auth.append(self.headers.get("Authorization", ""))
                    core.ctypes.append(self.headers.get("Content-Type", ""))
                    action = core.script.pop(0) if core.script else 200
                if self.path != "/internal/v1/observations":
                    return self._reply(404, {"error": "nf"})
                if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                    return self._reply(401, {"error": "unauthorized"})
                lines = [json.loads(l) for l in body.decode().splitlines() if l]
                if action == "hang":
                    time.sleep(1.5)
                    return
                if isinstance(action, tuple) and action[0] == "bad":
                    n = action[1]
                    with core.lock:
                        core.lines.extend(lines[:n])
                    return self._reply(400, {"error": f"line {n + 1}: bad", "accepted": n})
                if isinstance(action, tuple) and action[0] == "bad_line":
                    _, line, ign = action
                    with core.lock:
                        core.lines.extend(lines[:line - ign])  # the ignored ones are not stored
                    return self._reply(400, {"error": "bad", "accepted": line - ign, "ignored": ign, "line": line})
                if isinstance(action, tuple) and action[0] == "busy":
                    line = action[1]
                    with core.lock:
                        core.lines.extend(lines[:line])
                    return self._reply(503, {"error": "engine backlog full", "accepted": line, "ignored": 0,
                                             "line": line})
                if isinstance(action, tuple) and action[0] == "ignore":
                    k = action[1]
                    with core.lock:
                        core.lines.extend(lines[:len(lines) - k])
                    return self._reply(200, {"accepted": len(lines) - k, "ignored": k})
                if action != 200:
                    return self._reply(action, {"error": "busy"})
                with core.lock:
                    core.lines.extend(lines)
                self._reply(200, {"accepted": len(lines)})

            def _reply(self, code, obj):
                data = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.srv.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()


@pytest.fixture
def core():
    c = FakeCore()
    yield c
    c.close()


def wait_for(cond, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


def obs(i):
    return {"camera_id": "cam1", "capture_ts": "2026-10-31T12:00:00.000Z", "source": "MOCK",
            "ai_available": True, "tracks": [], "seq": i}


def fast_backoff():
    return Backoff(0.02, 0.1)


def test_batches_are_delivered_in_order_with_bearer_token(core):
    s = CoreSink(core.url, TOKEN, batch_max=50, backoff=fast_backoff())
    for i in range(230):
        s.emit(obs(i))
    assert wait_for(lambda: len(core.lines) == 230)
    s.close()
    assert [l["seq"] for l in core.lines] == list(range(230))
    assert 230 / 50 <= core.requests < 230  # batched
    assert set(core.auth) == {f"Bearer {TOKEN}"}
    assert set(core.ctypes) == {"application/x-ndjson"}
    st = s.status()
    assert st["accepted_total"] == 230 and st["dropped_total"] == 0 and st["buffered"] == 0
    assert TOKEN not in json.dumps(st)


def test_retries_503_and_network_errors_without_losing_data(core):
    core.script = [503, 503, 500]
    s = CoreSink(core.url, TOKEN, batch_max=10, backoff=fast_backoff())
    for i in range(25):
        s.emit(obs(i))
    assert wait_for(lambda: len(core.lines) == 25)
    s.close()
    assert [l["seq"] for l in core.lines] == list(range(25))
    assert s.retries_total >= 3 and s.failures_total >= 3

    # core down entirely, then back up
    dead = CoreSink("http://127.0.0.1:9", TOKEN, backoff=fast_backoff(), connect_timeout_s=0.5)
    dead.emit(obs(0))
    assert wait_for(lambda: dead.failures_total >= 2)
    assert "ConnectionRefusedError" in dead.last_error or "Error" in dead.last_error
    dead.close(timeout_s=0.2)


def test_read_timeout_is_explicit_and_retried(core):
    core.script = ["hang"]
    s = CoreSink(core.url, TOKEN, backoff=fast_backoff(), read_timeout_s=0.3)
    s.emit(obs(1))
    assert wait_for(lambda: len(core.lines) == 1, 10)
    s.close()
    assert "timed out" in s.status()["last_error"] or "timeout" in s.status()["last_error"].lower()


def test_bad_line_is_dropped_and_rest_retried(core):
    core.script = [("bad", 3)]
    s = CoreSink(core.url, TOKEN, batch_max=10, backoff=fast_backoff(), start=False)
    for i in range(10):
        s.emit(obs(i))
    s._thread.start()
    assert wait_for(lambda: len(core.lines) == 9)
    s.close()
    assert [l["seq"] for l in core.lines] == [0, 1, 2, 4, 5, 6, 7, 8, 9]
    assert s.rejected_total == 1 and s.written == 9


def test_bad_line_uses_line_index_from_v2_reply(core):
    core.script = [("bad_line", 5, 2)]  # lines 0-4 read (3 accepted, 2 ignored), line 5 bad
    s = CoreSink(core.url, TOKEN, batch_max=10, backoff=fast_backoff(), start=False)
    for i in range(10):
        s.emit(obs(i))
    s._thread.start()
    assert wait_for(lambda: s.buffered == 0 and core.requests >= 2)
    s.close()
    assert core.requests == 2
    assert [l["seq"] for l in core.lines] == [0, 1, 2, 6, 7, 8, 9]  # 3,4 ignored by core; 5 dropped; none resent
    assert s.rejected_total == 1 and s.ignored_total == 2 and s.written == 7


def test_503_after_partial_accept_resends_only_the_rest(core):
    core.script = [("busy", 4), ("busy", 0), ("busy", 2)]
    s = CoreSink(core.url, TOKEN, batch_max=10, backoff=fast_backoff(), start=False)
    for i in range(10):
        s.emit(obs(i))
    s._thread.start()
    assert wait_for(lambda: s.buffered == 0 and len(core.lines) == 10)
    s.close()
    assert [l["seq"] for l in core.lines] == list(range(10))  # no duplicates, in order
    assert core.requests == 4 and s.written == 10 and s.failures_total == 3


def test_ignored_lines_are_counted_not_resent(core):
    core.script = [("ignore", 3)]
    s = CoreSink(core.url, TOKEN, batch_max=10, backoff=fast_backoff(), start=False)
    for i in range(10):
        s.emit(obs(i))
    s._thread.start()
    assert wait_for(lambda: s.buffered == 0 and core.requests >= 1)
    s.close()
    assert core.requests == 1 and s.written == 7 and s.ignored_total == 3
    assert 'zeoatap_sink_ignored_total{sink="core"} 3' in metrics_text({"cameras": [], "sink": s.status()})


def test_nan_observation_is_dropped_not_sent(core):
    s = CoreSink(core.url, TOKEN, backoff=fast_backoff())
    s.emit({**obs(0), "tracks": [{"id": "a", "role": "person", "score": float("nan"), "box": [0, 0, 1, 1]}]})
    s.emit(obs(1))
    assert wait_for(lambda: len(core.lines) == 1)
    s.close()
    assert core.lines[0]["seq"] == 1 and s.invalid_total == 1 and s.emitted_total == 1


def test_wrong_token_is_retried_not_dropped_and_not_logged(core):
    s = CoreSink(core.url, "wrong", backoff=fast_backoff())
    s.emit(obs(1))
    assert wait_for(lambda: s.failures_total >= 2)
    assert "401" in s.last_error and "wrong" not in s.last_error
    assert s.buffered == 1
    s.close(timeout_s=0.1)


def test_backpressure_drops_oldest_and_never_blocks(core):
    core.script = [503] * 1000  # core backlog full for the whole test
    s = CoreSink(core.url, TOKEN, max_buffer=100, batch_max=10, backoff=Backoff(0.5, 1.0))
    t0 = time.perf_counter()
    for i in range(5000):
        s.emit(obs(i))
    elapsed = time.perf_counter() - t0
    assert elapsed < 1.0, elapsed  # producer (analysis thread) never waits on the network
    st = s.status()
    assert st["buffered"] <= 100 + 10  # buffer bound + one in-flight batch
    assert st["dropped_total"] >= 5000 - 110
    assert st["emitted_total"] == 5000
    text = metrics_text({"cameras": [], "sink": st})
    assert 'zeoatap_sink_dropped_total{sink="core"}' in text
    # the newest observations are the ones kept
    core.script = []
    assert wait_for(lambda: s.buffered == 0, 10)
    s.close()
    assert core.lines[-1]["seq"] == 4999


def test_rejects_bad_config():
    with pytest.raises(ValueError):
        CoreSink("http://127.0.0.1:1", "", start=False)
    with pytest.raises(ValueError):
        CoreSink("ftp://x", TOKEN, start=False)
