type WorkspaceCode = 'invalid' | 'not_found' | 'too_large' | 'binary' | 'no_repo' | 'exists';

export class WorkspaceError extends Error {
  constructor(public code: WorkspaceCode, message: string) { super(message); }
}
