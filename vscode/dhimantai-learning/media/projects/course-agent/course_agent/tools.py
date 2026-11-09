"""Milestone 4: turn a model's proposal into a validated, read-only tool call."""
from .documents import read_document
from .search import search_documents


def dispatch(action, documents):
    """Accept exactly {tool, args}; return {result: value} or {error: code}.

    search_documents args: exactly {query: nonblank str up to 200 chars}.
    read_document args: exactly {id: nonblank str up to 80 chars}.
    Errors: invalid_action, unknown_tool, invalid_arguments.
    A missing document returns {result: {error: 'unknown_document'}}.
    """
    raise NotImplementedError("Implement dispatch in milestone 4")
