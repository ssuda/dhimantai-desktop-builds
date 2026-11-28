/** Installed in a disposable webview. Simulates only the LiveKit transcription peer. */
export function installVoicePeer(w: any) {
  const peer = {identity:'dhimantai-transcription', isAgent:true, attributes:{'voice.input':'ready'}};
  w.LivekitClient = {...w.LivekitClient, Room:class {
    remoteParticipants = new Map([[peer.identity,peer]]);
    localParticipant = {
      registerRpcMethod:(_name:string, handler:Function) => {
        w.finishTestUtterance = (text:string, language:string) => handler({callerIdentity:peer.identity, payload:JSON.stringify({text,language})});
      },
      publishTrack:async () => {}, performRpc:async () => 'ok',
    };
    on() {} async connect() {} async disconnect() {}
  }, createLocalAudioTrack:async () => {
    const stream = await w.navigator.mediaDevices.getUserMedia({audio:true});
    const track = stream.getAudioTracks()[0];
    return {mediaStreamTrack:track, stop:() => track.stop()};
  }};
}
