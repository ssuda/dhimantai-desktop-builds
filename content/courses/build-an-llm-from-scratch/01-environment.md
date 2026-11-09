# Set Up Your Code Environment

Build a small language model step by step: prepare text, implement attention, assemble a GPT model, train it, and adapt it to useful tasks. The aim is to explain and test each component. Training a model that produces fluent, reliable conversation requires much more data and computation than the small experiments in this course.

**Watch:** [Sebastian Raschka — Set up your code environment](https://www.youtube.com/watch?v=yAcWnfsZhzo). **Code-along source:** [Official setup instructions](https://github.com/rasbt/LLMs-from-scratch/tree/main/setup). This chapter contains original Dhimant companion notes and exercises; the linked videos belong to their creator. The course follows the [original course outline](https://magazine.sebastianraschka.com/p/coding-llms-from-the-ground-up) and is not an official Sebastian Raschka certification.

**Before starting:** You should be comfortable with Python functions, lists, dictionaries, classes, imports, and reading an error message. If these are unfamiliar, practise them in the Python course first. You can learn tensor operations alongside this course. Use a laptop or desktop for the coding work; the videos and Tutor discussions are also suitable for mobile.

## A Reproducible Python Workspace

A virtual environment keeps a project's packages separate from other projects. A notebook kernel must use the same environment in which the packages were installed. A successful installation in one terminal does not prove that a different notebook kernel can import that package.

Follow the official setup instructions for your operating system. For the small Dhimant examples, a local environment needs PyTorch and a notebook interface. Record the Python and PyTorch versions after installation. Exact package versions should come from a tested environment, not from an old video screenshot. Keep the environment information beside your experiment so another learner can reproduce it.

The supplied downloadable labs run in local Jupyter or a compatible notebook service. Dhimant's general project runner does not currently provide this course's PyTorch environment. A cloud GPU is optional for the first exercises; do not start a paid training job for the setup check.

## Tensors and Shapes

A tensor is a numerical array. Shape describes the length of each axis. In a text model, a common shape is `(batch, sequence, features)`. A shape of `(2, 4, 8)` means two sequences, four token positions per sequence, and eight features per position. It does not mean eight words.

Matrix multiplication combines the final two axes. Multiplying `(4, 3)` by `(3, 2)` produces `(4, 2)`. The shared inner dimension represents matching features. Swapping axes is different from reshaping: a transpose changes which axis a value belongs to, while a reshape rearranges how the same ordered elements are grouped.

```python
import torch

x = torch.tensor([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]])
w = torch.tensor([[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]])
y = x @ w
assert y.shape == (2, 2)
assert torch.equal(y, torch.tensor([[4.0, 5.0], [10.0, 11.0]]))
print(y)
```

Predict the output before running the cell. For the first output entry, multiply the first input row by the first weight column: `1*1 + 2*0 + 3*1 = 4`. Trace the other entries in the same way.

## Gradients and Parameter Updates

A gradient tells us how a small change in a parameter changes the loss locally. PyTorch records differentiable operations when a tensor requires gradients. Calling `backward()` accumulates gradients; it does not update the parameters. An optimizer performs the update, and gradients usually need clearing before the next training step.

```python
import torch

weight = torch.tensor(2.0, requires_grad=True)
loss = (3 * weight - 1) ** 2
loss.backward()
assert weight.item() == 2.0
assert weight.grad.item() == 30.0
with torch.no_grad():
    weight -= 0.01 * weight.grad
weight.grad = None
assert torch.isclose(weight, torch.tensor(1.7))
```

Here the loss is `(3w - 1)^2`; its derivative is `6(3w - 1)`, which equals 30 at `w = 2`. The small update moves opposite the gradient. A learning rate that is too large can increase the loss rather than reduce it.

## Devices, Seeds, and Experiment Records

Start on the CPU with small tensors. A model and its input tensors must be on compatible devices. A GPU can accelerate some workloads, but tiny examples may spend more time transferring data than computing. Do not assume every notebook service provides a GPU.

A random seed makes many random operations repeatable within a controlled environment. It does not guarantee identical results across all devices, library versions, or nondeterministic operations. Record the seed, device, versions, data split, and model configuration. For published results, save the code and configuration used to produce them.

## Practice and Readiness Check

1. Create a `(3, 2)` tensor and a `(2, 4)` weight matrix. Predict the output shape and calculate one entry by hand before running the multiplication.
2. Repeat the gradient example with an initial weight of 1. The gradient should be 12. Explain why changing the initial weight changes the gradient.
3. Deliberately select the wrong notebook kernel, observe the import problem, and explain how you would diagnose it without repeatedly reinstalling packages.

**Evidence to keep:** the environment versions, your matrix calculation, and the gradient calculation. **Explain independently:** what is the difference between calculating a gradient and updating a parameter? A completed installation demonstrates readiness to run code; it does not demonstrate understanding of language models.

Further reading: [PyTorch tensor and neural-network introduction](https://github.com/rasbt/LLMs-from-scratch/tree/main/appendix-A).
