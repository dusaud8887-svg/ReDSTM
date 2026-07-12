from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from scripts.control_client import (
    _CONNECT_TIMEOUT_SECONDS,
    _MAX_RETRY_DELAY_SECONDS,
    _TOTAL_REQUEST_TIMEOUT_SECONDS,
    _UNAVAILABLE_COOLDOWN_SECONDS,
    ControlClient,
    ControlProtocolError,
    ControlUnavailableError,
    DeliveryResult,
)
from scripts.control_store import ControlStore

_WORKER_VERSION = "12345678-1234-1234-1234-123456789abc"
_WORKER_GIT_SHA = "b" * 40


def test_transport_policy_constants_are_explicit() -> None:
    assert _MAX_RETRY_DELAY_SECONDS == 60.0
    assert _UNAVAILABLE_COOLDOWN_SECONDS == 60.0
    assert _CONNECT_TIMEOUT_SECONDS == 5.0
    assert _TOTAL_REQUEST_TIMEOUT_SECONDS == 15.0


def _response(headers: dict[str, str], data: dict[str, Any]) -> bytes:
    return json.dumps(
        {
            "api_version": 1,
            "request_id": headers["X-Request-Id"],
            "server_time": "2026-07-12T00:00:00.000Z",
            "data": data,
        }
    ).encode()


def _release_smoke_data(
    release_sha256: str = "a" * 64,
    worker_version: str = _WORKER_VERSION,
    worker_git_sha: str = _WORKER_GIT_SHA,
) -> dict[str, Any]:
    return {
        "release_sha256": release_sha256,
        "worker_version_id": worker_version,
        "worker_git_sha": worker_git_sha,
        "counts": {
            "post_count": 1,
            "comment_count": 2,
            "board_count": 3,
            "collection_count": 4,
            "collection_entry_count": 5,
            "unavailable_post_count": 0,
            "unavailable_comment_count": 0,
        },
        "checks": {"worker_version": True, "r2_release": True, "d1_schema": True},
    }


