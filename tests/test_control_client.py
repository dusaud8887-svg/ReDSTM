from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from scripts.control_client import ControlClient, ControlProtocolError, ControlUnavailableError
from scripts.control_store import ControlStore


def _response(headers: dict[str, str], data: dict[str, Any]) -> bytes:
    return json.dumps(
        {
            "api_version": 1,
            "request_id": headers["X-Request-Id"],
            "server_time": "2026-07-12T00:00:00.000Z",
            "data": data,
        }
    ).encode()


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
    assert sent is False
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
        is False
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
        is False
    )
    assert store.stats()["rows"] == 1
