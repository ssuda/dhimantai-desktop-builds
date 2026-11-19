"""Two-GPU lab: one machine for tensor parallelism, or two private Ray nodes."""
import argparse
import json
import os


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", required=True, help="Same local model snapshot path on every node")
    parser.add_argument("--nodes", type=int, choices=(1, 2), default=int(os.environ.get('DHIMANTAI_GPU_NODES', '2')))
    args = parser.parse_args()
    if args.nodes == 2 and not os.environ.get("VLLM_HOST_IP"):
        raise RuntimeError("Set VLLM_HOST_IP to this node's private reachable IP before starting Ray.")
    from vllm import LLM, SamplingParams
    if args.nodes == 2:
        import ray
        ray.init(address="auto")
        nodes = [n for n in ray.nodes() if n["Alive"] and n.get("Resources", {}).get("GPU", 0) >= 1]
        if len(nodes) != 2 or any(n["Resources"]["GPU"] != 1 for n in nodes):
            raise RuntimeError("The cross-machine exercise expects two Ray nodes with one GPU each.")
    else:
        import torch
        if torch.cuda.device_count() != 2:
            raise RuntimeError('Expose exactly two GPUs for the single-machine tensor-parallel lab.')
        nodes = [{"NodeManagerAddress": "single-machine"}]
    # Qwen2.5-0.5B's attention-head count is divisible by two; do not arbitrarily raise TP.
    llm = LLM(model=args.model_path, tensor_parallel_size=2,
              distributed_executor_backend="ray" if args.nodes == 2 else "mp", dtype="half", max_model_len=1024,
              max_num_seqs=2, gpu_memory_utilization=0.70, enforce_eager=True, seed=17)
    output = llm.chat([[{"role": "user", "content": "Explain tensor parallel inference in two sentences."}]],
                      SamplingParams(temperature=0, max_tokens=64), use_tqdm=False)
    print(json.dumps({"gpu_nodes": [n["NodeManagerAddress"] for n in nodes],
                      "text": output[0].outputs[0].text, "finish_reason": output[0].outputs[0].finish_reason}))


if __name__ == "__main__":
    main()
