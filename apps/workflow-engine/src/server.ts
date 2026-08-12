// apps/workflow-engine/src/server.ts
//
// Hasura Actions backend:
//   POST /actions/trigger-workflow-run
//   POST /actions/approve-step
//
// Run with: npm run dev  (tsx watch src/server.ts)

import "dotenv/config";
import express from "express";

const app = express();
app.use(express.json());

const HASURA_GRAPHQL_ENDPOINT = process.env.HASURA_GRAPHQL_ENDPOINT;
const HASURA_ADMIN_SECRET = process.env.HASURA_ADMIN_SECRET;
const PORT = process.env.PORT || 4001;

if (!HASURA_GRAPHQL_ENDPOINT || !HASURA_ADMIN_SECRET) {
  console.error(
    "Missing HASURA_GRAPHQL_ENDPOINT or HASURA_ADMIN_SECRET in environment. Exiting.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
async function adminGraphql(query: string, variables: Record<string, any> = {}) {
  const response = await fetch(HASURA_GRAPHQL_ENDPOINT as string, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hasura-admin-secret": HASURA_ADMIN_SECRET as string,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json: any = await response.json();

  if (json.errors?.length) {
    throw new Error(
      `Hasura error: ${json.errors.map((e: any) => e.message).join("; ")}`,
    );
  }

  return json.data;
}

// ---------------------------------------------------------------------------
async function withRetry(
  fn: (attempt: number) => Promise<any>,
  { attempts = 2, delayMs = 500 } = {},
) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err: any) {
      lastError = err;
      console.warn(`Attempt ${attempt}/${attempts} failed: ${err.message}`);

      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Step executors
// ---------------------------------------------------------------------------

async function executeLlmCall(step: any, context: any) {
  const config = step.config || {};
  const prompt = config.prompt || "No prompt configured.";

  return withRetry(async () => {
    if (config.provider === "stub" || !process.env.LLM_API_KEY) {
      await new Promise((r) => setTimeout(r, 800));

      const priority = /urgent|asap|complaint|angry/i.test(
        JSON.stringify(context.input || {}),
      )
        ? "HIGH"
        : "LOW";

      return {
        output: {
          provider: "stub",
          prompt,
          result: `Classified as ${priority} priority (stubbed response).`,
          priority,
        },
      };
    }

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.LLM_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: [{ role: "user", content: prompt }],
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`LLM API returned ${response.status}`);
    }

    const data: any = await response.json();
    const text = data.choices?.[0]?.message?.content || "";

    return {
      output: {
        provider: "groq",
        prompt,
        result: text,
        priority: /high/i.test(text) ? "HIGH" : "LOW",
      },
    };
  });
}

async function executeHttpRequest(step: any, context: any) {
  const config = step.config || {};
  const url = config.url || "https://httpbin.org/get";
  const method = config.method || "GET";

  return withRetry(async () => {
    const response = await fetch(url, {
      method,
      headers: config.headers || {},
      body: method !== "GET" && config.body ? JSON.stringify(config.body) : undefined,
    });

    if (!response.ok) {
      throw new Error(`HTTP step returned ${response.status}`);
    }

    let body: any;
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }

    return { output: { status: response.status, body } };
  });
}

async function executeDbWrite(step: any, context: any) {
  const config = step.config || {};

  const result = await adminGraphql(
    `
      mutation InsertWorkflowData($workflow_run_id: uuid!, $data: jsonb!) {
        insert_workflow_data_one(
          object: { workflow_run_id: $workflow_run_id, data: $data }
        ) {
          id
        }
      }
    `,
    {
      workflow_run_id: context.workflowRunId,
      data: { step_id: step.id, ...context.previousOutput, ...config },
    },
  ).catch((err: any) => {
    throw new Error(`db_write failed: ${err.message}`);
  });

  return { output: result };
}

function executeConditionalBranch(step: any, context: any) {
  const config = step.config || {};
  const field = config.field || "priority";
  const expected = config.equals || "HIGH";

  const actualValue = context.previousOutput?.[field];
  const matched = actualValue === expected;

  return {
    output: {
      field,
      expected,
      actual: actualValue,
      branch: matched ? "true_branch" : "false_branch",
    },
  };
}

// ---------------------------------------------------------------------------
// step_runs helpers
// ---------------------------------------------------------------------------

