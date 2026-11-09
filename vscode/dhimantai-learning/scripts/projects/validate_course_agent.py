"""Author-only reference and mutation checks. Never included in the learner starter or VSIX."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
STARTER = ROOT / 'media/projects/course-agent'

REFERENCE = {
'documents.py': '''def read_document(document_id, documents):
    for document in documents:
        if document['id'] == document_id:
            return dict(document)
    return {'error': 'unknown_document'}
''',
'tools.py': '''from .documents import read_document
from .search import search_documents

def dispatch(action, documents):
    if not isinstance(action, dict) or set(action) != {'tool', 'args'} or not isinstance(action['tool'], str):
        return {'error': 'invalid_action'}
    name, args = action['tool'], action['args']
    if name not in {'search_documents', 'read_document'}:
        return {'error': 'unknown_tool'}
    key, bound = ('query', 200) if name == 'search_documents' else ('id', 80)
    if not isinstance(args, dict) or set(args) != {key} or not isinstance(args[key], str) or not args[key].strip() or len(args[key]) > bound:
        return {'error': 'invalid_arguments'}
    result = search_documents(args[key], documents) if name == 'search_documents' else read_document(args[key], documents)
    return {'result': result}
''',
'answers.py': '''def supported_answer(answer, citations, read_documents):
    if not isinstance(answer, str) or not isinstance(citations, list) or not 1 <= len(citations) <= 3:
        return False
    quotes = []
    for citation in citations:
        if not isinstance(citation, dict) or set(citation) != {'id', 'quote'}:
            return False
        ident, quote = citation['id'], citation['quote']
        if not isinstance(ident, str) or not isinstance(quote, str) or not quote.strip():
            return False
        if ident not in read_documents or quote not in read_documents[ident]:
            return False
        quotes.append(quote)
    return answer == '\\n'.join(quotes)
''',
'agent.py': '''from .answers import supported_answer
from .tools import dispatch

def run_agent(question, model, documents, max_steps=6):
    if type(max_steps) is not int or not 1 <= max_steps <= 12:
        raise ValueError('Invalid step budget')
    messages = [{'role': 'user', 'content': question}]
    trace, read = [], {}
    def result(status, answer='', citations=None):
        return {'status': status, 'answer': answer, 'citations': citations or [], 'trace': trace}
    for _ in range(max_steps):
        try:
            action = model.next(messages)
        except Exception:
            return result('model_error')
        event = {'role': 'assistant', 'content': action}
        messages.append(event)
        trace.append(event)
        if not isinstance(action, dict):
            return result('invalid_action')
        if set(action) == {'final'}:
            final = action['final']
            if not isinstance(final, dict) or set(final) != {'answer', 'citations'} or not isinstance(final['answer'], str) or not isinstance(final['citations'], list):
                return result('invalid_action')
            if supported_answer(final['answer'], final['citations'], read):
                return result('answered', final['answer'], final['citations'])
            return result('insufficient_evidence')
        if set(action) != {'tool', 'args'}:
            return result('invalid_action')
        observation = dispatch(action, documents)
        doc = observation.get('result')
        if action['tool'] == 'read_document' and isinstance(doc, dict) and 'text' in doc and 'id' in doc:
            read[doc['id']] = doc['text']
        event = {'role': 'tool', 'content': observation}
        messages.append(event)
        trace.append(event)
    return result('step_limit')
''',
}
REFERENCE['search.py'] = '''import re

def words(text):
    return set(re.findall(r'[a-z0-9]+', text.casefold()))

def search_documents(query, documents, limit=3):
    tokens = words(query)
    scored = [{'id': d['id'], 'title': d['title'], 'score': len(tokens & words(d['title'] + ' ' + d['text']))} for d in documents]
    return sorted([d for d in scored if d['score'] > 0], key=lambda d: (-d['score'], d['id']))[:limit]
'''


def run(root, *args):
    return subprocess.run([sys.executable, '-B', *args], cwd=root, text=True, capture_output=True, timeout=10)


def validate():
    curriculum = json.loads((ROOT / 'media/projects/course-agent.json').read_text())
    for path in curriculum['files']:
        assert (STARTER / path).is_file(), path
    with tempfile.TemporaryDirectory(prefix='course-agent-validation-') as tmp:
        project = Path(tmp) / 'project'
        shutil.copytree(STARTER, project, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        assert run(project, '-m', 'unittest', 'checks.test_setup').returncode == 0
        for module in ('search', 'documents', 'tools', 'loop', 'answers', 'reliability'):
            failed = run(project, '-m', 'unittest', 'checks.test_' + module)
            assert failed.returncode != 0 and 'NotImplementedError' in failed.stderr, module
        for name, source in REFERENCE.items():
            (project / 'course_agent' / name).write_text(source)
        passed = run(project, '-m', 'unittest', 'discover', '-s', '.', '-p', 'test_*.py', '-v')
        assert passed.returncode == 0, passed.stderr
        for scenario in ('submission', 'missing'):
            demo = run(project, '-m', 'course_agent', '--scenario', scenario, '--trace')
            assert demo.returncode == 0, demo.stdout + demo.stderr
        mutations = [
            ('search.py', "(-d['score'], d['id'])", "(d['score'], d['id'])", 'search'),
            ('search.py', "words(query)", "set()", 'search'),
            ('documents.py', "document['id'] == document_id", "True", 'documents'),
            ('tools.py', "set(args) != {key}", "False", 'tools'),
            ('answers.py', "answer == '\\n'.join(quotes)", "True", 'answers'),
            ('agent.py', "range(max_steps)", "range(max_steps + 1)", 'loop'),
            ('agent.py', "read = [], {}", "read = [], {d['id']: d['text'] for d in documents}", 'answers'),
            ('agent.py', "type(max_steps) is not int", "not isinstance(max_steps, int)", 'reliability'),
        ]
        for name, old, new, module in mutations:
            source = REFERENCE[name]
            assert old in source, (name, old)
            (project / 'course_agent' / name).write_text(source.replace(old, new))
            failed = run(project, '-m', 'unittest', 'checks.test_' + module)
            assert failed.returncode != 0, f'Mutation survived: {name}: {old}'
            (project / 'course_agent' / name).write_text(source)
        print('Starter setup passed; six unfinished milestones fail; reference passes public checks and both demos; eight mutations rejected.')


if __name__ == '__main__':
    validate()
