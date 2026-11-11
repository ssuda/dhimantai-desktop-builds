import unittest
from course_agent.answers import supported_answer
from course_agent.agent import run_agent
from course_agent.models import ScriptedModel


class Answers(unittest.TestCase):
    def test_quotes_must_support_entire_answer(self):
        source = {"a":"Submit before Friday. Ask your teacher."}
        citation = [{"id":"a","quote":"Submit before Friday."}]
        self.assertTrue(supported_answer("Submit before Friday.", citation, source))
        self.assertFalse(supported_answer("Submit after Friday.", citation, source))
        self.assertFalse(supported_answer("Submit before Friday.", citation, {}))
        self.assertFalse(supported_answer("", [], source))
        self.assertFalse(supported_answer("", [{"id":"a","quote":""}], source))

    def test_document_must_be_read_in_this_run(self):
        doc = {"id":"a","title":"Deadline","text":"Submit before Friday."}
        final = {"final":{"answer":doc["text"],"citations":[{"id":"a","quote":doc["text"]}]}}
        self.assertEqual(run_agent("When?", ScriptedModel([final]), [doc])["status"], "insufficient_evidence")
        model = ScriptedModel([{"tool":"read_document","args":{"id":"a"}}, final])
        self.assertEqual(run_agent("When?", model, [doc])["status"], "answered")
