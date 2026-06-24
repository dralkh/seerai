import {
  ProtocolRevision,
  ReviewProtocol,
  ScreeningDecision,
  ScreeningStage,
  SourceOccurrence,
  SourceSyncInput,
  SourceSyncResult,
  GapAnalysisRun,
  GapCandidate,
  ExtractionTemplate,
  ReviewJob,
  ReviewJobKind,
  SynthesisRun,
  SystematicReviewPaper,
  SystematicReviewSpace,
  SystematicReviewState,
} from "./types";
import { getSRStore, SystematicReviewStore } from "./store";
import {
  applyProtocolCompatibility,
  createProtocolRevision,
  getActiveProtocolRevision,
  validateProtocolRevision,
} from "./protocol";
import {
  buildGapAnalysisRun,
  buildSynthesisRun,
  computeSynthesisFingerprint,
} from "./analysisEngine";
import { buildExtractionCompatibility } from "./compatibility";
import { analyzeReviewPaper } from "./paperAnalyzer";
import { validateExtractionRow } from "./scientific";
import {
  extractReviewPaper,
  proposeExtractionTemplate,
} from "./extractionWorkflow";
import {
  runProtocolGeneration,
  type RunProtocolGenerationInput,
  type ExtractedDocument,
} from "./documentAnalyzer";
import type {
  ProtocolGenerationContext,
  ProtocolGenerationResult,
} from "./types";
import {
  ReviewCancellationController,
  ReviewCancellationSignal,
} from "./cancellation";

export class SystematicReviewService {
  private jobControllers = new Map<
    string,
    Map<number, ReviewCancellationController>
  >();

  constructor(private readonly store: SystematicReviewStore = getSRStore()) {}

  load(): Promise<SystematicReviewState> {
    return this.store.loadState();
  }

  async save(state: SystematicReviewState): Promise<void> {
    await this.store.saveState(state);
  }

  private activeJobs(state: SystematicReviewState): ReviewJob[] {
    return state.reviewJobs.filter((job) =>
      ["queued", "running", "paused"].includes(job.status),
    );
  }

  private requireIdleProject(state: SystematicReviewState): void {
    if (this.activeJobs(state).length > 0) {
      throw new Error(
        "Pause is not sufficient for project navigation. Cancel or finish active review jobs first",
      );
    }
  }

