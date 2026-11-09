# Implementing a GPT Model

**Watch:** [Sebastian Raschka — Implementing a GPT model from scratch to generate text](https://www.youtube.com/watch?v=YSAkgEarBGE). **Code along:** [Official chapter 4 notebooks](https://github.com/rasbt/LLMs-from-scratch/tree/main/ch04). These are original Dhimant companion notes and exercises. The source article repeats the setup heading for this video; its actual topic is GPT architecture.

**Outcome:** Assemble a decoder-only transformer and trace how token IDs become next-token logits. Start with a small configuration so each component is inspectable.

## The Model's Data Flow

Token IDs enter an embedding table. Position embeddings are added. A stack of transformer blocks processes the resulting sequence. A final normalization and output projection produce one score for each vocabulary token at every sequence position.

With batch size `B`, sequence length `T`, model width `D`, and vocabulary size `V`, the main shapes are `(B,T)`, then `(B,T,D)`, then `(B,T,V)`. The final values are logits: unconstrained scores. During training, a loss function can consume them directly. During sampling, convert the final position's logits into a probability distribution if the sampling method needs one.

## Layer Normalization and Residual Connections

Layer normalization rescales features within a token representation using that token's feature mean and variance, followed by learned scale and shift. It differs from normalizing across examples in a batch. A small epsilon prevents division by zero when variance is tiny.

A residual connection adds a block's input to its transformed output. The shapes must match. In a pre-normalization transformer block, the two main updates are `x = x + attention(norm1(x))` and then `x = x + feedforward(norm2(x))`. Residual paths help information and gradients pass through a deep stack; they do not guarantee that every training configuration will be stable.

```python
import torch

x = torch.tensor([[[1.0, 2.0, 3.0, 4.0]]])
norm = torch.nn.LayerNorm(4, elementwise_affine=False)
normalized = norm(x)
assert normalized.shape == x.shape
assert torch.allclose(normalized.mean(dim=-1), torch.zeros(1, 1), atol=1e-6)
assert torch.isfinite(normalized).all()
assert torch.isfinite(norm(torch.ones(1, 1, 4))).all()
```

The normalized variance is approximately one for this nonconstant input, with the small epsilon affecting the exact value. Constant features remain finite rather than causing a divide-by-zero error.

## The Feedforward Network

The feedforward part applies the same learned transformation separately to each position: an expansion projection, a nonlinear activation such as GELU, and a projection back to the model width. Attention mixes information between positions; this feedforward operation transforms features at a position.

```python
import torch

torch.manual_seed(2)
width = 8
feedforward = torch.nn.Sequential(
    torch.nn.Linear(width, 4 * width),
    torch.nn.GELU(),
    torch.nn.Linear(4 * width, width),
)
x = torch.randn(2, 3, width)
y = x + feedforward(x)
assert y.shape == (2, 3, width)
```

The factor of four is a design choice in this example, not a mathematical requirement. Explain which projection must change if you select a different expansion factor.

## Output Projection and Generation

The output layer maps model features to vocabulary logits. The token used to extend the prompt comes from the final position's logits. Append that token ID, then repeat. Greedy decoding chooses the highest-scoring token; sampling can choose different tokens according to a distribution.

```python
import torch

logits = torch.tensor([[[0.0, 1.0, 4.0], [3.0, 0.0, 1.0]]])
next_token = logits[:, -1, :].argmax(dim=-1, keepdim=True)
prompt = torch.tensor([[1, 2]])
extended = torch.cat((prompt, next_token), dim=1)
assert extended.tolist() == [[1, 2, 0]]
```

The example uses artificial logits to isolate the generation step. It is not output from a trained language model. A randomly initialized GPT can generate token IDs, but its output is not evidence that it has learned language.

When the prompt exceeds the configured context length, a simple teaching implementation can pass only its most recent tokens to the model. Recreate valid local position indices for that input. Do not index beyond the position embedding table.

## Practice and Understanding Check

1. Assemble your attention module, two normalization layers, and a feedforward network into a transformer block. Confirm that it preserves `(B,T,D)`.
2. Build a tiny GPT with vocabulary size 32, context length 16, width 16, two heads, and two blocks. Check that an input of shape `(2,7)` produces logits of shape `(2,7,32)`.
3. Implement a greedy generation loop that produces exactly five additional token IDs. Verify that the context window never exceeds sixteen positions.

**Independent check:** explain why the output vocabulary size and embedding width are different quantities. Trace one complete forward pass without looking at the implementation. **Deliverable:** a tiny GPT implementation, parameter count, shape tests, and an untrained generation example explicitly labelled as untrained.

For your project report, separate architectural correctness from language quality. Correct dimensions and causal behavior are necessary checks, but neither demonstrates successful training.