def test_retries_only_retryable_responses_with_stable_identity() -> None:
    calls: list[dict[str, str]] = []
    sleeps: list[float] = []

    def sender(
        path: str, body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        assert path == "/api/v1/runner/heartbeat"
        assert json.loads(body)["state"] == "idle"
        calls.append(dict(headers))
        if len(calls) == 1:
            return 503, {}, b""
        if len(calls) == 2:
            return 429, {"Retry-After": "3"}, b""
        return 200, {}, _response(headers, {"accepted": True})

    client = ControlClient(
        "https://archive.example",
        "client-id",
        "client-secret",
        sender=sender,
        sleep=sleeps.append,
    )
    result = client.post(
        "/api/v1/runner/heartbeat",
        {"runner_version": "git-1", "state": "idle"},
        "heartbeat-0001",
    )

    assert result == {"accepted": True}
    assert len(calls) == 3
    assert len({call["X-Request-Id"] for call in calls}) == 1
    assert len({call["Idempotency-Key"] for call in calls}) == 1
    assert 1.6 <= sleeps[0] <= 2.4
    assert sleeps[1] == 3


def test_non_retryable_error_is_safe_and_immediate() -> None:
    calls = 0

    def sender(
        _path: str, _body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        nonlocal calls
        calls += 1
        body = {
            "api_version": 1,
            "request_id": headers["X-Request-Id"],
            "server_time": "2026-07-12T00:00:00.000Z",
            "error": {"code": "invalid_heartbeat", "message": "rejected"},
        }
        return 400, {}, json.dumps(body).encode()

    client = ControlClient("https://archive.example", "client-id", "client-secret", sender=sender)
    with pytest.raises(ControlProtocolError, match="invalid_heartbeat"):
        client.post(
            "/api/v1/runner/heartbeat",
            {"runner_version": "git-1", "state": "idle"},
            "heartbeat-0001",
        )
    assert calls == 1


@pytest.mark.parametrize(
    ("expected", "normalized"),
    [(None, None), ("A" * 64, "a" * 64)],
    ids=["current", "expected"],
)
def test_release_smoke_uses_the_bounded_machine_auth_get(
    expected: str | None, normalized: str | None
) -> None:
    release_sha256 = "a" * 64

    def sender(
        path: str, body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        suffix = f"?expected_release_sha256={normalized}" if normalized is not None else ""
        assert path == f"/api/v1/runner/release-smoke{suffix}"
        assert body == b""
        assert headers["CF-Access-Client-Id"] == "client-id"
        assert headers["CF-Access-Client-Secret"] == "client-secret"
        assert "Idempotency-Key" not in headers
        return 200, {}, _response(headers, _release_smoke_data(release_sha256))

    client = ControlClient("https://archive.example", "client-id", "client-secret", sender=sender)

    assert client.release_smoke(expected)["release_sha256"] == release_sha256


def test_release_smoke_binds_the_worker_version_and_git_sha() -> None:
    def sender(
        path: str, _body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        assert path == (
            f"/api/v1/runner/release-smoke?expected_worker_version={_WORKER_VERSION}"
            f"&expected_git_sha={_WORKER_GIT_SHA}"
        )
        return 200, {}, _response(headers, _release_smoke_data())

    client = ControlClient("https://archive.example", "client-id", "client-secret", sender=sender)

    result = client.release_smoke(
        expected_worker_version=_WORKER_VERSION.upper(),
        expected_git_sha=_WORKER_GIT_SHA.upper(),
    )

    assert result["worker_version_id"] == _WORKER_VERSION
    assert result["worker_git_sha"] == _WORKER_GIT_SHA


def test_release_smoke_rejects_a_different_worker_than_requested() -> None:
    requested_version = "99999999-9999-9999-9999-999999999999"

    def sender(
        _path: str, _body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        return 200, {}, _response(headers, _release_smoke_data())

    client = ControlClient("https://archive.example", "client-id", "client-secret", sender=sender)

    with pytest.raises(ControlProtocolError, match="invalid_release_smoke_response"):
        client.release_smoke(
            expected_worker_version=requested_version,
            expected_git_sha=_WORKER_GIT_SHA,
        )


def test_release_smoke_default_transport_sends_get(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request: dict[str, Any] = {}

    class Response:
        status = 200

        def __init__(self) -> None:
            self.body = _response(request["headers"], _release_smoke_data())

        def getheader(self, name: str) -> str | None:
            return str(len(self.body)) if name == "Content-Length" else None

        def getheaders(self) -> list[tuple[str, str]]:
            return [("Content-Length", str(len(self.body)))]

        def read(self, limit: int) -> bytes:
            assert limit > len(self.body)
            return self.body

    class Connection:
        sock = None

        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        def request(
            self, method: str, path: str, body: bytes | None, headers: dict[str, str]
        ) -> None:
            request.update(method=method, path=path, body=body, headers=headers)

        def getresponse(self) -> Response:
            return Response()

        def close(self) -> None:
            pass

    monkeypatch.setattr("scripts.control_client.http.client.HTTPSConnection", Connection)

    ControlClient("https://archive.example", "client-id", "client-secret").release_smoke(
        expected_worker_version=_WORKER_VERSION,
        expected_git_sha=_WORKER_GIT_SHA,
    )

    assert request["method"] == "GET"
    assert request["path"] == (
        f"/api/v1/runner/release-smoke?expected_worker_version={_WORKER_VERSION}"
        f"&expected_git_sha={_WORKER_GIT_SHA}"
    )
    assert request["body"] is None


def test_release_smoke_rejects_a_mismatched_or_unbounded_response() -> None:
    expected = "a" * 64

    def sender(
        _path: str, _body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        return (
            200,
            {},
            _response(
                headers,
                {
                    "release_sha256": "b" * 64,
                    "worker_version_id": _WORKER_VERSION,
                    "worker_git_sha": _WORKER_GIT_SHA,
                    "counts": {},
                    "checks": {
                        "worker_version": True,
                        "r2_release": True,
                        "d1_schema": True,
                    },
                },
            ),
        )

    client = ControlClient("https://archive.example", "client-id", "client-secret", sender=sender)

    with pytest.raises(ControlProtocolError, match="invalid_release_smoke_response"):
        client.release_smoke(expected)


def test_failed_delivery_enters_bounded_outbox_and_flushes(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "control.sqlite")
    offline_calls = 0

    def offline(
        _path: str, _body: bytes, _headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        nonlocal offline_calls
        offline_calls += 1
        raise OSError("offline")

    client = ControlClient(
        "https://archive.example",
        "client-id",
        "client-secret",
        sender=offline,
        sleep=lambda _delay: None,
    )
    sent = client.send_or_enqueue(
        store,
        "heartbeat",
        "/api/v1/runner/heartbeat",
        {"runner_version": "git-1", "state": "idle"},
        "heartbeat-0001",
    )
    assert sent is DeliveryResult.RETRYABLE_QUEUED
    assert store.stats()["rows"] == 1
    client.send_or_enqueue(
        store,
        "board_status",
        "/api/v1/runner/boards/status",
        {
            "board_id": "aa",
            "last_scanned_at": "2026-07-12T00:00:00.000Z",
            "last_outcome": "failed",
            "counters": {"discovered": 0, "changed": 0, "pending": 0, "retry": 0, "dead": 0},
        },
        "board-status-0001",
    )
    assert offline_calls == 4

    def online(
        _path: str, _body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        return 200, {}, _response(headers, {"accepted": True})

    recovered = ControlClient(
        "https://archive.example", "client-id", "client-secret", sender=online
    )
    assert recovered.flush(store) == 2
    assert store.stats()["rows"] == 0


@pytest.mark.parametrize("status", [401, 403])
def test_access_rejection_enters_the_outbox_and_replays(tmp_path: Path, status: int) -> None:
    store = ControlStore(tmp_path / "control.sqlite")
    rejected = ControlClient(
        "https://archive.example",
        "client-id",
        "expired-secret",
        sender=lambda *_args: (status, {}, b"Access denied"),
        sleep=lambda _delay: None,
    )

    assert (
        rejected.send_or_enqueue(
            store,
            "heartbeat",
            "/api/v1/runner/heartbeat",
            {"runner_version": "git-1", "state": "idle"},
            "heartbeat-access-0001",
        )
        is DeliveryResult.RETRYABLE_QUEUED
    )
    assert store.stats()["rows"] == 1

    recovered = ControlClient(
        "https://archive.example",
        "client-id",
        "new-secret",
        sender=lambda _path, _body, headers: (
            200,
            {},
            _response(headers, {"accepted": True}),
        ),
    )
    assert recovered.flush(store) == 1
    assert store.stats()["rows"] == 0


def test_permanent_outbox_rejection_is_removed_before_later_delivery(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "control.sqlite")
    store.enqueue(
        "heartbeat",
        "/api/v1/runner/heartbeat",
        {"runner_version": "git-1", "state": "idle"},
        "heartbeat-rejected",
    )
    store.enqueue(
        "run_finish",
        "/api/v1/runner/runs/run-1/finish",
        {"state": "failed", "safe_summary_code": "runner_failed", "counters": {}},
        "finish-run-0001",
    )
    calls = 0

    def sender(
        _path: str, _body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        nonlocal calls
        calls += 1
        if calls == 1:
            return (
                400,
                {},
                json.dumps(
                    {
                        "api_version": 1,
                        "request_id": headers["X-Request-Id"],
                        "server_time": "2026-07-12T00:00:00.000Z",
                        "error": {"code": "invalid_heartbeat", "message": "rejected"},
                    }
                ).encode(),
            )
        return 200, {}, _response(headers, {"accepted": True})

    recovered = ControlClient(
        "https://archive.example", "client-id", "client-secret", sender=sender
    )
    assert recovered.flush(store) == 1
    assert calls == 2
    assert store.stats()["rows"] == 0
    rejection = store.rejection()
    assert rejection is not None
    assert rejection["rejected_count"] == 1
    assert rejection["last_code"] == "invalid_heartbeat"


def test_non_json_permanent_rejection_cannot_poison_the_outbox(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "control.sqlite")
    store.enqueue(
        "heartbeat",
        "/api/v1/runner/heartbeat",
        {"runner_version": "git-1", "state": "idle"},
        "heartbeat-rejected-html",
    )
    store.enqueue(
        "run_finish",
        "/api/v1/runner/runs/run-1/finish",
        {"state": "failed", "safe_summary_code": "runner_failed", "counters": {}},
        "finish-after-html-0001",
    )
    calls = 0

    def sender(
        _path: str, _body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        nonlocal calls
        calls += 1
        return (
            (400, {}, b"Bad request")
            if calls == 1
            else (
                200,
                {},
                _response(headers, {"accepted": True}),
            )
        )

    client = ControlClient("https://archive.example", "client-id", "client-secret", sender=sender)

    assert client.flush(store) == 1
    assert store.stats()["rows"] == 0
    rejection = store.rejection()
    assert rejection is not None
    assert rejection["last_code"] == "control_rejected"


def test_release_mismatch_is_the_only_retryable_conflict() -> None:
    calls = 0

    def sender(
        _path: str, _body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        nonlocal calls
        calls += 1
        return (
            409,
            {},
            json.dumps(
                {
                    "api_version": 1,
                    "request_id": headers["X-Request-Id"],
                    "server_time": "2026-07-12T00:00:00.000Z",
                    "error": {"code": "release_mismatch", "message": "not visible yet"},
                }
            ).encode(),
        )

    client = ControlClient(
        "https://archive.example",
        "client-id",
        "client-secret",
        sender=sender,
        sleep=lambda _delay: None,
    )
    with pytest.raises(ControlUnavailableError):
        client.release_smoke("a" * 64)
    assert calls == 4


def test_claim_rejects_unknown_actions() -> None:
    def sender(
        _path: str, _body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        return (
            200,
            {},
            _response(
                headers,
                {"command": {"command_id": "id", "action": "shell", "state": "claimed"}},
            ),
        )

    client = ControlClient("https://archive.example", "client-id", "client-secret", sender=sender)
    with pytest.raises(ControlProtocolError, match="invalid_command_response"):
        client.claim("oracle-primary", "claim-attempt-0001")


def test_marker_claim_is_explicit_and_rejects_process_commands() -> None:
    def sender(
        path: str, body: bytes, headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        assert path.endswith("/commands/claim")
        assert json.loads(body) == {"runner_id": "oracle-primary", "command_kind": "marker"}
        return (
            200,
            {},
            _response(
                headers,
                {"command": {"command_id": "id", "action": "sync-now", "state": "claimed"}},
            ),
        )

    client = ControlClient("https://archive.example", "client-id", "client-secret", sender=sender)
    with pytest.raises(ControlProtocolError, match="invalid_marker_command_response"):
        client.claim_marker("oracle-primary", "claim-marker-0001")


def test_marker_claim_respects_the_outage_circuit() -> None:
    calls = 0

    def sender(
        _path: str, _body: bytes, _headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        nonlocal calls
        calls += 1
        raise OSError("offline")

    client = ControlClient(
        "https://archive.example",
        "client-id",
        "client-secret",
        sender=sender,
        sleep=lambda _delay: None,
    )
    with pytest.raises(ControlUnavailableError):
        client.claim_marker("oracle-primary", "claim-marker-0001")

    assert client.claim_marker("oracle-primary", "claim-marker-0002") is None
    assert calls == 4


def test_rejects_bad_origin_and_mismatched_response_trace() -> None:
    with pytest.raises(ValueError, match="HTTPS origin"):
        ControlClient("http://archive.example/path", "id", "secret")
    client = ControlClient(
        "https://archive.example", "id", "secret", sender=lambda *_: (200, {}, b"")
    )
    with pytest.raises(ValueError, match="outside the runner API"):
        client.post("/api/v1/runner/shell", {}, "safe-key-001")

    def sender(
        _path: str, _body: bytes, _headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        return (
            200,
            {},
            json.dumps(
                {
                    "api_version": 1,
                    "request_id": "wrong",
                    "server_time": "2026-07-12T00:00:00.000Z",
                    "data": {},
                }
            ).encode(),
        )

    client = ControlClient("https://archive.example", "client-id", "client-secret", sender=sender)
    with pytest.raises(ControlProtocolError, match="invalid_response_envelope"):
        client.post("/api/v1/runner/heartbeat", {}, "heartbeat-0001")


def test_exhausted_retry_raises_without_secret_text() -> None:
    def sender(
        _path: str, _body: bytes, _headers: dict[str, str]
    ) -> tuple[int, dict[str, str], bytes]:
        return 503, {}, b""

    client = ControlClient(
        "https://archive.example",
        "client-id",
        "very-secret-value",
        sender=sender,
        sleep=lambda _delay: None,
    )
    with pytest.raises(ControlUnavailableError) as caught:
        client.post("/api/v1/runner/heartbeat", {}, "heartbeat-0001")
    assert "very-secret-value" not in str(caught.value)


def test_missing_control_credentials_can_be_explicitly_offline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in (
        "REDSTM_CONTROL_URL",
        "REDSTM_ACCESS_CLIENT_ID",
        "REDSTM_ACCESS_CLIENT_SECRET",
    ):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ValueError):
        ControlClient.from_environment()
    monkeypatch.setenv("REDSTM_CONTROL_URL", "https://archive.example")

    store = ControlStore(tmp_path / "control.sqlite")
    client = ControlClient.from_environment(allow_offline=True)

    assert (
        client.send_or_enqueue(
            store,
            "heartbeat",
            "/api/v1/runner/heartbeat",
            {"runner_version": "git-1", "state": "idle"},
            "heartbeat-offline-0001",
        )
        is DeliveryResult.RETRYABLE_QUEUED
    )
    assert store.stats()["rows"] == 1
