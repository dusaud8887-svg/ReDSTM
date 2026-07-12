from __future__ import annotations

import http.client
import json
import os
import random
import re
import ssl
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from scripts.control_store import ControlStore

_MAX_RESPONSE_BYTES = 128 * 1024
_RETRY_DELAYS = (2.0, 5.0, 15.0)
_ACTIONS = {
    "sync-now",
    "retry-batch",
    "publish-if-changed",
    "pause-after-current",
    "resume-schedule",
}
_RUNNER_PATH = re.compile(
    r"/api/v1/runner/(?:"
    r"commands/claim|heartbeat|boards/status|runs|"
    r"runs/[a-zA-Z0-9_.:-]{1,128}/(?:events:batch|finish)|"
    r"commands/[0-9a-f-]{36}/finish)"
)

Sender = Callable[[str, bytes, dict[str, str]], tuple[int, Mapping[str, str], bytes]]


class ControlUnavailableError(RuntimeError):
    def __init__(self, *, retry_after: float | None = None) -> None:
        super().__init__("control plane is temporarily unavailable")
        self.retry_after = retry_after


class ControlProtocolError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _offline_sender(
    _path: str, _body: bytes, _headers: dict[str, str]
) -> tuple[int, Mapping[str, str], bytes]:
    raise ControlUnavailableError()


