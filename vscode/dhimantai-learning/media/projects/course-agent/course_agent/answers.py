"""Milestone 6: validate a deliberately narrow, extractive answer contract."""


def supported_answer(answer, citations, read_documents):
    """Return bool. Require 1–3 citations, each exactly {id, quote}.

    Each nonblank quote must occur literally in the text of a document read
    during THIS run. answer must equal the quotes joined with a newline.
    read_documents maps IDs to document text. An existing source ID alone
    does not support a claim. This baseline validates quotations, not relevance.
    """
    raise NotImplementedError("Implement supported_answer in milestone 6")
