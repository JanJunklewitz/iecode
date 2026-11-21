import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmMessage, doneIsError, doneText, oppositeBool, readBackChanged, sentence } from '../src/core/writeText';

test('sentence strips exactly one trailing dot', () => {
  assert.equal(sentence('ends with a dot.'), 'ends with a dot');
  assert.equal(sentence('no dot'), 'no dot');
  assert.equal(sentence('two..'), 'two.');
});

test('without a type only the words TRUE and FALSE prove a BOOL', () => {
  assert.equal(readBackChanged('TRUE', 'FALSE'), true);
  assert.equal(readBackChanged(' false ', 'TRUE'), true);
  assert.equal(readBackChanged('TRUE', 'true'), false);
  assert.equal(readBackChanged('1', '0'), false);       // could be an INT
  assert.equal(readBackChanged('1', 'FALSE'), false);
  assert.equal(readBackChanged('1', '5'), false);
  assert.equal(readBackChanged('3.5', '3.0'), false);
  assert.equal(readBackChanged('abc', 'abd'), false);
});

test('a resolved BOOL type also accepts 1 and 0; any other type never changes the wording', () => {
  assert.equal(readBackChanged('1', 'FALSE', 'BOOL'), true);
  assert.equal(readBackChanged('TRUE', '0', 'bool'), true);
  assert.equal(readBackChanged('1', '1', 'BOOL'), false);
  assert.equal(readBackChanged('1', '0', 'INT'), false);
  assert.equal(readBackChanged('abc', 'abd', 'STRING'), false);
  assert.equal(readBackChanged('TRUE', 'FALSE', 'STRING'), false);
});

test('confirmMessage: one item is byte-identical to the old dialog, several list every write', () => {
  assert.equal(confirmMessage([{ symbol: 'MAIN.x', value: '1' }], 'A:851 (ws)', ''), 'Write MAIN.x := 1 on A:851 (ws)?');
  assert.equal(confirmMessage([{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '2' }], 'A:851 (ws)', ''),
    'Write 2 values on A:851 (ws)?\nMAIN.a := 1\nMAIN.b := 2');
  assert.equal(confirmMessage([{ symbol: 'MAIN.a', value: '1\nevil' }], 'T', ''), 'Write MAIN.a := 1\\nevil on T?');
});

test('confirmMessage: the note follows the question mark', () => {
  const note = ' (the workspace settings set the ADS target or port, so auto-approve does not apply)';
  assert.equal(confirmMessage([{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '2' }], 'A:851 (ws)', note),
    `Write 2 values on A:851 (ws)?${note}\nMAIN.a := 1\nMAIN.b := 2`);
});

test('doneText: header counts, one line per item, trailer for unknown items', () => {
  const items = [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '2' }, { symbol: 'MAIN.c', value: '3' }];
  assert.equal(doneText(items, [
    { symbol: 'MAIN.a', status: 'written', readBack: '1' },
    { symbol: 'MAIN.b', status: 'notWritten', reason: 'ADS error 0x6 (symbol not found)' },
    { symbol: 'MAIN.c', status: 'unknown', reason: 'ADS error 0x7' }]), [
    'Sent in one ADS request (3 writes): 1 written, 1 not written, 1 outcome unknown.',
    'MAIN.a: written, reads back as 1 (the PLC may change it again)',
    'MAIN.b: not written: ADS error 0x6 (symbol not found)',
    'MAIN.c: outcome unknown: ADS error 0x7',
    'Do not write the unknown items again on your own; read them and ask the user.'].join('\n'));
});

test('doneText: parts with a zero count are left out', () => {
  const items = [{ symbol: 'a', value: '1' }, { symbol: 'b', value: '2' }];
  assert.match(doneText(items, [{ symbol: 'a', status: 'written', readBack: '1' }, { symbol: 'b', status: 'written', readBack: '2' }]), /^Sent in one ADS request \(2 writes\): 2 written\.\n/);
  assert.match(doneText(items, [{ symbol: 'a', status: 'notWritten', reason: 'x' }, { symbol: 'b', status: 'notWritten', reason: 'y' }]), /^Sent in one ADS request \(2 writes\): 2 not written\.\n/);
});

test('doneText: a read-back failure keeps the item written and adds its trailer before the unknown one', () => {
  const items = [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '2' }, { symbol: 'MAIN.c', value: '3' }];
  assert.equal(doneText(items, [
    { symbol: 'MAIN.a', status: 'written', readBack: '1' },
    { symbol: 'MAIN.b', status: 'written', readBack: null, readBackError: 'link down.' },
    { symbol: 'MAIN.c', status: 'unknown', reason: 'no reply' }]), [
    'Sent in one ADS request (3 writes): 2 written, 1 outcome unknown.',
    'MAIN.a: written, reads back as 1 (the PLC may change it again)',
    'MAIN.b: written, but it could not be read back: link down',
    'MAIN.c: outcome unknown: no reply',
    'Read the items without a read-back before acting on their values.',
    'Do not write the unknown items again on your own; read them and ask the user.'].join('\n'));
});

test('doneText: a BOOL that reads back differently says the PLC changed it', () => {
  assert.equal(doneText([{ symbol: 'MAIN.a', value: 'TRUE' }, { symbol: 'MAIN.n', value: '1' }], [
    { symbol: 'MAIN.a', status: 'written', readBack: 'FALSE' },
    { symbol: 'MAIN.n', status: 'written', readBack: '0' }]), [
    'Sent in one ADS request (2 writes): 2 written.',
    'MAIN.a: written (accepted by ADS), but then reads back as FALSE, not TRUE: the PLC changed it after the write',
    'MAIN.n: written, reads back as 0 (the PLC may change it again)'].join('\n'));
});

