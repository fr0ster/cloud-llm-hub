using MonitorService from '../../srv/monitor-service';

annotate MonitorService.MonitoredDump with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Dump',
      TypeNamePlural: 'Monitored Dumps',
      Title: { Value: dumpId },
      Description: { Value: runtimeError }
    },
    Identification: [
      { $Type: 'UI.DataFieldForAction', Label: 'Analysis', Action: 'MonitorService.retryAnalysis' },
      { $Type: 'UI.DataFieldForAction', Label: 'Jira',     Action: 'MonitorService.pushToJira'    }
    ],
    SelectionFields: [ abapUser, system, runtimeError, category, occurredAt, analysisStatus, jiraStatus ],
    LineItem: [
      { Value: firstSeenAt, Label: 'Seen' },
      { Value: system, Label: 'System' },
      { Value: dumpId, Label: 'Dump' },
      { Value: runtimeError, Label: 'Runtime Error' },
      { Value: program, Label: 'Program' },
      { Value: include, Label: 'Include' },
      { Value: sourceLine, Label: 'Line' },
      { Value: abapUser, Label: 'User' },
      { Value: analysisStatus, Label: 'Analysis' },
      { Value: jiraStatus, Label: 'Jira' },
      { $Type: 'UI.DataFieldForAction', Label: 'Analysis', Action: 'MonitorService.retryAnalysis' },
      { $Type: 'UI.DataFieldForAction', Label: 'Jira',     Action: 'MonitorService.pushToJira'    }
    ],
    Facets: [
      { $Type: 'UI.ReferenceFacet', ID: 'Header',    Label: 'Header',     Target: '@UI.FieldGroup#Header' },
      { $Type: 'UI.ReferenceFacet', ID: 'Stack',     Label: 'Call Stack', Target: 'callStack/@UI.LineItem' },
      // Source code is rendered by a custom CodeEditor section (manifest.json → SourceCode)
      // for monospace + ABAP syntax highlight; the auto-generated FieldGroup facet is
      // intentionally omitted to avoid a duplicate tab.
      { $Type: 'UI.ReferenceFacet', ID: 'Variables', Label: 'Variables',  Target: 'variables/@UI.LineItem' },
      { $Type: 'UI.ReferenceFacet', ID: 'Refs',      Label: 'References', Target: 'referencedObjects/@UI.LineItem' },
      // Hidden helper facets — force Fiori to $select recommendations / jiraIssueUrl
      // (FE V4 doesn't honour requestAtLeast for LargeString fields in custom
      // sections, so visible FieldGroup references are the only way to make those
      // fields appear in OData $select). The tabs themselves are hidden via
      // @UI.Hidden; the user-facing rendering lives in the custom AnalysisCustom /
      // JiraCustom sections (CodeEditor / Link), see manifest.json.
      { $Type: 'UI.ReferenceFacet', ID: 'AnalysisHidden', Target: '@UI.FieldGroup#Analysis', @UI.Hidden: true },
      { $Type: 'UI.ReferenceFacet', ID: 'JiraHidden',     Target: '@UI.FieldGroup#Jira',     @UI.Hidden: true }
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
        { Value: jiraIssueUrl },
        { Value: jiraAttempts },
        { Value: skipJira },
        { Value: jiraError }
      ]
    }
  }
) {
  analysisStatus @Common.FieldControl: #ReadOnly;
  jiraStatus     @Common.FieldControl: #ReadOnly;

  // Value Helps for filter bar — self-reference the same entity so Fiori
  // Elements offers a F4 dialog with the distinct values currently in the
  // table (works without a separate VH entity).
  abapUser @Common.ValueList: {
    CollectionPath: 'AbapUserVH',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: abapUser, ValueListProperty: 'abapUser' }
    ]
  };
  system @Common.ValueList: {
    CollectionPath: 'SystemVH',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: system, ValueListProperty: 'system' }
    ]
  };
  runtimeError @Common.ValueList: {
    CollectionPath: 'RuntimeErrorVH',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: runtimeError, ValueListProperty: 'runtimeError' }
    ]
  };
  category @Common.ValueList: {
    CollectionPath: 'CategoryVH',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: category, ValueListProperty: 'category' }
    ]
  };
};

// SideEffects — refetch the entire bound entity after each action so Object Page
// reflects updated status / recommendations / Jira key automatically.
annotate MonitorService.MonitoredDump actions {
  retryAnalysis @(Common.SideEffects: { TargetEntities: ['_it'] });
  pushToJira    @(Common.SideEffects: { TargetEntities: ['_it'] });
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
      { Value: code, @UI.MultiLineText: true }
    ]
  }
) {
  code @UI.MultiLineText;
};

annotate MonitorService.Setting with @(
  UI.LineItem: [ { Value: key }, { Value: value }, { Value: dataType }, { Value: description }, { Value: updatedAt }, { Value: updatedBy } ],
  UI.HeaderInfo: { TypeName: 'Setting', TypeNamePlural: 'Settings', Title: { Value: key }, Description: { Value: value } }
);

annotate MonitorService.AssigneeRule with @(
  UI.LineItem: [ { Value: priority }, { Value: system }, { Value: runtimeErrorPattern }, { Value: programPattern }, { Value: categoryPattern }, { Value: assigneeName }, { Value: active } ],
  UI.HeaderInfo: { TypeName: 'AssigneeRule', TypeNamePlural: 'Assignee Rules', Title: { Value: assigneeName } }
);
