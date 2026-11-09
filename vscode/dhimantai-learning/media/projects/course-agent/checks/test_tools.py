import unittest
from course_agent.tools import dispatch


class Tools(unittest.TestCase):
    def test_valid_tools(self):
        docs = [{"id":"a","title":"Course","text":"Project"}]
        self.assertEqual(dispatch({"tool":"read_document","args":{"id":"a"}}, docs), {"result":docs[0]})
        self.assertEqual(dispatch({"tool":"search_documents","args":{"query":"project"}}, docs),
                         {"result":[{"id":"a","title":"Course","score":1}]})

    def test_invalid_actions_never_dispatch(self):
        for action, error in [({}, "invalid_action"), ([], "invalid_action"),
                ({"tool":"shell","args":{}}, "unknown_tool"),
                ({"tool":"read_document","args":{"id":3}}, "invalid_arguments"),
                ({"tool":"read_document","args":{"id":"a","path":".env"}}, "invalid_arguments"),
                ({"tool":"search_documents","args":{"query":" "}}, "invalid_arguments"),
                ({"tool":"search_documents","args":{"query":"x"*201}}, "invalid_arguments")]:
            with self.subTest(action=action):
                self.assertEqual(dispatch(action, []), {"error":error})
