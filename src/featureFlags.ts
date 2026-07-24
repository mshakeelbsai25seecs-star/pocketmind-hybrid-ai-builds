/** Product capability flags for data-safety + Code Workspace. */
export const FEATURE_FLAGS = {
  encryptedBackup: true,
  scheduledBackup: true,
  contextBudgetBar: true,
  contextTrimSlider: true,
  workspaceProfiles: true,
  orphanCleaner: true,
  modelSha256Verify: true,
  batchDocumentProcessing: true,
  diffViewer: true,
  codeWorkspace: true,
  codeWorkspaceSandbox: true,
  androidOnlineFolderOnly: true,
} as const;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;
