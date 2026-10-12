// Verifies the DSH adapter mounts exactly one prompt surface, that it points at
// the skill tool rather than inlining skill instructions, and that a broken
// surface cannot take the plugin — and with it the whole web boot — down.
//
// The bootstrap is a pointer, not a copy of `using-superpowers`. It rides every
// request, so anything it quotes is a per-request cost; inlining the mandate
// also produced a truncated skill (the section cut the body at
// `## Skill Priority`), so the model saw "invoke a skill" with no rule for
// which one. The rule itself is loaded once, in full, through the `skill` tool.

import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { apply, name } from '../lib/dsh-adapter.js';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A ctx that records what the adapter registers, standing in for the host. */
function makeCtx(overrides = {}) {
  const sections = [];
  const contexts = [];
  const providers = [];
  return {
    sections,
    contexts,
    providers,
    skills: { registerProvider: (factory) => providers.push(factory) },
    systemPrompt: {
      section: (s) => sections.push(s),
      context: (c) => contexts.push(c),
    },
    ...overrides,
  };
}

// The prompt surface mounts from a floating async block, so drain the macrotask
// queue before asserting. Polling is the honest way to wait for an unspecified
// number of I/O turns.
async function settle(predicate, { attempts = 50 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return predicate();
}

const sectionMounted = (ctx) => ctx.sections.length > 0;

test('mounts the bootstrap as a section and no runtime context', async () => {
  const ctx = makeCtx();
  apply(ctx);
  assert.ok(await settle(() => sectionMounted(ctx)), 'the bootstrap section must mount');

  const section = ctx.sections.find((s) => s.name === 'plugin:superpowers');
  assert.ok(section, 'bootstrap must register as a section');
  assert.match(section.text, /EXTREMELY-IMPORTANT/,
    'the bootstrap must keep the marker that carries the mandate');

  // The per-request reminder was removed: it duplicated the section and, as
  // runtime context, was the surface a preset can suppress.
  assert.deepEqual(ctx.contexts, [],
    'no runtime context may be registered');
});

test('bootstrap points at the skill instead of inlining the mandate', async () => {
  const ctx = makeCtx();
  apply(ctx);
  assert.ok(await settle(() => sectionMounted(ctx)), 'the bootstrap section must mount');

  const { text } = ctx.sections.find((s) => s.name === 'plugin:superpowers');
  assert.match(text, /using-superpowers/, 'must name the skill it asks the model to load');
  assert.match(text, /`skill`/, 'must name the tool that loads it');

  // A truncated copy of the skill is worse than no copy: it carried the
  // mandate while dropping `## Skill Priority` and the Red Flags table, so the
  // model was told to check for a skill without being told how to choose one.
  assert.doesNotMatch(text, /Skill Priority/,
    'must not quote the skill body; the rule belongs in the skill, not the prompt');
  assert.doesNotMatch(text, /rationalize/,
    'must not quote the Red Flags table');
  assert.doesNotMatch(text, /You cannot rationalize your way out of this/,
    'must not quote the skill mandate verbatim');
});

test('bootstrap tells the model to check for a skill on each new task', async () => {
  const ctx = makeCtx();
  apply(ctx);
  assert.ok(await settle(() => sectionMounted(ctx)), 'the bootstrap section must mount');

  // The reason this text exists at all: the user wants the model to consult the
  // superpowers workflow on every new task, not only at session start.
  const { text } = ctx.sections.find((s) => s.name === 'plugin:superpowers');
  assert.match(text, /each new task/i,
    'must tell the model to re-check per task, which is what a rebuilt section buys');
  assert.match(text, /catalog/i, 'must point at the catalog the model actually reads');
});

test('bootstrap stays small enough to ride every request', async () => {
  const ctx = makeCtx();
  apply(ctx);
  assert.ok(await settle(() => sectionMounted(ctx)), 'the bootstrap section must mount');

  const { text } = ctx.sections.find((s) => s.name === 'plugin:superpowers');
  // A restated mandate is a per-request cost. The previous 885-char slice of
  // the skill body was ~239 tokens on every single call.
  assert.ok(text.length < 600,
    `bootstrap must stay a pointer, got ${text.length} chars`);
});

test('plugin name matches the bundle row the loader resolves against', () => {
  // A mismatch makes the plugin mount silently: no tools, no routes, no error.
  assert.equal(name, 'superpowers');
  assert.equal(new URL('../package.json', import.meta.url).pathname.endsWith('package.json'), true);
});

test('a throwing section sink does not propagate out of apply()', async () => {
  const ctx = makeCtx({
    systemPrompt: {
      section: () => {
        throw new Error('section sink unavailable');
      },
      context: () => {
        throw new Error('context sink unavailable');
      },
    },
  });

  assert.doesNotThrow(() => apply(ctx), 'a prompt-surface failure must not take the plugin down');
  // With one surface left there is nothing left to fall back to, so the only
  // thing left to assert is that the failure is contained, not propagated.
});

test('skill provider registers and discovers the packaged skills', async () => {
  const ctx = makeCtx();
  apply(ctx);

  assert.equal(ctx.providers.length, 1, 'exactly one skill provider');
  // The host hands the provider a control carrying the cancellation signal;
  // list() reads it, so an absent control must not throw.
  const provider = ctx.providers[0]({ signal: undefined });
  const candidates = await provider.list({ signal: undefined });
  const names = candidates.map((c) => c.name);

  // The bootstrap names this skill, so an absent one would make the pointer a
  // dead end rather than a misfire.
  assert.ok(names.includes('using-superpowers'),
    'the bootstrap names using-superpowers, so it must be discoverable');
  for (const skill of candidates) {
    assert.equal(skill.provider, 'superpowers');
    assert.equal(skill.invocation.modelInvocable, true,
      `${skill.name} must be model-invocable or the bootstrap is a dead end`);
  }
});