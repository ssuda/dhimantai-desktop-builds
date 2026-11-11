"""Milestone 2: rank the supplied documents using distinct query words."""
import re


def words(text):
    return set(re.findall(r"[a-z0-9]+", text.casefold()))


def search_documents(query, documents, limit=3):
    """Return [{id, title, score}], highest overlap first; ties by id.

    Score is the number of DISTINCT query words in title + text. Omit zero
    scores. Return at most limit results. Blank query returns [].
    """
    raise NotImplementedError("Implement search_documents in milestone 2")
