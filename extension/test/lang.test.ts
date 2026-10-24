import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, wordAt } from '../src/lang/lexer';
import { parseObject, checkBlocks } from '../src/lang/parser';
import { SymbolIndex, baseTypeName } from '../src/lang/index';

const FB = `FUNCTION_BLOCK FB_Motor EXTENDS FB_Base IMPLEMENTS I_Motor, I_Diag
VAR_INPUT
    bEnable, bReset : BOOL; // two at once
    fSetSpeed : LREAL := 1.5;
END_VAR
VAR_OUTPUT
    eState : E_State;
END_VAR
VAR
    _fSpeed : LREAL;
    aBuf : ARRAY[1..10] OF ST_Axis;
    sInfo : STRING(80) := 'a;b (* not a comment *)';
END_VAR
//---- IMPLEMENTATION ----
IF bEnable THEN
    _fSpeed := fSetSpeed;
    aBuf[1].fPos := Speed;
    Start(fSpeed := 2.0);
END_IF
//==== METHOD Start ====
METHOD PUBLIC Start : BOOL
VAR_INPUT
    fSpeed : LREAL;
END_VAR
//---- IMPLEMENTATION ----
_fSpeed := fSpeed; (* nested (* comment *) here *)
Start := THIS^.bEnable;
//==== PROPERTY Speed ====
PROPERTY PUBLIC Speed : LREAL
//==== GET Speed ====
VAR
END_VAR
//---- IMPLEMENTATION ----
Speed := _fSpeed;
`;

const BASE = `FUNCTION_BLOCK FB_Base
VAR_OUTPUT
    bError : BOOL;
END_VAR
//---- IMPLEMENTATION ----
//==== METHOD Reset ====
METHOD PUBLIC Reset
//---- IMPLEMENTATION ----
bError := FALSE;
`;

const AXIS = `TYPE ST_Axis :
STRUCT
    fPos : LREAL;
    fVel : LREAL;
END_STRUCT
END_TYPE
`;
const ENUM = `{attribute 'qualified_only'}
TYPE E_State :
(
    Idle := 0,
    Running,
    Error := 99
) INT;
END_TYPE
`;
const GVL = `{attribute 'qualified_only'}
VAR_GLOBAL
    nCount : DINT;
    fbMain : FB_Motor;
END_VAR
`;
const MAIN = `PROGRAM MAIN
VAR
    fbMotor : FB_Motor;
    pAxis : POINTER TO ST_Axis;
END_VAR
//---- IMPLEMENTATION ----
fbMotor(bEnable := TRUE);
fbMotor.Start(fSpeed := 1);
fbMotor.Reset();
IF fbMotor.eState = E_State.Running THEN
    GVL_Main.nCount := GVL_Main.nCount + 1;
END_IF
pAxis^.fPos := fbMotor.Speed;
`;

function index() {
  const ix = new SymbolIndex();
  ix.update('/p/FB_Motor.TcPOU', FB);
  ix.update('/p/FB_Base.TcPOU', BASE);
  ix.update('/p/ST_Axis.TcDUT', AXIS);
  ix.update('/p/E_State.TcDUT', ENUM);
  ix.update('/p/GVL_Main.TcGVL', GVL);
  ix.update('/p/MAIN.TcPOU', MAIN);
  return ix;
}
const pos = (src: string, needle: string, nth = 0, delta = 0) => {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = src.indexOf(needle, at + 1);
  assert.ok(at >= 0, needle);
  const before = src.slice(0, at + delta);
  return { line: before.split('\n').length - 1, col: before.length - before.lastIndexOf('\n') - 1 };
};

test('lexer: comments (nested), strings, pragmas, typed literals, section headers', () => {
  const t = tokenize("x := T#1s + 16#FF; (* a (* b *) c *) s := 'it$'s'; {attribute 'x'}\n//==== METHOD A ====", true);
  assert.deepEqual(t.map(x => x.type), ['ident', 'op', 'number', 'op', 'number', 'op', 'comment', 'ident', 'op', 'string', 'op', 'pragma', 'section']);
  assert.deepEqual(wordAt('a[i + 1].b', 9)?.qualifier, ['a']);
  assert.deepEqual(wordAt('p^.b', 3)?.qualifier, ['p']);
  assert.deepEqual(wordAt('a := fbMotor.Start(1);', 15), { word: 'Start', qualifier: ['fbMotor'], start: 13, end: 18 });
});

test('parser: header, variables, members, accessors', () => {
  const { root, problems } = parseObject(FB, 'FB_Motor');
  assert.deepEqual(problems, []);
  assert.equal(root!.kind, 'FUNCTION_BLOCK');
  assert.deepEqual(root!.extends, ['FB_Base']);
  assert.deepEqual(root!.implements, ['I_Motor', 'I_Diag']);
  const v = Object.fromEntries(root!.children.map(c => [c.name, c]));
  assert.equal(v.bReset.type, 'BOOL');
  assert.equal(v.bReset.scope, 'VAR_INPUT');
  assert.equal(v.aBuf.type, 'ARRAY[1..10] OF ST_Axis');
  assert.equal(v.sInfo.type, 'STRING(80)');
  assert.equal(v.Start.kind, 'METHOD');
  assert.equal(v.Start.type, 'BOOL');
  assert.equal(v.Start.access, 'PUBLIC');
  assert.deepEqual(v.Start.children.map(c => c.name), ['fSpeed']);
  assert.equal(v.Speed.kind, 'PROPERTY');
  assert.equal(v.Speed.type, 'LREAL');
});

