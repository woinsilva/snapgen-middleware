import { randomUUID } from 'node:crypto';
import { ApiError, SnapGenError } from '../errors.js';
import type { VideoProvider } from '../providers/video.provider.js';
import { assertProjectTransition, assertSceneTransition, calculateProjectBudget, calculateProjectProgress, type ProjectState } from './project.domain.js';
import { deriveProjectPlan, projectStateSchema, type CreateProjectInput, type ValidatedProjectState } from './project.schemas.js';
import type { ProjectStateTokenService } from './project-state-token.js';
import { projectModelProfileRegistry } from './project-model-profile.registry.js';

export interface RenderResult { handle: string; expiresAt: string }
export interface ProjectRenderer { render(state: ValidatedProjectState, requestId: string): Promise<RenderResult> }

export interface ProjectResponse {
  projectId: string;
  status: ProjectState['status'];
  progress: number;
  model: string;
  targetDuration: number;
  scenes: { total: number; completed: number; processing: number; pending: number };
  projectState: string;
  downloadUrl: string | null;
  outputExpiresAt: string | null;
  error: { code: string; message: string; retryable: false } | null;
}

function isAmbiguousSubmission(error: unknown): boolean {
  if (!(error instanceof SnapGenError)) return false;
  return error.status >= 500;
}

function counts(state: ValidatedProjectState) {
  const completed = state.scenes.filter((scene) => scene.status === 'completed').length;
  const processing = state.scenes.filter((scene) => ['submitting', 'processing'].includes(scene.status)).length;
  return { total: state.scenes.length, completed, processing, pending: state.scenes.length - completed - processing };
}

export class StatelessProjectService {
  constructor(
    private readonly tokens: ProjectStateTokenService,
    private readonly provider: VideoProvider,
    private readonly renderer?: ProjectRenderer,
    private readonly tokenTtlSeconds = 2_592_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(input: CreateProjectInput): ProjectResponse {
    const profile = projectModelProfileRegistry.get(input.model);
    const plan = deriveProjectPlan(input);
    const budget = calculateProjectBudget(plan.plannedSegmentCount);
    const now = this.now();
    const state = projectStateSchema.parse({
      schemaVersion: 2,
      projectId: randomUUID(),
      tokenVersion: 1,
      model: input.model,
      generationStrategy: profile.generationStrategy,
      targetDuration: input.duration,
      segmentDuration: plan.segmentDuration,
      plannedSegmentCount: plan.plannedSegmentCount,
      rawDuration: plan.rawDuration,
      trimDuration: plan.trimDuration,
      resolution: input.resolution,
      aspectRatio: input.aspect_ratio,
      concept: input.concept,
      visualBible: input.visualBible,
      scenes: input.scenes.map((scene) => ({ ...scene, status: 'pending', attemptNumber: 0, operation: 'generate' })),
      paidOperations: 0,
      maxPaidOperations: budget.maxPaidOperations,
      maxAttemptsPerScene: budget.maxAttemptsPerScene,
      automaticPaidRetries: budget.automaticPaidRetries,
      status: 'planning',
      progress: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.tokenTtlSeconds * 1_000).toISOString(),
    });
    return this.response(state, this.tokens.sign(state, 8_192));
  }

  async continue(projectState: string, requestId: string): Promise<ProjectResponse> {
    const state = this.tokens.verify(projectState);
    return state.scenes.some((scene) => scene.status === 'processing')
      ? this.synchronizeStatus(projectState, requestId, this.provider.getVideo.bind(this.provider))
      : this.advance(projectState, requestId);
  }

  async advance(projectState: string, requestId: string): Promise<ProjectResponse> {
    const state = structuredClone(this.tokens.verify(projectState));
    if (state.status === 'completed' || state.status === 'failed') return this.response(state, projectState);
    if (state.status === 'assembling') return this.response(state, projectState);
    if (state.scenes.some((scene) => scene.status === 'processing')) {
      throw new ApiError(409, 'PROJECT_STATUS_REQUIRED', 'A scene is processing. Use the project status endpoint before advancing.');
    }
    if (state.status === 'planning') {
      assertProjectTransition('planning', 'generating');
      state.status = 'generating';
    }

    const unsafe = state.scenes.find((scene) => ['submitting', 'ambiguous'].includes(scene.status));
    if (unsafe) {
      if (unsafe.status === 'submitting') unsafe.status = 'ambiguous';
      state.status = 'failed';
      unsafe.errorCode = 'AMBIGUOUS_PROVIDER_SUBMISSION';
      unsafe.errorMessage = 'The provider submission cannot be safely repeated.';
      state.errorCode = unsafe.errorCode;
      state.errorMessage = unsafe.errorMessage;
      return this.updatedResponse(state);
    }

    const pending = state.scenes.find((scene) => scene.status === 'pending');
    if (!pending) {
      assertProjectTransition(state.status, 'assembling');
      state.status = 'assembling';
      return this.updatedResponse(state);
    }
    if (state.paidOperations >= state.maxPaidOperations) {
      assertProjectTransition(state.status, 'failed');
      state.status = 'failed';
      state.errorCode = 'PAID_OPERATION_BUDGET_EXHAUSTED';
      state.errorMessage = 'The project paid-operation budget is exhausted.';
      return this.updatedResponse(state);
    }

    assertSceneTransition('pending', 'submitting');
    pending.status = 'submitting';
    pending.attemptNumber = 1;
    const prompt = pending.continuityInstructions
      ? `${pending.prompt}\n\nContinuity instructions: ${pending.continuityInstructions}`
      : pending.prompt;
    try {
      const result = await this.provider.generateVideo({
        prompt,
        model: state.model,
        duration: state.segmentDuration,
        resolution: state.resolution,
        aspect_ratio: state.aspectRatio,
        ref_images: [],
      }, requestId);
      state.paidOperations += 1;
      assertSceneTransition('submitting', 'processing');
      pending.status = 'processing';
      pending.snapgenUuid = result.uuid;
      return this.updatedResponse(state);
    } catch (error) {
      if (isAmbiguousSubmission(error)) {
        state.paidOperations += 1;
        assertSceneTransition('submitting', 'ambiguous');
        pending.status = 'ambiguous';
        pending.errorCode = 'AMBIGUOUS_PROVIDER_SUBMISSION';
        pending.errorMessage = 'The provider may have accepted the request, but no UUID was received.';
      } else {
        assertSceneTransition('submitting', 'failed');
        pending.status = 'failed';
        pending.errorCode = 'PROVIDER_SUBMISSION_FAILED';
        pending.errorMessage = 'The provider conclusively rejected the request.';
      }
      assertProjectTransition(state.status, 'failed');
      state.status = 'failed';
      state.errorCode = pending.errorCode;
      state.errorMessage = pending.errorMessage;
      return this.updatedResponse(state);
    }
  }

