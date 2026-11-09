# Coding Attention Mechanisms

**Watch:** [Sebastian Raschka — Coding attention mechanisms](https://www.youtube.com/watch?v=-Ll8DtpNtvk). **Code along:** [Official chapter 3 notebooks](https://github.com/rasbt/LLMs-from-scratch/tree/main/ch03). These are original Dhimant companion notes and exercises.

**Outcome:** Implement scaled dot-product attention, prevent access to future tokens, and understand how multiple heads combine information. Keep a shape table beside your code.

## Queries, Keys, and Values

Attention builds a new representation at each position by combining information from eligible positions. A query describes what the current position is looking for; keys provide features used for matching; values carry the information being combined. These are learned numerical projections, not literal search terms.

For an input `X` of shape `(B, T, D)`, linear projections produce `Q`, `K`, and `V`. If each head has width `d`, a single head's query and key shapes are `(B, T, d)`. Multiplying `Q` by the transpose of `K` produces `(B, T, T)`. Row `i` contains the scores used when updating position `i`.

## Scores, Scaling, and Weighted Sums

The score matrix is `Q @ K.transpose(-2, -1) / sqrt(d)`. Scaling helps control score magnitudes as the head width changes. Apply softmax along the last axis so each row becomes a distribution over source positions. Multiplying these weights by `V` creates the context vectors.

A dot product can be positive, negative, or zero. It is not itself a probability. Likewise, attention weights are not a reliable standalone explanation of a model's entire decision; the rest of the network also affects the result.

```python
import math
import torch

q = torch.tensor([[[1.0, 0.0], [0.0, 1.0]]])
k = q.clone()
v = torch.tensor([[[10.0, 0.0], [0.0, 20.0]]])
scores = q @ k.transpose(-2, -1) / math.sqrt(q.shape[-1])
weights = scores.softmax(dim=-1)
context = weights @ v
assert context.shape == (1, 2, 2)
assert torch.allclose(weights.sum(dim=-1), torch.ones(1, 2))
```

Predict which value contributes more to the first output. Explain why the other value still contributes when attention is unmasked.

## Causal Masking

During next-token training, position `i` may use its own input token and preceding tokens. It must not read later input positions, because those positions contain information about its targets. A causal mask removes scores strictly above the diagonal before softmax.

Use negative infinity for blocked scores, not zero: zero is a valid score and would still receive probability mass. Every row must retain at least one eligible position; softmax over an entirely masked row can produce undefined values.

```python
import math
import torch

def causal_attention(q, k, v):
    length = q.shape[-2]
    scores = q @ k.transpose(-2, -1) / math.sqrt(q.shape[-1])
    blocked = torch.triu(
        torch.ones(length, length, dtype=torch.bool, device=q.device), diagonal=1
    )
    weights = scores.masked_fill(blocked, float("-inf")).softmax(dim=-1)
    return weights @ v, weights

torch.manual_seed(3)
x = torch.randn(1, 4, 3)
first, weights = causal_attention(x, x, x)
changed = x.clone()
changed[:, 3, :] += 100
second, _ = causal_attention(changed, changed, changed)
assert torch.allclose(first[:, :3], second[:, :3])
assert torch.count_nonzero(torch.triu(weights, diagonal=1)).item() == 0
```

This future-token perturbation is stronger evidence than merely checking the output shape. A wrong mask can produce perfectly plausible tensor dimensions.

## Multiple Heads and Dropout

Multi-head attention uses several learned query, key, and value projections. Reshape projected vectors into `(B, H, T, d)`, calculate each head's attention, then transpose and concatenate the head outputs back to `(B, T, H*d)`. A final projection mixes their information. The total model width must be divisible by the number of heads in this standard construction.

Heads can learn different patterns, but assigning a fixed linguistic role to each head before inspection is unwarranted. More heads do not automatically improve a model of fixed size.

Dropout randomly suppresses some values during training. If dropout is applied to attention weights, the sampled row sums need not equal one in every training pass. For deterministic mask tests, disable dropout and set evaluation mode. `eval()` changes dropout behavior but does not itself disable gradient tracking.

## Practice and Understanding Check

1. Implement a reusable single-head attention module with trainable projections. Verify output shapes for batch sizes one and three.
2. Implement four heads with a model width of sixteen. Print shapes before splitting, after splitting, and after recombination. Reject an incompatible width explicitly.
3. Add the future-token perturbation test. Also test a sequence of length one, where the only allowed attention weight is one before dropout.

**Independent check:** explain why masking after softmax without renormalizing changes the weighted sum. **Deliverable:** an attention notebook containing implementation, shape checks, causal behavior checks, and a brief explanation of one bug you found.

Reference: [PyTorch upper-triangular masking](https://docs.pytorch.org/docs/stable/generated/torch.triu.html).
