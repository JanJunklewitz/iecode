// Shared fixtures of the symbol tests (generic names only).

export const SRC: { file: string; view: string }[] = [
  { file: 'E_Mode.TcDUT', view: 'TYPE E_Mode :\n(\n    Off := 0,\n    Run := 1, // normal operation\n    Start := 1\n) INT;\nEND_TYPE\n' },
  { file: 'E_Step.TcDUT', view: 'TYPE E_Step :\n(\n    Idle,\n    Fill := 5,\n    Drain,\n    Done := 16#10\n);\nEND_TYPE\n' },
  { file: 'ST_Axis.TcDUT', view: 'TYPE ST_Axis :\nSTRUCT\n    nPos : DINT;\n    bOn : BOOL;\n    sName : STRING(20);\nEND_STRUCT\nEND_TYPE\n' },
  {
    file: 'FB_Drive.TcPOU',
    view: `FUNCTION_BLOCK FB_Drive
VAR_INPUT
    bEnable : BOOL;
END_VAR
VAR
    {attribute 'hide'}
    bBusy : BOOL;
    {attribute 'hide'}
    bPlain : BOOL;
    nState : INT;
END_VAR
//---- IMPLEMENTATION ----
//==== PROPERTY Busy ====
{attribute 'monitoring' := 'call'}
PROPERTY PUBLIC Busy : BOOL
//==== PROPERTY Plain ====
PROPERTY PUBLIC Plain : BOOL
`,
  },
  {
    file: 'MAIN.TcPOU',
    view: `PROGRAM MAIN
VAR
    fbDrive : FB_Drive;
    aDrives : ARRAY[1..3] OF FB_Drive;
    eMode : E_Mode;
    stAxis : ST_Axis;
END_VAR
//---- IMPLEMENTATION ----
fbDrive();
`,
  },
];

/** A minimal build output with the enum E_Mode (two names share the value 1) and one symbol. */
export const ENUM_TMC = `<?xml version="1.0" encoding="utf-8"?>
<TcModuleClass>
  <DataTypes>
    <DataType>
      <Name>E_Mode</Name>
      <BitSize>16</BitSize>
      <BaseType>INT</BaseType>
      <EnumInfo><Text>Off</Text><Enum>0</Enum></EnumInfo>
      <EnumInfo><Text>Run</Text><Enum>1</Enum><Comment>Normal operation</Comment></EnumInfo>
      <EnumInfo><Text>Start</Text><Enum>1</Enum></EnumInfo>
    </DataType>
  </DataTypes>
  <Modules>
    <Module>
      <DataAreas>
        <DataArea>
          <Symbol><Name>MAIN.eMode</Name><BitSize>16</BitSize><BaseType>E_Mode</BaseType></Symbol>
        </DataArea>
      </DataAreas>
    </Module>
  </Modules>
</TcModuleClass>
`;
