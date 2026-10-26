import type { Choice } from "@/components/ChoiceGroup";
import type {
  AgentProvider,
  Appearance,
  WorkspaceStyle,
} from "@/lib/preferences";

export const workspaceChoices: Choice<WorkspaceStyle>[] = [
  {
    value: "simple",
    title: "Simple",
    description: "Same tools, simpler interface.",
    image: "simple.png",
  },
  {
    value: "advanced",
    title: "Advanced",
    description: "More controls and panels in view.",
    image: "advanced.png",
  },
];
export const appearanceChoices: Choice<Appearance>[] = [
  {
    value: "system",
    title: "System",
    description: "Follow your system settings.",
    image: "system.png",
  },
  {
    value: "light",
    title: "Light",
    description: "A lighter workspace.",
    image: "light.png",
  },
  {
    value: "dark",
    title: "Dark",
    description: "A darker workspace.",
    image: "dark.png",
  },
];
export const agentChoices: Choice<AgentProvider>[] = [
  {
    value: "codex",
    title: "Codex",
    description: "OpenAI coding agent",
    image: "codex.png",
  },
  {
    value: "claude",
    title: "Claude Code",
    description: "Anthropic coding agent",
    image: "claude.png",
  },
  {
    value: "opencode",
    title: "OpenCode",
    description: "Open-source coding agent",
    image: "opencode.png",
  },
];
export const stepCopy: Record<number, { title: string; description: string }> =
  {
    2: {
      title: "How would you like BacktestEngine to look?",
      description: "Choose the layout that works for you.",
    },
    3: {
      title: "Choose your appearance",
      description: "You can change this anytime in Settings.",
    },
    4: {
      title: "Connect your AI agent",
      description: "Bring an agent you already use. This step is optional.",
    },
  };
