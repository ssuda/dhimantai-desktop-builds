import unittest
from course_agent.agent import run_agent
from course_agent.models import ScriptedModel


class Loop(unittest.TestCase):
    def test_observation_reaches_next_model_turn(self):
        model = ScriptedModel([{"tool":"search_documents","args":{"query":"missing"}},
                               {"final":{"answer":"","citations":[]}}])
        result = run_agent("Missing?", model, [])
        self.assertEqual(result["status"], "insufficient_evidence")
        self.assertEqual(model.requests[0], [{"role":"user","content":"Missing?"}])
        self.assertEqual(model.requests[1][-1], {"role":"tool","content":{"result":[]}})
        self.assertEqual(result["trace"][0]["role"], "assistant")

    def test_budget(self):
        model = ScriptedModel([{"tool":"search_documents","args":{"query":"x"}}]*10)
        self.assertEqual(run_agent("x", model, [], max_steps=2)["status"], "step_limit")
        self.assertEqual(len(model.requests), 2)
