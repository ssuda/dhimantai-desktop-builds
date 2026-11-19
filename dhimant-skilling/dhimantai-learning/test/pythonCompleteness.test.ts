import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {pythonCompleteness as inspect} from '../src/pythonCompleteness';

test('missing lesson definitions are identified without evaluating code',()=>{
  assert.deepEqual(inspect('model=ScriptedModel([1,2])\nprint(model.reply())').missing,['ScriptedModel']);
  assert.deepEqual(inspect('print(values[2])').missing,['values']);
  assert.equal(inspect('def broken(').syntax,false);
  assert.deepEqual(inspect('"ScriptedModel()" # print(missing)\nprint(3)').missing,[]);
});
test('ordinary Python setup, scopes and bindings do not disable Run',()=>{
  for(const source of [
    'class ScriptedModel:\n def __init__(self,replies): self.replies=iter(replies)\n def reply(self): return next(self.replies)\nmodel=ScriptedModel([1,2])\nprint(model.reply())',
    'print([x*x for x in range(3)])',
    'items=[1,2]\nfor i,x in enumerate(items):\n print(i,x)',
    'import numpy as np\nx=np.array([1])\nprint(x)',
    'from sklearn.ensemble import RandomForestClassifier\nmodel=RandomForestClassifier(n_estimators=10)\nprint(model)',
    'try:\n print(1)\nexcept ValueError as error:\n print(error)',
    'with open("x") as f:\n print(f.read())',
    'import os.path as p\nprint(p)',
    '(a:=4)\nprint(a)',
  ])assert.deepEqual(inspect(source).missing,[],source);
});
