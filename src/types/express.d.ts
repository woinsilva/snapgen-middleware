declare global {
  namespace Express {
    interface Locals {
      requestId: string;
      requestUuid?: string;
    }
  }
}

export {};
