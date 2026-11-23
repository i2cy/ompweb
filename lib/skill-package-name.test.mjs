import assert from "node:assert/strict";
import test from "node:test";

const { isValidSkillPackageName } = await import("./skill-package-name.ts");

test("accepts the skills.sh source grammar the search route returns (#499)", () => {
  assert.equal(isValidSkillPackageName("vercel-labs/agent-skills@vercel-react-best-practices"), true);
  assert.equal(isValidSkillPackageName("owner/repo@skill"), true);
  assert.equal(isValidSkillPackageName("owner/repo"), true);
});

test("still accepts plain npm names", () => {
  assert.equal(isValidSkillPackageName("react"), true);
  assert.equal(isValidSkillPackageName("react@1.2.3"), true);
  assert.equal(isValidSkillPackageName("@scope/pkg"), true);
  assert.equal(isValidSkillPackageName("@scope/pkg@1.2.3"), true);
  assert.equal(isValidSkillPackageName("my-skill"), true);
  assert.equal(isValidSkillPackageName("my.skill_name-1"), true);
});

test("still rejects option-like values and malformed names", () => {
  assert.equal(isValidSkillPackageName("--force"), false);
  assert.equal(isValidSkillPackageName("-x"), false);
  assert.equal(isValidSkillPackageName("foo/bar/baz"), false);
  assert.equal(isValidSkillPackageName("foo//bar"), false);
  assert.equal(isValidSkillPackageName("foo/"), false);
  assert.equal(isValidSkillPackageName("/foo"), false);
  assert.equal(isValidSkillPackageName("foo@"), false);
  assert.equal(isValidSkillPackageName("foo bar"), false);
  assert.equal(isValidSkillPackageName("../etc"), false);
  assert.equal(isValidSkillPackageName("@scope/"), false);
  assert.equal(isValidSkillPackageName("foo@bar@baz"), false);
  assert.equal(isValidSkillPackageName("foo/bar@baz/qux"), false);
  assert.equal(isValidSkillPackageName(""), false);
});
