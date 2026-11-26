"""Bounded observations of a single notebook cell during its ordinary execution."""
import ast
import contextlib
import hashlib
import itertools
import sys


def value_text(value, depth=0):
    """Display common Python values without invoking learner-defined representation methods."""
    kind = type(value)
    if kind is int and value.bit_length() > 256:
        return '<large integer>'
    if kind in (int, float, bool, type(None)):
        return repr(value)
    if kind in (str, bytes):
        return repr(value[:60])[:80] + ('…' if len(value) > 60 else '')
    if kind in (list, tuple, dict, set) and depth < 2:
        brackets = {list: '[]', tuple: '()', dict: '{}', set: '{}'}[kind]
        if kind is set and not value:
            return 'set()'
        parts = [value_text(item, depth + 1) for item in itertools.islice(value, 5)] if kind is not dict else [
            value_text(key, depth + 1) + ': ' + value_text(item, depth + 1)
            for key, item in itertools.islice(value.items(), 5)]
        if len(value) > 5:
            parts.append('…')
        body = ', '.join(parts) + (',' if kind is tuple and len(value) == 1 else '')
        return brackets[0] + body[:80] + brackets[1]
    return '<' + kind.__name__ + '>'


class LessonTrace:
    def __init__(self, source, observe_function=None):
        self.observe_function = observe_function
        self.call_args = {}
        self.function_calls = []
        self.steps = []
        self.limited = False
        self.output_line = 1
        self.digest = hashlib.sha256()
        try:
            tree = ast.parse(source)
            self.names = tuple(dict.fromkeys(node.id if isinstance(node, ast.Name) else node.arg
                                             for node in ast.walk(tree) if isinstance(node, (ast.Name, ast.arg))))
        except (SyntaxError, ValueError, RecursionError):
            self.names = ()
        self.frames = {}
        self.frame_ids = {}
        self.sequence = 0
        self.filename = None

    def values(self, frame):
        scope = frame.f_locals
        names = (name for name in self.names if name in scope and not name.startswith('__'))
        return {name: value_text(scope[name]) for name in itertools.islice(names, 16)}

    def trace(self, frame, event, arg):
        if self.limited:
            return None
        if event == 'call':
            code = frame.f_code
            if not self.filename and code.co_name == '<module>' and (
                    code.co_filename.startswith('<ipython-input-') or code.co_filename == self.fallback):
                self.filename = code.co_filename
            if code.co_filename != self.filename:
                return None
            if (self.observe_function and code.co_name == self.observe_function and code.co_argcount == 3
                    and frame.f_back is not None and frame.f_back.f_code.co_filename == self.filename
                    and not self.call_args and len(self.function_calls) < 24):
                args = [frame.f_locals.get(name) for name in code.co_varnames[:3]]
                if all(type(value) is int and value.bit_length() <= 256 for value in args):
                    self.call_args[frame] = [str(value) for value in args]
            self.sequence += 1
            self.frame_ids[frame] = 0 if code.co_name == '<module>' else self.sequence
            return self.trace
        if event not in ('line', 'return'):
            return self.trace
        if event == 'return' and frame in self.call_args:
            self.function_calls.append(dict(args=self.call_args.pop(frame), result=value_text(arg)))
        pending = self.frames.pop(frame, None)
        if pending:
            step, before = pending
            values = self.values(frame)
            step['locals'] = values
            step['previous'] = {name: before.get(name) for name in dict.fromkeys((*values, *before))
                                if before.get(name) != values.get(name)}
            self.steps.append(step)
            if len(self.steps) == 160:
                self.limited = True
                self.call_args.clear()
                self.frames.clear()
                self.frame_ids.clear()
                sys.settrace(None)
                return None
        if event == 'line':
            self.frames[frame] = ({'line': frame.f_lineno, 'function': frame.f_code.co_name, 'frame': self.frame_ids[frame]}, self.values(frame))
        else:
            self.frame_ids.pop(frame, None)
        return self.trace

    @contextlib.contextmanager
    def record(self, filename):
        self.fallback = filename
        observer = self
        stream = sys.stdout

        class Output:
            def write(self, text):
                count = stream.write(text)
                observer.digest.update(text.encode('utf-8', errors='replace'))
                frame = sys._getframe(1)
                while observer.frames and frame:
                    if frame in observer.frames:
                        step = observer.frames[frame][0]
                        step.setdefault('outputLine', observer.output_line)
                        step['printed'] = (step.get('printed', '') + text[:400])[:400]
                        break
                    frame = frame.f_back
                observer.output_line += text.count('\n')
                return count

            def __getattr__(self, name):
                return getattr(stream, name)

        original_trace = sys.gettrace()
        with contextlib.redirect_stdout(Output()):
            sys.settrace(self.trace)
            try:
                yield
            finally:
                sys.settrace(original_trace)
                self.call_args.clear()
                self.frames.clear()
                self.frame_ids.clear()

    def result(self, stdout):
        # Native writes bypass Python's text stream. Never attribute those lines to Python statements.
        aligned = self.digest.digest() == hashlib.sha256(stdout.encode('utf-8', errors='replace')).digest()
        return dict(steps=self.steps, limited=self.limited, outputAligned=aligned,
                    **({'functionCalls': self.function_calls} if self.observe_function else {}))