async function createStepRun(workflowRunId: any, workflowStepId: any, input: any) {
  const data = await adminGraphql(
    `
      mutation CreateStepRun(
        $workflow_run_id: uuid!
        $workflow_step_id: uuid!
        $input: jsonb
      ) {
        insert_step_runs_one(
          object: {
            workflow_run_id: $workflow_run_id
            workflow_step_id: $workflow_step_id
            status: "running"
            input: $input
            attempt_count: 1
          }
        ) {
          id
        }
      }
    `,
    {
      workflow_run_id: workflowRunId,
      workflow_step_id: workflowStepId,
      input: input || {},
    },
  );

  return data.insert_step_runs_one.id;
}

async function completeStepRun(stepRunId: any, status: any, output: any, errorMessage: any) {
  await adminGraphql(
    `
      mutation CompleteStepRun(
        $id: uuid!
        $status: String!
        $output: jsonb
        $error: String
      ) {
        update_step_runs_by_pk(
          pk_columns: { id: $id }
          _set: {
            status: $status
            output: $output
            error: $error
          }
        ) {
          id
        }
      }
    `,
    { id: stepRunId, status, output: output || {}, error: errorMessage || null },
  );
}

async function updateWorkflowRunStatus(workflowRunId: any, status: any) {
  await adminGraphql(
    `
      mutation UpdateRunStatus($id: uuid!, $status: String!) {
        update_workflow_runs_by_pk(
          pk_columns: { id: $id }
          _set: { status: $status }
        ) {
          id
        }
      }
    `,
    { id: workflowRunId, status },
  );
}

// ---------------------------------------------------------------------------
// Core executor
// ---------------------------------------------------------------------------

async function runStepsFrom(workflow: any, workflowRunId: any, startIndex: any, previousOutput: any) {
  const steps = workflow.workflow_steps;

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];

    const stepRunId = await createStepRun(workflowRunId, step.id, previousOutput);

    try {
      let result: any;

      switch (step.type) {
        case "llm_call":
          result = await executeLlmCall(step, { input: previousOutput });
          break;
        case "http_request":
          result = await executeHttpRequest(step, { input: previousOutput });
          break;
        case "db_write":
          result = await executeDbWrite(step, { workflowRunId, previousOutput });
          break;
        case "conditional_branch":
          result = executeConditionalBranch(step, { previousOutput });
          break;
        case "notify":
          result = { output: { notified: true } };
          break;
        case "approval_gate":
          await completeStepRun(stepRunId, "paused", null, null);
          await updateWorkflowRunStatus(workflowRunId, "paused");

          return {
            paused: true,
            pausedAtStepIndex: i,
            pausedAtStepRunId: stepRunId,
          };
        default:
          throw new Error(`Unknown step type: ${step.type}`);
      }

      await completeStepRun(stepRunId, "completed", result.output, null);
      previousOutput = result.output;
    } catch (err: any) {
      await completeStepRun(stepRunId, "failed", null, err.message);
      await updateWorkflowRunStatus(workflowRunId, "failed");

      return { paused: false, failed: true, error: err.message };
    }
  }

  await updateWorkflowRunStatus(workflowRunId, "completed");
  return { paused: false, failed: false };
}

// ---------------------------------------------------------------------------
// Action: triggerWorkflowRun
// ---------------------------------------------------------------------------

