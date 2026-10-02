import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollbackOps, checkSettingsPatch, redactNamespace } from '../src/settings.js';
test('rollback restores user overrides and unsets inherited defaults instead of copying resolved values',()=>{
  assert.deepEqual(rollbackOps({provider:'new',nested:{timeout:10},routes:['a']},{provider:'old',nested:{}}),[{op:'set',path:['provider'],value:'old'},{op:'unset',path:['nested','timeout']},{op:'unset',path:['routes']}]);
});
test('settings redact schema-declared secrets even when their keys have ordinary names',()=>{
  const source={ns:'test',secrets:[{path:['providers','route','credential']}],user:{providers:{route:{credential:'hidden',model:'space-bunny'}}},value:{providers:{route:{credential:'hidden'}}},base:{providers:{route:{credential:'base-hidden'}}}};
  const safe=redactNamespace(source);
  assert.equal(safe.user.providers.route.credential,'<redacted>');
  assert.equal(safe.value.providers.route.credential,'<redacted>');
  assert.equal(safe.base.providers.route.credential,'<redacted>');
  assert.equal(safe.user.providers.route.model,'space-bunny');
  assert.equal(source.user.providers.route.credential,'hidden');
});
test('schema-declared secret slots prevent replacing their parents but allow sibling ordinary settings',()=>{
  const secrets=[{path:['providers','route','key']}];checkSettingsPatch({providers:{route:{model:'new',maxTokens:10}}},secrets);assert.throws(()=>checkSettingsPatch({providers:null},secrets));assert.throws(()=>checkSettingsPatch({providers:{route:{key:'hidden'}}},secrets));assert.throws(()=>checkSettingsPatch(JSON.parse('{"__proto__":{}}'),[]));
});
