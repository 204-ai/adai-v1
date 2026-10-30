import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/field/js-interface/embed.js', import.meta.url), 'utf8');

function frame(standalone = false) {
  const listeners: Record<string, (e: any) => void> = {};
  const messages: Array<{ data: any; origin: string }> = [];
  const parent = { postMessage: (data: any, origin: string) => messages.push({ data, origin }) };
  const window: any = { parent, addEventListener: (name: string, fn: any) => { listeners[name] = fn; } };
  if (standalone) window.parent = window;
  vm.runInNewContext(script, { window });
  const hello = (source: any = parent, origin = 'https://gallery.example') => listeners.message?.({ source, origin, data: { adai: 'embed-hello', keys: ['m'] } });
  const key = (options: any = {}) => {
    let prevented = false, stopped = false;
    listeners.keydown?.({ key: 'm', target: {}, ...options, preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => { stopped = true; } });
    return { prevented, stopped };
  };
  return { listeners, messages, hello, key };
}

test('the field only hands keys to its own parent after a handshake', () => {
  const f = frame();
  assert.deepEqual(f.key(), { prevented: false, stopped: false });
  f.hello({}, 'https://other.example');
  assert.equal(f.messages.length, 0);
  assert.deepEqual(f.key(), { prevented: false, stopped: false });
  f.hello();
  assert.equal(f.messages[0].data.adai, 'embed-ready');
  assert.deepEqual(f.key({ key: 'M' }), { prevented: true, stopped: true });
  assert.equal(f.messages[1].data.key, 'm');
  assert.equal(f.messages[1].origin, 'https://gallery.example');
});

test('the framed field preserves typing, modified keys, and keys its parent did not request', () => {
  const f = frame();
  f.hello();
  for (const options of [
    { target: { tagName: 'INPUT' } }, { target: { tagName: 'TEXTAREA' } },
    { target: { tagName: 'SELECT' } }, { target: { isContentEditable: true } },
    { ctrlKey: true }, { metaKey: true }, { altKey: true }, { key: 'f' },
  ]) assert.deepEqual(f.key(options), { prevented: false, stopped: false });
  assert.equal(f.messages.length, 1);
});

test('an unframed field installs no embed listeners', () => {
  assert.deepEqual(frame(true).listeners, {});
});
