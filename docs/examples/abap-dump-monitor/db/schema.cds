namespace example.abapdumpmonitor;

using { managed, cuid } from '@sap/cds/common';

entity MonitoredDump : cuid, managed {
  system            : String(20)  not null;
  client            : String(3);
  dumpId            : String(40)  not null;
  runtimeError      : String(60);
  exceptionClass    : String(60);
  category          : String(40);
  host              : String(40);
  instance          : String(40);
  program           : String(40);
  include           : String(40);
  mainProgram       : String(40);
  sourceLine        : Integer;
  event             : String(40);
  transactionId     : String(40);
  abapUser          : String(12);
  occurredAt        : Timestamp;
  firstSeenAt       : Timestamp;
  shortText         : String(1000);
  signature         : String(200);
  rawPayload        : LargeString;
  analysisStatus    : String(20)  default 'pending';
  analysisResult    : LargeString;
  recommendations   : LargeString;
  analysisError     : String(2000);
  analysisAttempts  : Integer     default 0;
  jiraStatus        : String(20)  default 'pending';
  jiraIssueKey      : String(40);
  jiraError         : String(2000);
  jiraAttempts      : Integer     default 0;
  skipJira          : Boolean     default false;

  callStack         : Composition of many CallStackEntry on callStack.parent = $self;
  variables         : Composition of many VariableSnapshot on variables.parent = $self;
  sourceExtract     : Composition of one SourceExtract on sourceExtract.parent = $self;
}

entity CallStackEntry : cuid {
  parent       : Association to MonitoredDump;
  position     : Integer;
  program      : String(40);
  include      : String(40);
  line         : Integer;
  eventType    : String(40);
  eventName    : String(60);
}

entity VariableSnapshot : cuid {
  parent     : Association to MonitoredDump;
  frameNo    : Integer;
  scope      : String(20);
  name       : String(60);
  type       : String(40);
  value      : LargeString;
  truncated  : Boolean default false;
}

entity SourceExtract : cuid {
  parent    : Association to MonitoredDump;
  program   : String(40);
  include   : String(40);
  lineFrom  : Integer;
  lineTo    : Integer;
  code      : LargeString;
}

entity Setting {
  key ![key]   : String(60);
  value        : String(2000);
  dataType     : String(10);
  description  : String(500);
  updatedAt    : Timestamp @cds.on.insert : $now @cds.on.update : $now;
  updatedBy    : String    @cds.on.insert : $user @cds.on.update : $user;
}

annotate MonitoredDump with @assert.unique : { dumpKey: [system, dumpId] };

entity AssigneeRule : cuid {
  priority             : Integer not null default 100;
  system               : String(20);
  runtimeErrorPattern  : String(120);
  programPattern       : String(60);
  categoryPattern      : String(60);
  assigneeName         : String(120);
  active               : Boolean default true;
  description          : String(500);
}
