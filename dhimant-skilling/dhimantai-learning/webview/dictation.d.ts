interface Window {
  installDictation?(host: {postMessage(value: unknown): void}, field: HTMLTextAreaElement | HTMLInputElement, interrupt?: () => void):
    {setScope(key: string): void; cancel(): void} | undefined;
}