class ControlClient:
    def __init__(
        self,
        base_url: str,
        client_id: str,
        client_secret: str,
        *,
        sender: Sender | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        parsed = urlsplit(base_url)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("control URL must be an HTTPS origin")
        if not client_id or not client_secret:
            raise ValueError("Access service credentials are required")
        assert parsed.hostname is not None
        self._host = parsed.hostname
        self._port = parsed.port
        self._client_id = client_id
        self._client_secret = client_secret
        self._sender = sender or self._send_once
        self._sleep = sleep
        self._unavailable_until = 0.0

    @classmethod
    def from_environment(cls, *, allow_offline: bool = False) -> ControlClient:
        values = (
            os.environ.get("REDSTM_CONTROL_URL", ""),
            os.environ.get("REDSTM_ACCESS_CLIENT_ID", ""),
            os.environ.get("REDSTM_ACCESS_CLIENT_SECRET", ""),
        )
        if allow_offline and not any(values):
            return cls(
                "https://control.invalid",
                "offline",
                "offline",
                sender=_offline_sender,
                sleep=lambda _delay: None,
            )
        return cls(*values)

    def post(self, path: str, payload: dict[str, Any], idempotency_key: str) -> dict[str, Any]:
        if _RUNNER_PATH.fullmatch(path) is None:
            raise ValueError("control path is outside the runner API")
        if re.fullmatch(r"[a-zA-Z0-9_.:-]{8,128}", idempotency_key) is None:
            raise ValueError("idempotency key is invalid")
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        if len(body) > 64 * 1024:
            raise ValueError("control request is too large")
        request_id = str(uuid4())
        headers = {
            "CF-Access-Client-Id": self._client_id,
            "CF-Access-Client-Secret": self._client_secret,
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
            "Idempotency-Key": idempotency_key,
            "X-Request-Id": request_id,
            "X-ReDSTM-Protocol": "1",
        }
        for attempt in range(len(_RETRY_DELAYS) + 1):
            try:
                status, response_headers, response_body = self._sender(path, body, headers)
                return self._decode(status, response_headers, response_body, request_id)
            except ControlUnavailableError as error:
                unavailable = error
            except OSError, TimeoutError, http.client.HTTPException:
                unavailable = ControlUnavailableError()
            if attempt == len(_RETRY_DELAYS):
                raise unavailable
            delay = unavailable.retry_after
            if delay is None:
                delay = _RETRY_DELAYS[attempt] * random.uniform(0.8, 1.2)
            self._sleep(min(delay, 60.0))
        raise AssertionError("unreachable")

    def claim(self, runner_id: str, idempotency_key: str) -> dict[str, Any] | None:
        return self._claim({"runner_id": runner_id}, idempotency_key)

    def claim_marker(self, runner_id: str, idempotency_key: str) -> dict[str, Any] | None:
        if time.monotonic() < self._unavailable_until:
            return None
        try:
            command = self._claim(
                {"runner_id": runner_id, "command_kind": "marker"}, idempotency_key
            )
        except ControlUnavailableError:
            self._unavailable_until = time.monotonic() + 60
            raise
        if command is not None and command["action"] not in {
            "pause-after-current",
            "resume-schedule",
        }:
            raise ControlProtocolError("invalid_marker_command_response")
        return command

    def _claim(self, payload: dict[str, str], idempotency_key: str) -> dict[str, Any] | None:
        data = self.post("/api/v1/runner/commands/claim", payload, idempotency_key)
        command = data.get("command")
        if command is None:
            return None
        if (
            not isinstance(command, dict)
            or not isinstance(command.get("command_id"), str)
            or command.get("action") not in _ACTIONS
            or not isinstance(command.get("state"), str)
        ):
            raise ControlProtocolError("invalid_command_response")
        return command

    def send_or_enqueue(
        self,
        store: ControlStore,
        kind: str,
        path: str,
        payload: dict[str, Any],
        idempotency_key: str,
    ) -> bool:
        if time.monotonic() < self._unavailable_until:
            store.enqueue(kind, path, payload, idempotency_key)
            return False
        try:
            self.post(path, payload, idempotency_key)
        except ControlUnavailableError:
            self._unavailable_until = time.monotonic() + 60
            store.enqueue(kind, path, payload, idempotency_key)
            return False
        self._unavailable_until = 0.0
        return True

    def flush(self, store: ControlStore, *, limit: int = 50) -> int:
        if time.monotonic() < self._unavailable_until:
            return 0
        sent = 0
        for item in store.pending(limit=limit):
            payload = json.loads(item["payload_json"])
            if not isinstance(payload, dict):
                raise ControlProtocolError("invalid_outbox_payload")
            try:
                self.post(item["path"], payload, item["idempotency_key"])
            except ControlUnavailableError:
                self._unavailable_until = time.monotonic() + 60
                attempts = int(item["attempts"])
                delay = _RETRY_DELAYS[min(attempts, len(_RETRY_DELAYS) - 1)]
                store.defer(int(item["id"]), datetime.now(UTC) + timedelta(seconds=delay))
                break
            store.acknowledge(int(item["id"]))
            sent += 1
        return sent

    def _send_once(
        self, path: str, body: bytes, headers: dict[str, str]
    ) -> tuple[int, Mapping[str, str], bytes]:
        started = time.monotonic()
        connection = http.client.HTTPSConnection(
            self._host,
            self._port,
            timeout=5,
            context=ssl.create_default_context(),
        )
        try:
            connection.request("POST", path, body=body, headers=dict(headers))
            response = connection.getresponse()
            remaining = 15.0 - (time.monotonic() - started)
            if remaining <= 0:
                raise ControlUnavailableError()
            if connection.sock is not None:
                connection.sock.settimeout(remaining)
            declared = response.getheader("Content-Length")
            if declared is not None:
                try:
                    declared_size = int(declared)
                except ValueError as error:
                    raise ControlProtocolError("invalid_content_length") from error
                if declared_size < 0 or declared_size > _MAX_RESPONSE_BYTES:
                    raise ControlProtocolError("response_too_large")
            response_body = response.read(_MAX_RESPONSE_BYTES + 1)
            if len(response_body) > _MAX_RESPONSE_BYTES:
                raise ControlProtocolError("response_too_large")
            return response.status, dict(response.getheaders()), response_body
        except TimeoutError, ssl.SSLError:
            raise ControlUnavailableError() from None
        finally:
            connection.close()

    @staticmethod
    def _decode(
        status: int,
        headers: Mapping[str, str],
        body: bytes,
        request_id: str,
    ) -> dict[str, Any]:
        normalized_headers = {key.lower(): value for key, value in headers.items()}
        if status == 429 or status >= 500:
            raise ControlUnavailableError(
                retry_after=_retry_after(normalized_headers.get("retry-after"))
            )
        try:
            decoded = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ControlProtocolError("invalid_json_response") from error
        if not isinstance(decoded, dict):
            raise ControlProtocolError("invalid_response")
        if not 200 <= status < 300:
            error_payload = decoded.get("error")
            code = error_payload.get("code") if isinstance(error_payload, dict) else None
            raise ControlProtocolError(code if isinstance(code, str) else "control_rejected")
        if (
            decoded.get("api_version") != 1
            or decoded.get("request_id") != request_id
            or not isinstance(decoded.get("server_time"), str)
            or not isinstance(decoded.get("data"), dict)
        ):
            raise ControlProtocolError("invalid_response_envelope")
        return decoded["data"]


def _retry_after(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            parsed = parsedate_to_datetime(value)
        except TypeError, ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return max(0.0, (parsed - datetime.now(parsed.tzinfo)).total_seconds())
