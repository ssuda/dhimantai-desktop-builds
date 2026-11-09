"""Milestones 5–7: orchestrate messages, tools, evidence and stopping."""
from .answers import supported_answer
from .tools import dispatch


def run_agent(question, model, documents, max_steps=6):
    """Return {status, answer, citations, trace}.

    Begin messages with {role: 'user', content: question}. Each model.next(messages)
    returns {tool, args} or {final: {answer, citations}}. Append the action as
    {role: 'assistant', content: action}; append dispatch's observation as
    {role: 'tool', content: observation}. trace contains these same appended events.

    Stop after at most max_steps model calls (1–12; reject other limits with
    ValueError). Record documents successfully read in this run. Accept a final
    answer only when supported_answer passes; an empty answer with [] citations
    means insufficient_evidence. Other unsupported finals also stop with that status.

    Statuses: answered, insufficient_evidence, step_limit, invalid_action,
    model_error. Invalid final/action envelopes stop with invalid_action.
    Tool errors are observations: the model may recover within the same budget.
    Provider exceptions stop with model_error. Never include exception text.
    All non-answered results have answer '' and citations [].
    """
    raise NotImplementedError("Implement run_agent in milestone 5")
