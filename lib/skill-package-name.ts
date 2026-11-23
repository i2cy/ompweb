// Skills install accepts two package grammars (issue #499):
// - npm: `name`, `name@version`, `@scope/name`, `@scope/name@version`
// - skills.sh: `owner/repo@skill` (what the search route returns), and
//   `owner/repo` for a source's default skill.
// A leading `-` is still rejected so a value like `--force` cannot be
// interpreted as an npx/CLI option instead of a package name. The value is
// passed to `npx skills add` as a single argv element, never via a shell.
export const SKILL_PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?(?:@[a-z0-9][a-z0-9._-]*)?$/i;

export function isValidSkillPackageName(name: string): boolean {
  return !name.startsWith("-") && SKILL_PACKAGE_NAME_PATTERN.test(name);
}
