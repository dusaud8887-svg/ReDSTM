from __future__ import annotations

import argparse
import json
from collections.abc import Sequence

from scripts.control_client import (
    ControlClient,
    ControlProtocolError,
    ControlUnavailableError,
)


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify the active Worker/R2 release.")
    parser.add_argument("--expected-release-sha256")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        report = ControlClient.from_environment().release_smoke(args.expected_release_sha256)
    except ValueError:
        result = {"ok": False, "status": "failed", "safe_code": "release_smoke_config_invalid"}
    except ControlUnavailableError:
        result = {"ok": False, "status": "failed", "safe_code": "release_smoke_unavailable"}
    except ControlProtocolError:
        result = {"ok": False, "status": "failed", "safe_code": "release_smoke_rejected"}
    else:
        result = {"ok": True, "status": "succeeded", **report}
    print(json.dumps(result, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
