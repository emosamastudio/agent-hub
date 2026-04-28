import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { getApprovalResolveSupport, type ApprovalDecision, type ApprovalItem } from "../shared-types.js";
import { ControlPlaneError, type ControlPlaneService } from "./control-plane-service.js";
import type { OpenClawApprovalBridgeService } from "./openclaw-approval-bridge.js";

const execFileAsync = promisify(execFile);

interface ApprovalOperatorServiceOptions {
  openclawBin: string;
  openClawStateDir: string;
  service: ControlPlaneService;
  bridge: OpenClawApprovalBridgeService;
}

export interface ApprovalResolveResult {
  ok: true;
  approval: ApprovalItem | null;
  snapshot: ReturnType<ControlPlaneService["getSnapshot"]>;
  decision: ApprovalDecision;
  message: string;
}

export class ApprovalOperatorService {
  constructor(private readonly options: ApprovalOperatorServiceOptions) {}

  async resolveApproval(
    approval: ApprovalItem,
    decision: ApprovalDecision,
  ): Promise<ApprovalResolveResult> {
    const bridge = this.options.service.getApprovalBridgeStatus("openclaw");
    const support = getApprovalResolveSupport(approval, bridge);
    if (!support.supported) {
      throw new ControlPlaneError(
        409,
        describeUnsupportedApprovalResolve(approval, support.code),
      );
    }

    if (approval.platform !== "openclaw") {
      throw new ControlPlaneError(
        409,
        `Approval ${approval.id} is not backed by a truthful OpenClaw bridge.`,
      );
    }

    try {
      await execFileAsync(
        this.options.openclawBin,
        [
          "gateway",
          "call",
          "exec.approval.resolve",
          "--json",
          "--params",
          JSON.stringify({
            id: approval.id,
            decision,
          }),
        ],
        {
          env: this.buildOpenClawEnv(),
        },
      );
    } catch (error) {
      const message = describeProcessError(error);
      if (message.includes("unknown or expired approval id")) {
        throw new ControlPlaneError(
          409,
          `OpenClaw approval ${approval.id} is no longer pending.`,
        );
      }

      throw new ControlPlaneError(
        500,
        `Failed to resolve OpenClaw approval ${approval.id}: ${message}`,
      );
    }

    const settled = await this.options.bridge.waitForSettlement(approval.id, 1_500);

    return {
      ok: true,
      approval: settled,
      snapshot: this.options.service.getSnapshot(),
      decision,
      message:
        decision === "allow-once"
          ? `Requested a one-time allow decision for OpenClaw approval ${approval.id}.`
          : `Requested a deny decision for OpenClaw approval ${approval.id}.`,
    };
  }

  private buildOpenClawEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    const stateDir = this.options.openClawStateDir.trim();

    if (stateDir) {
      env.OPENCLAW_STATE_DIR = stateDir;
      env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
    }

    return env;
  }
}

function describeUnsupportedApprovalResolve(
  approval: ApprovalItem,
  code: ReturnType<typeof getApprovalResolveSupport>["code"],
): string {
  switch (code) {
    case "approval-not-pending":
      return `Approval ${approval.id} is no longer pending, so Agent Hub cannot resolve it.`;
    case "openclaw-bridge-disconnected":
      return `OpenClaw approval ${approval.id} is visible, but the live approval bridge is disconnected so resolve actions are disabled truthfully.`;
    case "openclaw-bridge-live":
      return `OpenClaw approval ${approval.id} is already actionable.`;
  }
}

function describeProcessError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
