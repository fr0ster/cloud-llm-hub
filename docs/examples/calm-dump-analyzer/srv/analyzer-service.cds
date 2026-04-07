@path: 'analyzer'
service AnalyzerService {
  /**
   * Analyze an ABAP dump from SAP Cloud ALM event payload.
   * Sends the event to cloud-llm-hub for analysis via SmartAgent pipeline.
   */
  action AnalyzeDump(event: LargeString, model: String, temperature: Double) returns AnalysisResult;

  /** Health check */
  function Health() returns HealthStatus;
}

type AnalysisResult {
  status          : String; // analyzed | error
  system          : String;
  program         : String;
  error           : String;
  exception       : String;
  user            : String;
  rootCause       : String;
  codeSection     : String;
  severity        : String; // low | medium | high | critical
  recommendations : LargeString; // JSON array of { type, description }
  errorMessage    : String; // populated when status = error
}

type HealthStatus {
  status    : String;
  llmHubUrl : String;
  timestamp : DateTime;
}
