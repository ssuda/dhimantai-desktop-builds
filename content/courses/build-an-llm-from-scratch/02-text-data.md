# Working with Text Data

**Watch:** [Sebastian Raschka — Working with text data](https://www.youtube.com/watch?v=341Rb8fJxY0). **Code along:** [Official chapter 2 notebooks](https://github.com/rasbt/LLMs-from-scratch/tree/main/ch02). These are original Dhimant companion notes; use the linked video for the complete instructor walkthrough.

**Outcome:** Convert text into token IDs, create next-token training pairs, and explain the shapes of token and position embeddings. You should already be able to run Python and perform basic tensor operations.

## From Characters to Token IDs

A language model receives numerical IDs rather than strings. A tokenizer defines how text is split into tokens and how each token maps to an integer. A token may be a character, a word fragment, punctuation, or another unit. A token ID is a lookup key; a larger ID does not mean a more important or more positive token.

Begin with a character tokenizer so every step is visible. This example builds a vocabulary from a small training string. It is a teaching example, not a tokenizer suitable for unrestricted input.

```python
text = "tea time"
vocabulary = sorted(set(text))
to_id = {character: index for index, character in enumerate(vocabulary)}
to_character = {index: character for character, index in to_id.items()}
encoded = [to_id[character] for character in text]
decoded = "".join(to_character[index] for index in encoded)
assert decoded == text
assert len(encoded) == len(text)
```

An unseen character causes this simple encoder to fail. A production tokenizer needs a defined way to handle unfamiliar inputs. Do not silently drop an unknown character: doing so changes the text being represented.

## Subword Tokenization and Byte Pair Encoding

Whole-word vocabularies grow quickly and struggle with unfamiliar words. Character tokenization keeps the vocabulary small but can require long sequences. Subword tokenization trades between these extremes by representing frequent pieces as units.

In a simplified byte pair encoding learning procedure, begin with small symbols, count adjacent pairs, merge a frequent pair, and repeat. The learned merge rules determine encoding; the rules are not relearned each time a new sentence arrives. Real byte-level implementations also require precise handling of bytes, boundaries, and special tokens. Use the official implementation for the code-along, and inspect its outputs rather than assuming every token corresponds to a word.

Compare a familiar word, an unusual name, punctuation, and a Telugu word. Record their token counts. Different counts do not indicate that one language has less meaning; they reflect the tokenizer's vocabulary and encoding rules.

## Next-Token Inputs and Targets

For a token sequence `[4, 7, 2, 9, 1]` and a context length of four, the input is `[4, 7, 2, 9]` and the target is `[7, 2, 9, 1]`. Each target is one position ahead. The model predicts a next-token distribution at every input position, not just after the final token.

```python
def next_token_windows(token_ids, context_length, stride):
    if context_length < 1 or stride < 1:
        raise ValueError("context_length and stride must be positive")
    return [
        (token_ids[start:start + context_length],
         token_ids[start + 1:start + context_length + 1])
        for start in range(0, len(token_ids) - context_length, stride)
    ]

pairs = next_token_windows([4, 7, 2, 9, 1], 4, 1)
assert pairs == [([4, 7, 2, 9], [7, 2, 9, 1])]
assert next_token_windows([4, 7], 4, 1) == []
```

Stride controls how far the next window moves. Smaller strides reuse more text. Split documents into training and validation sets before creating overlapping windows; otherwise nearby copies can appear in both sets and make evaluation misleading.

## Token Embeddings and Position Embeddings

An embedding table has shape `(vocabulary_size, embedding_dimension)`. Looking up token IDs of shape `(batch, sequence)` produces vectors of shape `(batch, sequence, embedding_dimension)`. The table contains trainable parameters. Repeated occurrences of one token initially select the same token vector; later attention creates context-dependent representations.

Position information distinguishes the same tokens in different orders. One approach adds a learned vector for each position to the token embedding. The two vectors need matching dimensions.

```python
import torch

torch.manual_seed(7)
ids = torch.tensor([[0, 1, 2], [2, 1, 0]], dtype=torch.long)
token_embedding = torch.nn.Embedding(5, 4)
position_embedding = torch.nn.Embedding(3, 4)
vectors = token_embedding(ids) + position_embedding(torch.arange(3))
assert vectors.shape == (2, 3, 4)
assert token_embedding.weight.shape == (5, 4)
```

The position vectors broadcast over the batch axis. The token ID input must use an integer type. IDs outside the embedding table's range are errors, not unknown-token handling.

## Practice and Understanding Check

1. Implement `encode` and `decode` for a character vocabulary. Test spaces, repeated characters, an empty string, and an unknown character. State your unknown-character policy explicitly.
2. For nine token IDs, context length three, and stride two, list every input/target pair by hand, then verify it with code.
3. Change the embedding dimension to six and predict all affected tensor shapes. Explain why the vocabulary size can stay unchanged.

**Independent check:** explain why using the input sequence itself as the target would teach a different task. **Deliverable:** a small data-preparation notebook with round-trip tests, shifted-target tests, and a documented split policy. The checks should detect indexing errors even when tensor shapes happen to be correct.

Reference: [PyTorch Embedding](https://docs.pytorch.org/docs/stable/generated/torch.nn.Embedding.html).
