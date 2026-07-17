import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GREETING = ROOT / "skills" / "hello-suitcase" / "references" / "greeting.md"
ROUTING_FIXTURES = (
    ROOT
    / "skills"
    / "check-resolvable-local"
    / "fixtures"
    / "routing-fixtures.json"
)
RUNNER = ROOT / "skills" / "hello-suitcase" / "scripts" / "render_greeting.py"
ROUTING_POLICY = ROOT / "skills" / "hello-suitcase" / "references" / "routing.json"
SKILL_FILE = ROOT / "skills" / "hello-suitcase" / "SKILL.md"


def load_runner():
    spec = importlib.util.spec_from_file_location("hello_suitcase_runner", RUNNER)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load the hello-suitcase runner")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def audit_workspace(fixtures, policy):
    skills_root = ROOT / "skills"
    discovered = {
        entry.name
        for entry in skills_root.iterdir()
        if entry.is_dir() and not (entry / ".support-directory").is_file()
    }
    self_owned = policy["skill"]
    if discovered != {self_owned}:
        raise AssertionError(f"unexpected discovered skills: {sorted(discovered)}")

    utterances = [fixture["utterance"] for fixture in fixtures]
    if len(utterances) != len(set(utterances)):
        raise AssertionError("routing fixtures must not contain duplicate utterances")

    declared = [route["utterance"] for route in policy["routes"]] + policy["nonMatches"]
    if utterances != declared:
        raise AssertionError("routing fixtures must mirror the skill routing policy")

    frontmatter = " ".join(
        SKILL_FILE.read_text(encoding="utf-8")
        .split("\n---\n", 1)[0]
        .lower()
        .split()
    )
    for route in policy["routes"]:
        for term in route["allTerms"]:
            if term not in frontmatter:
                raise AssertionError(f"frontmatter is missing routing term: {term}")


class HelloSuitcaseTest(unittest.TestCase):
    def test_greeting_unit(self):
        self.assertEqual(
            "# Greeting\n\nHello from the portable Skill Suitcase sample catalog.\n",
            GREETING.read_text(encoding="utf-8"),
        )

    def test_integration_temporary_directory_routing_e2e(self):
        """Exercise evaluate_routing plus an end-to-end local outcome."""
        runner = load_runner()
        fixtures = json.loads(ROUTING_FIXTURES.read_text(encoding="utf-8"))
        policy = json.loads(ROUTING_POLICY.read_text(encoding="utf-8"))
        audit_workspace(fixtures, policy)
        for fixture in fixtures:
            routed = runner.route_intent(fixture["utterance"])
            expected = fixture["expected"]
            forbidden = fixture["forbidden"]
            self.assertEqual(expected[0] if expected else None, routed)
            self.assertNotIn(routed, forbidden)

        self.assertTrue(SKILL_FILE.is_file(), "routing target must be reachable")

        with tempfile.TemporaryDirectory() as temporary_directory:
            completed = subprocess.run(
                [sys.executable, str(RUNNER), fixtures[0]["utterance"]],
                cwd=temporary_directory,
                check=True,
                capture_output=True,
                text=True,
            )
        self.assertEqual(GREETING.read_text(encoding="utf-8"), completed.stdout)


if __name__ == "__main__":
    unittest.main()
