import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const expected = { name: 'dhimantai-learning', publisher: 'optficial', version: '0.16.1' };
const validator = resolve(__dirname, '../../scripts/validate-vsix.py');
const valid = execFileSync('python3', ['-c', `
import io,zipfile,json,sys
b=io.BytesIO()
with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('extension/package.json',json.dumps(dict(name='dhimantai-learning',publisher='optficial',version='0.16.1',main='./out/src/extension.js')))
 z.writestr('extension/out/src/extension.js','exports.activate = () => {};')
 z.writestr('[Content_Types].xml','<Types/>')
 z.writestr('extension.vsixmanifest','<PackageManifest><Metadata><Identity Id="dhimantai-learning" Publisher="optficial" Version="0.16.1"/></Metadata></PackageManifest>')
sys.stdout.buffer.write(b.getvalue())
`]);
function check(bytes: Buffer, identity = expected) {
  return spawnSync('python3', [validator, JSON.stringify(identity)], { input: bytes });
}

test('release accepts a complete VSIX with matching compiled entry and identity', () => {
  const result = check(valid);
  assert.equal(result.status, 0, result.stderr.toString());
});
test('release rejects trailing bytes, truncation, false end records, HTML and mismatched versions', () => {
  const badComment = Buffer.from(valid);
  badComment.writeUInt16LE(61373, valid.length - 2);
  const corruptEntry = Buffer.from(valid);
  corruptEntry[80] ^= 0xff;
  for (const bytes of [Buffer.concat([valid, Buffer.from('extra!')]), valid.subarray(0, -6),
    badComment, corruptEntry, Buffer.from('<html>app shell</html>')]) {
    assert.notEqual(check(bytes).status, 0);
  }
  assert.notEqual(check(valid, { ...expected, version: '0.17.0' }).status, 0);
});

test('release writer leaves the last valid release intact when a new VSIX is corrupt', async () => {
  const { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(resolve(tmpdir(), 'dhimantai-vsix-release-'));
  try {
    await mkdir(resolve(root, 'scripts'));
    for (const script of ['write-release.mjs', 'validate-vsix.py']) {
      await copyFile(resolve(__dirname, '../../scripts', script), resolve(root, 'scripts', script));
    }
    await writeFile(resolve(root, 'package.json'), JSON.stringify(expected));
    const vsix = resolve(root, `dhimantai-learning-${expected.version}.vsix`);
    const output = resolve(root, 'downloads');
    await writeFile(vsix, valid);
    const publish = () => spawnSync(process.execPath, [resolve(root, 'scripts/write-release.mjs'), output]);
    assert.equal(publish().status, 0);
    const manifest = await readFile(resolve(output, 'dhimantai-learning.json'));
    await writeFile(vsix, Buffer.concat([valid, Buffer.from('extra!')]));
    assert.notEqual(publish().status, 0);
    assert.deepEqual(await readFile(resolve(output, 'dhimantai-learning.vsix')), valid);
    assert.deepEqual(await readFile(resolve(output, 'dhimantai-learning.json')), manifest);
  } finally { await rm(root, { recursive: true, force: true }); }
});
