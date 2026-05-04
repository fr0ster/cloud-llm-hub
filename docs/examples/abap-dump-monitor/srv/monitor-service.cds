using example.abapdumpmonitor as core from '../db/schema';

service MonitorService @(path: 'admin', requires: 'Viewer') {

  @readonly
  @cds.redirection.target
  entity MonitoredDump as projection on core.MonitoredDump {
    *,
    // Server-side rendered markdown (recommendations) for sap.m.FormattedText.
    null as recommendationsHtml : LargeString,
    // URL to the Jira ticket — built from JIRA_URL + jiraIssueKey at READ time.
    null as jiraIssueUrl : String(500),
    // Recurrence group metadata — populated in after-READ over rows sharing the
    // same signature. recurrenceCount = total dumps in this group seen so far;
    // firstOccurrenceID = ID of the oldest dump in the group (for navigation).
    null as recurrenceCount    : Integer,
    null as firstOccurrenceID  : UUID
  } actions {
    @(requires: 'Admin') action retryAnalysis() returns MonitoredDump;
    @(requires: 'Admin') action pushToJira()    returns MonitoredDump;
  };

  entity Setting       @(restrict: [{ grant: '*', to: 'Admin' }]) as projection on core.Setting;
  entity AssigneeRule  @(restrict: [{ grant: '*', to: 'Admin' }]) as projection on core.AssigneeRule;

  @(requires: 'Admin')
  action pollNow() returns String;

  // Value-help projections — distinct values currently in MonitoredDump,
  // used by Fiori Elements F4 dialogs on the List Report filter bar.
  @readonly entity AbapUserVH      as select distinct key abapUser     from core.MonitoredDump where abapUser     is not null;
  @readonly entity SystemVH        as select distinct key system       from core.MonitoredDump where system       is not null;
  @readonly entity RuntimeErrorVH  as select distinct key runtimeError from core.MonitoredDump where runtimeError is not null;
  @readonly entity CategoryVH      as select distinct key category     from core.MonitoredDump where category     is not null;
}
