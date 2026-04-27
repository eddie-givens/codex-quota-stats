from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Any


def connect_readonly(db_path: Path) -> sqlite3.Connection:
    uri = f"file:{db_path.as_posix()}?mode=ro"
    return sqlite3.connect(uri, uri=True, timeout=1.0)


def load_current_thread(state_db_path: Path) -> dict[str, Any] | None:
    if not state_db_path.exists():
        return None

    with connect_readonly(state_db_path) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            """
            select id, title, updated_at, tokens_used, model
            from threads
            order by updated_at desc
            limit 1
            """
        ).fetchone()

    if row is None:
        return None

    return {
        "id": row["id"],
        "title": row["title"],
        "updated_at": row["updated_at"],
        "tokens_used": row["tokens_used"] or 0,
        "model": row["model"] or "unknown",
    }


def extract_event(feedback_log_body: str | None) -> dict[str, Any] | None:
    if not feedback_log_body:
        return None

    marker = "websocket event: "
    marker_index = feedback_log_body.find(marker)
    if marker_index == -1:
        return None

    payload = feedback_log_body[marker_index + len(marker) :]
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return None


def load_completed_responses(logs_db_path: Path, cutoff: int) -> list[dict[str, Any]]:
    if not logs_db_path.exists():
        return []

    with connect_readonly(logs_db_path) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            select ts, feedback_log_body
            from logs
            where target = 'codex_api::endpoint::responses_websocket'
              and ts >= ?
              and feedback_log_body like '%"type":"response.completed"%'
            order by id desc
            limit 500
            """,
            (cutoff,),
        ).fetchall()

    responses: list[dict[str, Any]] = []
    for row in rows:
        event = extract_event(row["feedback_log_body"])
        if event is None:
            continue

        usage = event.get("response", {}).get("usage")
        if usage is None:
            continue

        responses.append(
            {
                "timestamp": row["ts"],
                "input_tokens": usage.get("input_tokens", 0),
                "cached_input_tokens": usage.get("input_tokens_details", {}).get("cached_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
                "reasoning_tokens": usage.get("output_tokens_details", {}).get("reasoning_tokens", 0),
                "total_tokens": usage.get("total_tokens", 0),
            }
        )

    return responses


def summarize_window(responses: list[dict[str, Any]], cutoff: int) -> dict[str, int]:
    filtered = [response for response in responses if response["timestamp"] >= cutoff]
    return {
        "total_tokens": sum(response["total_tokens"] for response in filtered),
        "request_count": len(filtered),
    }


def build_snapshot(codex_home: Path) -> dict[str, Any]:
    logs_db_path = codex_home / "logs_2.sqlite"
    state_db_path = codex_home / "state_5.sqlite"
    now = int(time.time())
    current_thread = load_current_thread(state_db_path)
    responses = load_completed_responses(logs_db_path, now - (7 * 24 * 60 * 60))

    return {
        "ok": True,
        "codex_home": str(codex_home),
        "generated_at": now,
        "current_thread": current_thread,
        "latest_response": responses[0] if responses else None,
        "windows": {
            "five_hours": summarize_window(responses, now - (5 * 60 * 60)),
            "seven_days": summarize_window(responses, now - (7 * 24 * 60 * 60)),
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read local Codex usage data from ~/.codex SQLite files.")
    parser.add_argument("--codex-home", default="", help="Optional override for CODEX_HOME.")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    codex_home = Path(args.codex_home or os.environ.get("CODEX_HOME") or (Path.home() / ".codex"))
    snapshot = build_snapshot(codex_home)
    indent = 2 if args.pretty else None
    print(json.dumps(snapshot, indent=indent))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
