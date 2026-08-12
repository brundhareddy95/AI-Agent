"use client";

import { useCallback, useEffect, useState } from "react";
import { nhost } from "../lib/nhost";

const WORKFLOW_ID = "edf1719b-5497-4a5c-9270-bf652812f934";

type WorkflowStep = {
  id: string;
  name: string;
  step_order: number;
  type: string;
  config: Record<string, unknown> | null;
};

type WorkflowTrigger = {
  id: string;
  type: string;
  config: Record<string, unknown> | null;
};

type WorkflowRun = {
  id: string;
  status: string;
  created_at: string;
};

type Workflow = {
  id: string;
  name: string;
  description: string | null;
  org_id: string;
  active: boolean;
  workflow_steps: WorkflowStep[];
  workflow_triggers: WorkflowTrigger[];
  workflow_runs: WorkflowRun[];
};

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{
    message: string;
  }>;
};

async function graphqlRequest<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const session = nhost.getUserSession();

  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };

  if (session?.accessToken) {
    headers.Authorization = `Bearer ${session.accessToken}`;
  }

  const graphqlUrl =
    process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL ||
    "https://zvurswochuuxsrfaoebf.hasura.ap-south-1.nhost.run/v1/graphql";

  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  const json = (await response.json()) as GraphQLResponse<T>;

  if (!response.ok) {
    throw new Error(
      `GraphQL HTTP error ${response.status}`,
    );
  }

  if (json.errors?.length) {
    throw new Error(json.errors[0].message);
  }

  if (!json.data) {
    throw new Error("GraphQL returned no data.");
  }

  return json.data;
}

const WORKFLOW_QUERY = `
  query GetWorkflow($id: uuid!) {
    workflows(
      where: { id: { _eq: $id } }
      limit: 1
    ) {
      id
      name
      description
      org_id
      active

      workflow_steps(
        order_by: { step_order: asc }
      ) {
        id
        name
        step_order
        type
        config
      }

      workflow_triggers {
        id
        type
        config
      }

      workflow_runs(
        order_by: { created_at: desc }
        limit: 10
      ) {
        id
        status
        created_at
      }
    }
  }
`;

// Real Hasura Action, backed by the workflow engine. Replaces the old
// raw insert_workflow_runs_one — this version actually runs the steps,
// checks role + org + quota server-side, instead of just creating a
// pending row and doing nothing with it.
const TRIGGER_WORKFLOW_RUN_MUTATION = `
  mutation TriggerWorkflowRun($workflow_id: uuid!) {
    triggerWorkflowRun(workflow_id: $workflow_id) {
      success
      run_id
      status
      message
    }
  }
`;

// Real Hasura Action for approving a paused approval_gate step.
// Replaces the old raw update_workflow_runs_by_pk — the role check now
// happens server-side in the engine at the moment of approval.
const APPROVE_STEP_MUTATION = `
  mutation ApproveStep($workflow_run_id: uuid!) {
    approveStep(workflow_run_id: $workflow_run_id) {
      success
      run_id
      status
      message
    }
  }
`;

function formatDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function prettyType(type: string) {
  return type
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) =>
      letter.toUpperCase(),
    );
}

function statusClass(status: string) {
  const normalized = status.toLowerCase();

  if (
    normalized === "completed" ||
    normalized === "success" ||
    normalized === "succeeded"
  ) {
    return "status success";
  }

  if (
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "cancelled"
  ) {
    return "status failed";
  }

  if (
    normalized === "running" ||
    normalized === "processing"
  ) {
    return "status running";
  }

  if (
    normalized === "waiting" ||
    normalized === "paused" ||
    normalized === "pending_approval"
  ) {
    return "status waiting";
  }

  return "status pending";
}

