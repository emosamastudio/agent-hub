import type { ReferenceProject } from "../shared-types.js";

export const referenceCatalog: ReferenceProject[] = [
  {
    id: "langflow",
    name: "Langflow",
    repoUrl: "https://github.com/langflow-ai/langflow",
    stars: 146800,
    language: "Python",
    category: "workflow-builder",
    summary: "Visual builder for AI agents and workflows with a large self-hosted community.",
    reuseInsteadOfBuilding:
      "Do not rebuild visual flow authoring, deployment UI, or graph editing inside Agent Hub.",
    hubIntegration:
      "Treat Langflow as an upstream builder/runtime and mirror run state, approvals, and failures back into Agent Hub.",
  },
  {
    id: "dify",
    name: "Dify",
    repoUrl: "https://github.com/langgenius/dify",
    stars: 137229,
    language: "TypeScript",
    category: "workflow-builder",
    summary: "Production-ready platform for agentic workflow development and app delivery.",
    reuseInsteadOfBuilding:
      "Reuse its workflow/app builder, knowledge tooling, and operator surfaces instead of cloning them locally.",
    hubIntegration:
      "Expose Dify app executions as runs and send webhook or sidecar status updates into Agent Hub.",
  },
  {
    id: "open-webui",
    name: "Open WebUI",
    repoUrl: "https://github.com/open-webui/open-webui",
    stars: 131232,
    language: "Python",
    category: "agent-workbench",
    summary: "Popular local AI workbench with model switching, MCP support, and plugin-friendly operator UX.",
    reuseInsteadOfBuilding:
      "Do not rebuild a full conversational AI workspace, authentication layer, or rich model chat surface in Agent Hub.",
    hubIntegration:
      "Use Open WebUI as the operator-facing chat layer while Agent Hub focuses on fleet health, inbox, and control actions.",
  },
  {
    id: "flowise",
    name: "Flowise",
    repoUrl: "https://github.com/FlowiseAI/Flowise",
    stars: 51770,
    language: "TypeScript",
    category: "workflow-builder",
    summary: "High-adoption visual agent builder that is easy to self-host and iterate with locally.",
    reuseInsteadOfBuilding:
      "Reuse its visual composition and prototyping workflow rather than adding another low-code builder into Agent Hub.",
    hubIntegration:
      "Wrap Flowise executions with a local sidecar that posts run progress and failures into Agent Hub.",
  },
  {
    id: "librechat",
    name: "LibreChat",
    repoUrl: "https://github.com/danny-avila/LibreChat",
    stars: 35510,
    language: "TypeScript",
    category: "agent-workbench",
    summary: "Multi-model chat and agent workspace with MCP support and a strong self-hosted ecosystem.",
    reuseInsteadOfBuilding:
      "Do not rebuild a full chat-centric control surface, prompt presets, or multi-provider UI inside Agent Hub.",
    hubIntegration:
      "Keep LibreChat as the human conversation front-end and have Hub aggregate agent run state and operational inbox items.",
  },
  {
    id: "langfuse",
    name: "Langfuse",
    repoUrl: "https://github.com/langfuse/langfuse",
    stars: 24724,
    language: "TypeScript",
    category: "observability",
    summary: "Open-source LLM engineering platform for tracing, evaluations, prompts, and metrics.",
    reuseInsteadOfBuilding:
      "Do not recreate deep tracing, eval dashboards, or prompt-management tooling in Agent Hub.",
    hubIntegration:
      "Use Langfuse for detailed traces and feed only summarized health, blockers, and attention signals into Agent Hub.",
  },
  {
    id: "agentops",
    name: "AgentOps",
    repoUrl: "https://github.com/AgentOps-AI/agentops",
    stars: 5450,
    language: "Python",
    category: "observability",
    summary: "Monitoring SDK focused on agent telemetry, cost tracking, and cross-framework operational visibility.",
    reuseInsteadOfBuilding:
      "Reuse its telemetry and cost instrumentation instead of building a full observability SDK into Agent Hub.",
    hubIntegration:
      "Pipe AgentOps metrics into Hub-level health summaries and use Hub for inbox/control rather than raw telemetry analysis.",
  },
];
