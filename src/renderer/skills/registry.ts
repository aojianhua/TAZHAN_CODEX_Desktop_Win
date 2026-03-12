import type { SkillManifestV1 } from "./types";

type GlobModule = { default: SkillManifestV1 };

function loadBuiltinSkills(): SkillManifestV1[] {
  const modules = import.meta.glob<GlobModule>("./manifests/*.skill.{ts,tsx}", { eager: true });
  const skills: SkillManifestV1[] = [];
  for (const mod of Object.values(modules)) {
    if (mod && mod.default) {
      skills.push(mod.default);
    }
  }
  skills.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  return skills;
}

export const builtinSkills: SkillManifestV1[] = loadBuiltinSkills();
