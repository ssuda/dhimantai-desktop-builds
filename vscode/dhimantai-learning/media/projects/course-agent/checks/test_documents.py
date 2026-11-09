import unittest
from course_agent.documents import read_document


class Documents(unittest.TestCase):
    def test_exact_id(self):
        doc = {"id":"a","title":"Course","text":"Read this."}
        self.assertEqual(read_document("a", [doc]), doc)
        for invalid in ("A", "../.env", "", "/etc/passwd"):
            self.assertEqual(read_document(invalid, [doc]), {"error":"unknown_document"})
