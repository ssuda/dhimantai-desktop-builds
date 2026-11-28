import type { RemoteParticipant, Room } from 'livekit-client';

declare const LivekitClient: typeof import('livekit-client');

/** Newly joined K–12 workers advertise their identity before their mode RPC is ready. */
export async function waitForLearningAgent(live: Room, current: () => boolean, start: (peer: RemoteParticipant) => Promise<void>) {
  const deadline = Date.now() + 65000;
  while (current() && Date.now() < deadline) {
    const peer = [...live.remoteParticipants.values()].find(p => p.isAgent);
    if (peer) {
      try { await start(peer); return; }
      catch (error) {
        if (!(LivekitClient.RpcError && error instanceof LivekitClient.RpcError && error.code === LivekitClient.RpcError.ErrorCode.UNSUPPORTED_METHOD)) throw error;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  if (current()) throw new Error('The learning agent did not become ready. Select the microphone to reconnect.');
}

export function switchLearningMode(live: Room, agent: string, mode: object) {
  return live.localParticipant.performRpc({ destinationIdentity: agent, method: 'switch_mode', payload: JSON.stringify(mode), responseTimeout: 30000 });
}

export async function prepareLearningAudio(live: Room, agent: string) {
  const ack = await live.localParticipant.performRpc({
    destinationIdentity: agent, method: 'toggle_audio',
    payload: JSON.stringify({ input_enabled: false, output_enabled: true }), responseTimeout: 8000
  });
  if (ack !== 'ok') throw new Error('Learning audio was not ready. Select the microphone to reconnect.');
}
