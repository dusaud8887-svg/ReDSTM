from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from crawler.session import SessionRefreshError, refresh_session_export
from crawler.settings import USER_AGENT


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh the private TypeMoon crawl session.")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(".data/private/typemoon-session.json"),
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    user_id = os.environ.get("TYPEMOON_ID", "")
    password = os.environ.get("TYPEMOON_PASSWORD", "")
    try:
        session = refresh_session_export(
            args.output,
            user_id=user_id,
            password=password,
            user_agent=USER_AGENT,
        )
    except SessionRefreshError as error:
        print(f"session refresh failed: {error}", file=sys.stderr)
        return 1

    print(
        json.dumps(
            {
                "status": "refreshed",
                "output": str(args.output),
                "expires_at": session.expires_at.isoformat(),
                "cookie_count": len(session.cookies),
            },
            ensure_ascii=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
