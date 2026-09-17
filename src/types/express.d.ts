declare global {
  namespace Express {
    interface Locals {
      requestId: string;
      requestUuid?: string;
      projectId?: string;
      generationJobId?: string;
      renderJobId?: string;
      sceneId?: string;
      attemptId?: string;
      snapgenUuid?: string;
    }
  }
}

export {};
