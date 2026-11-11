import json
import sys
import unittest
from pathlib import Path
from course_agent.models import ScriptedModel


class Setup(unittest.TestCase):
    def test_python_and_documents(self):
        self.assertGreaterEqual(sys.version_info[:2], (3, 10))
        docs = json.loads((Path(__file__).resolve().parents[1] / "data/documents.json").read_text())
        self.assertEqual(len({d["id"] for d in docs}), len(docs))
        self.assertTrue(all(d["text"].strip() for d in docs))

    def test_scripted_model_is_explicit(self):
        self.assertEqual(ScriptedModel([{"final": {"answer": "", "citations": []}}]).next([]),
                         {"final": {"answer": "", "citations": []}})
