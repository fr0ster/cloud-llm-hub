using example.abapdumpmonitor as core from '../db/schema';

service MonitorService @(path: 'admin', requires: 'Viewer') {

  @readonly
  entity MonitoredDump as projection on core.MonitoredDump
    actions {
      @(requires: 'Admin') action pushToJira()    returns String;
      @(requires: 'Admin') action retryAnalysis() returns String;
      @(requires: 'Admin') action retryJira()     returns String;
    };

  entity Setting       @(restrict: [{ grant: '*', to: 'Admin' }]) as projection on core.Setting;
  entity AssigneeRule  @(restrict: [{ grant: '*', to: 'Admin' }]) as projection on core.AssigneeRule;

  @(requires: 'Admin')
  action pollNow() returns String;
}
