# Fine-Tuning for Classification

**Watch:** [Sebastian Raschka — Finetuning for classification](https://www.youtube.com/watch?v=5PFXJYme4ik). **Code along:** [Official chapter 6 notebooks](https://github.com/rasbt/LLMs-from-scratch/tree/main/ch06). These are original Dhimant companion notes and exercises.

**Outcome:** Adapt a pretrained model to a supervised classification task and evaluate the errors that matter. The source walkthrough uses spam classification; these notes use small numerical examples to make the evaluation logic inspectable.

## From Token Prediction to Class Prediction

A language-model head produces scores for vocabulary tokens. A classification head produces scores for task labels, such as two classes. A hidden representation of a sequence becomes the classifier's input. Fine-tuning adjusts selected parameters using examples paired with class labels.

For a causal decoder, a later position can summarize information from earlier positions. A first-position representation cannot attend to tokens that come after it. If you choose the final non-padding position as a sequence representation, select it consistently during both training and evaluation.

```python
import torch

torch.manual_seed(5)
hidden = torch.randn(2, 5, 8)
lengths = torch.tensor([3, 5])
assert (lengths > 0).all() and (lengths <= hidden.shape[1]).all()
last_valid = hidden[torch.arange(hidden.shape[0]), lengths - 1]
head = torch.nn.Linear(8, 2)
class_logits = head(last_valid)
assert class_logits.shape == (2, 2)
```

This assumes right padding and that `lengths` counts valid positions. It is not a general solution for left-padded batches. Hidden states in this example are synthetic; the cell demonstrates indexing and head shapes, not classification quality.

## Data Splits, Padding, and Truncation

Create training, validation, and test splits before tuning. Keep duplicate or near-duplicate messages in the same split. When messages from one sender or conversation are closely related, consider grouping them to avoid leakage. Examine class balance in every split.

Sequences in a batch need a compatible length. Define the padding token, maximum length, truncation policy, and how the selected representation handles padding. Truncation can remove decisive information from long messages. Include long and short examples in evaluation, and report what happens to empty or whitespace-only inputs.

## Which Parameters Should Learn?

Training only a new classification head is inexpensive and provides a useful baseline. Unfreezing later blocks or the whole model increases flexibility and computation. There is no guarantee that more trainable parameters will improve held-out results on a small dataset.

```python
import torch

backbone = torch.nn.Linear(4, 4)
head = torch.nn.Linear(4, 2)
for parameter in backbone.parameters():
    parameter.requires_grad_(False)
trainable = [p for module in (backbone, head) for p in module.parameters()
             if p.requires_grad]
assert sum(p.numel() for p in trainable) == 10
```

Freezing parameters and selecting evaluation mode solve different problems. Freezing controls gradient-based updates; evaluation mode changes behaviors such as dropout. Choose both deliberately for your experiment, and construct the optimizer from the parameters you intend to train.

## Accuracy, Precision, and Recall

Accuracy is the fraction of correct predictions. For the positive class, precision is `TP / (TP + FP)` and recall is `TP / (TP + FN)`. A false positive marks an ordinary message as spam; a false negative lets a spam message through. The relative cost depends on the application.

```python
truth = [1, 0, 1, 0, 0]
predicted = [1, 1, 0, 0, 0]
tp = sum(t == 1 and p == 1 for t, p in zip(truth, predicted))
fp = sum(t == 0 and p == 1 for t, p in zip(truth, predicted))
fn = sum(t == 1 and p == 0 for t, p in zip(truth, predicted))
accuracy = sum(t == p for t, p in zip(truth, predicted)) / len(truth)
precision = tp / (tp + fp) if tp + fp else 0.0
recall = tp / (tp + fn) if tp + fn else 0.0
assert (accuracy, precision, recall) == (0.6, 0.5, 0.5)
```

This example defines a zero-division policy of zero. State that policy when reporting results. Compare against a simple majority-class baseline; high accuracy on an imbalanced dataset can hide failure on the smaller class. Use validation data to choose a threshold, then evaluate the chosen procedure once on the held-out test set.

## Practice and Understanding Check

1. Build a majority-class baseline and a head-only fine-tuning baseline. Evaluate both using the same splits and metrics.
2. Compare head-only training with unfreezing a small part of the model. Record trainable parameter counts and computation as well as scores.
3. Inspect false positives and false negatives. Group errors into patterns, propose one improvement, and test it using validation data without repeatedly tuning on the test set.

**Independent check:** explain why a 95% accurate classifier could still be useless when 95% of examples belong to one class. **Deliverable:** a reproducible classifier, split description, confusion matrix, per-class results, and a discussion of padding, truncation, and uncertainty. The supplied exercises do not constitute a validated spam-filtering service.
