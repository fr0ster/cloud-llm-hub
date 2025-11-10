@path: 'agent'
service AgentService {
  /**
   * Send a message to the agent and get response
   */
  function Chat(message: String) returns String;
  
  /**
   * Get conversation history
   */
  function GetHistory() returns array of ChatMessage;
  
  /**
   * Clear conversation history
   */
  action ClearHistory() returns {
    success: Boolean;
    message: String;
  };
  
  /**
   * Health check for agent service
   */
  function Health() returns AgentHealthStatus;
}

type ChatMessage {
  role: String;
  content: String;
  timestamp: DateTime;
}

type AgentHealthStatus {
  status: String;
  agentReady: Boolean;
  mcpConnected: Boolean;
  llmProvider: String;
  llmDestination: String;
  model: String;
  mcpDestination: String;
  timestamp: DateTime;
}

