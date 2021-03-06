import * as core from "@actions/core";
import * as toolrunnner from "@actions/exec/lib/toolrunner";

import * as api from "./api-client";
import * as sharedEnv from "./shared-environment";
import { GITHUB_DOTCOM_URL, isLocalRun } from "./util";

/**
 * Wrapper around core.getInput for inputs that always have a value.
 * Also see getOptionalInput.
 *
 * This allows us to get stronger type checking of required/optional inputs
 * and make behaviour more consistent between actions and the runner.
 */
export function getRequiredInput(name: string): string {
  return core.getInput(name, { required: true });
}

/**
 * Wrapper around core.getInput that converts empty inputs to undefined.
 * Also see getRequiredInput.
 *
 * This allows us to get stronger type checking of required/optional inputs
 * and make behaviour more consistent between actions and the runner.
 */
export function getOptionalInput(name: string): string | undefined {
  const value = core.getInput(name);
  return value.length > 0 ? value : undefined;
}

/**
 * Get an environment parameter, but throw an error if it is not set.
 */
export function getRequiredEnvParam(paramName: string): string {
  const value = process.env[paramName];
  if (value === undefined || value.length === 0) {
    throw new Error(`${paramName} environment variable must be set`);
  }
  core.debug(`${paramName}=${value}`);
  return value;
}

/**
 * Ensures all required environment variables are set in the context of a local run.
 */
export function prepareLocalRunEnvironment() {
  if (!isLocalRun()) {
    return;
  }

  core.debug("Action is running locally.");
  if (!process.env.GITHUB_JOB) {
    core.exportVariable("GITHUB_JOB", "UNKNOWN-JOB");
  }
  if (!process.env.CODEQL_ACTION_ANALYSIS_KEY) {
    core.exportVariable(
      "CODEQL_ACTION_ANALYSIS_KEY",
      `LOCAL-RUN:${process.env.GITHUB_JOB}`
    );
  }
}

/**
 * Gets the SHA of the commit that is currently checked out.
 */
export const getCommitOid = async function (): Promise<string> {
  // Try to use git to get the current commit SHA. If that fails then
  // log but otherwise silently fall back to using the SHA from the environment.
  // The only time these two values will differ is during analysis of a PR when
  // the workflow has changed the current commit to the head commit instead of
  // the merge commit, which must mean that git is available.
  // Even if this does go wrong, it's not a huge problem for the alerts to
  // reported on the merge commit.
  try {
    let commitOid = "";
    await new toolrunnner.ToolRunner("git", ["rev-parse", "HEAD"], {
      silent: true,
      listeners: {
        stdout: (data) => {
          commitOid += data.toString();
        },
        stderr: (data) => {
          process.stderr.write(data);
        },
      },
    }).exec();
    return commitOid.trim();
  } catch (e) {
    core.info(
      `Failed to call git to get current commit. Continuing with data from environment: ${e}`
    );
    return getRequiredEnvParam("GITHUB_SHA");
  }
};

/**
 * Get the path of the currently executing workflow.
 */
async function getWorkflowPath(): Promise<string> {
  const repo_nwo = getRequiredEnvParam("GITHUB_REPOSITORY").split("/");
  const owner = repo_nwo[0];
  const repo = repo_nwo[1];
  const run_id = Number(getRequiredEnvParam("GITHUB_RUN_ID"));

  const apiClient = api.getActionsApiClient();
  const runsResponse = await apiClient.request(
    "GET /repos/:owner/:repo/actions/runs/:run_id",
    {
      owner,
      repo,
      run_id,
    }
  );
  const workflowUrl = runsResponse.data.workflow_url;

  const workflowResponse = await apiClient.request(`GET ${workflowUrl}`);

  return workflowResponse.data.path;
}

/**
 * Get the workflow run ID.
 */
export function getWorkflowRunID(): number {
  const workflowRunID = parseInt(getRequiredEnvParam("GITHUB_RUN_ID"), 10);
  if (Number.isNaN(workflowRunID)) {
    throw new Error("GITHUB_RUN_ID must define a non NaN workflow run ID");
  }
  return workflowRunID;
}

/**
 * Get the analysis key paramter for the current job.
 *
 * This will combine the workflow path and current job name.
 * Computing this the first time requires making requests to
 * the github API, but after that the result will be cached.
 */
export async function getAnalysisKey(): Promise<string> {
  const analysisKeyEnvVar = "CODEQL_ACTION_ANALYSIS_KEY";

  let analysisKey = process.env[analysisKeyEnvVar];
  if (analysisKey !== undefined) {
    return analysisKey;
  }

  const workflowPath = await getWorkflowPath();
  const jobName = getRequiredEnvParam("GITHUB_JOB");

  analysisKey = `${workflowPath}:${jobName}`;
  core.exportVariable(analysisKeyEnvVar, analysisKey);
  return analysisKey;
}

/**
 * Get the ref currently being analyzed.
 */
export async function getRef(): Promise<string> {
  // Will be in the form "refs/heads/master" on a push event
  // or in the form "refs/pull/N/merge" on a pull_request event
  const ref = getRequiredEnvParam("GITHUB_REF");

  // For pull request refs we want to detect whether the workflow
  // has run `git checkout HEAD^2` to analyze the 'head' ref rather
  // than the 'merge' ref. If so, we want to convert the ref that
  // we report back.
  const pull_ref_regex = /refs\/pull\/(\d+)\/merge/;
  const checkoutSha = await getCommitOid();

  if (
    pull_ref_regex.test(ref) &&
    checkoutSha !== getRequiredEnvParam("GITHUB_SHA")
  ) {
    return ref.replace(pull_ref_regex, "refs/pull/$1/head");
  } else {
    return ref;
  }
}

