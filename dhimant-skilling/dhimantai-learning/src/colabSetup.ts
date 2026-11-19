export const COLAB_SETUP_STEPS = `1. Choose **Use Colab Kernel** in the notebook toolbar (it may be under **…**). This prepares Google's Colab extension and Microsoft Jupyter. Enable both in Extensions and reload the app if prompted.
2. In **Select Kernel**, choose **Select Another Kernel → Colab → New Colab Server**. Sign in with Google, choose **GPU**, then select the server's **Python 3 (ipykernel)** kernel. Do not choose **Auto Connect**, which may allocate a CPU.
3. Check that the notebook's selected kernel is the Colab server, then run the hardware-check cell. A connection failure does not establish whether a compatible GPU is available.

If the picker title is **dhimantAI Learning** and it lists only Course / Practice kernels, use its **Back** arrow to return to the kernel sources; **Colab** is a separate source. If searching for Colab shows no match, close the picker and use **Use Colab Kernel** first. If it is still missing, check that **Google Colab** and **Microsoft Jupyter** are enabled and up to date, reload the app, and inspect **View → Output → Colab / Jupyter** for activation errors. Google's separate **Colab** toolbar menu manages servers; it is not a prerequisite for showing the kernel source.`;

export interface ExternalNotebookRuntime {
  provider: 'google.colab' | 'jupyter';
  accelerator: 'gpu' | 'tpu';
  version: 1;
}

/** Preserve external compute even when a notebook is copied into a course folder. */
export function externalNotebookRuntime(metadata: Record<string, any>, sources: string[] = []): ExternalNotebookRuntime | undefined {
  const runtime = metadata.dhimantai_runtime;
  if (runtime?.version === 1 && ['google.colab', 'jupyter'].includes(runtime.provider)
      && ['gpu', 'tpu'].includes(runtime.accelerator)) return runtime;
  // Earlier connection notebooks had no runtime metadata. Recognize only our
  // generated Colab probe so existing course copies also get the recovery flow.
  if (sources.some(source => source.includes('DHIMANTAI_GPU_READY')
      && source.includes('COLAB_RELEASE_TAG') && source.includes('nvidia-smi')))
    return {provider: 'google.colab', accelerator: 'gpu', version: 1};
}
