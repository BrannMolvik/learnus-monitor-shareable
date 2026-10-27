import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

SPEC = importlib.util.spec_from_file_location('writer', Path(__file__).resolve().parent.parent / 'src' / 'second-brain-writer.py')
writer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(writer)


class IsolatedWriterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='learnus-vault-fixture-')
        self.root = Path(self.temp.name).resolve()
        self.vault = self.root / 'Test Vault'
        self.vault.mkdir()
        self.config_file = self.root / 'monitor.config.json'
        self.raw = {'schemaVersion': 1, 'dataDirectory': 'data', 'secondBrain': {
            'mode': 'obsidian', 'projectDirectory': str(self.root / 'Fake MCP'),
            'vaultDirectory': str(self.vault), 'intakeNote': 'Inbox/Example.md',
            'courses': [{'aliases': ['Example Course'], 'path': 'Courses/example.md'}], 'createMissingNotes': True}}
        self.config_file.write_text(json.dumps(self.raw))
        self.cfg = writer.settings(self.config_file)
        self.scope_file = self.root / 'permissions.json'
        self.appended = []
        self.proposals = {}

        def resolve(target, vault_root=None):
            path = (self.vault / target).resolve()
            path.relative_to(self.vault)
            return path

        def action(kind, **kwargs):
            if kwargs['action'] == 'propose':
                self.assertIn(kwargs['path'], self.cfg['targets'])
                key = str(len(self.proposals))
                self.proposals[key] = (kind, kwargs)
                return {'proposal_id': key}
            kind, proposal = self.proposals[kwargs['proposal_id']]
            target = proposal['path']
            path = resolve(target)
            path.parent.mkdir(parents=True, exist_ok=True)
            if kind == 'create':
                with path.open('x', encoding='utf-8') as file:
                    file.write(proposal['content'])
            else:
                with path.open('a', encoding='utf-8') as file:
                    file.write(proposal['text'])
                self.appended.append(target)
            return {'path': target}

        def scopes():
            raw = json.loads(self.scope_file.read_text()) if self.scope_file.exists() else {'scopes': {}}
            return {name: SimpleNamespace(**scope) for name, scope in raw['scopes'].items()}

        self.modules = {'resolve': resolve, 'read': lambda target: {'content': resolve(target).read_text(encoding='utf-8')},
                        'scope_path': lambda: self.scope_file, 'scopes': scopes,
                        'append': lambda **kw: action('append', **kw), 'create': lambda **kw: action('create', **kw)}
        self.record = {'capture_id': 'learnus:assignment_state:' + 'a' * 24, 'schema_version': 1,
                       'source': 'Yonsei LearnUs', 'source_kind': 'external_lms', 'kind': 'assignment_state',
                       'course': 'Example Course', 'title': 'Synthetic exercise'}
        line = writer.PREFIX + json.dumps(self.record, separators=(',', ':'))
        self.batch = {'schema_version': 1, 'target_path': self.cfg['intake'], 'captures': [{
            'capture_id': self.record['capture_id'], 'target_path': self.cfg['intake'],
            'course_note_path': 'Courses/example.md', 'line': line}]}

    def tearDown(self):
        self.temp.cleanup()

    def test_no_scope_or_note_creation_without_explicit_approval(self):
        with self.assertRaises(ValueError):
            writer.setup(self.modules, self.cfg)
        self.assertFalse(self.scope_file.exists())
        self.assertEqual(list(self.vault.iterdir()), [])

    def test_configured_setup_is_idempotent_and_notes_never_overwritten(self):
        writer.setup(self.modules, self.cfg, True)
        note = self.vault / self.cfg['intake']
        note.write_text('existing personal content', encoding='utf-8')
        before = self.scope_file.read_bytes()
        writer.setup(self.modules, self.cfg, True)
        self.assertEqual(note.read_text(), 'existing personal content')
        self.assertEqual(self.scope_file.read_bytes(), before)

    def test_capture_and_backfill_are_deduplicated(self):
        writer.setup(self.modules, self.cfg, True)
        self.assertEqual(writer.write_batch(self.modules, self.cfg, self.batch), 2)
        self.assertEqual(writer.write_batch(self.modules, self.cfg, self.batch), 0)
        self.assertEqual(writer.backfill(self.modules, self.cfg), 0)
        self.assertEqual(len(self.appended), 2)

    def test_whole_batch_validates_before_any_append(self):
        writer.setup(self.modules, self.cfg, True)
        self.batch['captures'].append({**self.batch['captures'][0], 'course_note_path': 'Courses/other.md'})
        with self.assertRaises(ValueError):
            writer.write_batch(self.modules, self.cfg, self.batch)
        self.assertEqual(self.appended, [])

    def test_scope_changes_are_rejected_and_preserved(self):
        writer.setup(self.modules, self.cfg, True)
        raw = json.loads(self.scope_file.read_text())
        raw['scopes'][self.cfg['scope_name']]['path_prefixes'] = ['Courses']
        self.scope_file.write_text(json.dumps(raw))
        before = self.scope_file.read_bytes()
        with self.assertRaises(ValueError):
            writer.setup(self.modules, self.cfg, True)
        with self.assertRaises(ValueError):
            writer.write_batch(self.modules, self.cfg, self.batch)
        self.assertEqual(self.scope_file.read_bytes(), before)

    def test_disabled_integration_rejected_before_importing_mcp(self):
        self.raw['secondBrain']['mode'] = 'none'
        self.config_file.write_text(json.dumps(self.raw))
        with self.assertRaises(ValueError):
            writer.settings(self.config_file)

    def test_traversal_and_windows_alias_routes_rejected(self):
        for path in ('Courses/../outside.md', '/outside.md', 'Courses/NUL.md', 'Courses\\other.md'):
            with self.assertRaises(ValueError):
                writer.note_path(path, True)

    def test_automatic_batch_never_creates_missing_note(self):
        writer.setup(self.modules, self.cfg, True)
        (self.vault / 'Courses/example.md').unlink()
        with self.assertRaises(ValueError):
            writer.write_batch(self.modules, self.cfg, self.batch)
        self.assertFalse((self.vault / 'Courses/example.md').exists())

    def test_stale_append_retries_once_without_duplicate_content(self):
        writer.setup(self.modules, self.cfg, True)
        original = self.modules['append']
        calls = []

        def stale_once(**kwargs):
            calls.append(kwargs['action'])
            if calls == ['propose', 'apply']:
                raise RuntimeError('STALE PROPOSAL')
            return original(**kwargs)

        self.modules['append'] = stale_once
        self.assertEqual(writer.write_batch(self.modules, self.cfg, self.batch), 2)
        self.assertEqual(len(self.appended), 2)
        self.assertEqual(writer.write_batch(self.modules, self.cfg, self.batch), 0)


if __name__ == '__main__':
    unittest.main()
