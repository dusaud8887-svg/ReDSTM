from __future__ import annotations

import argparse
import json
from pathlib import Path

from scripts.text_archive.importer import (
    list_novel_link_candidates,
    resolve_novel_link_candidate,
)
from scripts.text_archive.runtime import RuntimeWindowError, operation_window


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Review source-ID-preserving novel links; no automatic merge is performed"
    )
    decision = parser.add_mutually_exclusive_group()
    decision.add_argument(
        "--accept",
        nargs=4,
        metavar=("LEFT_SITE", "LEFT_WORK_ID", "RIGHT_SITE", "RIGHT_WORK_ID"),
        help="explicitly promote one listed candidate after the 20-work canary",
    )
    decision.add_argument(
        "--reject",
        nargs=4,
        metavar=("LEFT_SITE", "LEFT_WORK_ID", "RIGHT_SITE", "RIGHT_WORK_ID"),
        help="reject one listed candidate without linking source works",
    )
    parser.add_argument(
        "--canary-verified",
        action="store_true",
        help="required with --accept after recording the canary comparison",
    )
    args = parser.parse_args()
    if args.canary_verified and not args.accept:
        parser.error("--canary-verified is only valid with --accept")
    if args.accept and not args.canary_verified:
        parser.error("--accept requires --canary-verified")

    db_path = Path("/srv/redstm-text/text-archive.sqlite")
    result: dict[str, str] | list[dict[str, str]]
    try:
        with operation_window():
            if args.accept or args.reject:
                left_site, left_work_id, right_site, right_work_id = args.accept or args.reject
                result = resolve_novel_link_candidate(
                    db_path,
                    left_site,
                    left_work_id,
                    right_site,
                    right_work_id,
                    accept=bool(args.accept),
                    canary_verified=bool(args.canary_verified),
                )
            else:
                result = list_novel_link_candidates(db_path)
    except RuntimeWindowError as exc:
        parser.exit(75, f"text link review deferred: {exc}\n")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
