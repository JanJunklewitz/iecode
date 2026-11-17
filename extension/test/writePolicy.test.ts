import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWritePolicy, writePolicyReason, persistentIn, persistentRefusal } from '../src/core/writePolicy';

test('an empty list allows everything', () => assert.deepEqual(evaluateWritePolicy('MAIN.x', { allowedPaths: [] }), { allowed: true }));

test('a prefix matches the symbol and its children, not a longer name', () => {
  const s = { allowedPaths: ['MAIN.Sim', 'GVL.Test'] };
  for (const ok of ['MAIN.Sim', 'main.sim.bStart', 'MAIN.Sim.aValues[2]', ' GVL.Test.nX ', 'MAIN.Sim[1]']) assert.equal(evaluateWritePolicy(ok, s).allowed, true, ok);
  assert.deepEqual(evaluateWritePolicy('MAIN.Simulation.x', s), { allowed: false, reason: 'MAIN.Simulation.x is outside the paths the user allows for AI writes (iecode.ads.aiWritePaths: MAIN.Sim, GVL.Test)' });
  assert.equal(evaluateWritePolicy('MAIN.Other', s).allowed, false);
});

test('a prefix with a trailing dot matches by start', () => {
  assert.equal(evaluateWritePolicy('GVL.x', { allowedPaths: ['GVL.'] }).allowed, true);
  assert.equal(evaluateWritePolicy('GVLx.x', { allowedPaths: ['GVL.'] }).allowed, false);
});

test('blank entries are ignored and an all-blank list refuses everything', () => {
  assert.equal(evaluateWritePolicy('MAIN.Sim.x', { allowedPaths: ['', ' ', 'MAIN.Sim'] }).allowed, true);
  assert.equal(evaluateWritePolicy('MAIN.Sim.x', { allowedPaths: ['', ' '] }).allowed, false);
});

test('a batch reason names every symbol outside', () => {
  assert.equal(writePolicyReason(['GVL.Test.a', 'MAIN.a', 'MAIN.b'], { allowedPaths: ['GVL.Test'] }),
    'MAIN.a, MAIN.b are outside the paths the user allows for AI writes (iecode.ads.aiWritePaths: GVL.Test)');
  assert.equal(writePolicyReason(['GVL.Test.a'], { allowedPaths: ['GVL.Test'] }), undefined);
  assert.equal(writePolicyReason(['MAIN.a'], { allowedPaths: [] }), undefined);
});

test('persistentIn finds the symbols below a persistent prefix, same rule as the allow-list', () => {
  const paths = ['GVL.Persistent', ' ', 'MAIN.Cfg.'];
  assert.deepEqual(persistentIn(['GVL.Persistent.nA', 'gvl.persistent', 'GVL.PersistentX.n', 'MAIN.Cfg.nB', 'MAIN.nOther'], paths), ['GVL.Persistent.nA', 'gvl.persistent', 'MAIN.Cfg.nB']);
  assert.deepEqual(persistentIn(['GVL.Persistent.nA'], []), []);
});

test('persistentRefusal names every symbol and the flag', () => {
  assert.equal(persistentRefusal(['MAIN.nCfg']), 'MAIN.nCfg is PERSISTENT data (it survives a PLC restart). Call again with confirmPersistent: true if the user asked for this write.');
  assert.equal(persistentRefusal(['MAIN.nCfg', 'MAIN.nOther']), 'MAIN.nCfg, MAIN.nOther are PERSISTENT data (they survive a PLC restart). Call again with confirmPersistent: true if the user asked for these writes.');
});