export default function Page() {
  // ---- auth state ----
  const [checkingSession, setCheckingSession] =
    useState(true);

  const [isSignedIn, setIsSignedIn] =
    useState(false);

  const [userEmail, setUserEmail] =
    useState("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [authLoading, setAuthLoading] =
    useState(false);

  const [authError, setAuthError] =
    useState("");

  // ---- workflow state ----
  const [workflow, setWorkflow] =
    useState<Workflow | null>(null);

  const [loading, setLoading] =
    useState(true);

  const [running, setRunning] =
    useState(false);

  const [error, setError] =
    useState("");

  const [message, setMessage] =
    useState("");

  const loadWorkflow = useCallback(
    async () => {
      setLoading(true);
      setError("");

      try {
        const data =
          await graphqlRequest<{
            workflows: Workflow[];
          }>(
            WORKFLOW_QUERY,
            {
              id: WORKFLOW_ID,
            },
          );

        if (
          !data.workflows ||
          data.workflows.length === 0
        ) {
          throw new Error(
            "Workflow not found.",
          );
        }

        setWorkflow(data.workflows[0]);
      } catch (err) {
        console.error(
          "Unable to load workflow:",
          err,
        );

        setError(
          err instanceof Error
            ? err.message
            : "Unable to load workflow.",
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // On mount, check whether a session already exists
  // (e.g. from a previous visit). If so, skip the login
  // form and go straight to loading the dashboard.
  useEffect(() => {
    const session = nhost.getUserSession();

    if (session) {
      setIsSignedIn(true);
      setUserEmail(session.user?.email ?? "");
    }

    setCheckingSession(false);
  }, []);

  // Only load workflow data once we know the user is
  // signed in — otherwise every request goes out
  // unauthenticated and Hasura hides the fields.
  useEffect(() => {
    if (isSignedIn) {
      loadWorkflow();
    }
  }, [isSignedIn, loadWorkflow]);

  async function handleSignIn(
    e: React.FormEvent,
  ) {
    e.preventDefault();

    setAuthLoading(true);
    setAuthError("");

    try {
      const response =
        await nhost.auth.signInEmailPassword({
          email,
          password,
        });

      if (!response.body.session) {
        throw new Error(
          "Sign in did not return a session. Check your credentials.",
        );
      }

      setIsSignedIn(true);
      setUserEmail(
        response.body.session.user?.email ??
          email,
      );
    } catch (err) {
      console.error("Sign in failed:", err);

      setAuthError(
        err instanceof Error
          ? err.message
          : "Unable to sign in. Check your email and password.",
      );
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleSignOut() {
    try {
      const session = nhost.getUserSession();

      if (session) {
        await nhost.auth.signOut({
          refreshToken: session.refreshToken,
        });
      }
    } catch (err) {
      console.error("Sign out failed:", err);
    } finally {
      setIsSignedIn(false);
      setUserEmail("");
      setWorkflow(null);
      setEmail("");
      setPassword("");
    }
  }

  async function runWorkflow() {
    if (!workflow || running) {
      return;
    }

    setRunning(true);
    setError("");
    setMessage("");

    try {
      // Calls the real triggerWorkflowRun Hasura Action, which is backed
      // by the workflow engine. The engine verifies the caller is
      // owner/editor in the org, checks quota, creates the run, and
      // actually executes the steps in order — unlike the old raw
      // insert, which just created a "pending" row and did nothing.
      const data =
        await graphqlRequest<{
          triggerWorkflowRun: {
            success: boolean;
            run_id: string;
            status: string;
            message: string;
          } | null;
        }>(
          TRIGGER_WORKFLOW_RUN_MUTATION,
          {
            workflow_id: workflow.id,
          },
        );

      const result = data.triggerWorkflowRun;

      if (!result || !result.success) {
        throw new Error(
          result?.message ||
            "Workflow run could not be started.",
        );
      }

      setMessage(
        `Workflow run started: ${result.run_id}`,
      );

      // Give the engine a moment to create/update rows, then refresh.
      // (A live subscription would remove the need for this delay —
      // this refetch is a stand-in for that.)
      setTimeout(() => {
        loadWorkflow();
      }, 1500);
    } catch (err) {
      console.error(
        "Unable to start workflow:",
        err,
      );

      setError(
        err instanceof Error
          ? err.message
          : "Unable to start workflow.",
      );
    } finally {
      setRunning(false);
    }
  }

  async function markRunForApproval(
    run: WorkflowRun,
  ) {
    setError("");
    setMessage("");

    try {
      // Calls the real approveStep Hasura Action. The engine checks the
      // approver's role server-side at the moment of approval (this is
      // the step-level gate the assignment requires — it can't be a
      // plain database permission since it's a mid-execution decision),
      // then resumes execution from the step after the approval gate.
      const data =
        await graphqlRequest<{
          approveStep: {
            success: boolean;
            run_id: string;
            status: string;
            message: string;
          } | null;
        }>(
          APPROVE_STEP_MUTATION,
          {
            workflow_run_id: run.id,
          },
        );

      const result = data.approveStep;

      if (!result || !result.success) {
        throw new Error(
          result?.message ||
            "Run could not be approved.",
        );
      }

      setMessage(
        "Approved. Workflow is resuming.",
      );

      setTimeout(() => {
        loadWorkflow();
      }, 1500);
    } catch (err) {
      console.error(
        "Unable to approve workflow run:",
        err,
      );

      setError(
        err instanceof Error
          ? err.message
          : "Unable to approve workflow run.",
      );
    }
  }

  // Still figuring out whether a session already exists.
  if (checkingSession) {
    return (
      <>
        {styles}

        <main className="loading-screen">
          <div className="spinner" />
          <div>Checking session...</div>
        </main>
      </>
    );
  }

  // Not signed in yet — show the login gate instead
  // of the dashboard.
  if (!isSignedIn) {
    return (
      <>
        {styles}

        <main className="loading-screen">
          <form
            className="login-card"
            onSubmit={handleSignIn}
          >
            <div className="brand-icon">✦</div>

            <h1 className="login-title">
              AI Agent Workflow Builder
            </h1>

            <p className="login-subtitle">
              Sign in with your Nhost account to
              continue.
            </p>

            {authError && (
              <div className="alert error-alert login-alert">
                <span>{authError}</span>
              </div>
            )}

            <label className="login-label">
              Email
              <input
                className="login-input"
                type="email"
                required
                value={email}
                onChange={(e) =>
                  setEmail(e.target.value)
                }
                autoComplete="email"
              />
            </label>

            <label className="login-label">
              Password
              <input
                className="login-input"
                type="password"
                required
                value={password}
                onChange={(e) =>
                  setPassword(e.target.value)
                }
                autoComplete="current-password"
              />
            </label>

            <button
              type="submit"
              className="run-button login-submit"
              disabled={authLoading}
            >
              {authLoading ? (
                <>
                  <span className="button-spinner" />
                  Signing in...
                </>
              ) : (
                "Sign In"
              )}
            </button>
          </form>
        </main>
      </>
    );
  }

  if (loading) {
    return (
      <>
        {styles}

        <main className="loading-screen">
          <div className="spinner" />

          <div>
            Loading AI Agent Workflow Builder...
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      {styles}

      <main className="page">
        <header className="topbar">
          <div className="brand">
            <div className="brand-icon">
              ✦
            </div>

            <div>
              <div className="brand-name">
                AI AGENT
              </div>

              <div className="brand-subtitle">
                WORKFLOW BUILDER
              </div>
            </div>
          </div>

          <div className="topbar-actions">
            {userEmail && (
              <div className="connection">
                {userEmail}
              </div>
            )}

            <div className="connection">
              <span className="connection-dot" />
              Hasura Connected
            </div>

            <button
              className="refresh-button"
              onClick={loadWorkflow}
              disabled={loading}
            >
              ↻ Refresh
            </button>

            <button
              className="refresh-button"
              onClick={handleSignOut}
            >
              Sign Out
            </button>
          </div>
        </header>

        <section className="hero">
          <div>
            <div className="eyebrow">
              AI WORKFLOW PLATFORM
            </div>

            <h1>
              Build and run
              <br />
              <span>AI workflows.</span>
            </h1>

            <p>
              Execute AI steps, HTTP requests,
              conditional branches and approval
              gates while monitoring workflow
              execution in real time.
            </p>
          </div>

          <div className="usage-card">
            <div className="usage-title">
              <span>Usage</span>
              <strong>0 / 100</strong>
            </div>

            <div className="usage-track">
              <div className="usage-fill" />
            </div>

            <div className="usage-caption">
              Monthly workflow runs
            </div>
          </div>
        </section>

        {error && (
          <div className="alert error-alert">
            <strong>
              Unable to load workflow
            </strong>

            <span>{error}</span>
          </div>
        )}

        {message && (
          <div className="alert success-alert">
            <strong>Success</strong>
            <span>{message}</span>
          </div>
        )}

        {workflow && (
          <>
            <section className="workflow-header">
              <div>
                <div className="workflow-label">
                  WORKFLOW

                  <span
                    className={
                      workflow.active
                        ? "active-dot"
                        : "inactive-dot"
                    }
                  />

                  {workflow.active
                    ? "ACTIVE"
                    : "INACTIVE"}
                </div>

                <h2>
                  {workflow.name}
                </h2>

                <p>
                  {workflow.description ||
                    "AI workflow configured in Nhost / Hasura."}
                </p>

                <div className="meta-row">
                  <span>
                    <b>Workflow ID</b>
                    {workflow.id}
                  </span>

                  <span>
                    <b>Organization</b>
                    {workflow.org_id}
                  </span>
                </div>
              </div>

              <button
                className="run-button"
                onClick={runWorkflow}
                disabled={
                  running ||
                  !workflow.active
                }
              >
                {running ? (
                  <>
                    <span className="button-spinner" />
                    Starting...
                  </>
                ) : (
                  <>▶ Run Workflow</>
                )}
              </button>
            </section>

            <div className="dashboard-grid">
              <section className="panel steps-panel">
                <div className="panel-heading">
                  <div>
                    <span className="panel-kicker">
                      EXECUTION PIPELINE
                    </span>

                    <h3>
                      Workflow Steps
                    </h3>
                  </div>

                  <span className="count-badge">
                    {
                      workflow.workflow_steps
                        .length
                    }{" "}
                    steps
                  </span>
                </div>

                <div className="steps">
                  {workflow.workflow_steps
                    .length === 0 ? (
                    <div className="empty-state">
                      <div className="empty-icon">
                        ◌
                      </div>

                      <strong>
                        No workflow steps
                      </strong>

                      <span>
                        Add steps in Hasura.
                      </span>
                    </div>
                  ) : (
                    workflow.workflow_steps.map(
                      (step, index) => (
                        <div
                          className="step-wrapper"
                          key={step.id}
                        >
                          <div className="step-card">
                            <div className="step-number">
                              {String(
                                step.step_order,
                              ).padStart(
                                2,
                                "0",
                              )}
                            </div>

                            <div className="step-content">
                              <div className="step-title-row">
                                <h4>
                                  {step.name}
                                </h4>

                                <span className="type-badge">
                                  {prettyType(
                                    step.type,
                                  )}
                                </span>
                              </div>

                              <p className="step-id">
                                {step.id}
                              </p>

                              {step.config && (
                                <details>
                                  <summary>
                                    View configuration
                                  </summary>

                                  <pre>
                                    {JSON.stringify(
                                      step.config,
                                      null,
                                      2,
                                    )}
                                  </pre>
                                </details>
                              )}
                            </div>
                          </div>

                          {index <
                            workflow
                              .workflow_steps
                              .length -
                              1 && (
                            <div className="connector">
                              <span>↓</span>
                            </div>
                          )}
                        </div>
                      ),
                    )
                  )}
                </div>
              </section>

              <div className="right-column">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <span className="panel-kicker">
                        EVENT SOURCES
                      </span>

                      <h3>Triggers</h3>
                    </div>

                    <span className="count-badge">
                      {
                        workflow
                          .workflow_triggers
                          .length
                      }
                    </span>
                  </div>

                  <div className="trigger-list">
                    {workflow
                      .workflow_triggers
                      .length === 0 ? (
                      <div className="empty-state">
                        <div className="empty-icon">
                          ◌
                        </div>

                        <strong>
                          No triggers
                        </strong>

                        <span>
                          Configure a workflow
                          trigger in Hasura.
                        </span>
                      </div>
                    ) : (
                      workflow.workflow_triggers.map(
                        (trigger) => (
                          <div
                            className="trigger-card"
                            key={trigger.id}
                          >
                            <div
                              className={
                                trigger.type ===
                                "webhook"
                                  ? "trigger-icon webhook"
                                  : "trigger-icon manual"
                              }
                            >
                              {trigger.type ===
                              "webhook"
                                ? "⌁"
                                : "▶"}
                            </div>

                            <div>
                              <strong>
                                {prettyType(
                                  trigger.type,
                                )}
                              </strong>

                              <span>
                                {typeof trigger
                                  .config
                                  ?.description ===
                                "string"
                                  ? trigger
                                      .config
                                      .description
                                  : "Workflow trigger"}
                              </span>
                            </div>
                          </div>
                        ),
                      )
                    )}
                  </div>
                </section>

                <section className="panel runs-panel">
                  <div className="panel-heading">
                    <div>
                      <span className="panel-kicker">
                        EXECUTION HISTORY
                      </span>

                      <h3>
                        Recent Runs
                      </h3>
                    </div>

                    <span className="count-badge">
                      {
                        workflow
                          .workflow_runs
                          .length
                      }
                    </span>
                  </div>

                  {workflow.workflow_runs
                    .length === 0 ? (
                    <div className="empty-state">
                      <div className="empty-icon">
                        ◌
                      </div>

                      <strong>
                        No workflow runs yet
                      </strong>

                      <span>
                        Click "Run Workflow" to
                        create the first run.
                      </span>
                    </div>
                  ) : (
                    <div className="runs-list">
                      {workflow.workflow_runs.map(
                        (run) => (
                          <div
                            className="run-row"
                            key={run.id}
                          >
                            <div className="run-main">
                              <span
                                className={statusClass(
                                  run.status,
                                )}
                              >
                                {run.status}
                              </span>

                              <code>
                                {run.id.slice(
                                  0,
                                  8,
                                )}
                                ...
                              </code>
                            </div>

                            <div className="run-time">
                              {formatDate(
                                run.created_at,
                              )}
                            </div>

                            {run.status ===
                              "paused" && (
                              <button
                                className="approve-button"
                                onClick={() =>
                                  markRunForApproval(
                                    run,
                                  )
                                }
                              >
                                Approve &amp; Resume
                              </button>
                            )}
                          </div>
                        ),
                      )}
                    </div>
                  )}
                </section>
              </div>
            </div>
          </>
        )}

        <footer>
          <span>
            AI Agent Workflow Builder
          </span>

          <span>
            Powered by Nhost + Hasura
          </span>
        </footer>
      </main>
    </>
  );
}

const styles = (
  <style jsx global>{`
    * {
      box-sizing: border-box;
    }

    html,
    body {
      margin: 0;
      padding: 0;
    }

    body {
      background: #070b14;
      color: #e8edf7;
      font-family:
        Inter,
        ui-sans-serif,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
    }

    button {
      font: inherit;
    }

    .page {
      min-height: 100vh;
      background:
        radial-gradient(
          circle at 15% 5%,
          rgba(77, 104, 255, 0.12),
          transparent 28%
        ),
        radial-gradient(
          circle at 85% 10%,
          rgba(0, 208, 255, 0.08),
          transparent 24%
        ),
        #070b14;
    }

    .topbar {
      height: 76px;
      padding: 0 42px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #1b2333;
      background: rgba(7, 11, 20, 0.9);
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 20;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .brand-icon {
      width: 38px;
      height: 38px;
      border-radius: 11px;
      display: grid;
      place-items: center;
      background: linear-gradient(
        135deg,
        #6677ff,
        #26c6da
      );
      color: white;
      font-size: 21px;
      box-shadow:
        0 0 28px rgba(82, 103, 255, 0.3);
    }

    .brand-name {
      font-weight: 800;
      letter-spacing: 0.14em;
      font-size: 14px;
    }

    .brand-subtitle {
      color: #71809b;
      letter-spacing: 0.17em;
      font-size: 9px;
      margin-top: 3px;
    }

    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .connection {
      border: 1px solid #243149;
      border-radius: 999px;
      padding: 8px 13px;
      font-size: 12px;
      color: #a9b5ca;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .connection-dot,
    .active-dot,
    .inactive-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      display: inline-block;
    }

    .connection-dot,
    .active-dot {
      background: #31d59a;
      box-shadow:
        0 0 10px rgba(49, 213, 154, 0.7);
    }

    .inactive-dot {
      background: #68758a;
    }

    .refresh-button {
      border: 1px solid #27344b;
      background: #101827;
      color: #c5cede;
      border-radius: 9px;
      padding: 9px 13px;
      cursor: pointer;
    }

    .refresh-button:hover {
      background: #162135;
    }

    .refresh-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .hero {
      max-width: 1240px;
      margin: 0 auto;
      padding: 72px 32px 46px;
      display: flex;
      justify-content: space-between;
      gap: 60px;
      align-items: end;
    }

    .eyebrow,
    .panel-kicker,
    .workflow-label {
      color: #73819a;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.16em;
    }

    .hero h1 {
      font-size: clamp(42px, 5vw, 67px);
      line-height: 0.98;
      margin: 14px 0 22px;
      letter-spacing: -0.045em;
    }

    .hero h1 span {
      color: #7487ff;
    }

    .hero p {
      color: #8492a9;
      max-width: 670px;
      line-height: 1.7;
      font-size: 15px;
      margin: 0;
    }

    .usage-card {
      min-width: 240px;
      border: 1px solid #1e2a3d;
      border-radius: 14px;
      padding: 18px;
      background: rgba(15, 23, 37, 0.75);
    }

    .usage-title {
      display: flex;
      justify-content: space-between;
      color: #7d8aa1;
      font-size: 12px;
      margin-bottom: 13px;
    }

    .usage-title strong {
      color: #e6ebf5;
    }

    .usage-track {
      height: 7px;
      border-radius: 99px;
      background: #202b3c;
      overflow: hidden;
    }

    .usage-fill {
      height: 100%;
      width: 0%;
    }

    .usage-caption {
      color: #56647c;
      font-size: 10px;
      margin-top: 9px;
    }

    .alert {
      max-width: 1240px;
      margin: 0 auto 20px;
      padding: 13px 17px;
      border-radius: 10px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      font-size: 13px;
    }

    .error-alert {
      border: 1px solid #63323c;
      background: rgba(90, 29, 40, 0.25);
      color: #ff9da9;
    }

    .success-alert {
      border: 1px solid #285c4b;
      background: rgba(25, 92, 69, 0.2);
      color: #7be0ba;
    }

    .workflow-header {
      max-width: 1240px;
      margin: 0 auto 28px;
      padding: 26px 28px;
      border: 1px solid #202c40;
      border-radius: 17px;
      background: linear-gradient(
        135deg,
        rgba(16, 25, 41, 0.95),
        rgba(10, 16, 27, 0.95)
      );
      display: flex;
      justify-content: space-between;
      gap: 30px;
      align-items: center;
    }

    .workflow-label {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .workflow-header h2 {
      margin: 10px 0 8px;
      font-size: 27px;
    }

    .workflow-header p {
      color: #7e8ca3;
      margin: 0 0 17px;
      font-size: 13px;
    }

    .meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 18px;
    }

    .meta-row span {
      color: #5f6d83;
      font-size: 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .meta-row b {
      color: #8996aa;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 9px;
    }

    .run-button {
      flex-shrink: 0;
      border: 0;
      border-radius: 10px;
      padding: 13px 20px;
      background: linear-gradient(
        135deg,
        #6678ff,
        #5365e7
      );
      color: white;
      font-weight: 800;
      cursor: pointer;
      box-shadow:
        0 8px 25px rgba(79, 96, 231, 0.23);
    }

    .run-button:hover:not(:disabled) {
      transform: translateY(-1px);
    }

    .run-button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .dashboard-grid {
      max-width: 1240px;
      margin: 0 auto;
      padding: 0 0 40px;
      display: grid;
      grid-template-columns:
        minmax(0, 1.45fr)
        minmax(360px, 0.9fr);
      gap: 22px;
    }

    .right-column {
      display: flex;
      flex-direction: column;
      gap: 22px;
    }

    .panel {
      border: 1px solid #1e293c;
      background: rgba(12, 19, 31, 0.86);
      border-radius: 16px;
      overflow: hidden;
    }

    .panel-heading {
      padding: 19px 20px;
      border-bottom: 1px solid #1c2738;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .panel-heading h3 {
      margin: 6px 0 0;
      font-size: 16px;
    }

    .count-badge {
      color: #8795aa;
      background: #111b2a;
      border: 1px solid #26344a;
      border-radius: 999px;
      padding: 5px 9px;
      font-size: 10px;
    }

    .steps {
      padding: 20px;
    }

    .step-card {
      display: flex;
      gap: 15px;
      border: 1px solid #202d42;
      border-radius: 13px;
      background: #0e1725;
      padding: 16px;
    }

    .step-number {
      width: 37px;
      height: 37px;
      flex-shrink: 0;
      border-radius: 10px;
      display: grid;
      place-items: center;
      background: #19243a;
      color: #8092ff;
      font-size: 11px;
      font-weight: 900;
    }

    .step-content {
      min-width: 0;
      flex: 1;
    }

    .step-title-row {
      display: flex;
      align-items: center;
      gap: 9px;
      flex-wrap: wrap;
    }

    .step-title-row h4 {
      margin: 0;
      font-size: 14px;
    }

    .type-badge {
      border-radius: 999px;
      padding: 4px 7px;
      background: #162239;
      color: #8090ad;
      font-size: 9px;
    }

    .step-id {
      color: #46556c;
      font-family: monospace;
      font-size: 9px;
      margin: 7px 0 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    details {
      margin-top: 12px;
    }

    summary {
      cursor: pointer;
      color: #7182a2;
      font-size: 10px;
    }

    pre {
      overflow: auto;
      padding: 11px;
      border-radius: 8px;
      background: #080d16;
      color: #8998b2;
      font-size: 10px;
      line-height: 1.55;
    }

    .connector {
      height: 30px;
      display: grid;
      place-items: center;
      color: #3d4b61;
      font-size: 17px;
    }

    .trigger-list,
    .runs-list {
      padding: 12px;
    }

    .trigger-card {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 13px 10px;
      border-bottom: 1px solid #182334;
    }

    .trigger-card:last-child {
      border-bottom: 0;
    }

    .trigger-icon {
      width: 35px;
      height: 35px;
      border-radius: 9px;
      display: grid;
      place-items: center;
      font-weight: 800;
    }

    .trigger-icon.manual {
      background: #18274a;
      color: #8294ff;
    }

    .trigger-icon.webhook {
      background: #17352e;
      color: #5ed7ae;
    }

    .trigger-card strong {
      display: block;
      font-size: 12px;
      margin-bottom: 4px;
    }

    .trigger-card span:last-child {
      display: block;
      color: #66758d;
      font-size: 10px;
    }

    .run-row {
      padding: 13px 9px;
      border-bottom: 1px solid #182334;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .run-row:last-child {
      border-bottom: 0;
    }

    .run-main {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1;
    }

    .run-main code {
      color: #64738a;
      font-size: 9px;
    }

    .status {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 9px;
      text-transform: uppercase;
      font-weight: 800;
    }

    .status.success {
      color: #65d9ad;
      background: #12362c;
    }

    .status.failed {
      color: #ff8999;
      background: #3b1d26;
    }

    .status.running {
      color: #8ca0ff;
      background: #1b2750;
    }

    .status.waiting {
      color: #f2c66c;
      background: #3d3117;
    }

    .status.pending {
      color: #9daabd;
      background: #202a3a;
    }

    .run-time {
      color: #4f5e74;
      font-size: 9px;
    }

    .approve-button {
      border: 1px solid #665329;
      color: #e9c66f;
      background: #211c11;
      border-radius: 7px;
      padding: 6px 8px;
      font-size: 9px;
      cursor: pointer;
    }

    .approve-button:hover {
      background: #302812;
    }

    .empty-state {
      padding: 34px 20px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 7px;
    }

    .empty-icon {
      font-size: 30px;
      color: #39475b;
      margin-bottom: 5px;
    }

    .empty-state strong {
      font-size: 12px;
    }

    .empty-state span {
      color: #59677d;
      font-size: 10px;
    }

    footer {
      max-width: 1240px;
      margin: 0 auto;
      border-top: 1px solid #182233;
      padding: 18px 0 30px;
      display: flex;
      justify-content: space-between;
      color: #46536a;
      font-size: 9px;
      letter-spacing: 0.04em;
    }

    .loading-screen {
      min-height: 100vh;
      display: grid;
      place-items: center;
      align-content: center;
      gap: 14px;
      color: #74819a;
      font-size: 13px;
      background: #070b14;
    }

    .login-card {
      width: 340px;
      max-width: 90vw;
      border: 1px solid #1e2a3d;
      background: rgba(15, 23, 37, 0.85);
      border-radius: 16px;
      padding: 30px 26px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }

    .login-title {
      font-size: 17px;
      margin: 12px 0 2px;
      text-align: center;
    }

    .login-subtitle {
      color: #7d8aa1;
      font-size: 12px;
      text-align: center;
      margin: 0 0 14px;
    }

    .login-alert {
      max-width: none;
      margin: 0 0 12px;
      width: 100%;
    }

    .login-label {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 11px;
      color: #8996aa;
      letter-spacing: 0.04em;
      margin-bottom: 12px;
    }

    .login-input {
      background: #0e1725;
      border: 1px solid #243149;
      border-radius: 9px;
      padding: 10px 12px;
      color: #e8edf7;
      font-size: 13px;
    }

    .login-input:focus {
      outline: none;
      border-color: #5365e7;
    }

    .login-submit {
      width: 100%;
      margin-top: 6px;
      justify-content: center;
      display: flex;
      align-items: center;
    }

    .spinner,
    .button-spinner {
      border-radius: 50%;
      border: 2px solid #29364d;
      border-top-color: #7283ff;
      animation: spin 0.8s linear infinite;
    }

    .spinner {
      width: 30px;
      height: 30px;
    }

    .button-spinner {
      width: 13px;
      height: 13px;
      display: inline-block;
      margin-right: 7px;
      vertical-align: -2px;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    @media (max-width: 900px) {
      .topbar {
        padding: 0 20px;
      }

      .connection {
        display: none;
      }

      .hero {
        flex-direction: column;
        align-items: stretch;
        padding: 50px 20px 30px;
      }

      .dashboard-grid {
        grid-template-columns: 1fr;
        padding: 0 20px 30px;
      }

      .workflow-header {
        margin: 0 20px 22px;
        flex-direction: column;
        align-items: stretch;
      }

      .usage-card {
        width: 100%;
      }

      footer {
        margin: 0 20px;
      }
    }

    @media (max-width: 560px) {
      .topbar {
        height: 65px;
      }

      .brand-subtitle {
        display: none;
      }

      .hero h1 {
        font-size: 42px;
      }

      .workflow-header {
        padding: 20px;
      }

      .meta-row {
        flex-direction: column;
        gap: 10px;
      }

      footer {
        flex-direction: column;
        gap: 8px;
      }
    }
  `}</style>
);