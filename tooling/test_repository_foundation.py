import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from check_repository_foundation import check, PIN, UPSTREAM, TEMPLATE_SECTIONS


class PublicationBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        subprocess.run(["git", "init", "--quiet", str(self.root)], check=True)
        for name in ["src/main", "src/shared", "src/cli", "src/renderer", "mobile",
                     "provenance", ".github/workflows"]:
            (self.root / name).mkdir(parents=True, exist_ok=True)
        self.write("LICENSE", "preserved license notice")
        digest = hashlib.sha256((self.root / "LICENSE").read_bytes()).hexdigest()
        self.write("provenance/upstream-import.json", json.dumps({
            "source_commit": PIN, "repository": UPSTREAM,
            "imported_files": [{"path": "LICENSE", "sha256": digest}],
            "excluded_paths": [{"path": "mobile/google-services.json"}],
        }))
        self.write("mobile/package.json", "{}")
        self.write(".github/workflows/foundation-check.yml",
                   "contents: read\nrun: python3 tooling/check_repository_foundation.py\n")
        self.write(".github/PULL_REQUEST_TEMPLATE.md",
                   "\n".join("## " + heading for heading in TEMPLATE_SECTIONS))
        self.write(".github/CODEOWNERS", "* @hongseok-lee\n")
        self.stage()

    def write(self, name, body):
        (self.root / name).write_text(body)

    def stage(self):
        subprocess.run(["git", "add", "--all"], cwd=self.root, check=True)

    def errors(self):
        return check(self.root)[0]

    def test_baseline_and_import_attestation(self):
        self.assertEqual(check(self.root, verify_import=True)[0], [])
        self.write("LICENSE", "replacement notice")
        self.assertIn("upstream license notice changed", self.errors())

    def test_environment_file_cannot_be_published(self):
        self.write(".env", "DUMMY=yes\n")
        self.stage()
        self.assertIn("environment file prohibited: .env", self.errors())

    def test_extra_upstream_workflow_requires_review(self):
        self.write(".github/workflows/unreviewed.yml", "name: unreviewed\n")
        self.stage()
        self.assertIn("workflow set requires explicit foundation policy review", self.errors())

    def test_credential_shape_is_reported_without_its_value(self):
        self.write("new-file.txt", "ghp_" + "A" * 36)
        self.stage()
        errors = self.errors()
        self.assertIn("credential-shaped literal in new or changed file: new-file.txt", errors)
        self.assertFalse(any("A" * 36 in error for error in errors))


if __name__ == "__main__":
    unittest.main()
