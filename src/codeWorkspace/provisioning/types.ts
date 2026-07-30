export interface ProvisionResult {
  workspaceId: string;
  rootPath: string;
  message: string;
}

export interface ProvisionContext {
  agentHostBaseUrl: string;
  token: string;
}
