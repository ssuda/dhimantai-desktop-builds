interface Window {
  installLearningVoice?(host:{postMessage(value:unknown):void}, playback?:{readonly muted:boolean; readonly deviceId:string; readonly playbackSpeed:number; listenForReply():void}, replied?:()=>void):
    {setScope(key:string):void; cancel():void; languageFor?(text:string):string | undefined; updateAudio():void; output(deviceId:string):Promise<void>; speed(speed:number):Promise<void>} | undefined;
  installCoachAudio?(host: {postMessage(value: unknown): void}, live?: {muted(muted:boolean):void; output?(deviceId:string):Promise<void>; speed?(speed:number):Promise<void>}):
    {readonly deviceId:string; readonly playbackSpeed:number; readonly muted:boolean; reply(id: string | null): void; listenForReply(): void; turnOff(): void} | undefined;
  installDictation?(host: {postMessage(value: unknown): void}, field: HTMLTextAreaElement | HTMLInputElement, interrupt?: () => void | Promise<boolean>,
    submit?: () => boolean):
    {setScope(key: string): void; cancel(): void; languageFor(text: string): string | undefined} | undefined;
}
