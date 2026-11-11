"""Run with: python -m course_agent --scenario submission --trace"""
import argparse
import json
from pathlib import Path
from .agent import run_agent
from .models import LiveModel, ScriptedModel

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description="Course Research Agent")
    parser.add_argument("--scenario", choices=["submission", "missing"], default="submission")
    parser.add_argument("--question", default="How do I submit my project?")
    parser.add_argument("--live", action="store_true", help="Make up to six paid DeepSeek calls")
    parser.add_argument("--trace", action="store_true")
    args = parser.parse_args()
    documents = json.loads((ROOT / "data/documents.json").read_text(encoding="utf8"))
    try:
        scenario = json.loads((ROOT / f"scenarios/{args.scenario}.json").read_text(encoding="utf8"))
        model = LiveModel() if args.live else ScriptedModel(scenario["actions"])
        question = args.question if args.live else scenario["question"]
        result = run_agent(question, model, documents)
    except NotImplementedError as exc:
        print(str(exc))
        return 2
    except ValueError as exc:
        print(str(exc))
        return 2
    print("Mode:", "live model" if args.live else "scripted simulation")
    print("Status:", result["status"])
    print(result["answer"] or "No supported answer.")
    for citation in result["citations"]:
        print("Source:", citation["id"])
    if args.trace:
        print(json.dumps(result["trace"], indent=2, ensure_ascii=False))
    return 0 if result["status"] in {"answered", "insufficient_evidence"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
