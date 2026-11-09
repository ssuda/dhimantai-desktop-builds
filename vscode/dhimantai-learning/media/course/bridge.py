"""One real Jupyter kernel per open VS Code course notebook. JSON lines on stdin/stdout."""
import json
import os
from queue import Empty, Queue
import signal
import sys
from threading import Thread

from jupyter_client import KernelManager


def emit(**message):
    print(json.dumps(message, ensure_ascii=True), flush=True)


def main(language):
    manager = KernelManager(kernel_name='python3' if language == 'python' else language)
    manager.start_kernel(stdout=sys.stderr, stderr=sys.stderr)
    client = manager.client()
    client.start_channels()
    requests, inputs = Queue(), Queue()

    def interrupt():
        pid = getattr(manager.provisioner, 'pid', None)
        if pid:
            try:
                os.killpg(pid, signal.SIGINT)
            except ProcessLookupError:
                pass

    def receive():
        try:
            for line in sys.stdin:
                msg = json.loads(line)
                if msg['action'] == 'execute':
                    requests.put(msg)
                elif msg['action'] == 'interrupt':
                    interrupt()
                elif msg['action'] == 'input':
                    inputs.put(msg)
                elif msg['action'] == 'close':
                    break
        finally:
            interrupt()
            requests.put(None)

    try:
        client.wait_for_ready(timeout=45)
        Thread(target=receive, daemon=True).start()
        while (request := requests.get()) is not None:
            rid = request['id']
            sent = client.execute(request['code'], allow_stdin=True, stop_on_error=True)
            ok = True
            while True:
                try:
                    prompt = client.get_stdin_msg(timeout=0)
                    if prompt['parent_header'].get('msg_id') == sent:
                        emit(id=rid, kind='input', content=prompt['content'])
                except Empty:
                    pass
                try:
                    answer = inputs.get_nowait()
                    if answer['id'] == rid:
                        client.input(answer['value'])
                except Empty:
                    pass
                try:
                    msg = client.get_iopub_msg(timeout=.1)
                except Empty:
                    if not manager.is_alive():
                        raise RuntimeError('The course kernel stopped')
                    continue
                if msg['parent_header'].get('msg_id') != sent:
                    continue
                kind, content = msg['msg_type'], msg['content']
                if kind == 'status' and content['execution_state'] == 'idle':
                    emit(id=rid, kind='done', ok=ok)
                    break
                if kind == 'error':
                    ok = False
                if kind in ('error', 'stream', 'execute_input', 'display_data', 'execute_result', 'clear_output', 'update_display_data'):
                    emit(id=rid, kind=kind, content=content)
    finally:
        client.stop_channels()
        manager.shutdown_kernel(now=True)


if __name__ == '__main__':
    main(sys.argv[1])
