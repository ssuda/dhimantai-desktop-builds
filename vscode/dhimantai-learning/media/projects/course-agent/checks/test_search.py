import unittest
from course_agent.search import search_documents


class Search(unittest.TestCase):
    def test_ranking_distinct_words_ties_and_limit(self):
        docs = [{"id":"b","title":"Course","text":"Project project submission"},
                {"id":"a","title":"Course","text":"Project submission"},
                {"id":"c","title":"Other","text":"Project"}]
        self.assertEqual(search_documents("PROJECT project submission", docs, 2),
            [{"id":"a","title":"Course","score":2},{"id":"b","title":"Course","score":2}])

    def test_empty_and_no_overlap(self):
        docs = [{"id":"x","title":"Project","text":"Submit"}]
        self.assertEqual(search_documents(" ", docs), [])
        self.assertEqual(search_documents("placement", docs), [])
