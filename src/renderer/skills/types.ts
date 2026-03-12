export type SkillSchemaVersion = 1;

export type SkillOption = {
  label: string;
  value: string;
};

export type SkillBaseManifestV1 = {
  schemaVersion: SkillSchemaVersion;
  id: string;
  title: string;
  description?: string;
  version: string;
};

export type SkillCustomRenderProps = {
  scope: "local" | "remote";
  threadId: string | null;
  workspaceRoot: string;
  insertText: (text: string) => void;
  sendText: (text: string) => Promise<void>;
  saveToWorkspaceFile: (relPath: string, content: string) => Promise<{ ok: true; absPath: string } | { ok: false; error: string }>;
  llmChatComplete: (args: import("../../shared/types").LlmChatCompleteArgs) => Promise<import("../../shared/types").LlmChatCompleteResult>;
};

export type SkillStepV1 =
  | { type: "markdown"; content: string }
  | {
      type: "text";
      id: string;
      label: string;
      placeholder?: string;
      help?: string;
      required?: boolean;
      multiline?: boolean;
      default?: string;
    }
  | {
      type: "select";
      id: string;
      label: string;
      options: SkillOption[];
      help?: string;
      required?: boolean;
      default?: string;
    };

export type SkillResultV1 = {
  type: "markdown";
  title: string;
  template: string;
  outputPathAnswerId?: string;
  defaultOutputPath?: string;
};

export type SkillWizardManifestV1 = SkillBaseManifestV1 & {
  kind: "wizard";
  steps: SkillStepV1[];
  result: SkillResultV1;
};

export type SkillInterviewManifestV1 = SkillBaseManifestV1 & {
  kind: "interview";
  maxQuestions: number;
  questionPrompt: string;
  batchQuestionPrompt?: string;
  prdPrompt: string;
  defaultOutputPath: string;
};

export type SkillCustomManifestV1 = SkillBaseManifestV1 & {
  kind: "custom";
  Renderer: import("react").ComponentType<SkillCustomRenderProps>;
};

export type SkillManifestV1 = SkillWizardManifestV1 | SkillInterviewManifestV1 | SkillCustomManifestV1;
