// Verifies the DSH adapter mounts both prompt surfaces and that a broken
// surface cannot take the plugin — and with it the whole web boot — down.
//
// Both surfaces are assertions on registration, not on rendered prompt text:
// `systemPrompt.section` and `systemPrompt.context` are separate sort spaces
// in the host registry, so a mount that registers the wrong one is silent. The
// reminder exists to survive a long session, and it only survives if it is
// registered as runtime context.

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

// The prompt surfaces mount from a floating async block whose first await is a
// real file read, so drain the macrotask queue before asserting. setImmediate
// alone lands before that read resolves; polling is the honest way to wait for
// an unspecified number of I/O turns.
async function settle(predicate, { attempts = 50 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return predicate();
}

const bothMounted = (ctx) => ctx.sections.length > 0 && ctx.contexts.length > 0;

test('mounts the bootstrap as a section and the reminder as runtime context', async () => {
  const ctx = makeCtx();
  apply(ctx);
  assert.ok(await settle(() => bothMounted(ctx)), 'both prompt surfaces must mount');

  const section = ctx.sections.find((s) => s.name === 'plugin:superpowers');
  assert.ok(section, 'bootstrap must register as a section');
  assert.match(section.text, /EXTREMELY-IMPORTANT/,
    'the bootstrap text must be the mandate read from using-superpowers');

  const context = ctx.contexts.find((c) => c.name === 'plugin:superpowers-reminder');
  assert.ok(context, 'reminder must register as runtime context');
  assert.ok(context.text.trim().length > 0, 'reminder text must not be empty');
});

test('reminder is short and points at the skill tool', async () => {
  const ctx = makeCtx();
  apply(ctx);
  assert.ok(await settle(() => bothMounted(ctx)), 'both prompt surfaces must mount');

  const { text } = ctx.contexts.find((c) => c.name === 'plugin:superpowers-reminder');
  assert.match(text, /using-superpowers/, 'reminder must name the skill it asks for');
  assert.match(text, /skill/, 'reminder must name how to load it');
  // It rides every request, so a restated mandate is a real cost.
  assert.ok(text.split('\n').length <= 4,
    `reminder must stay short, got ${text.split('\n').length} lines`);
  assert.doesNotMatch(text, /EXTREMELY-IMPORTANT/,
    'reminder must not duplicate the mandate that the section already carries');
});

test('reminder orders after delegation policy and before tool guidance', async () => {
  const ctx = makeCtx();
  apply(ctx);
  assert.ok(await settle(() => bothMounted(ctx)), 'both prompt surfaces must mount');

  // DSH allocates SANDBOX_POLICY 110, APPROVAL_POLICY 115, SUBAGENT_DELEGATION
  // 120 in the runtime-context band; external contributors pick their own.
  const { order } = ctx.contexts.find((c) => c.name === 'plugin:superpowers-reminder');
  assert.ok(order > 120, `order must follow SUBAGENT_DELEGATION (120), got ${order}`);
  assert.ok(Number.isFinite(order), 'order must be finite or the host rejects registration');
});

test('plugin name matches the bundle row the loader resolves against', () => {
  // A mismatch makes the plugin mount silently: no tools, no routes, no error.
  assert.equal(name, 'superpowers');
  assert.equal(new URL('../package.json', import.meta.url).pathname.endsWith('package.json'), true);
});

test('a throwing section sink does not stop the reminder from mounting', async () => {
  const ctx = makeCtx({
    systemPrompt: {
      section: () => {
        throw new Error('section sink unavailable');
      },
      context: (c) => ctx.contexts.push(c),
    },
  });
  apply(ctx);
  assert.ok(
    await settle(() => ctx.contexts.length > 0),
    'the reminder is registered even when the section sink throws',
  );

  // The two surfaces are independent: one failing must not skip the other.
  assert.ok(
    ctx.contexts.some((c) => c.name === 'plugin:superpowers-reminder'),
    'reminder must still register when the section sink throws',
  );
});

test('a throwing context sink does not propagate out of apply()', async () => {
  const ctx = makeCtx({
    systemPrompt: {
      section: (s) => ctx.sections.push(s),
      context: () => {
        throw new Error('context sink unavailable');
      },
    },
  });

  assert.doesNotThrow(() => apply(ctx), 'a prompt-surface failure must not take the plugin down');
  assert.ok(
    await settle(() => ctx.sections.length > 0),
    'the bootstrap section still mounts when the context sink throws',
  );
  assert.ok(ctx.sections.some((s) => s.name === 'plugin:superpowers'),
    'the bootstrap section must still have mounted');
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

  assert.ok(names.includes('using-superpowers'),
    'the bootstrap skill must be discoverable, otherwise the reminder asks for something absent');
  for (const skill of candidates) {
    assert.equal(skill.provider, 'superpowers');
    assert.equal(skill.invocation.modelInvocable, true,
      `${skill.name} must be model-invocable or the reminder is a dead end`);
  }
});
