"""Installed runner: stdio transports bounded model actions, never platform credentials."""
import json
import sys

transport = sys.stdout
sys.stdout = sys.stderr


class ManagedModel:
    def __init__(self):
        self.calls = 0

    def next(self, messages):
        self.calls += 1
        if self.calls > 6:
            raise RuntimeError('Managed live run reached its six-call limit.')
        transport.write(json.dumps({'messages': messages}) + '\n')
        transport.flush()
        line = sys.stdin.readline(128001)
        if len(line) > 128000 or not line.endswith('\n'):
            raise RuntimeError('Managed live connection ended.')
        response = json.loads(line)
        if 'error' in response:
            raise RuntimeError(response['error'])
        return response['action']


print('Mode: managed live model · platform access · no personal API key')
import course_agent.models
course_agent.models.LiveModel = ManagedModel
from course_agent.__main__ import main
sys.argv = ['course_agent', '--live', '--trace', '--question', sys.argv[1]]
raise SystemExit(main())
