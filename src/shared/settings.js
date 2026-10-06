/**
 * Lingua — settings access layer.
 * Stored in chrome.storage.local (single key). Registers onto Lingua.settings.
 */
(function (root) {
  'use strict';
  const NS = (root.Lingua = root.Lingua || {});
  const KEY = 'lingua:settings:v1';

  const DEFAULTS = NS.constants.DEFAULT_SETTINGS;
  const { deepMerge } = NS.utils;

  let memo = null; // in-process cache to avoid hammering storage in hot paths

  /** Read merged settings (defaults <- stored). */
  async function getSettings() {
    if (memo) return memo;
    let stored = {};
    try {
      const res = await chrome.storage.local.get(KEY);
      stored = res && res[KEY] ? res[KEY] : {};
    } catch (e) {
      // storage unavailable (e.g. context invalidated) — fall back to defaults
      stored = {};
    }
    memo = deepMerge(DEFAULTS, stored);
    return memo;
  }

  /** Shallow-patch settings; nested `providers` object is deep-merged. */
  async function setSettings(patch) {
    const current = await getSettings();
    const next = deepMerge(current, patch);
    memo = next;
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  }

  function invalidate() {
    memo = null;
  }

  /** Subscribe to external changes (other tabs / options page). */
  function onChanged(cb) {
    if (!chrome.storage || !chrome.storage.onChanged) return () => {};
    const handler = (changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      memo = deepMerge(DEFAULTS, changes[KEY].newValue || {});
      cb(memo);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }

  /**
   * Is the selected provider usable enough to attempt a request?
   *
   * This mirrors what each implementation strictly cannot work without. Note it
   * deliberately does NOT require Azure's `region`: the header is only mandatory
   * for a regional resource, so demanding it here would lock out anyone using a
   * global one. A missing region is surfaced in the pane instead of blocking.
   */
  function providerReady(settings) {
    const p = settings.provider;
    const cfg = settings.providers[p] || {};
    if (p === 'google') return true; // free endpoint needs no key
    if (p === 'custom') return !!cfg.url;
    if (p === 'openai') return !!cfg.baseUrl && !!cfg.model;
    return !!cfg.apiKey;
  }

  NS.settings = { getSettings, setSettings, invalidate, onChanged, providerReady, KEY };
})(typeof globalThis !== 'undefined' ? globalThis : self);
