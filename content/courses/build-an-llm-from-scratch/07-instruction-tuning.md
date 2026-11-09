# Instruction Fine-Tuning

**Watch:** [Sebastian Raschka — Instruction finetuning](https://www.youtube.com/watch?v=4yNswvhPWCQ). **Code along:** [Official chapter 7 notebooks](https://github.com/rasbt/LLMs-from-scratch/tree/main/ch07). These are original Dhimant companion notes and exercises.

**Outcome:** Prepare instruction-response examples, construct a correct loss mask, fine-tune within a bounded experiment, and evaluate changes on unseen prompts. Begin with a pretrained checkpoint if you want to investigate instruction-following behavior; a tiny random model trained on a handful of examples is primarily a pipeline check.

## Instructions, Context, and Responses

An instruction dataset typically contains a request, optional input context, and a desired response. Choose a consistent formatting template and use it at inference time as well as during training. Inconsistent separators or missing end markers can teach unwanted continuation patterns.

```python
def format_prompt(instruction, context=""):
    if not instruction.strip():
        raise ValueError("instruction must not be empty")
    parts = ["Instruction:\n" + instruction.strip()]
    if context.strip():
        parts.append("Input:\n" + context.strip())
    parts.append("Response:\n")
    return "\n\n".join(parts)

prompt = format_prompt("Write one polite greeting.")
assert prompt.endswith("Response:\n")
assert "Input:" not in prompt
```

This is an original teaching template, not a promise of compatibility with every pretrained chat model. A model may expect its own special tokens and chat template. Match the source checkpoint's intended format when using one.

## Shifted Labels and Response-Only Loss

Training still predicts the next token. One possible objective trains on the whole formatted example; another computes loss only for response tokens. State which objective you use. Response-only loss is useful for focusing updates on the desired answer, but it is not the only valid instruction-tuning setup.

Let a full token sequence contain `P` prompt tokens followed by response tokens. Inputs are `tokens[:-1]` and labels are `tokens[1:]`. The first response token is predicted at input position `P - 1`. Mask label positions before that point, rather than accidentally masking the first response token too.

```python
import torch
import torch.nn.functional as F

tokens = torch.tensor([10, 11, 12, 20, 21, 2])
prompt_length = 3
inputs = tokens[:-1]
labels = tokens[1:].clone()
labels[:prompt_length - 1] = -100
assert labels.tolist() == [-100, -100, 20, 21, 2]
logits = torch.zeros(inputs.numel(), 32)
loss = F.cross_entropy(logits, labels, ignore_index=-100)
assert torch.allclose(loss, torch.log(torch.tensor(32.0)))
```

The numbers here are illustrative IDs, and `2` is an illustrative end-of-sequence token. Actual IDs depend on your tokenizer. Compute prompt boundaries using the same tokenization and template as the full sequence; separately tokenized substrings are not always interchangeable with the final token sequence.

## Padding, Truncation, and Valid Supervision

Batch examples by padding inputs to a common length. Mask padding labels out of the loss. If the same token ID represents both end-of-sequence and padding, mask by position and original length so that the genuine end-of-sequence target can remain supervised.

Truncation can remove every response token. Detect and reject or reprocess such examples; a batch with no supervised targets cannot provide a meaningful mean loss. Report the fraction of examples truncated or skipped. Inspect a few tokenized samples manually before a long run.

## Data Quality and Evaluation

Remove duplicate examples across splits and inspect responses for incorrect facts, inconsistent style, and unwanted personal information. Use examples whose use is permitted. More examples are not necessarily better if they teach contradictory or incorrect behavior.

Create a held-out prompt set before tuning. Include tasks such as extracting a field, following a length constraint, rewriting a sentence, using supplied context, and acknowledging missing information. Compare the starting and tuned models on identical prompts and decoding settings. Include some tasks outside the narrow training pattern to check generalization.

Evaluate correctness, instruction adherence, and unsupported claims separately. Deterministic tasks can use exact checks; open-ended responses need a clear rubric and human inspection. An automated judge can assist, but its score alone is not proof of improved understanding or reliable behavior.

## Capstone: A Reproducible Small LLM Experiment

Bring together the tokenizer, data loader, causal attention, transformer, training loop, and one fine-tuning experiment. Separate code you implemented from code or pretrained weights taken from the official repository. Preserve applicable attribution and license notices for reused code.

Record the starting checkpoint, tokenizer, data sources, splits, seed, model configuration, trainable parameters, training budget, and decoding settings. Include a small evaluation table with successes and failures. Save the final checkpoint and the commands needed to reproduce your result.

## Practice and Understanding Check

1. Implement collation for two different-length instruction examples. Print input IDs, label IDs, and supervised positions. Verify that padding is ignored and the first response token is included.
2. Test an example whose response is entirely removed by truncation. Your pipeline should report the issue instead of silently training on an empty target set.
3. Compare a starting checkpoint and a tuned checkpoint on held-out prompts. Explain one improvement and one regression using the actual outputs.

**Independent check:** change the instruction template or maximum length, predict the effect on labels, then verify the change with code. **Deliverable:** the capstone notebook, reproducibility record, evaluation examples, and a code walkthrough. Watching the videos or copying a finished notebook alone does not establish independent ability.

Course sources: [Sebastian Raschka's original video course](https://magazine.sebastianraschka.com/p/coding-llms-from-the-ground-up) and [official code repository](https://github.com/rasbt/LLMs-from-scratch).
