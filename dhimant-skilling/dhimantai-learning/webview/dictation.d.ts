interface Window {
  installCoachAudio?(host: {postMessage(value: unknown): void}):
    {reply(id: string | null): void; listenForReply(): void; turnOff(): void} | undefined;
  installDictation?(host: {postMessage(value: unknown): void}, field: HTMLTextAreaElement | HTMLInputElement, interrupt?: () => void):
    {setScope(key: string): void; cancel(): void} | undefined;
}
