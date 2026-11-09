"""A code cell is a complete single-file program, run in the notebook directory."""
from pathlib import Path
import subprocess
import sys
import tempfile

from ipykernel.kernelbase import Kernel
from ipykernel.kernelapp import IPKernelApp

language = sys.argv.pop(1)
commands = {
    'c': ('main.c', ['gcc', '-std=c17', '{src}', '-o', '{bin}'], ['{bin}']),
    'rust': ('main.rs', ['rustc', '--edition=2021', '{src}', '-o', '{bin}'], ['{bin}']),
    'go': ('main.go', ['go', 'build', '-o', '{bin}', '{src}'], ['{bin}']),
    'java': ('Main.java', ['javac', '{src}'], ['java', '-cp', '{tmp}', 'Main']),
    'javascript': ('main.js', [], ['node', '{src}']),
    'typescript': ('main.ts', ['tsc', '--target', 'ES2022', '--module', 'commonjs', '--typeRoots',
                               '/usr/local/lib/node_modules/@types', '{src}'], ['node', '{tmp}/main.js']),
}


class ProgramKernel(Kernel):
    implementation = 'dhimantai-program'
    implementation_version = '1'
    language_info = {'name': language, 'file_extension': '.' + commands[language][0].split('.')[-1]}
    banner = 'Each code cell runs as a complete program.'

    def do_execute(self, code, silent, store_history=True, user_expressions=None, allow_stdin=False, **kwargs):
        filename, build, execute = commands[language]
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp, filename)
            source.write_text(code)
            paths = dict(src=str(source), bin=tmp+'/program', tmp=tmp)
            for command in (build, execute):
                if not command:
                    continue
                result = subprocess.run([a.format(**paths) for a in command], stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace')
                if not silent and result.stdout:
                    self.send_response(self.iopub_socket, 'stream', {'name': 'stdout', 'text': result.stdout})
                if result.returncode:
                    error = dict(ename='ProgramError', evalue=f'Exit code {result.returncode}', traceback=result.stdout.splitlines())
                    if not silent:
                        self.send_response(self.iopub_socket, 'error', error)
                    return dict(status='error', execution_count=self.execution_count, **error)
        return dict(status='ok', execution_count=self.execution_count, payload=[], user_expressions={})


IPKernelApp.launch_instance(kernel_class=ProgramKernel)