app.post("/actions/trigger-workflow-run", async (req, res) => {
  try {
    const { input, session_variables } = req.body;
    const workflowId = input?.workflow_id;

    const userId = session_variables?.["x-hasura-user-id"];

    if (!workflowId) {
      return res.status(400).json({ message: "workflow_id is required" });
    }

    const data = await adminGraphql(
      `
        query WorkflowWithAccess($workflow_id: uuid!, $user_id: uuid!) {
          workflows_by_pk(id: $workflow_id) {
            id
            org_id
            active
            workflow_steps(order_by: { step_order: asc }) {
              id
              step_order
              type
              config
            }
          }
          org_members(where: { user_id: { _eq: $user_id } }) {
            org_id
            role
          }
          organizations {
            id
            quota_allowed
            quota_used
          }
        }
      `,
      { workflow_id: workflowId, user_id: userId },
    );

    const workflow = data.workflows_by_pk;

    if (!workflow) {
      return res.status(404).json({ message: "Workflow not found." });
    }

    const membership = data.org_members.find((m: any) => m.org_id === workflow.org_id);

    if (!membership || !["owner", "editor"].includes(membership.role)) {
      return res.status(403).json({
        message: "You must be an owner or editor in this workflow's organization to run it.",
      });
    }

    const org = data.organizations.find((o: any) => o.id === workflow.org_id);

    if (!org || org.quota_used >= org.quota_allowed) {
      return res.status(429).json({ message: "Organization quota exhausted for this period." });
    }

    if (!workflow.active) {
      return res.status(400).json({ message: "Workflow is not active." });
    }

    const createRunData = await adminGraphql(
      `
        mutation CreateRun($workflow_id: uuid!) {
          insert_workflow_runs_one(
            object: { workflow_id: $workflow_id, status: "running", started_at: "now()" }
          ) {
            id
          }
        }
      `,
      { workflow_id: workflowId },
    );

    const workflowRunId = createRunData.insert_workflow_runs_one.id;

    // FIX: added `success: true` — the Hasura Action type TriggerWorkflowRunResponse
    // requires this field, and the response was failing to parse without it.
    res.json({
      success: true,
      run_id: workflowRunId,
      status: "running",
      workflow_id: workflowId,
      organization_id: workflow.org_id,
      message: "Workflow run started.",
    });

    runStepsFrom(workflow, workflowRunId, 0, {})
      .then(async (result) => {
        if (!result.paused && !result.failed) {
          await adminGraphql(
            `
              mutation IncrementQuota($org_id: uuid!, $new_used: Int!) {
                update_organizations_by_pk(
                  pk_columns: { id: $org_id }
                  _set: { quota_used: $new_used }
                ) {
                  id
                }
              }
            `,
            { org_id: workflow.org_id, new_used: org.quota_used + 1 },
          );
        }
      })
      .catch((err) => {
        console.error("Background step execution failed:", err);
      });
  } catch (err: any) {
    console.error("trigger-workflow-run error:", err);
    res.status(500).json({ message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Action: approveStep
// ---------------------------------------------------------------------------

app.post("/actions/approve-step", async (req, res) => {
  try {
    const { input, session_variables } = req.body;
    const workflowRunId = input?.workflow_run_id;

    const userId = session_variables?.["x-hasura-user-id"];

    if (!workflowRunId) {
      return res.status(400).json({ message: "workflow_run_id is required" });
    }

    const data = await adminGraphql(
      `
        query RunForApproval($workflow_run_id: uuid!, $user_id: uuid!) {
          workflow_runs_by_pk(id: $workflow_run_id) {
            id
            status
            workflow_id
            workflow {
              id
              org_id
              workflow_steps(order_by: { step_order: asc }) {
                id
                step_order
                type
                config
              }
            }
          }
          step_runs(
            where: { workflow_run_id: { _eq: $workflow_run_id }, status: { _eq: "paused" } }
            order_by: { created_at: desc }
            limit: 1
          ) {
            id
            workflow_step_id
          }
          org_members(where: { user_id: { _eq: $user_id } }) {
            org_id
            role
          }
        }
      `,
      { workflow_run_id: workflowRunId, user_id: userId },
    );

    const run = data.workflow_runs_by_pk;

    if (!run) {
      return res.status(404).json({ message: "Run not found." });
    }

    if (run.status !== "paused") {
      return res.status(400).json({ message: `Run is not paused (current status: ${run.status}).` });
    }

    const membership = data.org_members.find((m: any) => m.org_id === run.workflow.org_id);

    if (!membership || !["owner", "editor"].includes(membership.role)) {
      return res.status(403).json({
        message: "You must be an owner or editor in this workflow's organization to approve.",
      });
    }

    const pausedStepRun = data.step_runs[0];

    if (!pausedStepRun) {
      return res.status(400).json({ message: "No paused step found for this run." });
    }

    await adminGraphql(
      `
        mutation ApproveStepRun($id: uuid!, $approved_by: uuid!) {
          update_step_runs_by_pk(
            pk_columns: { id: $id }
            _set: { status: "completed", approved_by: $approved_by, approved_at: "now()" }
          ) {
            id
          }
        }
      `,
      { id: pausedStepRun.id, approved_by: userId },
    );

    await updateWorkflowRunStatus(workflowRunId, "running");

    const steps = run.workflow.workflow_steps;
    const gateIndex = steps.findIndex((s: any) => s.id === pausedStepRun.workflow_step_id);

    // FIX: added `success: true` here too — same TriggerWorkflowRunResponse
    // shape requirement applies to this Action's response.
    res.json({
      success: true,
      run_id: workflowRunId,
      status: "running",
      workflow_id: run.workflow_id,
      organization_id: run.workflow.org_id,
      message: "Step approved. Resuming workflow.",
    });

    runStepsFrom(run.workflow, workflowRunId, gateIndex + 1, {}).catch((err) => {
      console.error("Background step execution failed (resume):", err);
    });
  } catch (err: any) {
    console.error("approve-step error:", err);
    res.status(500).json({ message: err.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Webhook trigger — a second way to start a run, without a user session.
// External systems POST here with the workflow's id in the URL. Since
// there's no logged-in user, the owner/editor role check doesn't apply —
// instead, knowledge of the workflow_id itself is the "credential" (same
// pattern most webhook-triggered automation tools use). Quota and
// workflow.active are still enforced.
// ---------------------------------------------------------------------------

app.post("/webhook/:workflow_id", async (req, res) => {
  try {
    const workflowId = req.params.workflow_id;

    const data = await adminGraphql(
      `
        query WorkflowForWebhook($workflow_id: uuid!) {
          workflows_by_pk(id: $workflow_id) {
            id
            org_id
            active
            workflow_steps(order_by: { step_order: asc }) {
              id
              step_order
              type
              config
            }
            workflow_triggers(where: { type: { _eq: "webhook" } }) {
              id
            }
          }
          organizations {
            id
            quota_allowed
            quota_used
          }
        }
      `,
      { workflow_id: workflowId },
    );

    const workflow = data.workflows_by_pk;

    if (!workflow) {
      return res.status(404).json({ success: false, message: "Workflow not found." });
    }

    if (workflow.workflow_triggers.length === 0) {
      return res.status(400).json({
        success: false,
        message: "This workflow has no webhook trigger configured.",
      });
    }

    if (!workflow.active) {
      return res.status(400).json({ success: false, message: "Workflow is not active." });
    }

    const org = data.organizations.find((o: any) => o.id === workflow.org_id);

    if (!org || org.quota_used >= org.quota_allowed) {
      return res.status(429).json({ success: false, message: "Organization quota exhausted." });
    }

    const createRunData = await adminGraphql(
      `
        mutation CreateRun($workflow_id: uuid!) {
          insert_workflow_runs_one(
            object: {
              workflow_id: $workflow_id
              status: "running"
              trigger_type: "webhook"
              started_at: "now()"
            }
          ) {
            id
          }
        }
      `,
      { workflow_id: workflowId },
    ).catch(async () => {
      // Fallback in case `trigger_type` column doesn't exist on
      // workflow_runs in this schema — retry without it so the webhook
      // path still works even if that column wasn't added.
      return adminGraphql(
        `
          mutation CreateRunFallback($workflow_id: uuid!) {
            insert_workflow_runs_one(
              object: { workflow_id: $workflow_id, status: "running", started_at: "now()" }
            ) {
              id
            }
          }
        `,
        { workflow_id: workflowId },
      );
    });

    const workflowRunId = createRunData.insert_workflow_runs_one.id;

    res.json({ success: true, run_id: workflowRunId, status: "running" });

    runStepsFrom(workflow, workflowRunId, 0, {})
      .then(async (result) => {
        if (!result.paused && !result.failed) {
          await adminGraphql(
            `
              mutation IncrementQuota($org_id: uuid!, $new_used: Int!) {
                update_organizations_by_pk(
                  pk_columns: { id: $org_id }
                  _set: { quota_used: $new_used }
                ) {
                  id
                }
              }
            `,
            { org_id: workflow.org_id, new_used: org.quota_used + 1 },
          );
        }
      })
      .catch((err) => {
        console.error("Background step execution failed (webhook):", err);
      });
  } catch (err: any) {
    console.error("webhook trigger error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Workflow engine listening on port ${PORT}`);
});