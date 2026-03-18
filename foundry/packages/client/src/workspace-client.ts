import type {
  TaskWorkspaceAddSessionResponse,
  TaskWorkspaceChangeModelInput,
  TaskWorkspaceChangeOwnerInput,
  TaskWorkspaceCreateTaskInput,
  TaskWorkspaceCreateTaskResponse,
  TaskWorkspaceDiffInput,
  TaskWorkspaceRenameInput,
  TaskWorkspaceRenameSessionInput,
  TaskWorkspaceSelectInput,
  TaskWorkspaceSetSessionUnreadInput,
  TaskWorkspaceSendMessageInput,
  TaskWorkspaceSnapshot,
  TaskWorkspaceSessionInput,
  TaskWorkspaceUpdateDraftInput,
} from "@sandbox-agent/foundry-shared";

export interface TaskWorkspaceClient {
  getSnapshot(): TaskWorkspaceSnapshot;
  subscribe(listener: () => void): () => void;
  createTask(input: TaskWorkspaceCreateTaskInput): Promise<TaskWorkspaceCreateTaskResponse>;
  markTaskUnread(input: TaskWorkspaceSelectInput): Promise<void>;
  renameTask(input: TaskWorkspaceRenameInput): Promise<void>;
  archiveTask(input: TaskWorkspaceSelectInput): Promise<void>;
  publishPr(input: TaskWorkspaceSelectInput): Promise<void>;
  revertFile(input: TaskWorkspaceDiffInput): Promise<void>;
  updateDraft(input: TaskWorkspaceUpdateDraftInput): Promise<void>;
  sendMessage(input: TaskWorkspaceSendMessageInput): Promise<void>;
  stopAgent(input: TaskWorkspaceSessionInput): Promise<void>;
  selectSession(input: TaskWorkspaceSessionInput): Promise<void>;
  setSessionUnread(input: TaskWorkspaceSetSessionUnreadInput): Promise<void>;
  renameSession(input: TaskWorkspaceRenameSessionInput): Promise<void>;
  closeSession(input: TaskWorkspaceSessionInput): Promise<void>;
  addSession(input: TaskWorkspaceSelectInput): Promise<TaskWorkspaceAddSessionResponse>;
  changeModel(input: TaskWorkspaceChangeModelInput): Promise<void>;
  changeOwner(input: TaskWorkspaceChangeOwnerInput): Promise<void>;
}
