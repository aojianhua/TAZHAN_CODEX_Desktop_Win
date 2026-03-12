import type { SkillWizardManifestV1 } from "../types";

const manifest: SkillWizardManifestV1 = {
  schemaVersion: 1,
  id: "bug_report",
  title: "问题反馈",
  description: "快速生成一份 Bug 报告（Markdown），可插入/发送/保存到工作区文件。",
  version: "0.1.0",
  kind: "wizard",
  steps: [
    {
      type: "markdown",
      content: "填写下面信息后，会生成一份结构化的 Bug 报告（Markdown）。"
    },
    {
      type: "text",
      id: "title",
      label: "标题",
      placeholder: "一句话描述问题",
      required: true
    },
    {
      type: "select",
      id: "severity",
      label: "严重程度",
      required: true,
      default: "S2",
      options: [
        { label: "S1 - 阻断", value: "S1" },
        { label: "S2 - 严重", value: "S2" },
        { label: "S3 - 一般", value: "S3" },
        { label: "S4 - 体验", value: "S4" }
      ]
    },
    {
      type: "text",
      id: "env",
      label: "环境信息",
      multiline: true,
      placeholder: "例如：Windows 11 / tazhan-desktop 版本 / 远端 codex 版本 ...",
      required: true
    },
    {
      type: "text",
      id: "steps",
      label: "复现步骤",
      multiline: true,
      placeholder: "建议用 1. 2. 3. 的形式",
      required: true
    },
    {
      type: "text",
      id: "expected",
      label: "期望结果",
      multiline: true,
      required: true
    },
    {
      type: "text",
      id: "actual",
      label: "实际结果",
      multiline: true,
      required: true
    },
    {
      type: "text",
      id: "notes",
      label: "补充信息（可选）",
      multiline: true,
      required: false
    },
    {
      type: "text",
      id: "outputPath",
      label: "保存路径（相对工作区）",
      help: "点击“保存”会写入该文件路径；留空则使用默认路径。",
      default: "docs/bug_report.md"
    }
  ],
  result: {
    type: "markdown",
    title: "预览",
    outputPathAnswerId: "outputPath",
    defaultOutputPath: "docs/bug_report.md",
    template: `# Bug Report

## 标题
{{title}}

## 严重程度
{{severity}}

## 环境信息
{{env}}

## 复现步骤
{{steps}}

## 期望结果
{{expected}}

## 实际结果
{{actual}}

## 补充信息
{{notes}}
`
  }
};

export default manifest;