test('doneText: exactly one item gets the single-write header (pulse, restore)', () => {
  const items = [{ symbol: 'MAIN.a', value: '1' }];
  assert.equal(doneText(items, [{ symbol: 'MAIN.a', status: 'written', readBack: '1' }]), 'Write sent: 1 written.\nMAIN.a: written, reads back as 1 (the PLC may change it again)');
  assert.equal(doneText(items, [{ symbol: 'MAIN.a', status: 'notWritten', reason: 'no such symbol' }]), 'Write sent: 1 not written.\nMAIN.a: not written: no such symbol');
  assert.equal(doneText(items, [{ symbol: 'MAIN.a', status: 'unknown', reason: 'no reply' }]),
    'Write sent: outcome unknown.\nMAIN.a: outcome unknown: no reply\nDo not write the unknown items again on your own; read them and ask the user.');
});

test('doneText keeps line breaks in AI text and device reasons on their line', () => {
  const t = doneText([{ symbol: 'a\nb', value: '1' }, { symbol: 'c', value: '2' }], [
    { symbol: 'a\nb', status: 'notWritten', reason: 'x\ny' }, { symbol: 'c', status: 'written', readBack: '2' }]);
  assert.equal(t.split('\n').length, 3);
});

test('doneIsError is true when any item is not written', () => {
  const w = { symbol: 'a', status: 'written' as const, readBack: '1' };
  assert.equal(doneIsError([w, w]), false);
  assert.equal(doneIsError([w, { symbol: 'b', status: 'unknown', reason: 'x' }]), true);
  assert.equal(doneIsError([w, { symbol: 'b', status: 'notWritten', reason: 'x' }]), true);
});

test('oppositeBool flips BOOL literals and refuses everything else', () => {
  assert.equal(oppositeBool('TRUE'), 'FALSE');
  assert.equal(oppositeBool(' 1 '), 'FALSE');
  assert.equal(oppositeBool('false'), 'TRUE');
  assert.equal(oppositeBool('0'), 'TRUE');
  assert.equal(oppositeBool('5'), undefined);
  assert.equal(oppositeBool(''), undefined);
});

test('the dialog names the pulse and what the bit returns to', () => {
  assert.equal(confirmMessage([{ symbol: 'MAIN.bStart', value: 'TRUE', pulseMs: 200 }], 'A:851 (ws)', ''),
    'Write MAIN.bStart := TRUE (pulse 200 ms, then FALSE) on A:851 (ws)?');
});

test('pulse lines: done, reset not sent, reset unknown', () => {
  const items = [{ symbol: 'MAIN.bStart', value: 'TRUE', pulseMs: 200 }];
  const done = doneText(items, [{ symbol: 'MAIN.bStart', status: 'written', readBack: 'TRUE', pulse: { ms: 200, heldMs: 214, reset: 'FALSE', state: 'done' } }]);
  assert.equal(done, 'Write sent: 1 written.\nMAIN.bStart: pulsed TRUE for 214 ms (asked 200 ms, timed by the extension, not cycle-exact), then FALSE');
  const notSent = doneText(items, [{ symbol: 'MAIN.bStart', status: 'written', readBack: 'TRUE', pulse: { ms: 200, heldMs: 210, reset: 'FALSE', state: 'notSent', reason: 'host stopped.' } }]);
  assert.match(notSent, /MAIN\.bStart: written TRUE, but the reset to FALSE was not sent: host stopped\. MAIN\.bStart may still be TRUE; reset it or ask the user\./);
  const unknown = doneText(items, [{ symbol: 'MAIN.bStart', status: 'written', readBack: 'TRUE', pulse: { ms: 200, heldMs: 210, reset: 'FALSE', state: 'unknown', reason: 'timed out' } }]);
  assert.match(unknown, /the reset to FALSE has an unknown outcome: timed out\. MAIN\.bStart may still be TRUE; read it, reset it or ask the user\./);
});

test('doneIsError is true when a pulse reset did not go through', () => {
  const ok = { symbol: 'A', status: 'written' as const, readBack: 'TRUE', pulse: { ms: 10, heldMs: 12, reset: 'FALSE', state: 'done' as const } };
  assert.equal(doneIsError([ok]), false);
  assert.equal(doneIsError([{ ...ok, pulse: { ms: 10, heldMs: 12, reset: 'FALSE', state: 'unknown', reason: 'x' } }]), true);
});

test('the dialog says Restore and marks PERSISTENT symbols', () => {
  const items = [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '5' }];
  assert.equal(confirmMessage(items, 'A:851 (ws)', '', { restore: true }), 'Restore 2 values on A:851 (ws)?\nMAIN.a := 1\nMAIN.b := 5');
  assert.equal(confirmMessage([items[0]], 'A:851 (ws)', '', { persistent: ['MAIN.a'] }), 'Write MAIN.a := 1 on A:851 (ws)?\nPERSISTENT: MAIN.a survives a PLC restart.');
  assert.equal(confirmMessage(items, 'T', '', { persistent: ['MAIN.b'] }), 'Write 2 values on T?\nMAIN.a := 1\nMAIN.b := 5\nPERSISTENT: MAIN.b survives a PLC restart.');
});
