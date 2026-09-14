export const projectStatuses = ['planning', 'generating', 'assembling', 'completed', 'failed'] as const;
export type VideoProjectStatus = typeof projectStatuses[number];

export const sceneStatuses = ['pending', 'submitting', 'processing', 'completed', 'failed', 'ambiguous'] as const;
export type VideoProjectSceneStatus = typeof sceneStatuses[number];

export interface VisualBibleCharacter { id: string; description: string }
export interface VisualBible {
  style: string;
  characters: VisualBibleCharacter[];
  environment: string;
  continuityRules: string[];
}
export interface ProjectSceneInput { sequence: number; prompt: string; continuityInstructions?: string }
export interface ProjectModelProfile {
  model: string;
  segmentDurationSeconds: number;
  supportsLongProject: boolean;
  supportsExtend: boolean;
  extendChainValidated: boolean;
  generationStrategy: 'independent' | 'extend';
  allowedResolutions: readonly string[];
  allowedAspectRatios: readonly string[];
}
export interface ProjectStateScene extends ProjectSceneInput {
  status: VideoProjectSceneStatus;
  attemptNumber: 0 | 1;
  operation: 'generate';
  snapgenUuid?: string;
  errorCode?: string;
  errorMessage?: string;
}
export interface ProjectOutputState { handle: string; expiresAt: string }
export interface ProjectState {
  schemaVersion: 1;
  projectId: string;
  tokenVersion: number;
  model: string;
  targetDuration: number;
  segmentDuration: number;
  plannedSegmentCount: number;
  rawDuration: number;
  trimDuration: number;
  resolution: string;
  aspectRatio: string;
  concept: string;
  visualBible: VisualBible;
  scenes: ProjectStateScene[];
  paidOperations: number;
  maxPaidOperations: number;
  maxAttemptsPerScene: 1;
  automaticPaidRetries: 0;
  status: VideoProjectStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  output?: ProjectOutputState;
  errorCode?: string;
  errorMessage?: string;
}
export interface ProjectBudget { maxPaidOperations: number; maxAttemptsPerScene: 1; automaticPaidRetries: 0 }

export const calculateSegmentCount = (duration: number, segmentDuration: number): number => Math.ceil(duration / segmentDuration);
export const calculateRawDuration = (count: number, segmentDuration: number): number => count * segmentDuration;
export const calculateTrimDuration = (target: number, raw: number): number => raw - target;
export const calculateProjectBudget = (count: number): ProjectBudget => ({ maxPaidOperations: count, maxAttemptsPerScene: 1, automaticPaidRetries: 0 });

export function calculateProjectProgress(status: VideoProjectStatus, completed: number, total: number): number {
  if (status === 'planning') return 0;
  if (status === 'assembling') return 90;
  if (status === 'completed') return 100;
  if (status === 'generating') return total <= 0 ? 5 : Math.min(89, 5 + Math.floor((Math.max(0, completed) / total) * 84));
  return total <= 0 ? 0 : Math.min(99, Math.floor((Math.max(0, completed) / total) * 90));
}

const projectTransitions: Record<VideoProjectStatus, readonly VideoProjectStatus[]> = {
  planning: ['generating', 'failed'], generating: ['assembling', 'failed'], assembling: ['completed', 'failed'], completed: [], failed: [],
};
const sceneTransitions: Record<VideoProjectSceneStatus, readonly VideoProjectSceneStatus[]> = {
  pending: ['submitting', 'failed'], submitting: ['processing', 'failed', 'ambiguous'], processing: ['completed', 'failed'], completed: [], failed: [], ambiguous: [],
};
export class InvalidStateTransitionError extends Error {
  constructor(entity: string, from: string, to: string) { super(`Invalid ${entity} state transition: ${from} -> ${to}`); this.name = 'InvalidStateTransitionError'; }
}
export function assertProjectTransition(from: VideoProjectStatus, to: VideoProjectStatus): void {
  if (!projectTransitions[from].includes(to)) throw new InvalidStateTransitionError('project', from, to);
}
export function assertSceneTransition(from: VideoProjectSceneStatus, to: VideoProjectSceneStatus): void {
  if (!sceneTransitions[from].includes(to)) throw new InvalidStateTransitionError('scene', from, to);
}
