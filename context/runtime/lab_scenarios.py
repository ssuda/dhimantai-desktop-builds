"""Resolve a notebook challenge to a tested setup packaged in the course image."""
import hashlib
import json
from pathlib import Path


CATALOG = Path('/opt/dhimantai/lab_scenarios.json')


def prepared_setup(requested, catalog=CATALOG):
    if not requested:
        return ''  # An ordinary lesson notebook can start a clean lab.
    try:
        data = json.loads(catalog.read_text())
        if data['version'] != 1:
            raise ValueError('Unsupported lab image version')
        digest = hashlib.sha256(requested.encode()).hexdigest()
        for scenario in data['scenarios']:
            if scenario['setup_sha256'] != digest:
                continue
            source = scenario['setup']
            if hashlib.sha256(source.encode()).hexdigest() != digest or source != requested:
                raise ValueError('Invalid packaged lab setup')
            return source  # Execute the image's source, never shell supplied by Coach or notebook metadata.
    except (OSError, KeyError, TypeError, ValueError) as error:
        raise RuntimeError('The course image does not contain a valid setup for this lab. '
                           'Use Set up / rebuild course, then restart the notebook runtime.') from error
    raise RuntimeError('This lab setup is not packaged in the course image. '
                       'Update the course image, then restart the notebook runtime.')
