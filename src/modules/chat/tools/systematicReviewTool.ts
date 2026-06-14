import { getPrismaSnapshot } from "../../systematicReview/scientific";
import { getSRService } from "../../systematicReview/service";
import { SystematicReviewParams, ToolResult } from "./toolTypes";
import {
  dimensionsForFramework,
  getActiveProtocolRevision,
  newEligibilityRule,
} from "../../systematicReview/protocol";
import {
  collectSourceRecords,
  sourceConfigFromCollectionId,
} from "../../systematicReview/sources";
import { validateExtractionRow } from "../../systematicReview/scientific";

export async function executeSystematicReview(
  params: SystematicReviewParams,
): Promise<ToolResult> {
  const service = getSRService();
  const state = await service.load();
  const selectProject = (projectId?: string) => {
    if (projectId && projectId !== state.activeSpaceId) {
      service.switchProject(state, projectId);
    }
  };
  switch (params.action) {
    case "list_projects":
      return {
        success: true,
        data: state.spaces.map((project) => ({
          id: project.id,
          name: project.name,
          active: project.id === state.activeSpaceId,
          updated_at: project.updatedAt,
          record_count: project.data?.papers.length || 0,
        })),
        summary: `Found ${state.spaces.length} systematic review project(s)`,
      };
    case "get_project":
      selectProject(params.project_id);
      return {
        success: true,
        data: {
          id: state.activeSpaceId,
          name: state.spaces.find(
            (project) => project.id === state.activeSpaceId,
          )?.name,
          framework: state.framework,
          criteria: state.frameworkValues,
          include_keywords: state.incKeywords,
          exclude_keywords: state.excKeywords,
          record_count: state.papers.length,
        },
      };
    case "get_records":
      selectProject(params.project_id);
      return {
        success: true,
        data: state.papers,
        summary: `Returned ${state.papers.length} review record(s)`,
      };
    case "get_synthesis": {
      selectProject(params.project_id);
      const run = params.run_id
        ? state.synthesisRuns.find(
            (candidate) => candidate.id === params.run_id,
          )
        : service.getSynthesis(state);
      return {
        success: true,
        data: run || null,
        summary: run
          ? `Returned synthesis run ${run.id} with ${run.domains.length} domain(s)`
          : "No synthesis run is available",
      };
    }
    case "get_gaps": {
      selectProject(params.project_id);
      const run = params.run_id
        ? state.gapAnalysisRuns.find(
            (candidate) => candidate.id === params.run_id,
          )
        : service.getGapAnalysis(state);
      return {
        success: true,
        data: run || null,
        summary: run
          ? `Returned gap-analysis run ${run.id} with ${run.gaps.length} candidate(s)`
          : "No gap-analysis run is available",
      };
    }
    case "get_prisma":
      selectProject(params.project_id);
      return {
        success: true,
        data: getPrismaSnapshot(state),
        summary: "Returned recorded PRISMA counts and missing-stage warnings",
      };
    case "get_sources":
      selectProject(params.project_id);
      return {
        success: true,
        data: {
          sources: state.folders,
          occurrences: state.sourceOccurrences,
        },
        summary: `Returned ${state.folders.length} configured review source(s)`,
      };
    case "sync_sources": {
      selectProject(params.project_id);
      const existingByCollection = new Map(
        state.folders
          .filter((source) => source.zoteroCollectionId)
          .map((source) => [source.zoteroCollectionId!, source]),
      );
      const inputs = await Promise.all(
        params.sources.map(async (source) => {
          const config = await sourceConfigFromCollectionId(
            source.collection_id,
            {
              type: source.type,
              srcLabel: source.label,
              includeSubfolders: source.include_subfolders ?? true,
            },
            existingByCollection.get(source.collection_id),
          );
          return {
            source: config,
            records: await collectSourceRecords(config),
          };
        }),
      );
      const result = service.syncSources(state, inputs);
      await service.save(state);
      return {
        success: true,
        data: result,
        summary: `Synchronized ${inputs.length} source folder(s): ${result.addedPapers.length} paper(s) added, ${result.removedPapers.length} removed`,
      };
    }
    case "get_protocol":
      selectProject(params.project_id);
      return {
        success: true,
        data: {
          active_revision_id: state.protocol.activeRevisionId,
          active_revision: getActiveProtocolRevision(state.protocol),
          revisions: state.protocol.revisions.map((revision) => ({
            id: revision.id,
            created_at: revision.createdAt,
            actor: revision.actor,
            model: revision.model,
            framework: revision.framework,
          })),
        },
        summary: `Returned active protocol and ${state.protocol.revisions.length} revision(s)`,
      };
    case "validate_protocol":
      selectProject(params.project_id);
      return {
        success: true,
        data: {
          revision_id: state.protocol.activeRevisionId,
          warnings: service.validateProtocol(state),
        },
        summary: "Validated the active review protocol",
      };
    case "rollback_protocol": {
      selectProject(params.project_id);
      const revision = service.rollbackProtocol(state, params.revision_id);
      await service.save(state);
      return {
        success: true,
        data: revision,
        summary: `Restored protocol revision ${revision.id}`,
      };
    }
    case "update_protocol": {
      selectProject(params.project_id);
      const active = getActiveProtocolRevision(state.protocol);
      const framework = params.framework || active.framework;
      const suppliedDimensions = params.dimensions?.map((dimension) => ({
        key: dimension.key,
        label: dimension.label,
        description: dimension.description || "",
        value: dimension.value,
        keywordAids: dimension.keyword_aids || [],
        evidenceLabels: dimension.evidence_labels || [],
      }));
      const dimensions = suppliedDimensions
        ? suppliedDimensions
        : framework === active.framework
          ? active.dimensions
          : dimensionsForFramework(framework, active.dimensions);
      const rules =
        params.inclusion_rules || params.exclusion_rules
          ? [
              ...(params.inclusion_rules || [])
                .filter(Boolean)
                .map((text) => newEligibilityRule("include", text)),
              ...(params.exclusion_rules || [])
                .filter(Boolean)
                .map((text) => newEligibilityRule("exclude", text)),
            ]
          : active.eligibilityRules;
      const revision = service.createProtocolRevision(state, {
        actor: "user",
        researchQuestion: params.research_question ?? active.researchQuestion,
        framework,
        frameworkReason: active.frameworkReason,
        dimensions,
        eligibilityRules: rules,
        includeKeywordAids:
          params.include_keyword_aids ?? active.includeKeywordAids,
        excludeKeywordAids:
          params.exclude_keyword_aids ?? active.excludeKeywordAids,
        provenance: [],
      });
      await service.save(state);
      return {
        success: true,
        data: revision,
        summary: `Created and activated protocol revision ${revision.id}`,
      };
    }
    case "create_project": {
      const project = service.createProject(state, params.name);
      await service.save(state);
      return {
        success: true,
        data: { id: project.id, name: project.name },
        summary: `Created systematic review project "${project.name}"`,
      };
    }
    case "add_papers": {
      selectProject(params.project_id);
      const added = service.addPapers(state, params.paper_ids);
      await service.save(state);
      return {
        success: true,
        data: {
          project_id: state.activeSpaceId,
          added_ids: added.map((p) => p.id),
        },
        summary: `Added ${added.length} paper(s)`,
      };
    }
    case "remove_papers": {
      selectProject(params.project_id);
      const removed = service.removePapers(state, params.paper_ids);
      await service.save(state);
      return {
        success: true,
        data: { project_id: state.activeSpaceId, removed_ids: removed },
        summary: `Removed ${removed.length} paper(s)`,
      };
    }
    case "get_extraction_template":
      selectProject(params.project_id);
      return {
        success: true,
        data: service.getExtractionTemplate(state) || null,
      };
    case "propose_extraction_template": {
      selectProject(params.project_id);
      const template = await service.proposeTemplate(
        state,
        params.instructions,
      );
      return {
        success: true,
        data: template,
        summary: `Proposed extraction template ${template.id}`,
      };
    }
    case "activate_extraction_template": {
      selectProject(params.project_id);
      const template = service.activateTemplate(state, params.template_id);
      await service.save(state);
      return {
        success: true,
        data: template,
        summary: `Activated extraction template ${template.id}`,
      };
    }
    case "update_extraction_template": {
      selectProject(params.project_id);
      const existing = state.extractionTemplates.find(
        (candidate) => candidate.id === params.template_id,
      );
      if (!existing) {
        throw new Error(`Extraction template not found: ${params.template_id}`);
      }
      const updated = service.updateTemplate(state, {
        ...existing,
        name: params.name || existing.name,
        instructions:
          params.instructions === undefined
            ? existing.instructions
            : params.instructions,
        outcomes:
          params.outcomes?.map((outcome, index) => ({
            id: outcome.id || `outcome_${Date.now()}_${index + 1}`,
            name: outcome.name,
            aliases: outcome.aliases || [],
            description: outcome.description || "",
            measures: outcome.measures,
            timepoints: outcome.timepoints || [],
            unit: outcome.unit,
            direction: outcome.direction,
            required: outcome.required ?? true,
          })) || existing.outcomes,
      });
      await service.save(state);
      return {
        success: true,
        data: updated,
        summary: `Updated extraction template ${updated.id}`,
      };
    }
    case "start_analysis_job":
    case "start_extraction_job": {
      selectProject(params.project_id);
      const job = await service.startReviewJob(
        state,
        params.action === "start_analysis_job" ? "analysis" : "extraction",
        params.paper_ids,
      );
      return {
        success: true,
        data: job,
        summary: `Started ${job.kind} job ${job.id}`,
      };
    }
    case "get_review_job": {
      selectProject(params.project_id);
      const job = state.reviewJobs.find(
        (candidate) => candidate.id === params.job_id,
      );
      return { success: true, data: job || null };
    }
    case "pause_review_job":
    case "cancel_review_job":
    case "retry_review_job": {
      selectProject(params.project_id);
      let job;
      if (params.action === "retry_review_job") {
        job = await service.retryReviewJob(state, params.job_id);
      } else {
        job =
          params.action === "pause_review_job"
            ? service.pauseReviewJob(state, params.job_id)
            : service.cancelReviewJob(state, params.job_id);
        await service.save(state);
      }
      return {
        success: true,
        data: job,
        summary: `${params.action.replaceAll("_", " ")}: ${job.id}`,
      };
    }
    case "get_extractions": {
      selectProject(params.project_id);
      const paperIds = params.paper_id
        ? [params.paper_id]
        : state.papers.map((paper) => paper.id);
      const rows = paperIds.flatMap((paperId) =>
        (state.extractions[paperId] || [])
          .filter(
            (row) =>
              !params.extraction_status ||
              row.verificationStatus === params.extraction_status,
          )
          .map((row) => ({ paper_id: paperId, ...row })),
      );
      return {
        success: true,
        data: rows,
        summary: `Returned ${rows.length} extraction row(s)`,
      };
    }
    case "review_extractions": {
      selectProject(params.project_id);
      params.extraction_ids.forEach((extractionId) =>
        service.reviewExtraction(
          state,
          params.paper_id,
          extractionId,
          params.verification_status,
        ),
      );
      await service.save(state);
      return {
        success: true,
        data: {
          paper_id: params.paper_id,
          extraction_ids: params.extraction_ids,
          verification_status: params.verification_status,
        },
        summary: `${params.verification_status} ${params.extraction_ids.length} extraction row(s)`,
      };
    }
    case "get_synthesis_readiness":
      selectProject(params.project_id);
      return {
        success: true,
        data: service.getSynthesisReadiness(state),
      };
    case "analyze_papers": {
      selectProject(params.project_id);
      const results = await service.analyzePapers(state, params.paper_ids);
      await service.save(state);
      return {
        success: true,
        data: results,
        summary: `Analyzed ${results.filter((result) => result.success).length} of ${results.length} paper(s)`,
      };
    }
    case "save_extraction": {
      selectProject(params.project_id);
      const paper = state.papers.find(
        (candidate) => candidate.id === params.paper_id,
      );
      if (!paper) {
        throw new Error(
          `Paper is not in the active review project: ${params.paper_id}`,
        );
      }
      const input = params.extraction;
      if (
        input.verification_status === "verified" &&
        !input.source_quote?.trim()
      ) {
        throw new Error(
          "Verified extraction requires a supporting source_quote",
        );
      }
      const row = {
        id:
          input.id ||
          `ext_${params.paper_id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        outcome: input.outcome,
        effectType: input.effect_type,
        effectSize: input.effect_size,
        ciLow: input.ci_low,
        ciHigh: input.ci_high,
        n: input.n,
        events: input.events,
        timepoint: input.timepoint,
        unit: input.unit,
        direction: input.direction,
        sourceAttachmentId: input.source_attachment_id,
        sourcePage: input.source_page,
        sourceQuote: input.source_quote,
        verificationStatus: input.verification_status || "proposed",
        revision: 1,
        updatedAt: new Date().toISOString(),
      };
      const validation = validateExtractionRow(row);
      if (!validation.valid) throw new Error(validation.errors.join("; "));
      const rows = state.extractions[params.paper_id] || [];
      const existing = rows.findIndex((candidate) => candidate.id === row.id);
      if (existing >= 0) {
        row.revision = (rows[existing].revision || 1) + 1;
        rows[existing] = row;
      } else {
        rows.push(row);
      }
      state.extractions[params.paper_id] = rows;
      await service.save(state);
      return {
        success: true,
        data: row,
        summary: `Saved ${row.verificationStatus} extraction ${row.id}`,
      };
    }
    case "run_synthesis": {
      selectProject(params.project_id);
      const run = service.runSynthesis(state, params.force);
      await service.save(state);
      return {
        success: true,
        data: run,
        summary: `Created synthesis run ${run.id} with ${run.domains.length} domain(s)`,
      };
    }
    case "confirm_synthesis": {
      selectProject(params.project_id);
      const run = service.confirmSynthesisDomain(
        state,
        params.domain_id,
        params.selected_model,
      );
      await service.save(state);
      return {
        success: true,
        data: run,
        summary: `Confirmed synthesis domain ${params.domain_id} using ${params.selected_model}`,
      };
    }
    case "generate_gaps": {
      selectProject(params.project_id);
      const run = service.generateGaps(
        state,
        params.synthesis_run_id,
        params.force,
      );
      await service.save(state);
      return {
        success: true,
        data: run,
        summary: `Created gap-analysis run ${run.id} with ${run.gaps.length} candidate(s)`,
      };
    }
    case "update_gap": {
      selectProject(params.project_id);
      const gap = service.updateGap(state, params.gap_id, {
        title: params.title,
        severity: params.severity,
        description: params.description,
        implication: params.implication,
        status: params.status,
        reviewerNote: params.reviewer_note,
      });
      await service.save(state);
      return {
        success: true,
        data: gap,
        summary: `Updated gap ${gap.id}`,
      };
    }
    case "screen": {
      selectProject(params.project_id);
      const updated = params.paper_ids.map((id) =>
        service.setDecision(
          state,
          id,
          params.decision,
          params.reason,
          params.stage,
        ),
      );
      await service.save(state);
      return {
        success: true,
        data: {
          project_id: state.activeSpaceId,
          updated_ids: updated.map((paper) => paper.id),
          decision: params.decision,
        },
        summary: `Screened ${updated.length} paper(s) as ${params.decision}`,
      };
    }
  }
}