  async status(projectState: string, requestId: string): Promise<ProjectResponse> {
    const lookup = this.provider.getVideoOnce?.bind(this.provider) ?? this.provider.getVideo.bind(this.provider);
    return this.synchronizeStatus(projectState, requestId, lookup);
  }

  private async synchronizeStatus(projectState: string, requestId: string, lookup: VideoProvider['getVideo']): Promise<ProjectResponse> {
    const state = structuredClone(this.tokens.verify(projectState));
    const active = state.scenes.find((scene) => scene.status === 'processing');
    if (!active) return this.response(state, projectState);

    const result = await lookup(active.snapgenUuid!, requestId);
    if (result.status === 'processing') return this.updatedResponse(state);
    if (result.status === 'failed') {
      assertSceneTransition('processing', 'failed');
      active.status = 'failed';
      active.errorCode = 'PROVIDER_GENERATION_FAILED';
      active.errorMessage = result.error ?? 'Video generation failed';
      assertProjectTransition(state.status, 'failed');
      state.status = 'failed';
      state.errorCode = active.errorCode;
      state.errorMessage = active.errorMessage;
      return this.updatedResponse(state);
    }
    assertSceneTransition('processing', 'completed');
    active.status = 'completed';
    const completed = state.scenes.filter((scene) => scene.status === 'completed').length;
    if (completed === state.scenes.length) {
      assertProjectTransition(state.status, 'assembling');
      state.status = 'assembling';
    }
    return this.updatedResponse(state);
  }

  async render(projectState: string, requestId: string): Promise<ProjectResponse> {
    const state = structuredClone(this.tokens.verify(projectState));
    if (state.status === 'completed') return this.response(state, projectState);
    this.assertRenderableState(state);
    if (!this.renderer) throw new ApiError(503, 'PROJECT_RENDERING_UNAVAILABLE', 'Project rendering is not configured.');
    const output = await this.renderer.render(state, requestId);
    assertProjectTransition('assembling', 'completed');
    state.status = 'completed';
    state.output = output;
    return this.updatedResponse(state);
  }

  verify(projectState: string): ValidatedProjectState { return this.tokens.verify(projectState); }

  assertReadyToRender(projectState: string): ValidatedProjectState {
    const state = this.tokens.verify(projectState);
    this.assertRenderableState(state);
    return state;
  }

  authorizeOutput(projectId: string, accessToken: string) { return this.tokens.verifyOutputAccess(accessToken, projectId); }

  private updatedResponse(state: ValidatedProjectState): ProjectResponse {
    const now = this.now();
    state.tokenVersion += 1;
    state.updatedAt = now.toISOString();
    state.expiresAt = new Date(now.getTime() + this.tokenTtlSeconds * 1_000).toISOString();
    const completed = state.scenes.filter((scene) => scene.status === 'completed').length;
    state.progress = calculateProjectProgress(state.status, completed, state.scenes.length);
    return this.response(projectStateSchema.parse(state));
  }

  private response(state: ValidatedProjectState, existingToken?: string): ProjectResponse {
    const sceneCounts = counts(state);
    return {
      projectId: state.projectId,
      status: state.status,
      progress: state.progress,
      model: state.model,
      targetDuration: state.targetDuration,
      scenes: sceneCounts,
      projectState: existingToken ?? this.tokens.sign(state),
      downloadUrl: state.output ? `/video/projects/output/${state.projectId}?access=${encodeURIComponent(this.tokens.signOutputAccess(state.projectId, state.output))}` : null,
      outputExpiresAt: state.output?.expiresAt ?? null,
      error: state.errorCode && state.errorMessage ? { code: state.errorCode, message: state.errorMessage, retryable: false } : null,
    };
  }

  private assertRenderableState(state: ValidatedProjectState): void {
    if (state.status !== 'assembling' || state.scenes.some((scene) => scene.status !== 'completed')) {
      throw new ApiError(409, 'PROJECT_NOT_READY_TO_RENDER', 'All project scenes must be completed before rendering.');
    }
  }
}