  async analyzePapers(
    state: SystematicReviewState,
    paperIds: number[],
  ): Promise<
    {
      paperId: number;
      success: boolean;
      evidenceCount?: number;
      error?: string;
    }[]
  > {
    const project = state.spaces.find(
      (candidate) => candidate.id === state.activeSpaceId,
    );
    if (!project) throw new Error("Active review project is unavailable");
    const results = [];
    for (const paperId of paperIds) {
      const paper = state.papers.find((candidate) => candidate.id === paperId);
      const item = Zotero.Items.get(paperId);
      if (!paper || !item) {
        results.push({
          paperId,
          success: false,
          error: "Paper not found",
        });
        continue;
      }
      try {
        const analyzed = await analyzeReviewPaper(item, project);
        paper.analysis = analyzed.analysis;
        paper.recommendation = analyzed.recommendation;
        results.push({
          paperId,
          success: true,
          evidenceCount: analyzed.analysis.evidence.length,
        });
      } catch (error) {
        results.push({
          paperId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.refreshDerivedDrafts(state);
    return results;
  }

  getExtractionTemplate(
    state: SystematicReviewState,
  ): ExtractionTemplate | undefined {
    return state.extractionTemplates.find(
      (template) => template.id === state.activeExtractionTemplateId,
    );
  }

  // Users no longer manually approve a template before extracting. Return the
  // active template, or auto-activate the most recent usable one (newest draft,
  // otherwise newest non-archived). Returns undefined only when none exists.
  ensureActiveExtractionTemplate(
    state: SystematicReviewState,
  ): ExtractionTemplate | undefined {
    const active = this.getExtractionTemplate(state);
    if (active) return active;
    const candidate = [...state.extractionTemplates]
      .filter((existing) => existing.status !== "archived")
      .sort((a, b) => {
        const draftRank =
          (a.status === "draft" ? 0 : 1) - (b.status === "draft" ? 0 : 1);
        if (draftRank !== 0) return draftRank;
        return (
          Date.parse(b.updatedAt || b.createdAt || "") -
          Date.parse(a.updatedAt || a.createdAt || "")
        );
      })[0];
    return candidate ? this.activateTemplate(state, candidate.id) : undefined;
  }

  getExtractionTemplateRevision(
    state: SystematicReviewState,
    revisionId: string | undefined,
  ): ExtractionTemplate | undefined {
    if (!revisionId) return undefined;
    return state.extractionTemplates.find(
      (template) => template.revisionId === revisionId,
    );
  }

  async proposeTemplate(
    state: SystematicReviewState,
    instructions = "",
    signal?: ReviewCancellationSignal,
  ): Promise<ExtractionTemplate> {
    const project = state.spaces.find(
      (candidate) => candidate.id === state.activeSpaceId,
    );
    if (!project) throw new Error("Active review project is unavailable");
    const template = await proposeExtractionTemplate(
      project,
      instructions,
      signal,
    );
    state.extractionTemplates.push(template);
    await this.save(state);
    return template;
  }

  async generateProtocolProposals(
    state: SystematicReviewState,
    documents: ExtractedDocument[],
    context: ProtocolGenerationContext = {},
    onStep?: (
      step:
        | "scope"
        | "eligibility"
        | "mapping"
        | "template"
        | "search-strategy",
      result: ProtocolGenerationResult,
    ) => void,
  ): Promise<ProtocolGenerationResult> {
    const project = state.spaces.find(
      (candidate) => candidate.id === state.activeSpaceId,
    );
    if (!project) throw new Error("Active review project is unavailable");
    const input: RunProtocolGenerationInput = {
      documents,
      baselineRevision: context.baselineRevision,
      baselineTemplate: context.baselineTemplate,
      labelDefs: state.labelDefs,
      space: project,
      steps: context.steps,
      onStep,
    };
    return runProtocolGeneration(input);
  }

  addExtractionTemplateProposal(
    state: SystematicReviewState,
    template: ExtractionTemplate,
  ): ExtractionTemplate {
    state.extractionTemplates.forEach((candidate) => {
      if (candidate.status === "draft") candidate.status = "archived";
    });
    const proposal: ExtractionTemplate = {
      ...template,
      status: "draft",
      source: "model",
      updatedAt: new Date().toISOString(),
    };
    state.extractionTemplates.push(proposal);
    return proposal;
  }

  activateTemplate(
    state: SystematicReviewState,
    templateId: string,
  ): ExtractionTemplate {
    const template = state.extractionTemplates.find(
      (candidate) => candidate.id === templateId,
    );
    if (!template)
      throw new Error(`Extraction template not found: ${templateId}`);
    state.extractionTemplates.forEach((candidate) => {
      if (candidate.status === "active") candidate.status = "archived";
    });
    template.status = "active";
    template.updatedAt = new Date().toISOString();
    state.activeExtractionTemplateId = template.id;
    state.synthesisRuns.forEach((run) => {
      if (run.status !== "stale") {
        run.status = "stale";
        run.staleReasons = ["Extraction template changed"];
        run.updatedAt = template.updatedAt;
      }
    });
    return template;
  }

  updateTemplate(
    state: SystematicReviewState,
    template: ExtractionTemplate,
  ): ExtractionTemplate {
    const index = state.extractionTemplates.findIndex(
      (candidate) => candidate.id === template.id,
    );
    if (index < 0)
      throw new Error(`Extraction template not found: ${template.id}`);
    const revision =
      (Number(template.revisionId.match(/_r(\d+)$/)?.[1]) || 0) + 1;
    const familyId = template.id.replace(/_r\d+$/, "");
    state.extractionTemplates[index] = {
      ...state.extractionTemplates[index],
      status: "archived",
      updatedAt: new Date().toISOString(),
    };
    const updated = {
      ...template,
      id: `${familyId}_r${revision}`,
      revisionId: `${familyId}_r${revision}`,
      status: "draft" as const,
      source: "user" as const,
      updatedAt: new Date().toISOString(),
    };
    state.extractionTemplates.push(updated);
    return updated;
  }

  async startReviewJob(
    state: SystematicReviewState,
    kind: ReviewJobKind,
    paperIds: number[],
  ): Promise<ReviewJob> {
    this.recoverStaleJobs(state);
    const requestedIds = Array.from(
      new Set(
        paperIds.filter((paperId) =>
          state.papers.some((paper) => paper.id === paperId),
        ),
      ),
    );
    const overlapsWithExtraction = (
      jobKind: ReviewJobKind,
      target: ReviewJobKind,
    ): boolean => {
      if (jobKind === target) return true;
      const extractionKinds: ReviewJobKind[] = [
        "extraction",
        "evidence_analysis",
        "gap_analysis",
      ];
      return (
        extractionKinds.includes(jobKind) && extractionKinds.includes(target)
      );
    };
    const activePaperIds = new Set(
      this.activeJobs(state)
        .filter((job) => overlapsWithExtraction(job.kind, kind))
        .flatMap((job) =>
          job.papers
            .filter((paper) => paper.stage !== "completed")
            .map((paper) => paper.paperId),
        ),
    );
    const ids = requestedIds.filter((paperId) => !activePaperIds.has(paperId));
    if (!ids.length) {
      throw new Error(
        requestedIds.length
          ? "The selected papers already have an active job of this type"
          : "No review papers were selected",
      );
    }
    const revision = getActiveProtocolRevision(state.protocol);
    const requiresTemplate =
      kind === "extraction" ||
      kind === "evidence_analysis" ||
      kind === "gap_analysis";
    const template = requiresTemplate
      ? this.ensureActiveExtractionTemplate(state)
      : undefined;
    if (requiresTemplate && !template) {
      throw new Error("Generate an extraction template before extracting data");
    }
    const now = new Date().toISOString();
    const job: ReviewJob = {
      id: `review_job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      kind,
      projectId: state.activeSpaceId,
      protocolRevisionId: revision.id,
      templateRevisionId: template?.revisionId,
      status: "queued",
      paperIds: ids,
      papers: ids.map((paperId) => ({
        paperId,
        stage: "queued",
        attempts: 0,
      })),
      concurrency: 2,
      createdAt: now,
      updatedAt: now,
    };
    state.reviewJobs.push(job);
    await this.save(state);
    Zotero.debug(
      `[seerai] Review job ${job.id}: queued ${kind} for ${ids.length} paper(s)`,
    );
    void this.runReviewJob(state, job.id).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      job.status = "failed";
      job.error = message;
      job.updatedAt = new Date().toISOString();
      Zotero.debug(
        `[seerai] Review job ${job.id}: failed to start: ${message}`,
      );
      try {
        await this.save(state);
      } catch (saveError) {
        Zotero.debug(
          `[seerai] Review job ${job.id}: failed to persist startup error: ${saveError}`,
        );
      }
    });
    return job;
  }

  async startEvidenceAnalysisJob(
    state: SystematicReviewState,
    paperIds?: number[],
  ): Promise<ReviewJob> {
    const { getIncludedPapers } = await import("./extractionHealth");
    const included = getIncludedPapers(state).map((paper) => paper.id);
    const target = (paperIds && paperIds.length ? paperIds : included).filter(
      (id) => included.includes(id),
    );
    return this.startReviewJob(state, "evidence_analysis", target);
  }

  async startGapAnalysisJob(
    state: SystematicReviewState,
    paperIds?: number[],
  ): Promise<ReviewJob> {
    const { getIncludedPapers } = await import("./extractionHealth");
    const included = getIncludedPapers(state).map((paper) => paper.id);
    const target = (paperIds && paperIds.length ? paperIds : included).filter(
      (id) => included.includes(id),
    );
    return this.startReviewJob(state, "gap_analysis", target);
  }

  async startFailedExtractionRetry(
    state: SystematicReviewState,
  ): Promise<ReviewJob | undefined> {
    const { getPapersWithFailedExtractions } =
      await import("./extractionHealth");
    const ids = getPapersWithFailedExtractions(state);
    if (!ids.length) return undefined;
    return this.startReviewJob(state, "extraction", ids);
  }

  private recoverStaleJobs(state: SystematicReviewState): void {
    const now = Date.now();
    state.reviewJobs.forEach((job) => {
      if (!["queued", "running"].includes(job.status)) return;
      const updated = Date.parse(job.updatedAt);
      if (Number.isFinite(updated) && now - updated < 15 * 60 * 1000) return;
      job.status = "interrupted";
      job.error = "Job stopped updating and was recovered as interrupted";
      job.updatedAt = new Date().toISOString();
      job.papers.forEach((paper) => {
        if (paper.stage !== "completed") {
          paper.stage = "failed";
          paper.error = job.error;
        }
      });
      Zotero.debug(`[seerai] Review job ${job.id}: recovered as interrupted`);
    });
  }

  async runReviewJob(
    state: SystematicReviewState,
    jobId: string,
  ): Promise<ReviewJob> {
    const job = state.reviewJobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`Review job not found: ${jobId}`);
    if (
      job.status === "cancelled" ||
      job.status === "completed" ||
      job.status === "completed_with_issues"
    ) {
      return job;
    }
    const template = this.getExtractionTemplateRevision(
      state,
      job.templateRevisionId,
    );
    if (
      (job.kind === "extraction" ||
        job.kind === "evidence_analysis" ||
        job.kind === "gap_analysis") &&
      !template
    ) {
      job.status = "failed";
      job.error = "The queued extraction template revision is unavailable";
      await this.save(state);
      return job;
    }
    const project = state.spaces.find(
      (candidate) => candidate.id === job.projectId,
    );
    if (!project) throw new Error("Review project is unavailable");
    job.status = "running";
    job.startedAt ||= new Date().toISOString();
    job.updatedAt = new Date().toISOString();
    await this.save(state);
    Zotero.debug(`[seerai] Review job ${job.id}: running`);
    const controllers = new Map<number, ReviewCancellationController>();
    this.jobControllers.set(job.id, controllers);
    let queueIndex = 0;
    const pending = job.papers.filter(
      (paper) => paper.stage === "queued" || paper.stage === "failed",
    );
    const worker = async () => {
      while (queueIndex < pending.length && job.status === "running") {
        const task = pending[queueIndex++];
        const item = Zotero.Items.get(task.paperId);
        const paper = state.papers.find(
          (candidate) => candidate.id === task.paperId,
        );
        if (!item || !paper) {
          task.stage = "failed";
          task.error = "Paper not found";
          continue;
        }
        const controller = new ReviewCancellationController();
        controllers.set(task.paperId, controller);
        task.startedAt = new Date().toISOString();
        task.error = undefined;
        Zotero.debug(
          `[seerai] Review job ${job.id}: paper ${task.paperId} started`,
        );
        for (let attempt = 1; attempt <= 3; attempt++) {
          task.attempts++;
          try {
            if (job.kind === "analysis") {
              const result = await analyzeReviewPaper(item, project, {
                signal: controller.signal,
                sourcePreference: paper.sourcePreference,
                onStage: async (stage) => {
                  task.stage = stage;
                  job.updatedAt = new Date().toISOString();
                  Zotero.debug(
                    `[seerai] Review job ${job.id}: paper ${task.paperId} ${stage}`,
                  );
                  await this.save(state);
                },
              });
              task.stage = "saving";
              paper.analysis = result.analysis;
              paper.recommendation = result.recommendation;
              paper.modelConfidence = result.recommendation?.confidence;
              paper.design = result.analysis.studyDesign;
              paper.pop = result.analysis.population;
              paper.methods = result.analysis.methods;
              paper.lim = result.analysis.limitations;
              paper.sample = result.analysis.sampleSize;
              task.evidenceCount = result.analysis.evidence.length;
              task.sourceSummary = result.analysis.sourceSummary;
            } else if (
              job.kind === "extraction" ||
              job.kind === "evidence_analysis" ||
              job.kind === "gap_analysis"
            ) {
              if (
                (job.kind === "evidence_analysis" ||
                  job.kind === "gap_analysis") &&
                !paper.analysis
              ) {
                const result = await analyzeReviewPaper(item, project, {
                  signal: controller.signal,
                  sourcePreference: paper.sourcePreference,
                  onStage: async (stage) => {
                    task.stage = stage;
                    job.updatedAt = new Date().toISOString();
                    await this.save(state);
                  },
                });
                paper.analysis = result.analysis;
                paper.recommendation = result.recommendation;
                paper.modelConfidence = result.recommendation?.confidence;
                paper.design = result.analysis.studyDesign;
                paper.pop = result.analysis.population;
                paper.methods = result.analysis.methods;
                paper.lim = result.analysis.limitations;
                paper.sample = result.analysis.sampleSize;
                task.evidenceCount = result.analysis.evidence.length;
              }
              task.stage = "reading_source";
              const extraction = await extractReviewPaper(
                item,
                template!,
                job.id,
                controller.signal,
                paper.sourcePreference,
              );
              task.stage = "validating";
              const proposals = extraction.rows;
              const existing = state.extractions[task.paperId] || [];
              const protectedRows = existing.filter(
                (row) => row.verificationStatus !== "proposed",
              );
              const otherProposals = existing.filter(
                (row) =>
                  row.verificationStatus === "proposed" &&
                  row.templateRevisionId !== template!.revisionId,
              );
              state.extractions[task.paperId] = [
                ...protectedRows,
                ...otherProposals,
                ...proposals,
              ];
              this.markAnalysisRunsStale(state, "Extraction proposals changed");
              task.stage = "saving";
              task.proposalCount = proposals.length;
              task.issueCount = extraction.issues.length;
              task.sourceSummary = extraction.sourceSummary;
              task.error = undefined;
            }
            task.stage = "completed";
            task.completedAt = new Date().toISOString();
            Zotero.debug(
              `[seerai] Review job ${job.id}: paper ${task.paperId} completed`,
            );
            break;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (controller.signal.aborted) {
              task.stage = "cancelled";
              task.error = "Cancelled";
              break;
            }
            const retryable = this.isRetryableReviewError(message);
            if (attempt === 3 || !retryable) {
              task.stage = "failed";
              task.error = message;
              Zotero.debug(
                `[seerai] Review job ${job.id}: paper ${task.paperId} failed: ${message}`,
              );
              break;
            } else {
              Zotero.debug(
                `[seerai] Review job ${job.id}: paper ${task.paperId} retry ${attempt}: ${message}`,
              );
              await new Promise((resolve) =>
                setTimeout(resolve, 1000 * 2 ** (attempt - 1)),
              );
            }
          }
        }
        controllers.delete(task.paperId);
        job.updatedAt = new Date().toISOString();
        await this.save(state);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(job.concurrency, pending.length) }, () =>
        worker(),
      ),
    );
    this.jobControllers.delete(job.id);
    if (
      job.status === "running" &&
      (job.kind === "evidence_analysis" || job.kind === "gap_analysis")
    ) {
      try {
        const pipelinePapers = job.papers.filter(
          (task) => task.stage === "completed",
        );
        const failedPapers = job.papers.filter(
          (task) => task.stage === "failed" || task.stage === "cancelled",
        );
        const partialWarnings = failedPapers.map(
          (task) =>
            `Paper ${task.paperId} was not included in automatic extraction because ${task.error || task.stage}.`,
        );
        for (const task of pipelinePapers) {
          task.stage = "synthesizing";
          job.updatedAt = new Date().toISOString();
        }
        await this.save(state);
        const autoVerified = this.autoVerifyValidProposals(
          state,
          pipelinePapers.map((task) => task.paperId),
        );
        if (autoVerified.verifiedRows) {
          Zotero.debug(
            `[seerai] Review job ${job.id}: auto-verified ${autoVerified.verifiedRows} valid proposal(s) across ${autoVerified.papers} paper(s) before synthesis`,
          );
          await this.save(state);
        }
        const compatibility = buildExtractionCompatibility(
          state.papers,
          state.extractions,
          template,
        ).report;
        const blockers = compatibility.issues.filter(
          (issue) => issue.severity === "blocker",
        );
        job.compatibilityIssueCount = blockers.length;
        const synthesis = this.runSynthesis(state, true);
        if (partialWarnings.length) {
          synthesis.warnings.push(...partialWarnings);
        }
        job.synthesisRunId = synthesis.id;
        Zotero.debug(
          `[seerai] Review job ${job.id}: synthesis ${synthesis.id} produced ${synthesis.domains.length} domain(s)`,
        );
        if (job.kind === "gap_analysis") {
          for (const task of pipelinePapers) {
            task.stage = "analyzing_gaps";
            job.updatedAt = new Date().toISOString();
          }
          await this.save(state);
          const gaps = this.generateGaps(state, synthesis.id, true);
          job.gapAnalysisRunId = gaps.id;
          Zotero.debug(
            `[seerai] Review job ${job.id}: gap analysis ${gaps.id} produced ${gaps.gaps.length} candidate(s)`,
          );
        }
        for (const task of pipelinePapers) {
          task.stage = "completed";
          task.completedAt = new Date().toISOString();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        job.status = "failed";
        job.error = `Pipeline stage failed: ${message}`;
        Zotero.debug(
          `[seerai] Review job ${job.id}: pipeline failed: ${message}`,
        );
      }
    }
    if (job.status === "running") {
      const failedCount = job.papers.filter(
        (paper) => paper.stage === "failed",
      ).length;
      const issueCount = job.papers.reduce(
        (sum, paper) => sum + (paper.issueCount || 0),
        0,
      );
      const producedDownstreamRun = !!(
        job.synthesisRunId || job.gapAnalysisRunId
      );
      job.status =
        failedCount === job.papers.length && !producedDownstreamRun
          ? "failed"
          : failedCount > 0 || issueCount > 0
            ? "completed_with_issues"
            : "completed";
      job.completedAt = new Date().toISOString();
    }
    job.updatedAt = new Date().toISOString();
    await this.save(state);
    Zotero.debug(`[seerai] Review job ${job.id}: ${job.status}`);
    return job;
  }

  private hasAnyIncompletePaper(job: ReviewJob): boolean {
    return job.papers.some(
      (paper) => paper.stage === "failed" || paper.stage === "cancelled",
    );
  }

  private isRetryableReviewError(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("network") ||
      normalized.includes("fetch") ||
      normalized.includes("429") ||
      normalized.includes("502") ||
      normalized.includes("503") ||
      normalized.includes("socket") ||
      normalized.includes("econnreset") ||
      normalized.includes("model returned no json")
    );
  }

  pauseReviewJob(state: SystematicReviewState, jobId: string): ReviewJob {
    const job = state.reviewJobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`Review job not found: ${jobId}`);
    if (job.status === "running" || job.status === "queued") {
      job.status = "paused";
      job.updatedAt = new Date().toISOString();
    }
    return job;
  }

  cancelReviewJob(state: SystematicReviewState, jobId: string): ReviewJob {
    const job = state.reviewJobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`Review job not found: ${jobId}`);
    job.status = "cancelled";
    job.updatedAt = new Date().toISOString();
    this.jobControllers
      .get(job.id)
      ?.forEach((controller) => controller.abort());
    job.papers.forEach((paper) => {
      if (!["completed", "failed"].includes(paper.stage)) {
        paper.stage = "cancelled";
      }
    });
    return job;
  }

  async retryReviewJob(
    state: SystematicReviewState,
    jobId: string,
  ): Promise<ReviewJob> {
    const job = state.reviewJobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error(`Review job not found: ${jobId}`);
    job.papers.forEach((paper) => {
      if (paper.stage === "failed" || paper.stage === "cancelled") {
        paper.stage = "queued";
        paper.error = undefined;
      }
    });
    job.status = "queued";
    job.error = undefined;
    job.completedAt = undefined;
    job.updatedAt = new Date().toISOString();
    await this.save(state);
    void this.runReviewJob(state, job.id).catch((error) => {
      Zotero.debug(`[seerai] Review job ${job.id}: retry failed: ${error}`);
    });
    return job;
  }

  getSynthesisReadiness(state: SystematicReviewState): {
    included: number;
    analyzed: number;
    processed: number;
    extracted: number;
    proposed: number;
    valid: number;
    verified: number;
    invalid: number;
    quarantined: number;
    complete: number;
    synthesisReady: number;
    compatibleDomains: number;
    blockedDomains: number;
    incompletePoolableRows: number;
    narrativeReadyDomains: number;
  } {
    const included = state.papers.filter(
      (paper) =>
        paper.status === "included" &&
        (paper.screeningStage === "final" || !paper.screeningStage),
    );
    const template = this.getExtractionTemplate(state);
    let extracted = 0;
    let processed = 0;
    let proposed = 0;
    let valid = 0;
    let verified = 0;
    let invalid = 0;
    let quarantined = 0;
    let complete = 0;
    let synthesisReady = 0;
    for (const paper of included) {
      const rows = state.extractions[paper.id] || [];
      const latestTask = state.reviewJobs
        .filter((job) =>
          ["extraction", "evidence_analysis", "gap_analysis"].includes(
            job.kind,
          ),
        )
        .slice()
        .reverse()
        .flatMap((job) => job.papers)
        .find((task) => task.paperId === paper.id);
      if (latestTask?.stage === "completed") processed++;
      if (rows.length) extracted++;
      proposed += rows.filter(
        (row) => row.verificationStatus === "proposed",
      ).length;
      valid += rows.filter(
        (row) =>
          row.verificationStatus !== "rejected" &&
          !row.issues?.some((issue) => issue.severity === "error") &&
          validateExtractionRow(row).valid,
      ).length;
      verified += rows.filter(
        (row) => row.verificationStatus === "verified",
      ).length;
      invalid += rows.filter(
        (row) =>
          row.verificationStatus !== "rejected" &&
          (!row.sourceQuote?.trim() || !validateExtractionRow(row).valid),
      ).length;
      quarantined += rows.filter((row) =>
        row.issues?.some((issue) => issue.severity === "error"),
      ).length;
      if (
        template &&
        template.outcomes
          .filter((outcome) => outcome.required)
          .every((outcome) =>
            rows.some(
              (row) =>
                row.outcomeId === outcome.id &&
                row.verificationStatus === "verified",
            ),
          )
      ) {
        complete++;
      }
      if (
        rows.some(
          (row) =>
            row.verificationStatus === "verified" &&
            validateExtractionRow(row).valid,
        )
      ) {
        synthesisReady++;
      }
    }
    const compatibility = buildExtractionCompatibility(
      included,
      state.extractions,
      template,
    ).report;
    return {
      included: included.length,
      analyzed: included.filter((paper) => !!paper.analysis).length,
      processed,
      extracted,
      proposed,
      valid,
      verified,
      invalid,
      quarantined,
      complete,
      synthesisReady,
      compatibleDomains: compatibility.compatibleDomains,
      blockedDomains: compatibility.blockedDomains,
      incompletePoolableRows: compatibility.incompletePoolableRows,
      narrativeReadyDomains: compatibility.narrativeReadyDomains,
    };
  }

  reviewExtraction(
    state: SystematicReviewState,
    paperId: number,
    extractionId: string,
    status: "verified" | "rejected",
  ): void {
    const row = (state.extractions[paperId] || []).find(
      (candidate) => candidate.id === extractionId,
    );
    if (!row) throw new Error(`Extraction not found: ${extractionId}`);
    if (status === "verified") {
      const blockingIssues = row.issues?.filter(
        (issue) => issue.severity === "error",
      );
      if (blockingIssues?.length) {
        throw new Error(
          blockingIssues.map((issue) => issue.message).join("; "),
        );
      }
      if (!row.sourceQuote?.trim()) {
        throw new Error("Verified extraction requires a supporting quote");
      }
      const validation = validateExtractionRow(row);
      if (!validation.valid) throw new Error(validation.errors.join("; "));
    }
    row.verificationStatus = status;
    row.revision = (row.revision || 1) + 1;
    row.updatedAt = new Date().toISOString();
    this.markAnalysisRunsStale(state, "Extraction review changed");
  }

  autoVerifyValidProposals(
    state: SystematicReviewState,
    paperIds?: number[],
  ): { verifiedRows: number; papers: number } {
    const targetIds = paperIds && paperIds.length ? paperIds : null;
    let verifiedRows = 0;
    let papersTouched = 0;
    const sourcePapers = targetIds
      ? state.papers.filter((paper) => targetIds.includes(paper.id))
      : state.papers.filter(
          (paper) =>
            paper.status === "included" &&
            (paper.screeningStage === "final" || !paper.screeningStage),
        );
    const now = new Date().toISOString();
    for (const paper of sourcePapers) {
      const rows = state.extractions[paper.id];
      if (!rows || !rows.length) continue;
      let touched = false;
      for (const row of rows) {
        if (row.verificationStatus !== "proposed") continue;
        const blocking = row.issues?.find(
          (issue) => issue.severity === "error",
        );
        if (blocking) continue;
        if (!row.sourceQuote?.trim()) continue;
        const validation = validateExtractionRow(row);
        if (!validation.valid) continue;
        row.verificationStatus = "verified";
        row.revision = (row.revision || 1) + 1;
        row.updatedAt = now;
        verifiedRows++;
        touched = true;
      }
      if (touched) {
        papersTouched++;
      }
    }
    if (verifiedRows > 0) {
      this.markAnalysisRunsStale(
        state,
        "Proposals auto-verified for synthesis",
      );
    }
    return { verifiedRows, papers: papersTouched };
  }

  private markAnalysisRunsStale(
    state: SystematicReviewState,
    reason: string,
  ): void {
    const now = new Date().toISOString();
    const synthesis = this.getSynthesis(state);
    if (synthesis && synthesis.status !== "stale") {
      synthesis.status = "stale";
      synthesis.staleReasons = [reason];
      synthesis.updatedAt = now;
    }
    const gaps = this.getGapAnalysis(state);
    if (gaps && gaps.status !== "stale") {
      gaps.status = "stale";
      gaps.updatedAt = now;
    }
  }

  getSynthesis(state: SystematicReviewState): SynthesisRun | undefined {
    return (
      state.synthesisRuns?.find(
        (run) => run.id === state.activeSynthesisRunId,
      ) || state.synthesisRuns?.[state.synthesisRuns.length - 1]
    );
  }

  getGapAnalysis(state: SystematicReviewState): GapAnalysisRun | undefined {
    return (
      state.gapAnalysisRuns?.find(
        (run) => run.id === state.activeGapAnalysisRunId,
      ) || state.gapAnalysisRuns?.[state.gapAnalysisRuns.length - 1]
    );
  }

  runSynthesis(state: SystematicReviewState, force = false): SynthesisRun {
    state.synthesisRuns ||= [];
    state.gapAnalysisRuns ||= [];
    const fingerprint = computeSynthesisFingerprint(state);
    const active = this.getSynthesis(state);
    if (!force && active?.inputFingerprint === fingerprint) return active;
    if (active && active.status !== "stale") {
      active.status = "stale";
      active.staleReasons = ["Review inputs changed"];
      active.updatedAt = new Date().toISOString();
    }
    const run = buildSynthesisRun(state);
    state.synthesisRuns.push(run);
    state.activeSynthesisRunId = run.id;
    state.evidenceDomains = run.domains.map((domain) => ({
      id: domain.id,
      outcome: domain.outcome,
      strength:
        domain.grade.certainty === "not_applicable"
          ? "verylow"
          : domain.grade.certainty,
      direction: domain.direction === "unclear" ? "none" : domain.direction,
      studyCount: domain.paperIds.length,
      summary: domain.summary,
      contributing: domain.paperIds,
    }));
    return run;
  }

  generateGaps(
    state: SystematicReviewState,
    synthesisRunId?: string,
    force = false,
  ): GapAnalysisRun {
    state.synthesisRuns ||= [];
    state.gapAnalysisRuns ||= [];
    state.analysisSettings ||= {
      automation: "manual",
      sparseStudyThreshold: 2,
    };
    const synthesis =
      state.synthesisRuns.find((run) => run.id === synthesisRunId) ||
      this.runSynthesis(state);
    const active = this.getGapAnalysis(state);
    if (
      !force &&
      active?.synthesisRunId === synthesis.id &&
      active.status !== "stale"
    ) {
      return active;
    }
    if (active && active.status !== "stale") {
      active.status = "stale";
      active.updatedAt = new Date().toISOString();
    }
    const run = buildGapAnalysisRun(state, synthesis);
    state.gapAnalysisRuns.push(run);
    state.activeGapAnalysisRunId = run.id;
    state.gaps = run.gaps.map((gap) => ({
      id: gap.id,
      title: gap.title,
      severity: gap.severity,
      picosTags: gap.dimensionTags,
      reasonCode:
        gap.reasonCode === "insufficient"
          ? "A"
          : gap.reasonCode === "biased"
            ? "B"
            : gap.reasonCode === "inconsistent"
              ? "C"
              : "D",
      description: gap.description,
      implication: gap.implication,
    }));
    return run;
  }

  refreshDerivedDrafts(state: SystematicReviewState): {
    synthesis: SynthesisRun;
    gaps: GapAnalysisRun;
  } {
    const synthesis = this.runSynthesis(state);
    const gaps = this.generateGaps(state, synthesis.id);
    return { synthesis, gaps };
  }

  updateGap(
    state: SystematicReviewState,
    gapId: string,
    updates: Partial<
      Pick<
        GapCandidate,
        | "title"
        | "severity"
        | "description"
        | "implication"
        | "status"
        | "reviewerNote"
      >
    >,
  ): GapCandidate {
    const run = this.getGapAnalysis(state);
    const gap = run?.gaps.find((candidate) => candidate.id === gapId);
    if (!gap) throw new Error(`Gap not found: ${gapId}`);
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        (gap as unknown as Record<string, unknown>)[key] = value;
      }
    }
    gap.updatedAt = new Date().toISOString();
    return gap;
  }

  confirmSynthesisDomain(
    state: SystematicReviewState,
    domainId: string,
    selectedModel: "common_effect" | "random_effects" | "narrative",
  ): SynthesisRun {
    const run = this.getSynthesis(state);
    const domain = run?.domains.find((candidate) => candidate.id === domainId);
    if (!run || !domain) {
      throw new Error(`Synthesis domain not found: ${domainId}`);
    }
    if (
      selectedModel === "common_effect" &&
      domain.commonEffect === undefined
    ) {
      throw new Error("Common-effect synthesis is unavailable for this domain");
    }
    if (
      selectedModel === "random_effects" &&
      domain.randomEffects === undefined
    ) {
      throw new Error(
        "Random-effects synthesis is unavailable for this domain",
      );
    }
    domain.selectedModel = selectedModel;
    domain.methodConfirmed = true;
    domain.grade.confirmed = true;
    domain.narrativeConfirmed = true;
    run.status = run.domains.every(
      (candidate) =>
        candidate.methodConfirmed &&
        candidate.grade.confirmed &&
        candidate.narrativeConfirmed,
    )
      ? "confirmed"
      : "draft";
    run.updatedAt = new Date().toISOString();
    return run;
  }

  switchProject(
    state: SystematicReviewState,
    projectId: string,
  ): SystematicReviewState {
    if (projectId !== state.activeSpaceId) this.requireIdleProject(state);
    return this.store.switchProject(state, projectId);
  }

  createProject(
    state: SystematicReviewState,
    name: string,
  ): SystematicReviewSpace {
    this.requireIdleProject(state);
    return this.store.createProject(state, name);
  }

  getProtocol(state: SystematicReviewState): ReviewProtocol {
    return state.protocol;
  }

  applyProtocolRevision(
    state: SystematicReviewState,
    revision: ProtocolRevision,
  ): ProtocolRevision {
    const validationWarnings = validateProtocolRevision(revision);
    const normalized = {
      ...revision,
      warnings: Array.from(
        new Set([...revision.warnings, ...validationWarnings]),
      ),
    };
    state.protocol.revisions.push(normalized);
    state.protocol.activeRevisionId = normalized.id;
    this.syncProtocolCompatibility(state);
    return normalized;
  }

  createProtocolRevision(
    state: SystematicReviewState,
    input: Omit<ProtocolRevision, "id" | "createdAt" | "warnings">,
  ): ProtocolRevision {
    const revision = createProtocolRevision({
      ...input,
      warnings: [],
    });
    return this.applyProtocolRevision(state, revision);
  }

  rollbackProtocol(
    state: SystematicReviewState,
    revisionId: string,
  ): ProtocolRevision {
    const revision = state.protocol.revisions.find(
      (candidate) => candidate.id === revisionId,
    );
    if (!revision) {
      throw new Error(`Protocol revision not found: ${revisionId}`);
    }
    state.protocol.activeRevisionId = revision.id;
    this.syncProtocolCompatibility(state);
    return revision;
  }

  validateProtocol(state: SystematicReviewState): string[] {
    return validateProtocolRevision(getActiveProtocolRevision(state.protocol));
  }

  private syncProtocolCompatibility(state: SystematicReviewState): void {
    const project = state.spaces.find(
      (candidate) => candidate.id === state.activeSpaceId,
    );
    if (!project) return;
    const data = project.data || ({} as SystematicReviewSpace["data"]);
    if (!data) return;
    data.protocol = state.protocol;
    applyProtocolCompatibility(data);
    state.framework = data.framework;
    state.frameworkValues = data.frameworkValues;
    state.incKeywords = data.incKeywords;
    state.excKeywords = data.excKeywords;
    project.protocol = state.protocol;
    project.framework = data.framework;
    project.frameworkValues = data.frameworkValues;
    project.incKeywords = data.incKeywords;
    project.excKeywords = data.excKeywords;
    project.picoLabelMap = data.picoLabelMap;
  }

  renameProject(
    state: SystematicReviewState,
    projectId: string,
    name: string,
  ): SystematicReviewSpace {
    const project = state.spaces.find(
      (candidate) => candidate.id === projectId,
    );
    if (!project) throw new Error(`Review project not found: ${projectId}`);
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Project name is required");
    project.name = trimmed;
    project.updatedAt = new Date().toISOString();
    return project;
  }

  deleteProject(
    state: SystematicReviewState,
    projectId: string,
  ): SystematicReviewState {
    if (state.spaces.length <= 1) {
      throw new Error("At least one review project must remain");
    }
    if (state.activeSpaceId === projectId) this.requireIdleProject(state);
    const index = state.spaces.findIndex((project) => project.id === projectId);
    if (index < 0) throw new Error(`Review project not found: ${projectId}`);
    state.spaces.splice(index, 1);
    if (state.activeSpaceId === projectId) {
      this.store.switchProject(state, state.spaces[0].id);
    }
    return state;
  }

  addPapers(
    state: SystematicReviewState,
    paperIds: number[],
    sourceLabel?: string,
  ): SystematicReviewPaper[] {
    const existing = new Map(state.papers.map((paper) => [paper.id, paper]));
    for (const id of paperIds) {
      const paper = existing.get(id);
      if (paper) {
        paper.manualAdded = true;
        if (sourceLabel && !paper.sourceLabel) {
          paper.sourceLabel = sourceLabel;
        }
      }
    }
    const trimmedLabel = sourceLabel?.trim() || undefined;
    const added = Array.from(new Set(paperIds))
      .filter((id) => Number.isInteger(id) && id > 0 && !existing.has(id))
      .map<SystematicReviewPaper>((id) => ({
        id,
        status: "undecided",
        aiStatus: "manual",
        confidence: 0,
        manualAdded: true,
        sourceLabel: trimmedLabel,
      }));
    state.papers.push(...added);
    return added;
  }

  setManualSourceType(
    state: SystematicReviewState,
    label: string,
    sourceType: "Database" | "Register" | "Other source" | undefined,
  ): number {
    let updated = 0;
    for (const paper of state.papers) {
      if (paper.sourceLabel !== label) continue;
      if (paper.folderId) continue;
      paper.sourceType = sourceType;
      updated++;
    }
    return updated;
  }

  removePapers(state: SystematicReviewState, paperIds: number[]): number[] {
    const remove = new Set(paperIds);
    const removed = state.papers
      .filter((paper) => remove.has(paper.id))
      .map((paper) => paper.id);
    state.papers = state.papers.filter((paper) => !remove.has(paper.id));
    state.sourceOccurrences = state.sourceOccurrences.filter(
      (occurrence) => !remove.has(occurrence.paperId),
    );
    state.scrSelected = state.scrSelected.filter((id) => !remove.has(id));
    for (const id of removed) {
      delete state.extractions[id];
      delete state.robData[id];
      delete state.paperLabels[id];
    }
    state.evidenceDomains = state.evidenceDomains.map((domain) => ({
      ...domain,
      contributing: domain.contributing.filter((id) => !remove.has(id)),
    }));
    return removed;
  }

  syncSources(
    state: SystematicReviewState,
    inputs: SourceSyncInput[],
  ): SourceSyncResult {
    const now = new Date().toISOString();
    const previousOccurrences = state.sourceOccurrences;
    const previousKeys = new Map(
      previousOccurrences.map((occurrence) => [
        `${occurrence.paperId}:${occurrence.sourceId}:${occurrence.collectionId}`,
        occurrence,
      ]),
    );
    const desiredKeys = new Set<string>();
    const nextOccurrences: SourceOccurrence[] = [];
    const warnings: string[] = [];

    state.folders = inputs.map(({ source, records }) => {
      if (!source.available) {
        warnings.push(
          `Folder unavailable: ${source.collectionPath || source.name}`,
        );
        for (const occurrence of previousOccurrences.filter(
          (candidate) => candidate.sourceId === source.id,
        )) {
          const key = `${occurrence.paperId}:${occurrence.sourceId}:${occurrence.collectionId}`;
          desiredKeys.add(key);
          nextOccurrences.push(occurrence);
        }
        return source;
      }
      const uniquePaperIds = new Set(records.map((record) => record.paperId));
      for (const record of records) {
        const key = `${record.paperId}:${source.id}:${record.collectionId}`;
        if (desiredKeys.has(key)) continue;
        desiredKeys.add(key);
        const previous = previousKeys.get(key);
        nextOccurrences.push({
          id:
            previous?.id ||
            `source_${source.id}_${record.paperId}_${record.collectionId}`,
          paperId: record.paperId,
          sourceId: source.id,
          collectionId: record.collectionId,
          firstSeenAt: previous?.firstSeenAt || now,
          lastSeenAt: now,
        });
      }
      return {
        ...source,
        itemCount: uniquePaperIds.size,
        lastSyncedAt: now,
      };
    });

    const paperById = new Map(state.papers.map((paper) => [paper.id, paper]));
    const addedPapers: number[] = [];
    for (const occurrence of nextOccurrences) {
      if (paperById.has(occurrence.paperId)) continue;
      const paper: SystematicReviewPaper = {
        id: occurrence.paperId,
        status: "undecided",
        aiStatus: "manual",
        confidence: 0,
        manualAdded: false,
      };
      state.papers.push(paper);
      paperById.set(paper.id, paper);
      addedPapers.push(paper.id);
    }

    state.sourceOccurrences = nextOccurrences;
    state.selectedFolderIds = state.folders.map((folder) => folder.id);
    const sourcedPaperIds = new Set(
      nextOccurrences.map((occurrence) => occurrence.paperId),
    );
    const removedPapers = state.papers
      .filter((paper) => !paper.manualAdded && !sourcedPaperIds.has(paper.id))
      .map((paper) => paper.id);
    if (removedPapers.length > 0) {
      this.removePapers(state, removedPapers);
    }

    const sourceIdsByPaper = new Map<number, Set<string>>();
    for (const occurrence of state.sourceOccurrences) {
      if (!sourceIdsByPaper.has(occurrence.paperId)) {
        sourceIdsByPaper.set(occurrence.paperId, new Set());
      }
      sourceIdsByPaper.get(occurrence.paperId)!.add(occurrence.sourceId);
    }
    const overlappingPapers = Array.from(sourceIdsByPaper.entries())
      .filter(([, sourceIds]) => sourceIds.size > 1)
      .map(([paperId]) => paperId);

    return {
      addedPapers,
      removedPapers,
      addedOccurrences: Array.from(desiredKeys).filter(
        (key) => !previousKeys.has(key),
      ).length,
      removedOccurrences: Array.from(previousKeys.keys()).filter(
        (key) => !desiredKeys.has(key),
      ).length,
      retainedOccurrences: Array.from(desiredKeys).filter((key) =>
        previousKeys.has(key),
      ).length,
      overlappingPapers,
      warnings,
    };
  }

  removePapersFromAllProjects(
    state: SystematicReviewState,
    paperIds: number[],
  ): number[] {
    const remove = new Set(paperIds);
    const removed = new Set<number>();
    this.removePapers(state, paperIds).forEach((id) => removed.add(id));
    for (const project of state.spaces) {
      if (project.id === state.activeSpaceId || !project.data) continue;
      const data = project.data;
      data.papers = data.papers.filter((paper) => {
        if (!remove.has(paper.id)) return true;
        removed.add(paper.id);
        return false;
      });
      data.scrSelected = data.scrSelected.filter((id) => !remove.has(id));
      for (const id of paperIds) {
        delete data.extractions[id];
        delete data.robData[id];
        delete data.paperLabels[id];
      }
      data.sourceOccurrences = data.sourceOccurrences.filter(
        (occurrence) => !remove.has(occurrence.paperId),
      );
      data.evidenceDomains = data.evidenceDomains.map((domain) => ({
        ...domain,
        contributing: domain.contributing.filter((id) => !remove.has(id)),
      }));
    }
    return Array.from(removed);
  }

  removeCollectionsFromAllProjects(
    state: SystematicReviewState,
    collectionIds: number[],
  ): void {
    const remove = new Set(collectionIds);
    const markUnavailable = (folders: SystematicReviewState["folders"]) =>
      folders.map((folder) =>
        folder.zoteroCollectionId !== undefined &&
        remove.has(folder.zoteroCollectionId)
          ? { ...folder, available: false }
          : folder,
      );
    state.folders = markUnavailable(state.folders);
    for (const project of state.spaces) {
      if (!project.data) continue;
      project.data.folders = markUnavailable(project.data.folders);
    }
  }

  setDecision(
    state: SystematicReviewState,
    paperId: number,
    decision: ScreeningDecision,
    reason?: string,
    stage: ScreeningStage = "title_abstract",
  ): SystematicReviewPaper {
    const paper = state.papers.find((candidate) => candidate.id === paperId);
    if (!paper) {
      throw new Error(`Paper is not in the active review project: ${paperId}`);
    }
    paper.status = decision;
    paper.screeningStage = stage;
    paper.aiStatus = "manual";
    paper.exclReason = decision === "excluded" ? reason : undefined;
    if (!paper.screeningEvents) paper.screeningEvents = [];
    paper.screeningEvents.push({
      id: `screen_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      stage,
      decision,
      actor: "user",
      reason,
      confirmed: true,
      createdAt: new Date().toISOString(),
    });
    return paper;
  }

  acceptRecommendation(
    state: SystematicReviewState,
    paperId: number,
  ): SystematicReviewPaper {
    const paper = state.papers.find((candidate) => candidate.id === paperId);
    if (!paper?.recommendation) {
      throw new Error(`Paper has no pending recommendation: ${paperId}`);
    }
    const recommendation = paper.recommendation;
    const updated = this.setDecision(
      state,
      paperId,
      recommendation.decision,
      undefined,
      "final",
    );
    const events = updated.screeningEvents;
    const event = events?.[events.length - 1];
    if (event) {
      event.confidence = recommendation.confidence;
    }
    if (recommendation.source === "model") {
      updated.modelConfidence = recommendation.confidence;
    } else {
      updated.keywordConfidence = recommendation.confidence;
    }
    updated.recommendation = undefined;
    return updated;
  }
}

let service: SystematicReviewService | null = null;

export function getSRService(): SystematicReviewService {
  if (!service) service = new SystematicReviewService();
  return service;
}
