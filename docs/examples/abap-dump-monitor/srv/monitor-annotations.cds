using MonitorService from './monitor-service';

annotate MonitorService.MonitoredDump with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Dump',
      TypeNamePlural: 'Monitored Dumps',
      Title: { Value: dumpId },
      Description: { Value: runtimeError }
    },
    SelectionFields: [system, analysisStatus, jiraStatus, runtimeError, program],
    LineItem: [
      { Value: firstSeenAt, Label: 'Seen' },
      { Value: system, Label: 'System' },
      { Value: dumpId, Label: 'Dump' },
      { Value: runtimeError, Label: 'Runtime Error' },
      { Value: program, Label: 'Program' },
      { Value: include, Label: 'Include' },
      { Value: sourceLine, Label: 'Line' },
      { Value: abapUser, Label: 'User' },
      { Value: analysisStatus, Label: 'Analysis', Criticality: analysisStatusCriticality },
      { Value: jiraStatus, Label: 'Jira', Criticality: jiraStatusCriticality },
      { Value: jiraIssueKey, Label: 'Jira Key' },
      { $Type: 'UI.DataFieldForAction', Label: 'Push to Jira',    Action: 'MonitorService.pushToJira'    },
      { $Type: 'UI.DataFieldForAction', Label: 'Retry Analysis',  Action: 'MonitorService.retryAnalysis' },
      { $Type: 'UI.DataFieldForAction', Label: 'Retry Jira',      Action: 'MonitorService.retryJira'     }
    ],
    Facets: [
      { $Type: 'UI.ReferenceFacet', ID: 'Header',    Label: 'Header',     Target: '@UI.FieldGroup#Header' },
      { $Type: 'UI.ReferenceFacet', ID: 'Stack',     Label: 'Call Stack', Target: 'callStack/@UI.LineItem' },
      { $Type: 'UI.ReferenceFacet', ID: 'Source',    Label: 'Source',     Target: 'sourceExtract/@UI.FieldGroup#Source' },
      { $Type: 'UI.ReferenceFacet', ID: 'Variables', Label: 'Variables',  Target: 'variables/@UI.LineItem' },
      { $Type: 'UI.ReferenceFacet', ID: 'Refs',      Label: 'References', Target: 'referencedObjects/@UI.LineItem' },
      { $Type: 'UI.ReferenceFacet', ID: 'Analysis',  Label: 'Analysis',   Target: '@UI.FieldGroup#Analysis' },
      { $Type: 'UI.ReferenceFacet', ID: 'Jira',      Label: 'Jira',       Target: '@UI.FieldGroup#Jira' }
    ],
    FieldGroup#Header: {
      Data: [
        { Value: system },           { Value: client },
        { Value: dumpId },           { Value: occurredAt },
        { Value: firstSeenAt },      { Value: abapUser },
        { Value: runtimeError },     { Value: exceptionClass },
        { Value: program },          { Value: include },
        { Value: mainProgram },      { Value: sourceLine },
        { Value: event },            { Value: transactionId },
        { Value: host },             { Value: instance },
        { Value: shortText },
        { Value: signature, Label: 'Dedup signature' }
      ]
    },
    FieldGroup#Analysis: {
      Data: [
        { Value: analysisStatus },
        { Value: analysisAttempts },
        { Value: recommendations },
        { Value: analysisError }
      ]
    },
    FieldGroup#Jira: {
      Data: [
        { Value: jiraStatus },
        { Value: jiraIssueKey },
        { Value: jiraAttempts },
        { Value: skipJira },
        { Value: jiraError }
      ]
    }
  }
) {
  analysisStatus @Common.FieldControl: #ReadOnly;
  jiraStatus     @Common.FieldControl: #ReadOnly;
};

extend MonitorService.MonitoredDump with columns {
  virtual null as analysisStatusCriticality : Integer,
  virtual null as jiraStatusCriticality     : Integer
};

annotate MonitorService.CallStackEntry with @(
  UI.LineItem: [
    { Value: position },
    { Value: eventType },
    { Value: eventName },
    { Value: program },
    { Value: include },
    { Value: line },
    { Value: objectClass }
  ]
);

annotate MonitorService.ReferencedObject with @(
  UI.LineItem: [
    { Value: objectName },
    { Value: objectType },
    { Value: subObject },
    { Value: package },
    { Value: source }
  ]
);

annotate MonitorService.VariableSnapshot with @(
  UI.LineItem: [
    { Value: scope },
    { Value: name },
    { Value: type },
    { Value: value },
    { Value: truncated }
  ]
);

annotate MonitorService.SourceExtract with @(
  UI.FieldGroup#Source: {
    Data: [
      { Value: program },
      { Value: include },
      { Value: lineFrom },
      { Value: lineTo },
      { Value: code }
    ]
  }
);

annotate MonitorService.Setting with @(
  UI.LineItem: [ { Value: key }, { Value: value }, { Value: dataType }, { Value: description }, { Value: updatedAt }, { Value: updatedBy } ],
  UI.HeaderInfo: { TypeName: 'Setting', TypeNamePlural: 'Settings', Title: { Value: key }, Description: { Value: value } }
);

annotate MonitorService.AssigneeRule with @(
  UI.LineItem: [ { Value: priority }, { Value: system }, { Value: runtimeErrorPattern }, { Value: programPattern }, { Value: categoryPattern }, { Value: assigneeName }, { Value: active } ],
  UI.HeaderInfo: { TypeName: 'AssigneeRule', TypeNamePlural: 'Assignee Rules', Title: { Value: assigneeName } }
);
