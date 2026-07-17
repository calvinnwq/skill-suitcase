#!/usr/bin/env python3
import argparse
import json
import re
from pathlib import Path
from typing import Optional


REFERENCES = Path(__file__).resolve().parents[1] / "references"
GREETING = REFERENCES / "greeting.md"
ROUTING = REFERENCES / "routing.json"


def contains_phrase(text: str, phrase: str) -> bool:
    return re.search(rf"(?<!\w){re.escape(phrase)}(?!\w)", text) is not None


def starts_with_phrase(text: str, phrase: str) -> bool:
    return re.match(rf"{re.escape(phrase)}(?!\w)", text) is not None


def route_intent(user_request: str) -> Optional[str]:
    policy = json.loads(ROUTING.read_text(encoding="utf-8"))
    normalized = " ".join(user_request.lower().split())
    if any(contains_phrase(normalized, phrase) for phrase in policy["rejectPhrases"]):
        return None
    matches = any(
        all(contains_phrase(normalized, term) for term in route["allTerms"])
        and any(starts_with_phrase(normalized, phrase) for phrase in route["requestPhrases"])
        for route in policy["routes"]
    )
    return policy["skill"] if matches else None


def render_greeting(user_request: str) -> str:
    if route_intent(user_request) is None:
        raise ValueError("request does not match the hello-suitcase skill")
    return GREETING.read_text(encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Render the portable sample greeting.")
    parser.add_argument("request", nargs="+", help="User request used for deterministic routing.")
    args = parser.parse_args()
    print(render_greeting(" ".join(args.request)), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