type ActionName = "init" | "autobuild" | "finish" | "upload-sarif";
type ActionStatus = "starting" | "aborted" | "success" | "failure";

export interface StatusReportBase {
  // ID of the workflow run containing the action run
  workflow_run_id: number;
  // Workflow name. Converted to analysis_name further down the pipeline.
  workflow_name: string;
  // Job name from the workflow
  job_name: string;
  // Analysis key, normally composed from the workflow path and job name
  analysis_key: string;
  // Value of the matrix for this instantiation of the job
  matrix_vars?: string;
  // Commit oid that the workflow was triggered on
  commit_oid: string;
  // Ref that the workflow was triggered on
  ref: string;
  // Name of the action being executed
  action_name: ActionName;
  // Version if the action being executed, as a commit oid
  action_oid: string;
  // Time the first action started. Normally the init action
  started_at: string;
  // Time this action started
  action_started_at: string;
  // Time this action completed, or undefined if not yet completed
  completed_at?: string;
  // State this action is currently in
  status: ActionStatus;
  // Cause of the failure (or undefined if status is not failure)
  cause?: string;
  // Stack trace of the failure (or undefined if status is not failure)
  exception?: string;
}

/**
 * Compose a StatusReport.
 *
 * @param actionName The name of the action, e.g. 'init', 'finish', 'upload-sarif'
 * @param status The status. Must be 'success', 'failure', or 'starting'
 * @param startedAt The time this action started executing.
 * @param cause  Cause of failure (only supply if status is 'failure')
 * @param exception Exception (only supply if status is 'failure')
 */
export async function createStatusReportBase(
  actionName: ActionName,
  status: ActionStatus,
  actionStartedAt: Date,
  cause?: string,
  exception?: string
): Promise<StatusReportBase> {
  const commitOid = process.env["GITHUB_SHA"] || "";
  const ref = await getRef();
  const workflowRunIDStr = process.env["GITHUB_RUN_ID"];
  let workflowRunID = -1;
  if (workflowRunIDStr) {
    workflowRunID = parseInt(workflowRunIDStr, 10);
  }
  const workflowName = process.env["GITHUB_WORKFLOW"] || "";
  const jobName = process.env["GITHUB_JOB"] || "";
  const analysis_key = await getAnalysisKey();
  let workflowStartedAt = process.env[sharedEnv.CODEQL_WORKFLOW_STARTED_AT];
  if (workflowStartedAt === undefined) {
    workflowStartedAt = actionStartedAt.toISOString();
    core.exportVariable(
      sharedEnv.CODEQL_WORKFLOW_STARTED_AT,
      workflowStartedAt
    );
  }

  const statusReport: StatusReportBase = {
    workflow_run_id: workflowRunID,
    workflow_name: workflowName,
    job_name: jobName,
    analysis_key,
    commit_oid: commitOid,
    ref,
    action_name: actionName,
    action_oid: "unknown", // TODO decide if it's possible to fill this in
    started_at: workflowStartedAt,
    action_started_at: actionStartedAt.toISOString(),
    status,
  };

  // Add optional parameters
  if (cause) {
    statusReport.cause = cause;
  }
  if (exception) {
    statusReport.exception = exception;
  }
  if (status === "success" || status === "failure" || status === "aborted") {
    statusReport.completed_at = new Date().toISOString();
  }
  const matrix = getRequiredInput("matrix");
  if (matrix) {
    statusReport.matrix_vars = matrix;
  }

  return statusReport;
}

/**
 * Send a status report to the code_scanning/analysis/status endpoint.
 *
 * Optionally checks the response from the API endpoint and sets the action
 * as failed if the status report failed. This is only expected to be used
 * when sending a 'starting' report.
 *
 * Returns whether sending the status report was successful of not.
 */
export async function sendStatusReport<S extends StatusReportBase>(
  statusReport: S,
  ignoreFailures?: boolean
): Promise<boolean> {
  if (getRequiredEnvParam("GITHUB_SERVER_URL") !== GITHUB_DOTCOM_URL) {
    core.debug("Not sending status report to GitHub Enterprise");
    return true;
  }

  if (isLocalRun()) {
    core.debug("Not sending status report because this is a local run");
    return true;
  }

  const statusReportJSON = JSON.stringify(statusReport);
  core.debug(`Sending status report: ${statusReportJSON}`);

  const nwo = getRequiredEnvParam("GITHUB_REPOSITORY");
  const [owner, repo] = nwo.split("/");
  const client = api.getActionsApiClient();
  const statusResponse = await client.request(
    "PUT /repos/:owner/:repo/code-scanning/analysis/status",
    {
      owner,
      repo,
      data: statusReportJSON,
    }
  );

  if (!ignoreFailures) {
    // If the status report request fails with a 403 or a 404, then this is a deliberate
    // message from the endpoint that the SARIF upload can be expected to fail too,
    // so the action should fail to avoid wasting actions minutes.
    //
    // Other failure responses (or lack thereof) could be transitory and should not
    // cause the action to fail.
    if (statusResponse.status === 403) {
      core.setFailed(
        "The repo on which this action is running is not opted-in to CodeQL code scanning."
      );
      return false;
    }
    if (statusResponse.status === 404) {
      core.setFailed(
        "Not authorized to used the CodeQL code scanning feature on this repo."
      );
      return false;
    }
  }

  return true;
}