test('parser: struct fields, enum values, GVL', () => {
  assert.deepEqual(parseObject(AXIS, 'ST_Axis').root!.children.map(c => `${c.kind}:${c.name}`), ['FIELD:fPos', 'FIELD:fVel']);
  const e = parseObject(ENUM, 'E_State').root!;
  assert.equal(e.kind, 'ENUM');
  assert.deepEqual(e.children.map(c => c.name), ['Idle', 'Running', 'Error']);
  const g = parseObject(GVL, 'GVL_Main').root!;
  assert.equal(g.kind, 'GVL');
  assert.equal(g.name, 'GVL_Main');
});

test('parser: block structure and duplicate variables', () => {
  const p = parseObject('PROGRAM X\nVAR\n a : INT;\n a : BOOL;\nEND_VAR\n//---- IMPLEMENTATION ----\nIF a THEN\nFOR i := 1 TO 2 DO\nEND_IF\n', 'X');
  assert.deepEqual(p.problems.map(x => x.message), ["Duplicate variable 'a'", 'END_IF closes FOR (line 8)', 'IF without END_IF', 'FOR without END_FOR']);
  assert.deepEqual(checkBlocks(tokenize('CASE x OF 1: y := 2; END_CASE')), []);
  assert.match(parseObject('PROGRAM Y\nVAR\n a : INT;\n', 'Y').problems[0].message, /without END_VAR/);
});

test('resolve: locals, own and inherited members, qualified chains, enum, GVL, pointer deref', () => {
  const ix = index();
  const at = (file: string, src: string, needle: string, nth = 0, delta = 0) => {
    const p = pos(src, needle, nth, delta);
    const l = ix.resolve(file, p.line, p.col);
    return l && `${l.file.split('/').pop()}:${l.symbol.kind}:${l.symbol.name}`;
  };
  assert.equal(at('/p/FB_Motor.TcPOU', FB, '_fSpeed := fSpeed', 0, 11), 'FB_Motor.TcPOU:VARIABLE:fSpeed');        // method input, not the FB var
  assert.equal(at('/p/FB_Motor.TcPOU', FB, '_fSpeed := fSetSpeed', 0, 0), 'FB_Motor.TcPOU:VARIABLE:_fSpeed');
  assert.equal(at('/p/FB_Motor.TcPOU', FB, 'Start(fSpeed'), 'FB_Motor.TcPOU:METHOD:Start');
  assert.equal(at('/p/FB_Motor.TcPOU', FB, 'aBuf[1].fPos', 0, 8), 'ST_Axis.TcDUT:FIELD:fPos');
  assert.equal(at('/p/FB_Motor.TcPOU', FB, 'E_State'), 'E_State.TcDUT:ENUM:E_State');
  assert.equal(at('/p/MAIN.TcPOU', MAIN, 'fbMotor.Start', 0, 8), 'FB_Motor.TcPOU:METHOD:Start');
  assert.equal(at('/p/MAIN.TcPOU', MAIN, 'fbMotor.Reset', 0, 8), 'FB_Base.TcPOU:METHOD:Reset');           // inherited
  assert.equal(at('/p/MAIN.TcPOU', MAIN, 'E_State.Running', 0, 8), 'E_State.TcDUT:ENUM_VALUE:Running');
  assert.equal(at('/p/MAIN.TcPOU', MAIN, 'GVL_Main.nCount', 0, 9), 'GVL_Main.TcGVL:VARIABLE:nCount');
  assert.equal(at('/p/MAIN.TcPOU', MAIN, 'pAxis^.fPos', 0, 7), 'ST_Axis.TcDUT:FIELD:fPos');                 // through POINTER TO
  assert.equal(at('/p/MAIN.TcPOU', MAIN, 'fbMotor.Speed', 0, 8), 'FB_Motor.TcPOU:PROPERTY:Speed');
  assert.equal(at('/p/FB_Motor.TcPOU', FB, "'a;b"), undefined);                                             // inside a string
});

test('references across files, including section headers', () => {
  const ix = index();
  const p = pos(FB, 'Start : BOOL');
  const target = ix.resolve('/p/FB_Motor.TcPOU', p.line, p.col)!;
  const refs = ix.references(target).map(r => `${r.file.split('/').pop()}:${r.range.line}`).sort();
  assert.deepEqual(refs, ['FB_Motor.TcPOU:17', 'FB_Motor.TcPOU:19', 'FB_Motor.TcPOU:20', 'FB_Motor.TcPOU:26', 'MAIN.TcPOU:7']);
});

test('completion after a dot shows the public face of the type', () => {
  const ix = index();
  const p = pos(MAIN, 'fbMotor.Start', 0, 8);
  const labels = ix.completions('/p/MAIN.TcPOU', p.line, p.col).map(c => c.label);
  assert.ok(labels.includes('Start') && labels.includes('Speed') && labels.includes('bEnable') && labels.includes('Reset'));
  assert.ok(!labels.includes('_fSpeed'), 'internal VAR not offered');
});

test('baseTypeName strips pointers, arrays and string lengths', () => {
  assert.equal(baseTypeName('POINTER TO ARRAY[0..9] OF ST_Axis'), 'ST_Axis');
  assert.equal(baseTypeName('STRING(80)'), 'STRING');
});
